import type {
  AccountCapabilityDto,
  CapabilitiesSnapshot,
  DebugSnapshot,
  ErrorEnvelope,
  HnActionHistoryDto,
  HnActionKind,
  HnActionResultDto,
  InterestProfileDto,
  JobDto,
  PreferenceRuleDto,
  QueueDto,
  QueueEntryDto,
  QueueState,
  RawActivity,
  ReadinessSnapshot,
  StoryDetailDto,
} from "./types.js";

export const API_BASE = "/api/v1";
export const AUTH_REQUIRED_EVENT = "tmtp:auth-required";

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT";
  body?: unknown;
  csrf?: boolean;
  signal?: AbortSignal | undefined;
  keepalive?: boolean;
  successStatuses?: readonly number[];
}

export class ApiError extends Error {
  override readonly name = "ApiError" as const;
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly details?: ErrorEnvelope["error"]["details"];

  constructor(options: { code: string; message: string; status: number; retryable: boolean; requestId?: string; details?: ErrorEnvelope["error"]["details"] }) {
    super(options.message);
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.details !== undefined) this.details = options.details;
  }
}

function isEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const error = (value as { error?: unknown }).error;
  return typeof error === "object" && error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string" &&
    typeof (error as { retryable?: unknown }).retryable === "boolean";
}

function notifyAuthRequired(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
}

export function getCsrf(): string | undefined {
  if (!csrfInitialized) {
    try {
      memoryCsrf = sessionStorage.getItem("tmtp.csrf.v1") ?? undefined;
    } catch {
      // Memory-only storage remains available when sessionStorage is blocked.
    }
    csrfInitialized = true;
  }
  return memoryCsrf;
}

let memoryCsrf: string | undefined;
let csrfInitialized = false;

export function setCsrf(value: string | undefined): void {
  memoryCsrf = value;
  csrfInitialized = true;
  try {
    if (value === undefined) sessionStorage.removeItem("tmtp.csrf.v1");
    else sessionStorage.setItem("tmtp.csrf.v1", value);
  } catch {
    // Memory-only storage remains available when sessionStorage is blocked.
  }
}

async function responseError(response: Response): Promise<ApiError> {
  let envelope: ErrorEnvelope | undefined;
  try {
    const body: unknown = await response.json();
    if (isEnvelope(body)) envelope = body;
  } catch {
    // A fixed fallback avoids surfacing upstream response text.
  }
  if (response.status === 401 || (response.status === 403 && envelope?.error.code === "csrf-invalid")) {
    notifyAuthRequired();
  }
  return new ApiError({
    code: envelope?.error.code ?? "http-failure",
    message: envelope?.error.message ?? `The request failed with status ${response.status}.`,
    status: response.status,
    retryable: envelope?.error.retryable ?? response.status >= 500,
    ...(envelope?.error.requestId === undefined ? {} : { requestId: envelope.error.requestId }),
    ...(envelope?.error.details === undefined ? {} : { details: envelope.error.details }),
  });
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const needsCsrf = options.csrf ?? method !== "GET";
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (needsCsrf) {
    const csrf = getCsrf();
    if (csrf === undefined) {
      notifyAuthRequired();
      throw new ApiError({ code: "csrf-required", message: "Log in again to restore this tab’s security key.", status: 0, retryable: false });
    }
    headers.set("x-tmtp-csrf", csrf);
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.keepalive === undefined ? {} : { keepalive: options.keepalive }),
    });
  } catch (error) {
    if (options.signal?.aborted === true) throw error;
    throw new ApiError({ code: "network-unavailable", message: "The reader service could not be reached. Check the service and try again.", status: 0, retryable: true });
  }
  const successful = response.ok || options.successStatuses?.includes(response.status) === true;
  if (!successful) throw await responseError(response);
  if (response.status === 204) return undefined as T;
  try {
    return await response.json() as T;
  } catch {
    throw new ApiError({ code: "invalid-response", message: "The service returned an unreadable response.", status: response.status, retryable: false });
  }
}

function queryString(values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const result = query.toString();
  return result === "" ? "" : `?${result}`;
}

