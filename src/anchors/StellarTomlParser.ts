/**
 * StellarTomlParser (#487)
 *
 * Fetches and parses a `stellar.toml` file according to SEP-1 from a given
 * domain's well-known URL (`https://{domain}/.well-known/stellar.toml`).
 *
 * Results are cached per-domain for `tomlCacheTtlMs` milliseconds (default
 * 1 hour) to avoid redundant HTTP round-trips.
 */

// `toml` is a CommonJS package — we import it as a namespace.
import * as toml from "toml";

// ---------------------------------------------------------------------------
// SEP-1 typed structures
// ---------------------------------------------------------------------------

/** A single currency entry in the CURRENCIES array. */
export interface TomlCurrency {
  /** Asset code (e.g. "USDC"). */
  code: string;
  /** Issuer Stellar address. */
  issuer?: string;
  /** Human-readable name. */
  name?: string;
  /** Asset description. */
  desc?: string;
  /** Number of decimal places. */
  decimals?: number;
  /** URL to the asset image. */
  image?: string;
  /** Whether the asset is anchored to a real-world asset. */
  is_asset_anchored?: boolean;
  /** Anchor asset type (e.g. "fiat"). */
  anchor_asset_type?: string;
  /** Anchor asset code (e.g. "USD"). */
  anchor_asset?: string;
  /** Allow extra fields from the TOML file. */
  [key: string]: unknown;
}

/** A validator node entry. */
export interface TomlValidator {
  /** Alias for the validator. */
  alias?: string;
  /** Stellar address of the validator. */
  public_key?: string;
  /** Horizon-accessible URL for the validator. */
  host?: string;
  /** History archive URL. */
  history?: string;
  [key: string]: unknown;
}

/** DOCUMENTATION section of the TOML file. */
export interface TomlDocumentation {
  ORG_NAME?: string;
  ORG_URL?: string;
  ORG_LOGO?: string;
  ORG_DESCRIPTION?: string;
  ORG_PHYSICAL_ADDRESS?: string;
  ORG_OFFICIAL_EMAIL?: string;
  ORG_SUPPORT_EMAIL?: string;
  OP_EMAIL?: string;
  [key: string]: unknown;
}

/**
 * Parsed representation of a `stellar.toml` file, mirroring the SEP-1
 * top-level sections.
 */
