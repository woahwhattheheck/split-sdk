/**
 * WaterfallRouter — sequences a multi-tier invoice payout (e.g. platform
 * fee, then tax withholding, then beneficiary) so lower-priority recipients
 * are only paid once every upstream tier's minimum has been met.
 */

import type { Invoice } from "../types.js";
import { ValidationError } from "../errors.js";
import type {
  WaterfallConfig,
  WaterfallPlan,
  WaterfallStep,
  WaterfallTier,
} from "../types/routing.js";

/**
 * Order tiers by score, highest first, keeping declaration order among ties.
 *
 * Decorated with the original index and undecorated afterwards rather than
 * relying on the sort being stable: the index tiebreak makes the ordering
 * total, so equal-scored tiers keep FIFO order regardless of the engine or
 * the compile target. The caller's array is never mutated.
 */
function orderTiersByScore(tiers: WaterfallTier[]): WaterfallTier[] {
  return tiers
    .map((tier, index) => ({ tier, index }))
    .sort((a, b) => {
      const byScore = (b.tier.score ?? 0) - (a.tier.score ?? 0);
      return byScore !== 0 ? byScore : a.index - b.index;
    })
    .map((entry) => entry.tier);
}

export class WaterfallRouter {
  /**
   * Build a sequenced payment plan for `invoice` given `availableAmount`
   * (stroops) to distribute across `config.tiers`. Tiers are funded in
   * descending `score` order, and tiers sharing a score keep their
   * declaration order, so a config with no scores behaves exactly as before.
   * As soon as a tier's minimumAmount exceeds what's left of
   * availableAmount, that tier and every tier after it come back with
   * `satisfied: false` and a zero amount.
   */
  plan(invoice: Invoice, availableAmount: bigint, config: WaterfallConfig): WaterfallPlan {
    if (availableAmount < 0n) {
      throw new ValidationError("availableAmount must be >= 0", { availableAmount: availableAmount.toString() });
    }
    for (const tier of config.tiers) {
      if (tier.minimumAmount < 0n) {
        throw new ValidationError("WaterfallTier.minimumAmount must be >= 0", {
          recipient: tier.recipient,
          minimumAmount: tier.minimumAmount.toString(),
        });
      }
      // A NaN score makes the sort comparator return NaN, which silently
      // yields an arbitrary order rather than an error. Reject it here.
      if (tier.score !== undefined && !Number.isFinite(tier.score)) {
        throw new ValidationError("WaterfallTier.score must be a finite number", {
          recipient: tier.recipient,
          score: String(tier.score),
        });
      }
    }

    const orderedTiers = orderTiersByScore(config.tiers);

    let remaining = availableAmount;
    let blocked = false;
    const steps: WaterfallStep[] = [];

    for (const tier of orderedTiers) {
      const asset = tier.asset ?? invoice.token;

      if (blocked || tier.minimumAmount > remaining) {
        blocked = true;
        steps.push({
          recipient: tier.recipient,
          amount: 0n,
          asset,
          minimumAmount: tier.minimumAmount,
          satisfied: false,
        });
        continue;
      }

      remaining -= tier.minimumAmount;
      steps.push({
        recipient: tier.recipient,
        amount: tier.minimumAmount,
        asset,
        minimumAmount: tier.minimumAmount,
        satisfied: true,
      });
    }

    const totalAllocated = steps.reduce((sum, s) => sum + s.amount, 0n);
    return {
      steps,
      fullySatisfied: steps.every((s) => s.satisfied),
      totalAllocated,
      remaining,
      allowPartial: config.allowPartial,
    };
  }
}
