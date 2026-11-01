export interface AdapterOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
}

function typeError(name: string): never {
  throw new TypeError(`Invalid type for llm.${name}.`);
}
function rangeError(name: string): never {
  throw new RangeError(`Invalid value for llm.${name}.`);
}

export function snapshotOptions(value: AdapterOptions): AdapterOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) typeError("options");
  const { baseUrl, apiKey, timeoutMs, maxRetries, maxOutputTokens } = value;
  if (typeof baseUrl !== "string") typeError("baseUrl");
  if (typeof apiKey !== "string") typeError("apiKey");
  if (typeof timeoutMs !== "number") typeError("timeoutMs");
  if (typeof maxRetries !== "number") typeError("maxRetries");
  if (typeof maxOutputTokens !== "number") typeError("maxOutputTokens");

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    rangeError("baseUrl");
  }
  if (
    baseUrl.trim() !== baseUrl ||
    baseUrl.includes("?") || baseUrl.includes("#") ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== ""
  ) rangeError("baseUrl");
  if (apiKey.trim() === "") rangeError("apiKey");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) rangeError("timeoutMs");
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) rangeError("maxRetries");
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) rangeError("maxOutputTokens");
  return { baseUrl, apiKey, timeoutMs, maxRetries, maxOutputTokens };
}
