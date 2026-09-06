/**
 * XBullAdapter — Adapter for the xBull wallet extension.
 */

import type { WalletAdapter } from "../../types.js";

type Unsubscribe = () => void;

/**
 * Lowest xBull extension version this adapter supports.
 *
 * Earlier builds predate the object-shaped `connect()` / `sign()` surface used
 * below and fail with errors that do not name the real cause. Bump this
 * constant when the required surface changes.
 */
export const MIN_XBULL_VERSION = "1.4.0";

/**
 * Thrown when an installed extension is older than the version this SDK
 * requires, or when its version cannot be determined.
 */
export class ExtensionVersionError extends Error {
  constructor(
    /** Extension the version was read from, e.g. `"xBull"`. */
    public readonly extension: string,
    /** Version reported by the extension, or a note on why it was unreadable. */
    public readonly foundVersion: string,
    /** Minimum version this SDK accepts. */
    public readonly requiredVersion: string,
  ) {
    super(
      `${extension} extension ${foundVersion} is not supported; ` +
        `version ${requiredVersion} or newer is required. ` +
        `Update the ${extension} extension and try again.`,
    );
    this.name = "ExtensionVersionError";
    // Keeps `instanceof` working when the SDK is compiled to an ES5 target.
    Object.setPrototypeOf(this, ExtensionVersionError.prototype);
  }
}

/**
 * Parse a dotted numeric version into comparable parts.
 *
 * @returns The numeric components, or `null` when the value is not a version
 *          this function can reason about.
 */
function parseVersion(version: unknown): number[] | null {
  if (typeof version !== "string") {
    return null;
  }

  const parts = version.trim().split(".");
  const numbers: number[] = [];

  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    numbers.push(Number(part));
  }

  return numbers.length > 0 ? numbers : null;
}

/**
 * Compare two dotted numeric versions.
 *
 * Missing trailing components count as zero, so `"1.4"` and `"1.4.0"` compare
 * equal. Comparison is numeric, so `"1.10.0"` is newer than `"1.9.0"` — which
 * a string comparison gets backwards.
 *
 * @returns Negative when `a < b`, zero when equal, positive when `a > b`, or
 *          `null` when either version is unparseable.
 */
export function compareExtensionVersions(a: unknown, b: unknown): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);

  if (left === null || right === null) {
    return null;
  }

  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

declare global {
  interface Window {
    xbull?: {
      connect(): Promise<{ public_key: string }>;
      sign(params: { xdr: string; publicKey: string }): Promise<{ xdr: string }>;
      onAccountChange(handler: (publicKey: string) => void): () => void;
      /** Extension version, when the build exposes one. */
      version?: string;
    };
    /**
     * The globally documented xBull handle. Some builds expose the version
     * here rather than on `window.xbull`.
     */
    xBullSDK?: { version?: string };
  }
}

/** Options for constructing an {@link XBullAdapter}. */
export interface XBullAdapterOptions {
  /**
   * Skip the extension version check.
   *
   * Intended for tests, and as an escape hatch for a build that does not
   * report a version but is known to work.
   *
   * @default false
   */
  skipVersionCheck?: boolean;
}

export class XBullAdapter implements WalletAdapter {
  readonly name = "xBull";
  private accountChangeHandlers: Array<(address: string) => void> = [];
  private unsubscribe: (() => void) | null = null;
  private currentPublicKey: string | null = null;
  private readonly skipVersionCheck: boolean;

  constructor(options: XBullAdapterOptions = {}) {
    this.skipVersionCheck = options.skipVersionCheck ?? false;
  }

  async connect(): Promise<string> {
    if (!window.xbull) {
      throw new Error("xBull wallet not installed");
    }

    this.assertSupportedVersion();

    const result = await window.xbull.connect();
    this.currentPublicKey = result.public_key;

    // Set up account change listener
    this.setupAccountChangeListener();

    return result.public_key;
  }

  async sign(xdr: string): Promise<string> {
    if (!window.xbull || !this.currentPublicKey) {
      throw new Error("xBull wallet not connected");
    }

    const result = await window.xbull.sign({
      xdr,
      publicKey: this.currentPublicKey,
    });

    return result.xdr;
  }

  async getAddress(): Promise<string> {
    if (!window.xbull) {
      throw new Error("xBull wallet not installed");
    }

    if (this.currentPublicKey) {
      return this.currentPublicKey;
    }

    // This path also opens a connection, so it is gated the same way.
    this.assertSupportedVersion();

    const result = await window.xbull.connect();
    this.currentPublicKey = result.public_key;
    return result.public_key;
  }

  async signTransaction(xdr: string, _network: string): Promise<string> {
    return this.sign(xdr);
  }

  disconnect(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.accountChangeHandlers = [];
    this.currentPublicKey = null;
  }

  onAccountChange(handler: (address: string) => void): Unsubscribe {
    this.accountChangeHandlers.push(handler);

    return () => {
      const index = this.accountChangeHandlers.indexOf(handler);
      if (index > -1) {
        this.accountChangeHandlers.splice(index, 1);
      }
    };
  }

  /**
   * Read the installed extension version.
   *
   * `window.xbull.version` is preferred, falling back to `window.xBullSDK`,
   * since builds differ in which handle carries it.
   */
  private readInstalledVersion(): unknown {
    return window.xbull?.version ?? window.xBullSDK?.version;
  }

  /**
   * Reject an extension older than {@link MIN_XBULL_VERSION}.
   *
   * Fails closed: a version that is absent or unparseable is treated as
   * unsupported. A build too old to report a version is almost certainly too
   * old to provide the API surface used here, and connecting anyway produces
   * exactly the cryptic failure this check exists to replace.
   * {@link XBullAdapterOptions.skipVersionCheck} is the escape hatch.
   */
  private assertSupportedVersion(): void {
    if (this.skipVersionCheck) {
      return;
    }

    const found = this.readInstalledVersion();
    const comparison = compareExtensionVersions(found, MIN_XBULL_VERSION);

    if (comparison === null) {
      throw new ExtensionVersionError(
        "xBull",
        found === undefined
          ? "(version not reported)"
          : `"${String(found)}" (unrecognised version)`,
        MIN_XBULL_VERSION,
      );
    }

    if (comparison < 0) {
      throw new ExtensionVersionError(
        "xBull",
        String(found),
        MIN_XBULL_VERSION,
      );
    }
  }

  private setupAccountChangeListener(): void {
    if (!window.xbull) return;

    this.unsubscribe = window.xbull.onAccountChange((publicKey: string) => {
      this.currentPublicKey = publicKey;

      for (const handler of this.accountChangeHandlers) {
        try {
          handler(publicKey);
        } catch (err) {
          console.error("Error in account change handler:", err);
        }
      }
    });
  }
}