export interface TomlMetadata {
  /** Parsed domain. */
  domain: string;
  /** Raw URL the TOML was fetched from. */
  tomlUrl: string;
  /** Stellar account addresses listed under ACCOUNTS. */
  ACCOUNTS?: string[];
  /** Currency definitions. */
  CURRENCIES?: TomlCurrency[];
  /** Validator node definitions. */
  VALIDATORS?: TomlValidator[];
  /** Documentation section. */
  DOCUMENTATION?: TomlDocumentation;
  /** Any additional top-level keys. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// SEP-1 schema version
// ---------------------------------------------------------------------------

/**
 * `stellar.toml` schema versions this parser understands, as `major.minor`.
 *
 * A future schema may move or re-type fields, in which case parsing it with
 * the current logic yields plausible-looking but wrong data rather than an
 * error. Gating on the declared version turns that silent corruption into a
 * clear failure.
 */
export const SUPPORTED_TOML_VERSIONS: readonly string[] = ["2.0", "2.1"];

/**
 * Thrown when a `stellar.toml` declares a schema version this parser does not
 * support.
 */
export class UnsupportedTomlVersionError extends Error {
  constructor(
    /** The version exactly as it appeared in the document. */
    public readonly version: string,
    /** Domain the document was fetched from, when known. */
    public readonly domain?: string,
    /** The versions that would have been accepted. */
    public readonly supportedVersions: readonly string[] = SUPPORTED_TOML_VERSIONS,
  ) {
    super(
      `Unsupported stellar.toml VERSION "${version}"` +
        (domain ? ` for domain "${domain}"` : "") +
        `; supported versions are ${supportedVersions.join(", ")}`,
    );
    this.name = "UnsupportedTomlVersionError";
    // Keeps `instanceof` working when the SDK is compiled to an ES5 target.
    Object.setPrototypeOf(this, UnsupportedTomlVersionError.prototype);
  }
}

/**
 * Reduce a declared VERSION to the `major.minor` form used for comparison.
 *
 * SEP-1 documents write the version as a quoted string, commonly with a patch
 * component (`"2.0.0"`), but an unquoted `VERSION = 2.0` is parsed by TOML as
 * the number `2`. Both normalise to `"2.0"`, so a valid numeric patch component
 * and the quoting style do not affect support. Malformed or extra components
 * are rejected rather than being accepted by a valid major/minor prefix.
 *
 * @returns The normalised version, or `null` when the value is not a usable
 *          version at all.
 */
function normaliseTomlVersion(value: unknown): string | null {
  // An unquoted `VERSION = 2.0` arrives as the number 2. Preserve the numeric
  // digits that remain after TOML parsing instead of rounding to one decimal:
  // rounding would silently turn unsupported 2.04/2.14 declarations into
  // supported 2.0/2.1 versions.
  if (typeof value === "number") {
    return Number.isFinite(value) ? normaliseTomlVersion(String(value)) : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const major = match[1];
  const minor = match[2];
  if (major === undefined) {
    return null;
  }

  return `${Number(major)}.${minor === undefined ? 0 : Number(minor)}`;
}

// ---------------------------------------------------------------------------
// Cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  metadata: TomlMetadata;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// StellarTomlParser
// ---------------------------------------------------------------------------

/** Options accepted by `StellarTomlParser`. */
export interface StellarTomlParserOptions {
  /**
   * Cache TTL in milliseconds. Cached TOML responses are served until this
   * duration elapses, after which a fresh HTTP request is made.
   * @default 3_600_000 (1 hour)
   */
  tomlCacheTtlMs?: number;
  /**
   * Request timeout in milliseconds.
   * @default 10_000
   */
  fetchTimeoutMs?: number;
}

/**
 * Fetches and parses `stellar.toml` files per SEP-1, with per-domain caching.
 *
 * @example
 * ```ts
 * const parser = new StellarTomlParser();
 * const meta = await parser.fetch("circle.io");
 * console.log(meta.CURRENCIES);
 * ```
 */
export class StellarTomlParser {
  private readonly _cache = new Map<string, CacheEntry>();
  private readonly _ttlMs: number;
  private readonly _fetchTimeoutMs: number;

  constructor(options: StellarTomlParserOptions = {}) {
    this._ttlMs = options.tomlCacheTtlMs ?? 3_600_000;
    this._fetchTimeoutMs = options.fetchTimeoutMs ?? 10_000;
  }

  /**
   * Fetch and parse the `stellar.toml` file for `domain`.
   *
   * Results are cached per-domain. A cached result is returned if it was
   * fetched within the last `tomlCacheTtlMs` milliseconds; otherwise a fresh
   * HTTP request is made.
   *
   * @param domain - Bare domain name, e.g. `"circle.io"` (no protocol prefix).
   * @returns Parsed `TomlMetadata`.
   * @throws `StellarTomlFetchError` on network failure or parse error.
   */
  async fetch(domain: string): Promise<TomlMetadata> {
    const cached = this._cache.get(domain);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.metadata;
    }

    const tomlUrl = `https://${domain}/.well-known/stellar.toml`;
    const raw = await this._fetchRaw(tomlUrl, domain);
    const parsed = this._parse(raw, domain, tomlUrl);

    this._cache.set(domain, {
      metadata: parsed,
      expiresAt: Date.now() + this._ttlMs,
    });

    return parsed;
  }

  /**
   * Manually clear the cache entry for `domain` (useful in tests or when a
   * domain's TOML is known to have changed).
   */
  clearCache(domain?: string): void {
    if (domain) {
      this._cache.delete(domain);
    } else {
      this._cache.clear();
    }
  }

  /**
   * Check whether a cached (non-expired) entry exists for `domain`.
   */
  isCached(domain: string): boolean {
    const entry = this._cache.get(domain);
    return !!entry && entry.expiresAt > Date.now();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async _fetchRaw(url: string, domain: string): Promise<string> {
    // Dynamically imported so callers in non-browser environments without a
    // global `fetch` can still use the class (they would need to polyfill).
    const fetchFn: typeof fetch =
      typeof globalThis.fetch === "function"
        ? globalThis.fetch
        : (await import("node:https" as string)).request as unknown as typeof fetch;

    let controller: AbortController | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      controller = new AbortController();
      timeoutId = setTimeout(
        () => controller!.abort(),
        this._fetchTimeoutMs,
      );

      const response = await fetchFn(url, { signal: controller.signal });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      return response.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Dynamically import to avoid a circular-dep risk at module load time
      const { StellarTomlFetchError } = await import("../errors.js");
      throw new StellarTomlFetchError(domain, msg);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  private _parse(raw: string, domain: string, tomlUrl: string): TomlMetadata {
    let parsed: Record<string, unknown>;
    try {
      parsed = toml.parse(raw) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Throw synchronously is fine here; this is called inside an async context
      throw Object.assign(
        new Error(`Failed to parse stellar.toml for domain "${domain}": ${msg}`),
        { code: "STELLAR_TOML_FETCH_ERROR", domain },
      );
    }

    // First validation after a successful parse: refuse a schema version this
    // parser was not written against, rather than silently misreading it.
    this._assertSupportedVersion(parsed, domain);

    return {
      domain,
      tomlUrl,
      ...parsed,
    } as TomlMetadata;
  }

  /**
   * Reject a document whose declared VERSION is outside
   * {@link SUPPORTED_TOML_VERSIONS}.
   *
   * A document that declares no VERSION is accepted: SEP-1 does not require
   * the field, and many published `stellar.toml` files omit it, so treating
   * absence as a failure would reject valid anchors.
   *
   * @throws {UnsupportedTomlVersionError} When VERSION is present and
   *   unsupported.
   */
  private _assertSupportedVersion(
    parsed: Record<string, unknown>,
    domain: string,
  ): void {
    const declared = parsed["VERSION"];
    if (declared === undefined || declared === null) {
      return;
    }

    const normalised = normaliseTomlVersion(declared);
    if (normalised !== null && SUPPORTED_TOML_VERSIONS.includes(normalised)) {
      return;
    }

    throw new UnsupportedTomlVersionError(String(declared), domain);
  }
}
