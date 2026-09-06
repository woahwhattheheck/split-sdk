import type { WalletAdapter } from "./types.js";

/**
 * Storage key under which the active WalletConnect session is persisted.
 *
 * Namespaced so it cannot collide with WalletConnect's own `wc@2:*` keys or
 * with an application's own storage.
 */
export const WALLETCONNECT_SESSION_KEY = "stellar-split:walletconnect:session";

/**
 * The subset of the DOM `Storage` API this module uses.
 *
 * Declared structurally so a caller can supply their own store — a React
 * Native storage shim, or an in-memory stub in tests — without this module
 * depending on DOM lib types.
 */
export interface WalletConnectSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A WalletConnect session as persisted between page loads. */
export interface PersistedWalletConnectSession {
  /** Active WalletConnect session topic. */
  topic: string;
  /** Relay URL the session was established through. */
  relayUrl: string;
  /** Stellar chain ID (e.g. "stellar:testnet"). */
  chainId: string;
  /** The connected wallet's Stellar public key. */
  address: string;
  /**
   * Session expiry as a Unix timestamp in **seconds**, matching the `expiry`
   * field WalletConnect puts on a session.
   */
  expiry: number;
}

/**
 * Resolve the default store: `globalThis.localStorage` when it exists.
 *
 * Returns `null` outside the browser, and also when the property access
 * itself throws — some privacy modes expose `localStorage` as a throwing
 * getter rather than simply omitting it.
 */
function defaultStorage(): WalletConnectSessionStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: WalletConnectSessionStorage })
      .localStorage;
    return candidate ?? null;
  } catch {
    return null;
  }
}

function isPersistedSession(
  value: unknown,
): value is PersistedWalletConnectSession {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["topic"] === "string" &&
    typeof candidate["relayUrl"] === "string" &&
    typeof candidate["chainId"] === "string" &&
    typeof candidate["address"] === "string" &&
    typeof candidate["expiry"] === "number" &&
    Number.isFinite(candidate["expiry"])
  );
}

/**
 * Persist `session` so it can be restored after a page reload.
 *
 * Never throws: a full or unavailable store degrades to not persisting, which
 * costs the user one reconnect rather than breaking an otherwise good session.
 *
 * @returns `true` when the session was written.
 */
export function persistWalletConnectSession(
  session: PersistedWalletConnectSession,
  storage: WalletConnectSessionStorage | null = defaultStorage(),
): boolean {
  if (!storage) {
    return false;
  }

  try {
    storage.setItem(WALLETCONNECT_SESSION_KEY, JSON.stringify(session));
    return true;
  } catch {
    // Quota exceeded, or storage disabled mid-flight.
    return false;
  }
}

/** Remove any persisted session. Never throws. */
export function clearWalletConnectSession(
  storage: WalletConnectSessionStorage | null = defaultStorage(),
): void {
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(WALLETCONNECT_SESSION_KEY);
  } catch {
    // Nothing useful to do if the store rejects a delete.
  }
}

/**
 * Load a previously persisted session.
 *
 * A session that is missing, unparseable, structurally wrong, or expired
 * yields `null`. In the latter three cases the entry is also removed, so a
 * corrupt or stale value cannot be re-read on every subsequent load.
 *
 * @param storage - Store to read from. Defaults to `localStorage`.
 * @param nowSeconds - Current Unix time in seconds; injectable for tests.
 */
export function loadWalletConnectSession(
  storage: WalletConnectSessionStorage | null = defaultStorage(),
  nowSeconds: number = Math.floor(Date.now() / 1000),
): PersistedWalletConnectSession | null {
  if (!storage) {
    return null;
  }

  let raw: string | null;
  try {
    raw = storage.getItem(WALLETCONNECT_SESSION_KEY);
  } catch {
    return null;
  }

  if (raw === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearWalletConnectSession(storage);
    return null;
  }

  if (!isPersistedSession(parsed)) {
    clearWalletConnectSession(storage);
    return null;
  }

  if (parsed.expiry <= nowSeconds) {
    clearWalletConnectSession(storage);
    return null;
  }

  return parsed;
}

