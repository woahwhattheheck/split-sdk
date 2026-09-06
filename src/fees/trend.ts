/**
 * Transaction fee history trend analyzer for StellarSplit.
 *
 * Polls Horizon's `/fee_stats` endpoint on a rolling basis and computes
 * percentile estimates over a sliding window, so callers can request a
 * recommended base fee for a chosen acceptance percentile instead of
 * guessing during network congestion.
 */

import { Horizon } from "@stellar/stellar-sdk";
import { CircularBuffer } from "../utils/circularBuffer.js";
import { percentile } from "../utils/stats.js";
import type { FeeTrendOptions } from "../types.js";

/** Acceptance-percentile targets supported by {@link FeeTrendAnalyzer.recommendedFee}. */
export type FeePercentile = 50 | 75 | 95 | 99;

const MIN_WINDOW_SIZE = 5;
const MAX_WINDOW_SIZE = 100;
const DEFAULT_WINDOW_SIZE = 20;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

const brand: unique symbol = Symbol("WindowCapacity");

/** Branded integer type: a window size validated to `[5, 100]` at construction time. */
export type WindowCapacity = number & { readonly [brand]: true };

/** Validates and brands a raw window size. */
function toWindowCapacity(size: number): WindowCapacity {
  if (!Number.isInteger(size) || size < MIN_WINDOW_SIZE || size > MAX_WINDOW_SIZE) {
    throw new RangeError(
      `windowSize must be an integer between ${MIN_WINDOW_SIZE} and ${MAX_WINDOW_SIZE}, got ${size}`
    );
  }
  return size as WindowCapacity;
}

/** A single fee snapshot captured from Horizon's `/fee_stats` endpoint. */
interface FeeSample {
  /** Representative fee charged (stroops) for the most recently closed ledger. */
  value: number;
  /** Time the sample was captured, used for TTL-based eviction. */
  capturedAt: number;
}

/**
 * Compute a Simple Moving Average series over `samples`.
 *
 * The result has the same length as the input so a caller can plot it
 * directly against the samples without re-aligning indices. The first
 * `windowSize - 1` entries have no full window behind them and are `NaN`
 * rather than a partial average, which would understate early movement and
 * read as real signal.
 *
 * Pure: the input array is never read beyond the current window and is never
 * mutated.
 *
 * @param samples - Fee samples, oldest first.
 * @param windowSize - Number of samples per average. Must be an integer >= 1.
 * @returns SMA series, same length as `samples`, `NaN`-padded at the front.
 * @throws {RangeError} When `windowSize` is not an integer >= 1.
 *
 * @example
 * ```typescript
 * computeMovingAverage([1, 2, 3, 4], 2); // [NaN, 1.5, 2.5, 3.5]
 * ```
 */
export function computeMovingAverage(
  samples: number[],
  windowSize: number,
): number[] {
  if (!Number.isInteger(windowSize) || windowSize < 1) {
    throw new RangeError(
      `windowSize must be an integer >= 1, got ${windowSize}`,
    );
  }

  const result: number[] = new Array(samples.length);

  for (let i = 0; i < samples.length; i++) {
    if (i < windowSize - 1) {
      result[i] = Number.NaN;
      continue;
    }

    // Summed per window rather than by a running total: the window is small
    // and this avoids the drift a subtract-the-outgoing-value accumulator
    // develops over a long series of floats.
    let sum = 0;
    for (let j = i - windowSize + 1; j <= i; j++) {
      sum += samples[j] as number;
    }

    result[i] = sum / windowSize;
  }

  return result;
}

/**
 * Tracks a rolling window of Horizon fee_stats snapshots and recommends a
 * base fee at a caller-specified acceptance percentile.
 *
 * @example
 * ```typescript
 * const analyzer = new FeeTrendAnalyzer({ horizonUrl: "https://horizon.stellar.org" });
 * await analyzer.sample();
 * const fee = analyzer.recommendedFee(95); // stroops
 * ```
 */
export class FeeTrendAnalyzer {
  private readonly server: Horizon.Server;
  private readonly buffer: CircularBuffer<FeeSample>;
  private readonly ttlMs: number;

  constructor(options: FeeTrendOptions) {
    const windowSize = toWindowCapacity(options.windowSize ?? DEFAULT_WINDOW_SIZE);
    this.buffer = new CircularBuffer<FeeSample>(windowSize);
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.server = new Horizon.Server(options.horizonUrl);
  }

  /**
   * Fetches the current fee stats snapshot from Horizon and appends it to
   * the rolling window, evicting the oldest entry once at capacity.
   */
  async sample(): Promise<void> {
    const stats = await this.server.feeStats();
    const value = Number(stats.fee_charged.mode);
    this.buffer.push({ value, capturedAt: Date.now() });
  }

  /**
   * Returns the recommended fee, in stroops, at `percentileTarget` across
   * all samples currently in the window. Samples older than the
   * configured TTL are evicted before the computation runs.
   */
  recommendedFee(percentileTarget: FeePercentile): number {
    this.evictExpired();

    const values = this.buffer.toArray().map((sample) => sample.value);
    if (values.length === 0) {
      throw new RangeError("No fee samples available; call sample() before recommendedFee()");
    }

    return Math.ceil(percentile(values, percentileTarget));
  }

  /** Number of non-expired samples currently held in the window. */
  get sampleCount(): number {
    this.evictExpired();
    return this.buffer.size;
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    this.buffer.evictOldestWhile((sample) => sample.capturedAt < cutoff);
  }
}
