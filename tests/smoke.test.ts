import { describe, expect, it } from "vitest";

/**
 * Smoke test — proves the Vitest + TypeScript harness is wired correctly.
 * No Stigmergy code under test yet; real suites land alongside each
 * primitive's implementation in the following sub-steps.
 */
describe("test harness", () => {
  it("runs TypeScript through Vitest", () => {
    const two: number = 1 + 1;
    expect(two).toBe(2);
  });
});
