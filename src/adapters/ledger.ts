import TransportWebHID from "@ledgerhq/hw-transport-webhid";
import type Transport from "@ledgerhq/hw-transport";
import Str from "@ledgerhq/hw-app-str";
import type { WalletAdapter } from "./types.js";

/**
 * Minimum Stellar app version required to sign.
 *
 * Older builds predate transaction features the SDK emits and fail in ways
 * that surface as an opaque device error rather than a useful message.
 */
export const MIN_LEDGER_FIRMWARE = "3.0.0";

/** Thrown when the connected Ledger reports a Stellar app older than {@link MIN_LEDGER_FIRMWARE}. */
export class LedgerFirmwareTooOldError extends Error {
  constructor(
    /** Version string the device reported, or a description of why it could not be read. */
    public readonly foundVersion: string,
    /** Minimum version this SDK accepts. */
    public readonly requiredVersion: string = MIN_LEDGER_FIRMWARE,
  ) {
    super(
      `Ledger Stellar app ${foundVersion} is too old; ` +
        `version ${requiredVersion} or newer is required. Update the Stellar ` +
        `app on your device and try again.`,
    );
    this.name = "LedgerFirmwareTooOldError";
    // Keeps `instanceof` working when the SDK is compiled to an ES5 target.
    Object.setPrototypeOf(this, LedgerFirmwareTooOldError.prototype);
  }
}

/** The subset of `@ledgerhq/hw-app-str` this adapter uses. */
export interface LedgerStellarApp {
  getPublicKey(path: string): Promise<{ publicKey: string }>;
  signTransaction(path: string, transaction: Buffer): Promise<{ signature: unknown }>;
  /** Reports the Stellar app version running on the device. */
  getAppConfiguration(): Promise<{ version: string }>;
}

/** Options for constructing a {@link LedgerAdapter}. */
export interface LedgerAdapterOptions {
  /** BIP-44 derivation path. */
  path?: string;
  /**
   * Skip the firmware check before signing.
   *
   * Intended for tests and for callers who have already verified the device.
   * @default false
   */
  skipFirmwareCheck?: boolean;
  /** Override how the transport is opened. Defaults to WebHID. */
  transportFactory?: () => Promise<Transport>;
  /** Override how the Stellar app binding is built. Defaults to `hw-app-str`. */
  appFactory?: (transport: Transport) => LedgerStellarApp;
}

/**
 * Parse a dotted numeric version into comparable parts.
 *
 * @returns The numeric components, or `null` when the string is not a version
 *          this function can reason about.
 */
function parseVersion(version: string): number[] | null {
  if (typeof version !== "string") {
    return null;
  }

  const parts = version.trim().split(".");
  if (parts.length === 0) {
    return null;
  }

  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    numbers.push(Number(part));
  }

  return numbers;
}

/**
 * Compare two dotted numeric versions.
 *
 * Missing trailing components count as zero, so `"3.0"` and `"3.0.0"` compare
 * equal.
 *
 * @returns Negative when `a < b`, zero when equal, positive when `a > b`, or
 *          `null` when either version is unparseable.
 */
export function compareLedgerVersions(a: string, b: string): number | null {
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

/** Ledger hardware wallet adapter implementing WalletAdapter. */
export class LedgerAdapter implements WalletAdapter {
  private readonly path: string;
  private readonly skipFirmwareCheck: boolean;
  private readonly transportFactory: () => Promise<Transport>;
  private readonly appFactory: (transport: Transport) => LedgerStellarApp;

  /**
   * @param pathOrOptions - A BIP-44 derivation path, or an options object.
   *   The string form is kept so existing callers continue to work unchanged.
   */
  constructor(pathOrOptions: string | LedgerAdapterOptions = "44'/148'/0'") {
    const options: LedgerAdapterOptions =
      typeof pathOrOptions === "string" ? { path: pathOrOptions } : pathOrOptions;

    this.path = options.path ?? "44'/148'/0'";
    this.skipFirmwareCheck = options.skipFirmwareCheck ?? false;
    this.transportFactory =
      options.transportFactory ?? (() => TransportWebHID.create());
    this.appFactory =
      options.appFactory ??
      ((transport: Transport) => new Str(transport) as unknown as LedgerStellarApp);
  }

  async getAddress(): Promise<string> {
    const transport = await this.openTransport();
    try {
      const app = this.appFactory(transport);
      const { publicKey } = await app.getPublicKey(this.path);
      return publicKey;
    } finally {
      await transport.close();
    }
  }

  async signTransaction(xdr: string, _network: string): Promise<string> {
    const transport = await this.openTransport();
    try {
      const app = this.appFactory(transport);

      // Checked before the signing request so an unsupported device fails
      // with a message naming the required version, rather than with an
      // opaque error from the device part-way through signing.
      await this.assertFirmwareSupported(app);

      const txBytes = Uint8Array.from(atob(xdr), (c) => c.charCodeAt(0));
      const { signature } = await app.signTransaction(
        this.path,
        txBytes as unknown as Buffer,
      );
      const sigBytes = signature as unknown as Uint8Array;
      return btoa(String.fromCharCode(...sigBytes));
    } finally {
      await transport.close();
    }
  }

  /**
   * Reject a device whose Stellar app is older than
   * {@link MIN_LEDGER_FIRMWARE}.
   *
   * Fails closed: a version string that cannot be parsed is treated as
   * unsupported. Signing with a device whose compatibility could not be
   * established is the outcome this check exists to prevent.
   */
  private async assertFirmwareSupported(app: LedgerStellarApp): Promise<void> {
    if (this.skipFirmwareCheck) {
      return;
    }

    const { version } = await app.getAppConfiguration();
    const comparison = compareLedgerVersions(version, MIN_LEDGER_FIRMWARE);

    if (comparison === null) {
      throw new LedgerFirmwareTooOldError(
        `"${String(version)}" (unrecognised version)`,
      );
    }

    if (comparison < 0) {
      throw new LedgerFirmwareTooOldError(version);
    }
  }

  private async openTransport(): Promise<Transport> {
    try {
      return await this.transportFactory();
    } catch {
      throw new Error(
        "Ledger device not connected. Please connect your Ledger and open the Stellar app.",
      );
    }
  }
}
