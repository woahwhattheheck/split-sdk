import { describe, expect, it } from "vitest";

import { decompressMetadata } from "../src/compression.js";
import { SdkError, SdkErrorCode } from "../src/errors.js";

describe("decompressMetadata malformed base64url", () => {
  it.each(["A", "A=", "=="])(
    "normalizes decoder failure for %j to CONTRACT_REJECTED",
    (encoded) => {
      try {
        decompressMetadata(encoded);
        throw new Error("expected malformed base64url to be rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(SdkError);
        expect((error as SdkError).code).toBe(SdkErrorCode.CONTRACT_REJECTED);
      }
    },
  );
});
