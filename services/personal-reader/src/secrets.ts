import { readFile } from "node:fs/promises";
import { systemClock } from "@tmtp/clock";
import type { Clock } from "@tmtp/clock";
import type { IssuedSession } from "@tmtp/access-control";
import type { ResolvedConfig } from "./config.js";

export type SecretConfigKey =
  | "auth.access_token_path"
  | "llm.api_key_path"
  | "hn.session_cookie_path";

export interface StartupSecrets {
  accessToken: string;
  llmApiKey: string;
  hnSessionCookie?: string;
}

export interface SecretRedactionRegistry {
  readonly secretValuesProvider: () => string[];
  registerSession(session: IssuedSession): void;
  unregisterSession(opaqueSession: string): void;
}

export class SecretFileError extends Error {
  override readonly name = "SecretFileError" as const;

  constructor(readonly key: SecretConfigKey) {
    super("Secret file could not be loaded.");
  }
}

function removeTerminalNewline(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

export async function readSecretFile(path: string, key: SecretConfigKey): Promise<string> {
  let value: string;
  try {
    value = await readFile(path, { encoding: "utf8" });
  } catch {
    throw new SecretFileError(key);
  }
  return removeTerminalNewline(value);
}

export async function loadStartupSecrets(config: ResolvedConfig): Promise<StartupSecrets> {
  const accessToken = await readSecretFile(config.auth.access_token_path, "auth.access_token_path");
  const llmApiKey = await readSecretFile(config.llm.api_key_path, "llm.api_key_path");
  const hnSessionCookie = config.hn.username !== null && config.hn.session_cookie_path !== null
    ? await readSecretFile(config.hn.session_cookie_path, "hn.session_cookie_path")
    : undefined;
  return {
    accessToken,
    llmApiKey,
    ...(hnSessionCookie === undefined ? {} : { hnSessionCookie }),
  };
}

interface SessionEntry {
  opaqueSession: string;
  csrfSecret: string;
  expiresAtMs: number;
}

export function createSecretRedactionRegistry(
  startupSecrets: StartupSecrets,
  clock: Clock = systemClock,
): SecretRedactionRegistry {
  const startupValues = [
    startupSecrets.accessToken,
    startupSecrets.llmApiKey,
    ...(startupSecrets.hnSessionCookie === undefined ? [] : [startupSecrets.hnSessionCookie]),
  ];
  const sessions = new Map<string, SessionEntry>();

  return {
    secretValuesProvider(): string[] {
      const nowMs = clock.now().getTime();
      for (const [opaqueSession, entry] of sessions) {
        if (entry.expiresAtMs <= nowMs) sessions.delete(opaqueSession);
      }
      const values = [...startupValues];
      for (const entry of sessions.values()) {
        values.push(entry.opaqueSession, entry.csrfSecret);
      }
      return values;
    },

    registerSession(session: IssuedSession): void {
      const expiresAtMs = Date.parse(session.expiresAt);
      if (
        typeof session.opaqueSession !== "string" || typeof session.csrfSecret !== "string" ||
        !Number.isFinite(expiresAtMs)
      ) {
        throw new TypeError("Invalid session secret registration.");
      }
      sessions.set(session.opaqueSession, {
        opaqueSession: session.opaqueSession,
        csrfSecret: session.csrfSecret,
        expiresAtMs,
      });
    },

    unregisterSession(opaqueSession: string): void {
      sessions.delete(opaqueSession);
    },
  };
}
