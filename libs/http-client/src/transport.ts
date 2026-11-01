import { Agent, Client, buildConnector } from "undici";
import type { HttpTransport, HttpTransportRequest, HttpTransportResponse } from "./index.js";

export function createDefaultTransport(): HttpTransport {
  const agent = new Agent({ allowH2: false, pipelining: 1 });
  const pinnedCleanups = new Map<Client, (normal: boolean) => Promise<void>>();

  function trackPinned(client: Client): (normal: boolean) => Promise<void> {
    let cleanup: Promise<void> | undefined;
    const run = (normal: boolean): Promise<void> => {
      if (cleanup === undefined) {
        cleanup = (async () => {
          if (normal) await client.close();
          else await client.destroy();
        })().finally(() => pinnedCleanups.delete(client));
      }
      return cleanup;
    };
    pinnedCleanups.set(client, run);
    return run;
  }

  function pinnedBody(
    body: AsyncIterable<Uint8Array>,
    cleanup: (normal: boolean) => Promise<void>,
  ): AsyncIterable<Uint8Array> {
    return {
      [Symbol.asyncIterator]() {
        const iterator = body[Symbol.asyncIterator]();
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            try {
              const result = await iterator.next();
              if (result.done) await cleanup(true);
              return result;
            } catch (error) {
              await cleanup(false);
              throw error;
            }
          },
          async return(value?: unknown): Promise<IteratorResult<Uint8Array>> {
            try {
              if (iterator.return !== undefined) await iterator.return(value);
            } finally {
              await cleanup(false);
            }
            return { done: true, value: undefined };
          },
          async throw(error?: unknown): Promise<IteratorResult<Uint8Array>> {
            try {
              if (iterator.throw !== undefined) await iterator.throw(error);
            } finally {
              await cleanup(false);
            }
            throw error;
          },
        };
      },
    };
  }

  return {
    async request(request: HttpTransportRequest): Promise<HttpTransportResponse> {
      const url = new URL(request.url);
      const path = `${url.pathname}${url.search}`;
      let pinned: Client | undefined;
      let cleanup: ((normal: boolean) => Promise<void>) | undefined;
      try {
        let dispatcher: Agent | Client = agent;
        if (request.connection !== undefined) {
          const connector = buildConnector({});
          const pin = request.connection;
          pinned = new Client(url.origin, {
            allowH2: false,
            pipelining: 1,
            connect(options, callback) {
              connector({
                ...options,
                hostname: pin.address,
                port: String(pin.port),
                servername: pin.servername,
              }, callback);
            },
          });
          dispatcher = pinned;
          cleanup = trackPinned(pinned);
        }
        const response = await (dispatcher as Agent).request({
          origin: url.origin,
          path,
          method: request.method,
          headers: request.headers,
          ...(request.body === undefined ? {} : { body: request.body }),
          signal: request.signal,
          headersTimeout: 0,
          bodyTimeout: 0,
        });
        return {
          status: response.statusCode,
          headers: response.headers,
          body: cleanup === undefined
            ? response.body
            : pinnedBody(response.body, cleanup),
        };
      } catch (error) {
        if (cleanup !== undefined) await cleanup(false);
        throw error;
      }
    },

    async close(): Promise<void> {
      const results = await Promise.allSettled([
        ...[...pinnedCleanups.values()].map((cleanup) => cleanup(false)),
        agent.close(),
      ]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure !== undefined) throw failure.reason;
    },
  };
}
