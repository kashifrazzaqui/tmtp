import type { QueueState } from "./types.js";

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function createClientEventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function createId(prefix: string): string {
  return `${prefix}_${createClientEventId()}`;
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export function safeHost(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.hostname;
  } catch {
    // The service supplies safe targets; malformed values get a neutral label.
  }
  return "Hacker News";
}

export function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

export function allowedQueueStates(current: QueueState): QueueState[] {
  if (current === "dismissed") return ["unread", "dismissed", "archived"];
  if (current === "archived") return ["unread", "archived"];
  return ["unread", "reading", "read", "dismissed", "archived"];
}

export function sentenceCase(value: string): string {
  const spaced = value.replaceAll("-", " ");
  return spaced.length === 0 ? "Unknown" : `${spaced[0]?.toUpperCase() ?? ""}${spaced.slice(1)}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

// Exported for deterministic tests of the ID alphabet without weakening production entropy.
export function isClientEventId(value: string): boolean {
  return value.length === 43 && [...value].every((character) => ID_ALPHABET.includes(character));
}
