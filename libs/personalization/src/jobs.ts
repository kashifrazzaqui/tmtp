import type { JobEnqueue, JobPayloadCodec } from "@tmtp/job-queue";
import { PersonalizationError } from "./errors.js";
import { exactKeys, plainObject, validIsoDateTime, validOpaqueId, validReason } from "./validation.js";
import type { PersonalizationJobDescription, PersonalizationJobKind } from "./types.js";

export const PERSONALIZATION_JOB_PAYLOAD_SCHEMA_VERSION = 1 as const;
const KINDS: readonly PersonalizationJobKind[] = ["personalization.profile-rebuild", "personalization.score-pending", "personalization.queue-project", "personalization.recover"];
function invalidPayload(): never { throw new TypeError("Invalid personalization job payload."); }
function decodePayload(kind: PersonalizationJobKind, payload: unknown, sourceVersion: unknown): unknown {
  if (sourceVersion !== PERSONALIZATION_JOB_PAYLOAD_SCHEMA_VERSION || !plainObject(payload)) invalidPayload();
  if (kind === "personalization.profile-rebuild") {
    if (!exactKeys(payload, ["reason", "rulesVersion", "activityVersion"]) || !validReason(payload.reason) ||
      !validOpaqueId(payload.rulesVersion) || !validOpaqueId(payload.activityVersion)) invalidPayload();
    return { reason: payload.reason, rulesVersion: payload.rulesVersion, activityVersion: payload.activityVersion };
  }
  if (kind === "personalization.score-pending" || kind === "personalization.queue-project") {
    if (!exactKeys(payload, ["profileId"]) || !validOpaqueId(payload.profileId)) invalidPayload();
    return { profileId: payload.profileId };
  }
  if (!exactKeys(payload, [])) invalidPayload();
  return {};
}
export const personalizationJobCodecs: readonly JobPayloadCodec[] = KINDS.map((kind) => ({
  kind, currentVersion: PERSONALIZATION_JOB_PAYLOAD_SCHEMA_VERSION,
  decode: (payload: unknown, sourceVersion: number): unknown => decodePayload(kind, payload, sourceVersion),
}));

function validDescription(description: PersonalizationJobDescription): boolean {
  if (!plainObject(description) || !exactKeys(description, ["kind", "payload", "runAfter"]) ||
    !KINDS.includes(description.kind) || !validIsoDateTime(description.runAfter)) return false;
  try { decodePayload(description.kind, description.payload, PERSONALIZATION_JOB_PAYLOAD_SCHEMA_VERSION); return true; }
  catch { return false; }
}
export function createPersonalizationJobEnqueue(description: PersonalizationJobDescription): JobEnqueue {
  if (!validDescription(description)) throw new PersonalizationError("invalid-input", { field: "description" });
  const { kind, runAfter } = description;
  const payload = decodePayload(kind, description.payload, PERSONALIZATION_JOB_PAYLOAD_SCHEMA_VERSION) as Record<string, unknown>;
  let tuple: unknown[];
  if (kind === "personalization.profile-rebuild") tuple = [kind, payload.rulesVersion, payload.activityVersion];
  else if (kind === "personalization.score-pending" || kind === "personalization.queue-project") tuple = [kind, payload.profileId];
  else tuple = [kind];
  return { kind, payload, payloadSchemaVersion: PERSONALIZATION_JOB_PAYLOAD_SCHEMA_VERSION, dedupeKey: JSON.stringify(tuple), runAfter };
}

export function decodeRunJobPayload(kind: PersonalizationJobKind, payload: unknown, version: unknown, jobId: string): unknown {
  try { return decodePayload(kind, payload, version); }
  catch { throw new PersonalizationError("invalid-job", { jobId }); }
}
export function isPersonalizationJobKind(value: unknown): value is PersonalizationJobKind {
  return typeof value === "string" && KINDS.includes(value as PersonalizationJobKind);
}
