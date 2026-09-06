import { describe, it, expect } from "vitest";
import { WaterfallRouter } from "../src/routing/WaterfallRouter.js";
import { createMockInvoice } from "../src/testing/factories.js";
import type { WaterfallConfig } from "../src/types/routing.js";

const PLATFORM = "GPLATFORM00000000000000000000000000000000000000000000000";
const TAX = "GTAX000000000000000000000000000000000000000000000000000";
const BENEFICIARY = "GBENEFICIARY0000000000000000000000000000000000000000000";

describe("WaterfallRouter", () => {
  const router = new WaterfallRouter();
  const invoice = createMockInvoice({ token: "NATIVE_TOKEN" });

  function threeTierConfig(overrides?: Partial<WaterfallConfig>): WaterfallConfig {
    return {
      tiers: [
        { recipient: PLATFORM, minimumAmount: 100n },
        { recipient: TAX, minimumAmount: 200n },
        { recipient: BENEFICIARY, minimumAmount: 700n },
      ],
      ...overrides,
    };
  }

  it("returns steps in declared priority order with correct amounts when fully funded", () => {
    const result = router.plan(invoice, 1000n, threeTierConfig());

    expect(result.steps.map((s) => s.recipient)).toEqual([PLATFORM, TAX, BENEFICIARY]);
    expect(result.steps.map((s) => s.amount)).toEqual([100n, 200n, 700n]);
    expect(result.steps.every((s) => s.satisfied)).toBe(true);
    expect(result.fullySatisfied).toBe(true);
    expect(result.totalAllocated).toBe(1000n);
    expect(result.remaining).toBe(0n);
  });

  it("marks tiers N+1 and beyond unsatisfied with zero amount on partial funding", () => {
    // Covers only the first tier (100) plus part of the second (needs 200, only 50 left).
    const result = router.plan(invoice, 150n, threeTierConfig());

    expect(result.steps[0]).toMatchObject({ recipient: PLATFORM, amount: 100n, satisfied: true });
    expect(result.steps[1]).toMatchObject({ recipient: TAX, amount: 0n, satisfied: false });
    expect(result.steps[2]).toMatchObject({ recipient: BENEFICIARY, amount: 0n, satisfied: false });
    expect(result.fullySatisfied).toBe(false);
    expect(result.totalAllocated).toBe(100n);
    expect(result.remaining).toBe(50n);
  });

  it("handles a single-tier waterfall", () => {
    const result = router.plan(invoice, 500n, { tiers: [{ recipient: PLATFORM, minimumAmount: 300n }] });
    expect(result.steps).toEqual([
      { recipient: PLATFORM, amount: 300n, asset: invoice.token, minimumAmount: 300n, satisfied: true },
    ]);
    expect(result.remaining).toBe(200n);
  });

  it("treats a zero-amount tier as trivially satisfied regardless of remaining funds", () => {
    const result = router.plan(invoice, 0n, {
      tiers: [
        { recipient: PLATFORM, minimumAmount: 0n },
        { recipient: TAX, minimumAmount: 50n },
      ],
    });
    expect(result.steps[0]).toMatchObject({ amount: 0n, satisfied: true });
    expect(result.steps[1]).toMatchObject({ amount: 0n, satisfied: false });
  });

  it("supports mixed-asset tiers, defaulting to the invoice token when a tier omits asset", () => {
    const usdc = "CUSDCCONTRACTADDRESSEXAMPLE00000000000000000000000000000";
    const result = router.plan(invoice, 1000n, {
      tiers: [
        { recipient: PLATFORM, minimumAmount: 100n, asset: usdc },
        { recipient: TAX, minimumAmount: 200n }, // defaults to invoice.token
      ],
    });
    expect(result.steps[0].asset).toBe(usdc);
    expect(result.steps[1].asset).toBe(invoice.token);
  });

  it("halts downstream steps entirely once a tier is unsatisfied, even if a later tier's minimum is smaller", () => {
    const result = router.plan(invoice, 100n, {
      tiers: [
        { recipient: PLATFORM, minimumAmount: 100n },
        { recipient: TAX, minimumAmount: 500n }, // unsatisfied — blocks below
        { recipient: BENEFICIARY, minimumAmount: 1n }, // would fit, but must stay blocked
      ],
    });
    expect(result.steps[1].satisfied).toBe(false);
    expect(result.steps[2]).toMatchObject({ amount: 0n, satisfied: false });
  });

  it("rejects a negative availableAmount", () => {
    expect(() => router.plan(invoice, -1n, threeTierConfig())).toThrow();
  });

  describe("score ordering", () => {
    it("keeps declaration order when no tier declares a score", () => {
      const result = router.plan(invoice, 1000n, threeTierConfig());

      expect(result.steps.map((s) => s.recipient)).toEqual([PLATFORM, TAX, BENEFICIARY]);
    });

    it("funds the highest-scored tier first", () => {
      const result = router.plan(invoice, 1000n, {
        tiers: [
          { recipient: PLATFORM, minimumAmount: 100n, score: 1 },
          { recipient: TAX, minimumAmount: 200n, score: 5 },
          { recipient: BENEFICIARY, minimumAmount: 700n, score: 3 },
        ],
      });

      expect(result.steps.map((s) => s.recipient)).toEqual([TAX, BENEFICIARY, PLATFORM]);
      expect(result.steps.map((s) => s.amount)).toEqual([200n, 700n, 100n]);
      expect(result.fullySatisfied).toBe(true);
    });

    it("treats a tier with no score as 0, so a positive score outranks it", () => {
      const result = router.plan(invoice, 1000n, {
        tiers: [
          { recipient: PLATFORM, minimumAmount: 100n },
          { recipient: TAX, minimumAmount: 200n, score: 2 },
        ],
      });

      expect(result.steps.map((s) => s.recipient)).toEqual([TAX, PLATFORM]);
    });

    it("sorts a negative score below an unscored tier", () => {
      const result = router.plan(invoice, 1000n, {
        tiers: [
          { recipient: PLATFORM, minimumAmount: 100n, score: -1 },
          { recipient: TAX, minimumAmount: 200n },
        ],
      });

      expect(result.steps.map((s) => s.recipient)).toEqual([TAX, PLATFORM]);
    });

    it("preserves declaration order among equal scores", () => {
      const recipients = Array.from({ length: 8 }, (_unused, i) => `GTIER${i}`);
      const result = router.plan(invoice, 1000n, {
        tiers: recipients.map((recipient) => ({
          recipient,
          minimumAmount: 0n,
          score: 1,
        })),
      });

      expect(result.steps.map((s) => s.recipient)).toEqual(recipients);
    });

    it("preserves declaration order within each score group", () => {
      const result = router.plan(invoice, 1000n, {
        tiers: [
          { recipient: "A", minimumAmount: 0n, score: 1 },
          { recipient: "B", minimumAmount: 0n, score: 2 },
          { recipient: "C", minimumAmount: 0n, score: 1 },
          { recipient: "D", minimumAmount: 0n, score: 2 },
        ],
      });

      // Score 2 group in order (B, D), then score 1 group in order (A, C).
      expect(result.steps.map((s) => s.recipient)).toEqual(["B", "D", "A", "C"]);
    });

    it("lets a high score win the funds when there is not enough for every tier", () => {
      const result = router.plan(invoice, 200n, {
        tiers: [
          { recipient: PLATFORM, minimumAmount: 200n, score: 0 },
          { recipient: TAX, minimumAmount: 200n, score: 9 },
        ],
      });

      expect(result.steps[0]).toMatchObject({ recipient: TAX, amount: 200n, satisfied: true });
      expect(result.steps[1]).toMatchObject({ recipient: PLATFORM, amount: 0n, satisfied: false });
    });

    it("does not mutate the caller's tier array", () => {
      const tiers = [
        { recipient: PLATFORM, minimumAmount: 100n, score: 1 },
        { recipient: TAX, minimumAmount: 200n, score: 5 },
      ];
      const original = [...tiers];

      router.plan(invoice, 1000n, { tiers });

      expect(tiers).toEqual(original);
      expect(tiers[0]!.recipient).toBe(PLATFORM);
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
      "rejects a non-finite score (%s)",
      (score) => {
        expect(() =>
          router.plan(invoice, 1000n, {
            tiers: [{ recipient: PLATFORM, minimumAmount: 100n, score }],
          }),
        ).toThrow();
      },
    );
  });
});