/** The WalletConnect Sign Client surface this adapter depends on. */
export interface WalletConnectSignClient {
  request(args: {
    topic: string;
    chainId: string;
    request: { method: string; params: unknown };
  }): Promise<string>;
  /** Optional; called by {@link WalletConnectAdapter.disconnect} when present. */
  disconnect?(args: {
    topic: string;
    reason: { code: number; message: string };
  }): Promise<void>;
}

/** Options for constructing a WalletConnectAdapter. */
export interface WalletConnectAdapterOptions {
  /** WalletConnect Sign Client instance (from @walletconnect/sign-client). */
  // Typed structurally to avoid a hard dependency on @walletconnect/sign-client.
  client: WalletConnectSignClient;
  /** Active WalletConnect session topic. */
  topic: string;
  /** Stellar chain ID (e.g. "stellar:testnet"). */
  chainId: string;
  /** The connected wallet's Stellar public key. */
  address: string;
  /** Relay URL the session was established through. */
  relayUrl?: string;
  /**
   * Session expiry as a Unix timestamp in seconds, as WalletConnect reports
   * it on the session object.
   */
  expiry?: number;
  /**
   * Store used to persist the session. Defaults to `localStorage` when one is
   * available; pass `null` to disable persistence entirely.
   */
  storage?: WalletConnectSessionStorage | null;
  /**
   * Set `false` to construct without writing the session to storage.
   * @default true
   */
  persist?: boolean;
}

/**
 * WalletConnect adapter — routes signing through a WalletConnect session
 * instead of the Freighter browser extension.
 *
 * Constructing the adapter is the point at which the SDK is handed a live
 * session, so the session is persisted then (given `relayUrl` and `expiry`),
 * and {@link WalletConnectAdapter.restore} brings it back after a reload
 * without a fresh QR scan.
 */
export class WalletConnectAdapter implements WalletAdapter {
  private readonly opts: WalletConnectAdapterOptions;
  private readonly storage: WalletConnectSessionStorage | null;

  constructor(opts: WalletConnectAdapterOptions) {
    this.opts = opts;
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;

    // Persist only when the session carries the metadata a restore needs.
    // Without an expiry there is no way to tell a live session from a dead one
    // later, and restoring a dead session is worse than asking for a reconnect.
    if (
      opts.persist !== false &&
      opts.relayUrl !== undefined &&
      opts.expiry !== undefined
    ) {
      persistWalletConnectSession(
        {
          topic: opts.topic,
          relayUrl: opts.relayUrl,
          chainId: opts.chainId,
          address: opts.address,
          expiry: opts.expiry,
        },
        this.storage,
      );
    }
  }

  /**
   * Rebuild an adapter from a persisted session, if one is stored and still
   * valid.
   *
   * @param client - Sign client to bind the restored session to.
   * @param storage - Store to read from. Defaults to `localStorage`.
   * @param nowSeconds - Current Unix time in seconds; injectable for tests.
   * @returns The restored adapter, or `null` when there is nothing usable.
   */
  static restore(
    client: WalletConnectSignClient,
    storage: WalletConnectSessionStorage | null = defaultStorage(),
    nowSeconds: number = Math.floor(Date.now() / 1000),
  ): WalletConnectAdapter | null {
    const session = loadWalletConnectSession(storage, nowSeconds);
    if (!session) {
      return null;
    }

    return new WalletConnectAdapter({
      client,
      topic: session.topic,
      chainId: session.chainId,
      address: session.address,
      relayUrl: session.relayUrl,
      expiry: session.expiry,
      storage,
      // Already stored; rewriting the same value on restore is a pointless write.
      persist: false,
    });
  }

  async getAddress(): Promise<string> {
    return this.opts.address;
  }

  async signTransaction(xdr: string, network: string): Promise<string> {
    return this.opts.client.request({
      topic: this.opts.topic,
      chainId: this.opts.chainId,
      request: {
        method: "stellar_signXDR",
        params: { xdr, network },
      },
    });
  }

  /**
   * End the session and drop the persisted copy.
   *
   * The stored session is cleared even when the client's own disconnect
   * rejects, so a relay error cannot leave a dead session behind to be
   * restored on the next load.
   */
  async disconnect(): Promise<void> {
    try {
      await this.opts.client.disconnect?.({
        topic: this.opts.topic,
        reason: { code: 6000, message: "User disconnected" },
      });
    } finally {
      clearWalletConnectSession(this.storage);
    }
  }
}
