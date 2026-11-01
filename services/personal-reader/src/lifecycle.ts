export async function settleWithinGrace(
  settlement: Promise<unknown>,
  graceMs: number,
  sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>,
): Promise<boolean> {
  let settled = false;
  const observedSettlement = settlement.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  const graceController = new AbortController();
  try {
    await Promise.race([
      observedSettlement,
      graceMs > 0 ? sleep(graceMs, graceController.signal) : Promise.resolve(),
    ]);
    return settled;
  } finally {
    graceController.abort();
  }
}

export async function yieldToCooperativeCancellation(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
