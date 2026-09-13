import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";

import {
  assertWebhookSignature,
  verifyWebhookSignature,
  WebhookVerificationError,
} from "../src/webhooks/verify.js";

const SECRET = "whsec_test_secret";
const PAYLOAD = JSON.stringify({ id: "evt_123", event: "invoice.paid" });

const sign = (payload: string, secret: string): string =>
  createHmac("sha256", secret).update(payload).digest("hex");

describe("verifyWebhookSignature", () => {
  it("returns true for a signature produced with the same secret and payload", () => {
    expect(verifyWebhookSignature(PAYLOAD, sign(PAYLOAD, SECRET), SECRET)).toBe(true);
  });

  it("returns false when the secret differs", () => {
    expect(verifyWebhookSignature(PAYLOAD, sign(PAYLOAD, "wrong_secret"), SECRET)).toBe(false);
  });

  it("returns false when the payload was tampered with", () => {
    expect(verifyWebhookSignature(`${PAYLOAD} `, sign(PAYLOAD, SECRET), SECRET)).toBe(false);
  });

  it("accepts an uppercase hex signature", () => {
    expect(
      verifyWebhookSignature(PAYLOAD, sign(PAYLOAD, SECRET).toUpperCase(), SECRET)
    ).toBe(true);
  });

  it("accepts Uint8Array payloads and secrets", () => {
    const signature = sign(PAYLOAD, SECRET);
    expect(
      verifyWebhookSignature(Buffer.from(PAYLOAD), signature, Buffer.from(SECRET))
    ).toBe(true);
  });

  it("returns false for malformed signatures without throwing", () => {
    for (const signature of ["abcd", "zzzz", "abc", ""]) {
      expect(() => verifyWebhookSignature(PAYLOAD, signature, SECRET)).not.toThrow();
      expect(verifyWebhookSignature(PAYLOAD, signature, SECRET)).toBe(false);
    }
  });

  // Regression: these inputs previously reached createHmac()/update() and threw
  // a TypeError instead of returning false.
  it.each([
    ["undefined secret", PAYLOAD, undefined],
    ["null secret", PAYLOAD, null],
    ["numeric secret", PAYLOAD, 12345],
    ["undefined payload", undefined, SECRET],
    ["null payload", null, SECRET],
    ["object payload", { not: "a string" }, SECRET],
  ])("returns false instead of throwing for %s", (_label, payload, secret) => {
    const signature = sign(PAYLOAD, SECRET);
    expect(() =>
      verifyWebhookSignature(payload as never, signature, secret as never)
    ).not.toThrow();
    expect(verifyWebhookSignature(payload as never, signature, secret as never)).toBe(false);
  });

  it("returns false instead of throwing for a non-string signature", () => {
    expect(() => verifyWebhookSignature(PAYLOAD, undefined as never, SECRET)).not.toThrow();
    expect(verifyWebhookSignature(PAYLOAD, undefined as never, SECRET)).toBe(false);
    expect(verifyWebhookSignature(PAYLOAD, null as never, SECRET)).toBe(false);
  });
});

describe("assertWebhookSignature", () => {
  it("does not throw for a valid signature", () => {
    expect(() =>
      assertWebhookSignature(PAYLOAD, sign(PAYLOAD, SECRET), SECRET)
    ).not.toThrow();
  });

  it("throws WebhookVerificationError for an invalid signature", () => {
    expect(() =>
      assertWebhookSignature(PAYLOAD, sign(PAYLOAD, "nope"), SECRET)
    ).toThrow(WebhookVerificationError);
  });

  it("throws a named error that is also an Error", () => {
    try {
      assertWebhookSignature(PAYLOAD, "abcd", SECRET);
      throw new Error("expected assertWebhookSignature to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WebhookVerificationError);
      expect(error).toBeInstanceOf(Error);
      expect((error as WebhookVerificationError).name).toBe("WebhookVerificationError");
    }
  });
});
