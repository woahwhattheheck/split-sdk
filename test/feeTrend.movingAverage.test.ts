/**
 * Tests for computeMovingAverage (Issue #781).
 * Pure function — no network, no Horizon server is constructed.
 */

import { describe, it, expect } from "vitest";

import { computeMovingAverage } from "../src/fees/trend.js";

describe("computeMovingAverage", () => {
  it("computes a simple moving average with NaN padding at the front", () => {
    const result = computeMovingAverage([1, 2, 3, 4], 2);

    expect(result).toHaveLength(4);
    expect(result[0]).toBeNaN();
    expect(result.slice(1)).toEqual([1.5, 2.5, 3.5]);
  });

  it("pads exactly windowSize - 1 entries", () => {
    const result = computeMovingAverage([10, 20, 30, 40, 50], 3);

    expect(result[0]).toBeNaN();
    expect(result[1]).toBeNaN();
    expect(result.slice(2)).toEqual([20, 30, 40]);
  });

  it("returns the input values unchanged for a window of 1", () => {
    expect(computeMovingAverage([1, 2, 3, 4], 1)).toEqual([1, 2, 3, 4]);
  });

  it("returns the same length as the input", () => {
    for (const size of [1, 2, 3, 5]) {
      expect(computeMovingAverage([1, 2, 3, 4, 5], size)).toHaveLength(5);
    }
  });

  it("returns all NaN when the window is larger than the series", () => {
    const result = computeMovingAverage([1, 2, 3], 5);

    expect(result).toHaveLength(3);
    expect(result.every((value) => Number.isNaN(value))).toBe(true);
  });

  it("returns an empty series for an empty input", () => {
    expect(computeMovingAverage([], 3)).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const samples = [1, 2, 3, 4];
    const copy = [...samples];

    computeMovingAverage(samples, 2);

    expect(samples).toEqual(copy);
  });

  it("averages realistic stroop fee samples", () => {
    // 100, 100, 200, 200 with a 2-wide window.
    const result = computeMovingAverage([100, 100, 200, 200], 2);

    expect(result[1]).toBe(100);
    expect(result[2]).toBe(150);
    expect(result[3]).toBe(200);
  });

  it("propagates a NaN sample only through the windows containing it", () => {
    const result = computeMovingAverage([1, Number.NaN, 3, 4], 2);

    expect(result[1]).toBeNaN();
    expect(result[2]).toBeNaN();
    expect(result[3]).toBe(3.5);
  });

  it.each([0, -1, -10])("throws RangeError for windowSize %s", (windowSize) => {
    expect(() => computeMovingAverage([1, 2, 3], windowSize)).toThrow(RangeError);
  });

  it.each([2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "throws RangeError for non-integer windowSize %s",
    (windowSize) => {
      expect(() => computeMovingAverage([1, 2, 3], windowSize)).toThrow(RangeError);
    }
  );

  it("names the offending windowSize in the error", () => {
    expect(() => computeMovingAverage([1, 2, 3], 0)).toThrow(/got 0/);
  });
});
