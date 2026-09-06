/**
 * Tests for split ratio validation in splitExecutor (Issue #778).
 * Network-free: the validator is pure, and splitExecutor is exercised with
 * `skipCapacityCheck: true` so no Horizon call is made.
 */

import { describe, it, expect } from "vitest";

import {
  assertSplitRatiosSumToOne,
  splitExecutor,
  SplitRatioSumError,
  SPLIT_RATIO_TOLERANCE,
  type SplitRecipient,
} from "../src/payments/splitExecutor.js";

const A = "GABC00000000000000000000000000000000000000000000000000AA";
const B = "GDEF00000000000000000000000000000000000000000000000000BB";
const C = "GHIJ00000000000000000000000000000000000000000000000000CC";

const r = (address: string, ratio?: number): SplitRecipient => ({
  address,
  amount: 1_000_000n,
  ...(ratio === undefined ? {} : { ratio }),
});

describe("SPLIT_RATIO_TOLERANCE", () => {
  it("is 1e-9", () => {
    expect(SPLIT_RATIO_TOLERANCE).toBe(1e-9);
  });
});

describe("assertSplitRatiosSumToOne", () => {
  it("passes an amount-only split that declares no ratios", () => {
    expect(() => assertSplitRatiosSumToOne([r(A), r(B)])).not.toThrow();
  });

  it("passes an empty recipient list", () => {
    expect(() => assertSplitRatiosSumToOne([])).not.toThrow();
  });

  it("passes ratios that sum to exactly 1", () => {
    expect(() =>
      assertSplitRatiosSumToOne([r(A, 0.5), r(B, 0.25), r(C, 0.25)])
    ).not.toThrow();
  });

  it("passes ratios that sum to 1 only within floating-point tolerance", () => {
    // 0.1 + 0.2 + 0.7 === 0.9999999999999999, not 1
    expect(0.1 + 0.2 + 0.7).not.toBe(1);
    expect(() =>
      assertSplitRatiosSumToOne([r(A, 0.1), r(B, 0.2), r(C, 0.7)])
    ).not.toThrow();
  });

  it("throws when the ratios under-allocate", () => {
    expect(() => assertSplitRatiosSumToOne([r(A, 0.5), r(B, 0.4)])).toThrow(
      SplitRatioSumError
    );
  });

  it("throws when the ratios over-allocate", () => {
    expect(() => assertSplitRatiosSumToOne([r(A, 0.6), r(B, 0.5)])).toThrow(
      SplitRatioSumError
    );
  });

  it("reports the actual sum on the error", () => {
    try {
      assertSplitRatiosSumToOne([r(A, 0.5), r(B, 0.4)]);
      throw new Error("expected assertSplitRatiosSumToOne to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SplitRatioSumError);
      const err = error as SplitRatioSumError;
      expect(err.actualSum).toBeCloseTo(0.9, 12);
      expect(err.tolerance).toBe(SPLIT_RATIO_TOLERANCE);
      expect(err.name).toBe("SplitRatioSumError");
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("1.0");
    }
  });

  it("counts a recipient that omits a ratio as 0 once any ratio is declared", () => {
    // B contributes 0, so the split under-allocates rather than silently passing.
    expect(() => assertSplitRatiosSumToOne([r(A, 1), r(B)])).not.toThrow();
    expect(() => assertSplitRatiosSumToOne([r(A, 0.5), r(B)])).toThrow(
      SplitRatioSumError
    );
  });

  it("rejects a NaN ratio rather than letting the comparison pass", () => {
    expect(() => assertSplitRatiosSumToOne([r(A, Number.NaN), r(B, 1)])).toThrow(
      SplitRatioSumError
    );
  });
});

describe("splitExecutor — ratio pre-flight", () => {
  it("rejects a mis-allocated split before any other pre-flight work", async () => {
    await expect(
      splitExecutor([r(A, 0.5), r(B, 0.4)], { skipCapacityCheck: true })
    ).rejects.toBeInstanceOf(SplitRatioSumError);
  });

  it("proceeds when the ratios sum to 1", async () => {
    const result = await splitExecutor([r(A, 0.5), r(B, 0.5)], {
      skipCapacityCheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.skippedCapacityCheck).toBe(true);
  });

  it("leaves amount-only splits unaffected", async () => {
    const result = await splitExecutor([r(A), r(B)], {
      skipCapacityCheck: true,
    });

    expect(result.success).toBe(true);
  });
});
