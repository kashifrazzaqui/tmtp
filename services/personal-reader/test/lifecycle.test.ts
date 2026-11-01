import { describe, expect, it } from "vitest";
import { settleWithinGrace } from "../src/lifecycle.js";

describe("graceful lifecycle bound", () => {
  it("should recognize already settled borrowers at a zero grace boundary", async () => {
    await expect(settleWithinGrace(Promise.allSettled([]), 0, async () => undefined)).resolves.toBe(true);
  });

  it("should reject a non-cooperative borrower at the grace boundary", async () => {
    await expect(settleWithinGrace(new Promise(() => undefined), 0, async () => undefined)).resolves.toBe(false);
  });
});
