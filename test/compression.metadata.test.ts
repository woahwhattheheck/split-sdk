/**
 * Tests for invoice metadata encoding (Issue #619).
 * Pure functions — no network, no filesystem.
 */

import { describe, it, expect } from "vitest";

import {
  DEFAULT_METADATA_MAX_BYTES,
  compressMetadata,
  decompressMetadata,
} from "../src/compression.js";
import { SdkError, SdkErrorCode } from "../src/errors.js";

const expectRejected = (fn: () => unknown) => {
  try {
    fn();
    throw new Error("expected the call to throw an SdkError");
  } catch (error) {
    expect(error).toBeInstanceOf(SdkError);
    expect((error as SdkError).code).toBe(SdkErrorCode.CONTRACT_REJECTED);
    return error as SdkError;
  }
};

describe("DEFAULT_METADATA_MAX_BYTES", () => {
  it("is 512", () => {
    expect(DEFAULT_METADATA_MAX_BYTES).toBe(512);
  });
});

describe("compressMetadata", () => {
  it("encodes without base64 padding", () => {
    // "{}" is 2 bytes, which is the case standard base64 would pad.
    const encoded = compressMetadata({});

    expect(encoded).not.toContain("=");
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("uses the base64url alphabet, never + or /", () => {
    // Bytes that encode to '+' and '/' under standard base64.
    const encoded = compressMetadata({ v: "ÿÿÿ????>>>" });

    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
  });

  it("rejects a payload over the default limit", () => {
    const error = expectRejected(() =>
      compressMetadata({ blob: "x".repeat(1000) }),
    );

    expect(error.message).toContain(String(DEFAULT_METADATA_MAX_BYTES));
  });

  it("honours a custom maxBytes", () => {
    expect(() => compressMetadata({ a: 1 }, 4)).toThrow(SdkError);
    expect(() => compressMetadata({ a: 1 }, 64)).not.toThrow();
  });

  it("reports the actual size alongside the limit", () => {
    const error = expectRejected(() => compressMetadata({ a: 1 }, 4));
    const details = error.details as { bytes: number; maxBytes: number };

    expect(details.maxBytes).toBe(4);
    expect(details.bytes).toBeGreaterThan(4);
  });

  it.each([
    ["null", null],
    ["an array", [1, 2, 3]],
    ["a string", "not an object"],
    ["a number", 42],
  ])("rejects %s", (_label, value) => {
    expectRejected(() => compressMetadata(value as never));
  });

  it("rejects a circular structure rather than throwing a raw TypeError", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expectRejected(() => compressMetadata(circular));
  });

  it("rejects a BigInt value, which JSON cannot serialise", () => {
    expectRejected(() => compressMetadata({ amount: 1n as unknown }));
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects the invalid maxBytes %s",
    (maxBytes) => {
      expectRejected(() => compressMetadata({ a: 1 }, maxBytes));
    },
  );
});

describe("decompressMetadata", () => {
  it("rejects a string outside the base64url alphabet", () => {
    expectRejected(() => decompressMetadata("not base64!"));
    expectRejected(() => decompressMetadata("has+plus/slash"));
  });

  it("rejects base64url that does not contain JSON", () => {
    // "Hello" — valid base64url, not JSON.
    expectRejected(() => decompressMetadata("SGVsbG8"));
  });

  it("rejects a non-string input", () => {
    expectRejected(() => decompressMetadata(undefined as never));
    expectRejected(() => decompressMetadata(123 as never));
  });

  it.each([
    ["an array", "[1,2,3]"],
    ["a number", "42"],
    ["a string", '"hello"'],
    ["null", "null"],
  ])("rejects encoded JSON that decodes to %s", (_label, json) => {
    const encoded = Buffer.from(json, "utf8").toString("base64url");

    expectRejected(() => decompressMetadata(encoded));
  });

  it("accepts padded input even though it never emits padding", () => {
    // A caller may have padded the value elsewhere; decoding should still work.
    const padded = Buffer.from(JSON.stringify({ p: 1 }), "utf8").toString("base64");

    expect(decompressMetadata(padded)).toEqual({ p: 1 });
  });
});

describe("browser safety", () => {
  it("encodes and decodes with no Node Buffer global present", () => {
    // compression.ts is isomorphic - it feature-detects CompressionStream and
    // falls back to node:zlib - so these helpers must not need a Node global.
    // A browser bundle without a Buffer polyfill is exactly this shape.
    const originalBuffer = globalThis.Buffer;

    try {
      // @ts-expect-error deliberately simulating an environment with no Buffer
      delete globalThis.Buffer;

      const value = { id: "evt_1", note: "héllo ✓ 日本語" };
      const encoded = compressMetadata(value);

      expect(encoded).not.toContain("=");
      expect(decompressMetadata(encoded)).toEqual(value);
    } finally {
      globalThis.Buffer = originalBuffer;
    }
  });
});

describe("round trip", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["an empty object", {}],
    ["a flat object", { invoiceId: "inv_1", amount: 1000 }],
    ["nested objects and arrays", { a: { b: { c: [1, 2, { d: true }] } } }],
    ["null and boolean values", { n: null, t: true, f: false }],
    ["unicode", { note: "héllo ✓ 日本語" }],
    ["keys needing escaping", { 'quote"key': 'value with "quotes"' }],
  ];

  it.each(cases)("round-trips %s", (_label, value) => {
    expect(decompressMetadata(compressMetadata(value))).toEqual(value);
  });

  it("survives a second round trip unchanged", () => {
    const value = { invoiceId: "inv_2", tags: ["a", "b"] };
    const once = compressMetadata(value);

    expect(compressMetadata(decompressMetadata(once))).toBe(once);
  });
});
