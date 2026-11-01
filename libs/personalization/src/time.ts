import type { Clock } from "@tmtp/clock";
import type { IsoDateTime } from "@tmtp/domain";

export function wallNow(clock: Clock): IsoDateTime {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("Invalid personalization clock result.");
  return value.toISOString();
}

export function notBefore(at: IsoDateTime, existing: readonly string[]): IsoDateTime {
  let maximum = Date.parse(at);
  for (const timestamp of existing) maximum = Math.max(maximum, Date.parse(timestamp));
  return new Date(maximum).toISOString();
}

export function profileTimestamp(at: IsoDateTime, previousCreatedAt: string | undefined): IsoDateTime {
  if (previousCreatedAt === undefined) return at;
  return new Date(Math.max(Date.parse(at), Date.parse(previousCreatedAt) + 1)).toISOString();
}
