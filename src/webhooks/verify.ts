/**
 * Server-side verification helper for StellarSplit webhook signatures.
 *
 * Mirrors the HMAC-SHA256 signing performed by {@link WebhookAgent} so
 * webhook consumers can confirm a payload originated from the SDK and
 * was not tampered with in transit.
 *
 * This module is the synchronous, Node-only counterpart to the isomorphic
 * `verifyWebhookSignature` exported from `./webhookMiddleware.js`. It is
 * re-exported from the package root as `verifyWebhookSignatureSync`.
 */

import { createHmac, timingSafeEqual } from "crypto";

const HEX_PATTERN = /^[0-9a-f]+$/i;

/** Runtime types accepted for the HMAC key and the signed payload. */
type BinaryInput = string | Uint8Array;

function isBinaryInput(value: unknown): value is BinaryInput {
  return typeof value === "string" || value instanceof Uint8Array;
}

/**
 * Verifies the `X-Stellar-Split-Signature` header against the raw request
 * body using a timing-safe comparison.
 *
 * This function is total: it never throws. Any malformed, missing or
 * wrongly-typed argument yields `false`, so it can be called directly inside
 * a request handler without a defensive `try`/`catch`.
 *
 * @param payload - The exact, unparsed request body bytes as received.
 * @param signature - The hex-encoded signature from the request header.
 * @param secret - The shared HMAC secret configured for the webhook.
 * @returns `true` only when the computed digest matches the signature.
 */
export function verifyWebhookSignature(
  payload: BinaryInput,
  signature: string,
  secret: BinaryInput
): boolean {
  // Reject unusable inputs up front so createHmac()/update() cannot throw.
  if (!isBinaryInput(payload) || !isBinaryInput(secret)) {
    return false;
  }

  if (typeof signature !== "string") {
    return false;
  }

  if (!HEX_PATTERN.test(signature) || signature.length % 2 !== 0) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(payload).digest();
  const provided = Buffer.from(signature, "hex");

  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}

/**
 * Thrown by {@link assertWebhookSignature} when a webhook signature does not
 * match the expected HMAC-SHA256 digest.
 *
 * Consumers that prefer exceptions over boolean checks can catch this to
 * return `401`/`403` from their webhook route.
 */
export class WebhookVerificationError extends Error {
  constructor(message = "Webhook signature verification failed") {
    super(message);
    this.name = "WebhookVerificationError";
    // Keeps `instanceof` working when the SDK is compiled to an ES5 target.
    Object.setPrototypeOf(this, WebhookVerificationError.prototype);
  }
}

/**
 * Throwing counterpart to {@link verifyWebhookSignature}.
 *
 * @throws {WebhookVerificationError} When verification fails for any reason.
 */
export function assertWebhookSignature(
  payload: BinaryInput,
  signature: string,
  secret: BinaryInput
): void {
  if (!verifyWebhookSignature(payload, signature, secret)) {
    throw new WebhookVerificationError();
  }
}
