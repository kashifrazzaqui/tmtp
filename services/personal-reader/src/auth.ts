import type { AccessSession } from "@tmtp/access-control";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServiceGraph } from "./composition.js";
import { ServiceError } from "./errors.js";

const sessions = new WeakMap<FastifyRequest, AccessSession>();

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized === "0.0.0.0" ? normalized !== "0.0.0.0"
    : /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export class OriginPolicy {
  private effective?: string;

  constructor(private readonly graph: ServiceGraph) {
    if (graph.config.server.public_base_url !== null) {
      this.effective = new URL(graph.config.server.public_base_url).origin;
    }
  }

  bound(port: number): void {
    if (this.effective !== undefined) return;
    const host = this.graph.config.server.host;
    const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    this.effective = new URL(`http://${bracketed}:${port}`).origin;
  }

  get origin(): string {
    if (this.effective === undefined) throw new ServiceError("internal-failure", 500);
    return this.effective;
  }

  get secureCookies(): boolean {
    return !isLoopbackHost(this.graph.config.server.host) || this.origin.startsWith("https:");
  }

  verify(request: FastifyRequest, allowSameOriginFetch = false): void {
    const origin = request.headers.origin;
    const fetchSite = request.headers["sec-fetch-site"];
    const sameOriginFetch = allowSameOriginFetch && origin === undefined && fetchSite === "same-origin";
    if ((!sameOriginFetch && origin !== this.origin) || (typeof fetchSite === "string" && fetchSite === "cross-site") || Array.isArray(fetchSite)) {
      throw new ServiceError("origin-invalid", 403);
    }
  }
}

export function createAuth(graph: ServiceGraph, origins: OriginPolicy): {
  authenticate(request: FastifyRequest): Promise<AccessSession>;
  mutationGuard(request: FastifyRequest): Promise<void>;
  debugGuard(request: FastifyRequest): Promise<void>;
  optionalSession(request: FastifyRequest): Promise<AccessSession | undefined>;
  login(accessToken: string): Promise<{ expiresAt: string; csrfSecret: string; opaqueSession: string }>;
  logout(request: FastifyRequest): Promise<void>;
} {
  const optionalSession = async (request: FastifyRequest): Promise<AccessSession | undefined> => {
    const opaque = request.cookies.tmtp_session;
    if (opaque === undefined) return undefined;
    return graph.accessControl.authenticate(opaque);
  };
  const authenticate = async (request: FastifyRequest): Promise<AccessSession> => {
    const session = await optionalSession(request);
    if (session === undefined) throw new ServiceError("authentication-required", 401);
    sessions.set(request, session);
    return session;
  };
  const verifyGuard = async (request: FastifyRequest, debug: boolean): Promise<void> => {
    const session = await authenticate(request);
    const csrf = request.headers["x-tmtp-csrf"];
    if (typeof csrf !== "string" || !(await graph.accessControl.verifyCsrf(session, csrf))) {
      throw new ServiceError("csrf-invalid", 403);
    }
    origins.verify(request, debug);
  };
  return {
    authenticate,
    mutationGuard: async (request: FastifyRequest) => verifyGuard(request, false),
    debugGuard: async (request: FastifyRequest) => verifyGuard(request, true),
    optionalSession,
    async login(accessToken: string) {
      const issued = await graph.accessControl.login(accessToken);
      graph.secrets.registry.registerSession(issued);
      return issued;
    },
    async logout(request: FastifyRequest) {
      const opaque = request.cookies.tmtp_session;
      if (opaque === undefined) throw new ServiceError("authentication-required", 401);
      await graph.accessControl.logout(opaque);
      graph.secrets.registry.unregisterSession(opaque);
      sessions.delete(request);
    },
  };
}

export function sessionCookie(graph: ServiceGraph, origins: OriginPolicy): {
  name: string;
  options: { httpOnly: true; path: string; sameSite: "strict"; secure: boolean };
} {
  return {
    name: "tmtp_session",
    options: { httpOnly: true, path: "/", sameSite: "strict", secure: origins.secureCookies },
  };
}

export function setLoginCookie(reply: FastifyReply, graph: ServiceGraph, origins: OriginPolicy, opaque: string): void {
  const cookie = sessionCookie(graph, origins);
  reply.setCookie(cookie.name, opaque, cookie.options);
}

export function clearLoginCookie(reply: FastifyReply, graph: ServiceGraph, origins: OriginPolicy): void {
  const cookie = sessionCookie(graph, origins);
  reply.clearCookie(cookie.name, cookie.options);
}
