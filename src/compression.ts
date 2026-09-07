import { SdkError, SdkErrorCode } from "./errors.js";
import type { RequestInterceptor, ResponseInterceptor } from "./interceptors.js";

export type CompressionAlgorithm = "gzip" | "deflate";
export type CompressionPayload = string | Uint8Array;

export interface CompressionConfig {
  enabled: boolean;
  algorithm: CompressionAlgorithm;
}

export interface CompressedPayload {
  compressed: true;
  algorithm: CompressionAlgorithm;
  body: Uint8Array;
  originalBytes: number;
}

const MIN_COMPRESSION_BYTES = 1024;

function toBytes(payload: CompressionPayload): Uint8Array {
  return typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
}

function isCompressionStreamAvailable(): boolean {
  return (
    typeof CompressionStream !== "undefined" &&
    typeof Response !== "undefined" &&
    typeof Blob !== "undefined" &&
    typeof (Blob.prototype as any).stream === "function"
  );
}

function isDecompressionStreamAvailable(): boolean {
  return (
    typeof DecompressionStream !== "undefined" &&
    typeof Response !== "undefined" &&
    typeof Blob !== "undefined" &&
    typeof (Blob.prototype as any).stream === "function"
  );
}

function isCompressedPayload(value: unknown): value is CompressedPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<CompressedPayload>;
  return candidate.compressed === true && candidate.body instanceof Uint8Array;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

async function compressInBrowser(bytes: Uint8Array, algorithm: CompressionAlgorithm): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(new CompressionStream(algorithm));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function decompressInBrowser(bytes: Uint8Array, algorithm: CompressionAlgorithm): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(new DecompressionStream(algorithm));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function compressInNode(bytes: Uint8Array, algorithm: CompressionAlgorithm): Promise<Uint8Array> {
  const zlib = await import("node:zlib");
  const { promisify } = await import("node:util");
  const run = promisify(algorithm === "gzip" ? zlib.gzip : zlib.deflate);
  const compressed = await run(bytes);
  return new Uint8Array(compressed);
}

async function decompressInNode(bytes: Uint8Array, algorithm: CompressionAlgorithm): Promise<Uint8Array> {
  const zlib = await import("node:zlib");
  const { promisify } = await import("node:util");
  const run = promisify(algorithm === "gzip" ? zlib.gunzip : zlib.inflate);
  const decompressed = await run(bytes);
  return new Uint8Array(decompressed);
}

export async function compressPayload(
  payload: CompressionPayload,
  algorithm: CompressionAlgorithm = "gzip"
): Promise<CompressedPayload> {
  const bytes = toBytes(payload);
  const body = isCompressionStreamAvailable()
    ? await compressInBrowser(bytes, algorithm)
    : await compressInNode(bytes, algorithm);

  return {
    compressed: true,
    algorithm,
    body,
    originalBytes: bytes.byteLength,
  };
}

export async function decompressPayload(payload: CompressedPayload): Promise<Uint8Array> {
  return isDecompressionStreamAvailable()
    ? await decompressInBrowser(payload.body, payload.algorithm)
    : await decompressInNode(payload.body, payload.algorithm);
}

export function createCompressionRequestInterceptor(config: CompressionConfig): RequestInterceptor {
  return async (req) => {
    if (!config.enabled) {
      return req;
    }

    const params = await Promise.all(
      req.params.map(async (param) => {
        if (typeof param !== "string" && !(param instanceof Uint8Array)) {
          return param;
        }

        if (toBytes(param).byteLength <= MIN_COMPRESSION_BYTES) {
          return param;
        }

        return await compressPayload(param, config.algorithm);
      })
    );

    return { ...req, params };
  };
}

export function createCompressionResponseInterceptor(_config: CompressionConfig): ResponseInterceptor {
  return async (res) => {
    if (!isCompressedPayload(res.result)) {
      return res;
    }

    return {
      ...res,
      result: await decompressPayload(res.result),
    };
  };
}

