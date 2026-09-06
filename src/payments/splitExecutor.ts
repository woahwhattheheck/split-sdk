/**
 * SplitExecutor — orchestrates multi-recipient split payment execution (Issue #591).
 *
 * Runs a subentry capacity pre-flight check via {@link checkSubentryCapacity}
 * for each recipient account before attempting to add new trustlines or data
 * entries, preventing silent `op_low_reserve` failures on the Stellar network.
 *
 * Callers may opt out of the capacity check by passing
 * `{ skipCapacityCheck: true }` in the options, which bypasses the guard
 * entirely without altering any other pre-flight behaviour.
 */

import { checkSubentryCapacity, SubentryCapacityGuardError } from "../account/subentryGuard.js";
import type { SubentryCapacityResult } from "../types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single recipient leg in a split payment. */
export interface SplitRecipient {
  /** Stellar G… address of the recipient. */
  address: string;
  /** Amount to send in stroops. */
  amount: bigint;
  /**
   * Number of new subentry slots this recipient will consume as a result of
   * this operation (e.g., 1 for a new trustline, 1 for a new data entry).
   * Defaults to 1 when not provided.
   */
  requiredSlots?: number;
  /**
   * This recipient's share of the total, as a fraction in `[0, 1]`
   * (`0.25` = 25%).
   *
   * Optional. When no recipient in a split declares a ratio the split is
   * treated as amount-only and the sum check does not apply; when any
   * recipient declares one, every recipient's ratio must together sum to
   * `1.0` within {@link SPLIT_RATIO_TOLERANCE}.
   */
  ratio?: number;
}

/** Options that control splitExecutor behaviour. */
export interface SplitExecutorOptions {
  /**
   * When `true`, the subentry capacity pre-flight check is skipped entirely.
   * Useful when the caller has already verified capacity out-of-band.
   * Defaults to `false`.
   */
  skipCapacityCheck?: boolean;
  /**
   * Horizon API base URL used for account lookups during the capacity check.
   * Defaults to `"https://horizon.stellar.org"`.
   */
  horizonUrl?: string;
}

/** Result of a successful split execution. */
export interface SplitExecutionResult {
  /** Whether the execution was successful (pre-flight and dispatch passed). */
  success: boolean;
  /**
   * Per-recipient capacity check results, keyed by recipient address.
   * Only populated when the capacity check was not skipped.
   */
  capacityChecks: Record<string, SubentryCapacityResult>;
  /** Whether the capacity pre-flight check was skipped. */
  skippedCapacityCheck: boolean;
}

// ---------------------------------------------------------------------------
// Ratio validation
// ---------------------------------------------------------------------------

/**
 * Tolerance applied when checking that recipient ratios sum to `1.0`.
 *
 * Ratios are floating point, so an exact comparison rejects legitimate splits:
 * `0.1 + 0.2 + 0.7` evaluates to `0.9999999999999999`, not `1`.
 */
export const SPLIT_RATIO_TOLERANCE = 1e-9;

/**
 * Thrown when recipient ratios do not sum to `1.0` within
 * {@link SPLIT_RATIO_TOLERANCE}.
 */
export class SplitRatioSumError extends Error {
  constructor(
    /** The sum that was actually computed from the recipients. */
    public readonly actualSum: number,
    /** The tolerance the sum was compared against. */
    public readonly tolerance: number = SPLIT_RATIO_TOLERANCE,
  ) {
    super(
      `Split ratios must sum to 1.0 (tolerance ${tolerance}); got ${actualSum}`,
    );
    this.name = "SplitRatioSumError";
    // Keeps `instanceof` working when the SDK is compiled to an ES5 target.
    Object.setPrototypeOf(this, SplitRatioSumError.prototype);
  }
}

/**
 * Assert that recipient ratios sum to `1.0` within
 * {@link SPLIT_RATIO_TOLERANCE}.
 *
 * A split that declares no ratios at all is amount-only and passes untouched,
 * so existing callers are unaffected. Once any recipient declares a ratio the
 * whole split is validated, and a recipient that omits one contributes `0` —
 * which surfaces as a failed sum rather than being silently ignored.
 *
 * @throws {SplitRatioSumError} When the ratios do not sum to `1.0`.
 */
export function assertSplitRatiosSumToOne(
  recipients: SplitRecipient[],
): void {
  const declaresRatio = recipients.some(
    (recipient) => recipient?.ratio !== undefined,
  );

  if (!declaresRatio) {
    return;
  }

  let sum = 0;
  for (const recipient of recipients) {
    sum += recipient?.ratio ?? 0;
  }

  // Written as a negated `<=` so that a NaN sum fails rather than passing.
  if (!(Math.abs(sum - 1) <= SPLIT_RATIO_TOLERANCE)) {
    throw new SplitRatioSumError(sum);
  }
}

// ---------------------------------------------------------------------------
// splitExecutor
// ---------------------------------------------------------------------------

/**
 * Executes a multi-recipient split payment after running subentry capacity
 * pre-flight checks for each recipient.
 *
 * @param recipients - Array of recipient addresses, amounts, and required slots.
 * @param options    - Execution options including the opt-out skip flag and Horizon URL.
 *
 * @returns {@link SplitExecutionResult} with capacity check outcomes.
 *
 * @throws {SplitRatioSumError} When recipients declare ratios that do not sum
 *   to `1.0` within {@link SPLIT_RATIO_TOLERANCE}. Checked before any other
 *   pre-flight work.
 * @throws {SubentryCapacityGuardError} When any recipient's account cannot
 *   accommodate the required subentry slots and `skipCapacityCheck` is not set.
 *
 * @example
 * ```ts
 * // Normal execution — capacity guard runs for each recipient
 * const result = await splitExecutor(
 *   [
 *     { address: "GABC...", amount: 5_000_000n, requiredSlots: 1 },
 *     { address: "GDEF...", amount: 5_000_000n, requiredSlots: 1 },
 *   ],
 *   { horizonUrl: "https://horizon-testnet.stellar.org" },
 * );
 *
 * // Opt-out — skip capacity guard entirely
 * const result = await splitExecutor(recipients, { skipCapacityCheck: true });
 * ```
 */
export async function splitExecutor(
  recipients: SplitRecipient[],
  options: SplitExecutorOptions = {},
): Promise<SplitExecutionResult> {
  const {
    skipCapacityCheck = false,
    horizonUrl = "https://horizon.stellar.org",
  } = options;

  // Validate the split itself before any network work or transaction building:
  // an over- or under-allocated split must never reach the capacity checks.
  assertSplitRatiosSumToOne(recipients);

  const capacityChecks: Record<string, SubentryCapacityResult> = {};

  if (!skipCapacityCheck) {
    // Run capacity checks for all recipients sequentially so that the first
    // failing account surfaces a clear error with the account ID and the
    // amount of additional XLM required.
    for (const recipient of recipients) {
      const requiredSlots = recipient.requiredSlots ?? 1;
      // checkSubentryCapacity throws SubentryCapacityGuardError on failure,
      // which names the specific account ID and the reserve shortfall.
      const result = await checkSubentryCapacity(
        recipient.address,
        requiredSlots,
        horizonUrl,
      );
      capacityChecks[recipient.address] = result;
    }
  }

  return {
    success: true,
    capacityChecks,
    skippedCapacityCheck: skipCapacityCheck,
  };
}

// Re-export the error class so callers can catch it without a separate import.
export { SubentryCapacityGuardError };
