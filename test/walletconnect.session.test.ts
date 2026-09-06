/**
 * Tests for WalletConnect session persistence (Issue #774).
 * Offline: an in-memory store stands in for localStorage and the sign client
 * is a stub, so nothing touches the network or the DOM.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  WalletConnectAdapter,
  WALLETCONNECT_SESSION_KEY,
  clearWalletConnectSession,
  loadWalletConnectSession,
  persistWalletConnectSession,
  type PersistedWalletConnectSession,
  type WalletConnectSessionStorage,
} from "../src/adapters/walletconnect.js";

class MemoryStorage implements WalletConnectSessionStorage {
  readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const NOW = 1_700_000_000; // Unix seconds

const session = (overrides: Partial<PersistedWalletConnectSession> = {}) => ({
  topic: "topic-abc",
  relayUrl: "wss://relay.walletconnect.com",
  chainId: "stellar:testnet",
  address: "GABC00000000000000000000000000000000000000000000000000AA",
  expiry: NOW + 3600,
  ...overrides,
});

const makeClient = () => ({
  request: vi.fn().mockResolvedValue("signed-xdr"),
  disconnect: vi.fn().mockResolvedValue(undefined),
});

describe("persist / load / clear", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it("round-trips a live session", () => {
    expect(persistWalletConnectSession(session(), storage)).toBe(true);
    expect(loadWalletConnectSession(storage, NOW)).toEqual(session());
  });

  it("writes under the namespaced key", () => {
    persistWalletConnectSession(session(), storage);
    expect(storage.map.has(WALLETCONNECT_SESSION_KEY)).toBe(true);
  });

  it("returns null when nothing is stored", () => {
    expect(loadWalletConnectSession(storage, NOW)).toBeNull();
  });

  it("clears a stored session", () => {
    persistWalletConnectSession(session(), storage);
    clearWalletConnectSession(storage);
    expect(loadWalletConnectSession(storage, NOW)).toBeNull();
  });

  it("refuses an expired session and removes it", () => {
    persistWalletConnectSession(session({ expiry: NOW - 1 }), storage);

    expect(loadWalletConnectSession(storage, NOW)).toBeNull();
    // Removed, so a stale entry is not re-read on every later load.
    expect(storage.map.has(WALLETCONNECT_SESSION_KEY)).toBe(false);
  });

  it("treats an expiry exactly at now as expired", () => {
    persistWalletConnectSession(session({ expiry: NOW }), storage);
    expect(loadWalletConnectSession(storage, NOW)).toBeNull();
  });

  it("discards unparseable JSON and removes it", () => {
    storage.setItem(WALLETCONNECT_SESSION_KEY, "{not json");

    expect(loadWalletConnectSession(storage, NOW)).toBeNull();
    expect(storage.map.has(WALLETCONNECT_SESSION_KEY)).toBe(false);
  });

  it("discards a structurally wrong record and removes it", () => {
    storage.setItem(
      WALLETCONNECT_SESSION_KEY,
      JSON.stringify({ topic: "t", expiry: "soon" }),
    );

    expect(loadWalletConnectSession(storage, NOW)).toBeNull();
    expect(storage.map.has(WALLETCONNECT_SESSION_KEY)).toBe(false);
  });

  it("degrades quietly when there is no store at all", () => {
    expect(persistWalletConnectSession(session(), null)).toBe(false);
    expect(loadWalletConnectSession(null, NOW)).toBeNull();
    expect(() => clearWalletConnectSession(null)).not.toThrow();
  });

  it("degrades quietly when the store throws", () => {
    const hostile: WalletConnectSessionStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };

    expect(persistWalletConnectSession(session(), hostile)).toBe(false);
    expect(loadWalletConnectSession(hostile, NOW)).toBeNull();
    expect(() => clearWalletConnectSession(hostile)).not.toThrow();
  });
});

describe("WalletConnectAdapter — persistence", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it("persists the session on construction", () => {
    new WalletConnectAdapter({ client: makeClient(), ...session(), storage });

    expect(loadWalletConnectSession(storage, NOW)).toEqual(session());
  });

  it("does not persist when persist is false", () => {
    new WalletConnectAdapter({
      client: makeClient(),
      ...session(),
      storage,
      persist: false,
    });

    expect(loadWalletConnectSession(storage, NOW)).toBeNull();
  });

  it("does not persist a session with no expiry to validate later", () => {
    new WalletConnectAdapter({
      client: makeClient(),
      topic: "topic-abc",
      chainId: "stellar:testnet",
      address: "GABC",
      relayUrl: "wss://relay.walletconnect.com",
      storage,
    });

    expect(loadWalletConnectSession(storage, NOW)).toBeNull();
  });

  it("still signs through the client", async () => {
    const client = makeClient();
    const adapter = new WalletConnectAdapter({
      client,
      ...session(),
      storage,
    });

    await expect(adapter.signTransaction("xdr", "testnet")).resolves.toBe(
      "signed-xdr",
    );
    expect(client.request).toHaveBeenCalledWith({
      topic: "topic-abc",
      chainId: "stellar:testnet",
      request: { method: "stellar_signXDR", params: { xdr: "xdr", network: "testnet" } },
    });
  });
});

describe("WalletConnectAdapter.restore", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it("restores an adapter from a live stored session", async () => {
    persistWalletConnectSession(session(), storage);

    const adapter = WalletConnectAdapter.restore(makeClient(), storage, NOW);

    expect(adapter).not.toBeNull();
    await expect(adapter!.getAddress()).resolves.toBe(session().address);
  });

  it("returns null when the stored session has expired", () => {
    persistWalletConnectSession(session({ expiry: NOW - 1 }), storage);

    expect(WalletConnectAdapter.restore(makeClient(), storage, NOW)).toBeNull();
  });

  it("returns null when nothing is stored", () => {
    expect(WalletConnectAdapter.restore(makeClient(), storage, NOW)).toBeNull();
  });

  it("leaves the stored session intact", () => {
    persistWalletConnectSession(session(), storage);
    const before = storage.getItem(WALLETCONNECT_SESSION_KEY);

    WalletConnectAdapter.restore(makeClient(), storage, NOW);

    expect(storage.getItem(WALLETCONNECT_SESSION_KEY)).toBe(before);
  });
});

describe("WalletConnectAdapter.disconnect", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it("clears the persisted session and ends the client session", async () => {
    const client = makeClient();
    const adapter = new WalletConnectAdapter({
      client,
      ...session(),
      storage,
    });

    await adapter.disconnect();

    expect(loadWalletConnectSession(storage, NOW)).toBeNull();
    expect(client.disconnect).toHaveBeenCalledWith({
      topic: "topic-abc",
      reason: { code: 6000, message: "User disconnected" },
    });
  });

  it("clears the persisted session even when the client disconnect fails", async () => {
    const client = {
      request: vi.fn(),
      disconnect: vi.fn().mockRejectedValue(new Error("relay unreachable")),
    };
    const adapter = new WalletConnectAdapter({
      client,
      ...session(),
      storage,
    });

    await expect(adapter.disconnect()).rejects.toThrow("relay unreachable");

    // A relay error must not leave a dead session to be restored next load.
    expect(loadWalletConnectSession(storage, NOW)).toBeNull();
  });

  it("works with a client that exposes no disconnect", async () => {
    const adapter = new WalletConnectAdapter({
      client: { request: vi.fn() },
      ...session(),
      storage,
    });

    await expect(adapter.disconnect()).resolves.toBeUndefined();
    expect(loadWalletConnectSession(storage, NOW)).toBeNull();
  });
});
