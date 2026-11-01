import type { Clock, Sleep } from "@tmtp/clock";
import type { HnActionIntent, IsoDateTime } from "@tmtp/domain";
import type { HttpClient } from "@tmtp/http-client";
import type { HnAccountErrorCode } from "./errors.js";
export type AccountCapabilityName = "upvoted" | "favorites" | "flagged" | "mutations";
export type AccountCapabilityState = "available" | "unavailable" | "unverified";
export interface AccountCapability { name: AccountCapabilityName; state: AccountCapabilityState; reason?: HnAccountErrorCode; }
export interface AccountObservation { storyId: number; kind: "upvote" | "flag" | "favorite"; present: boolean; observedAt: IsoDateTime; }
export interface AccountObservationPage { observations: AccountObservation[]; nextCursor?: string; }
export interface HnActionResult { intentId: string; status: "verified" | "indeterminate" | "failed"; observedAt: IsoDateTime; errorCode?: HnAccountErrorCode; }
export interface HnAccountOptions {
  baseUrl: string;
  http: HttpClient;
  clock: Clock;
  sleep: Sleep;
  username: string;
  sessionCookie: string;
  maxRequestsPerMinute: number;
  flagReadbackEnabled?: boolean;
}
export interface HnAccount {
  capabilities(signal?: AbortSignal): Promise<AccountCapability[]>;
  validateSession(signal?: AbortSignal): Promise<{ username: string }>;
  readUpvoted(cursor?: string, signal?: AbortSignal): Promise<AccountObservationPage>;
  readFavorites(cursor?: string, signal?: AbortSignal): Promise<AccountObservationPage>;
  readFlagged(cursor?: string, signal?: AbortSignal): Promise<AccountObservationPage>;
  performAction(intent: HnActionIntent, signal?: AbortSignal): Promise<HnActionResult>;
}