export const api = {
  session: (signal?: AbortSignal) => request<{ authenticated: false } | { authenticated: true; expiresAt: string; csrfState: "stored" }>(`${API_BASE}/auth/session`, { signal }),
  login: (accessToken: string) => request<{ expiresAt: string; csrfSecret: string }>(`${API_BASE}/auth/login`, { method: "POST", body: { accessToken }, csrf: false }),
  logout: () => request<void>(`${API_BASE}/auth/logout`, { method: "POST" }),
  queue: (query: { state?: QueueState; evaluationState?: string; visibilityState?: string; cursor?: string; limit?: number }, signal?: AbortSignal) =>
    request<QueueDto>(`${API_BASE}/queue${queryString({ ...query, evaluationState: query.evaluationState || undefined, visibilityState: query.visibilityState || undefined })}`, { signal }),
  story: (storyId: number, signal?: AbortSignal) => request<StoryDetailDto>(`${API_BASE}/stories/${storyId}`, { signal }),
  setQueueState: (storyId: number, state: QueueState) => request<QueueEntryDto>(`${API_BASE}/queue/${storyId}`, { method: "PATCH", body: { state } }),
  refreshArticle: (storyId: number) => request<JobDto>(`${API_BASE}/stories/${storyId}/article-refresh`, { method: "POST" }),
  recordActivity: (batch: RawActivity[], keepalive = false) => request<{ accepted: number; profileWorkEnqueued: boolean }>(`${API_BASE}/activity/batches`, { method: "POST", body: { batch }, keepalive }),
  preferences: (signal?: AbortSignal) => request<PreferenceRuleDto[]>(`${API_BASE}/preferences`, { signal }),
  replacePreferences: (rules: PreferenceRuleDto[]) => request<InterestProfileDto>(`${API_BASE}/preferences`, { method: "PUT", body: { rules } }),
  rebuild: (reason: string) => request<InterestProfileDto>(`${API_BASE}/personalization/rebuild`, { method: "POST", body: { reason } }),
  hnCapabilities: (signal?: AbortSignal) => request<AccountCapabilityDto[]>(`${API_BASE}/hn/capabilities`, { signal }),
  hnHistory: (storyId: number, afterId?: string, signal?: AbortSignal) =>
    request<HnActionHistoryDto[]>(`${API_BASE}/stories/${storyId}/hn-actions${queryString({ afterId })}`, { signal }),
  performHnAction: (storyId: number, action: HnActionKind, idempotencyKey: string) =>
    request<HnActionResultDto>(`${API_BASE}/hn/actions`, { method: "POST", body: { storyId, action, idempotencyKey } }),
  reconcileHn: () => request<JobDto>(`${API_BASE}/hn/reconcile`, { method: "POST" }),
  readiness: (signal?: AbortSignal) => request<ReadinessSnapshot>("/health/ready", { signal, successStatuses: [503] }),
  capabilities: (signal?: AbortSignal) => request<CapabilitiesSnapshot>("/health/capabilities", { signal }),
  debugState: (signal?: AbortSignal) => request<DebugSnapshot>(`${API_BASE}/debug/state`, { csrf: true, signal }),
};

export async function streamDebug(options: { signal: AbortSignal; onFrame: (frame: import("./types.js").DebugStreamFrame) => void }): Promise<void> {
  const csrf = getCsrf();
  if (csrf === undefined) throw new ApiError({ code: "csrf-required", message: "Log in again to open diagnostics.", status: 0, retryable: false });
  const response = await fetch(`${API_BASE}/debug/stream`, {
    credentials: "same-origin",
    headers: { Accept: "text/event-stream", "x-tmtp-csrf": csrf, "Cache-Control": "no-cache" },
    signal: options.signal,
  });
  if (!response.ok) throw await responseError(response);
  if (response.body === null) throw new ApiError({ code: "invalid-response", message: "The diagnostics stream is unavailable.", status: response.status, retryable: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let data: string[] = [];

  const dispatch = (): void => {
    if (eventName === "debug-snapshot" && data.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.join("\n"));
      } catch {
        throw new ApiError({ code: "invalid-response", message: "The diagnostics stream contained an invalid frame.", status: 200, retryable: true });
      }
      if (typeof parsed === "object" && parsed !== null && "sequence" in parsed && "snapshot" in parsed) {
        options.onFrame(parsed as import("./types.js").DebugStreamFrame);
      }
    }
    eventName = "message";
    data = [];
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") dispatch();
        else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          let fieldValue = colon < 0 ? "" : line.slice(colon + 1);
          if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
          if (field === "event") eventName = fieldValue;
          else if (field === "data") data.push(fieldValue);
        }
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const line = buffer.replace(/\r$/, "");
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      else if (line.startsWith("event:")) eventName = line.slice(6).trimStart();
    }
    if (data.length > 0) dispatch();
  } finally {
    reader.releaseLock();
  }
}