// ---------------------------------------------------------------------------
// Invoice metadata encoding (#619)
// ---------------------------------------------------------------------------

/** Default byte ceiling for an encoded metadata string. */
export const DEFAULT_METADATA_MAX_BYTES = 512;

/**
 * base64url alphabet. Trailing padding is tolerated on decode even though it
 * is never produced, so a caller that padded the value elsewhere still round
 * trips.
 */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*={0,2}$/;

/**
 * base64url encode, without depending on the Node `Buffer` global.
 *
 * This module is isomorphic - it feature-detects `CompressionStream` and falls
 * back to `node:zlib` - so the metadata helpers must not reach for a Node-only
 * global either. `TextEncoder`/`TextDecoder` and `btoa`/`atob` exist in both
 * browsers and Node >= 16.
 */
function toBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);

  // Chunked rather than String.fromCharCode(...bytes): spreading a large array
  // overflows the call stack, and the size limit is only checked after encoding.
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url decode, tolerating optional padding. Mirror of {@link toBase64Url}. */
function fromBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Encode an invoice metadata object as a compact base64url string.
 *
 * The value is JSON-serialised then base64url encoded without padding, so the
 * result is safe to place in a Stellar transaction memo or an IPFS payload.
 *
 * @param metadata - Any JSON-serialisable plain object.
 * @param maxBytes - Ceiling for the encoded string, in bytes.
 * @returns The encoded metadata.
 * @throws {SdkError} With {@link SdkErrorCode.CONTRACT_REJECTED} when the
 *   input is not a serialisable plain object, or when the encoded result
 *   exceeds `maxBytes`.
 */
export function compressMetadata(
  metadata: Record<string, unknown>,
  maxBytes: number = DEFAULT_METADATA_MAX_BYTES,
): string {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new SdkError(
      "Metadata must be a plain object",
      SdkErrorCode.CONTRACT_REJECTED,
      { received: metadata === null ? "null" : typeof metadata },
    );
  }

  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new SdkError(
      "maxBytes must be a positive, finite number",
      SdkErrorCode.CONTRACT_REJECTED,
      { maxBytes },
    );
  }

  let json: string;
  try {
    json = JSON.stringify(metadata);
  } catch (err) {
    // Circular references and BigInt values both reach here.
    throw new SdkError(
      "Metadata is not JSON-serialisable",
      SdkErrorCode.CONTRACT_REJECTED,
      { reason: err instanceof Error ? err.message : String(err) },
    );
  }

  const encoded = toBase64Url(json);
  // base64url is ASCII-only, so the character count is the byte count.
  const bytes = encoded.length;

  if (bytes > maxBytes) {
    throw new SdkError(
      `Encoded metadata is ${bytes} bytes, over the ${maxBytes} byte limit`,
      SdkErrorCode.CONTRACT_REJECTED,
      { bytes, maxBytes },
    );
  }

  return encoded;
}

/**
 * Decode a metadata string produced by {@link compressMetadata}.
 *
 * @param encoded - base64url-encoded metadata.
 * @returns The decoded object.
 * @throws {SdkError} With {@link SdkErrorCode.CONTRACT_REJECTED} when the
 *   input is not base64url, does not contain JSON, or does not decode to a
 *   plain object.
 */
export function decompressMetadata(encoded: string): Record<string, unknown> {
  if (typeof encoded !== "string" || !BASE64URL_PATTERN.test(encoded)) {
    throw new SdkError(
      "Encoded metadata is not a base64url string",
      SdkErrorCode.CONTRACT_REJECTED,
      { received: typeof encoded },
    );
  }

  const json = fromBase64Url(encoded);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new SdkError(
      "Encoded metadata does not contain valid JSON",
      SdkErrorCode.CONTRACT_REJECTED,
      { reason: err instanceof Error ? err.message : String(err) },
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SdkError(
      "Encoded metadata did not decode to an object",
      SdkErrorCode.CONTRACT_REJECTED,
      { decodedType: parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed },
    );
  }

  return parsed as Record<string, unknown>;
}
