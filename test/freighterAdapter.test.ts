/**
 * Tests for FreighterAdapter's not-installed handling (#772)
 * Covers: typed error, install URL, non-browser contexts, unchanged happy path
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { FreighterAdapter } from "../src/wallets/adapters/FreighterAdapter.js";
import {
  FreighterNotInstalledError,
  isFreighterNotInstalledError,
  FREIGHTER_INSTALL_URL,
  StellarSplitError,
} from "../src/errors.js";

const MOCK_PUBLIC_KEY = "GBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const MOCK_XDR = "AAAAAgAAAAA=";

/** A Freighter API double that records the calls the adapter makes. */
function installedFreighter() {
  return {
    isConnected: vi.fn().mockResolvedValue(true),
    getPublicKey: vi.fn().mockResolvedValue(MOCK_PUBLIC_KEY),
    signTransaction: vi.fn().mockResolvedValue("signed-xdr"),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FreighterAdapter — extension absent", () => {
  it("connect() throws FreighterNotInstalledError instead of a raw TypeError", async () => {
    vi.stubGlobal("window", {});
    const adapter = new FreighterAdapter();

    await expect(adapter.connect()).rejects.toThrow(FreighterNotInstalledError);
  });

  it("sign() throws FreighterNotInstalledError", async () => {
    vi.stubGlobal("window", {});
    const adapter = new FreighterAdapter();

    await expect(adapter.sign(MOCK_XDR, "TESTNET")).rejects.toThrow(
      FreighterNotInstalledError
    );
  });

  it("signTransaction() throws FreighterNotInstalledError through sign()", async () => {
    vi.stubGlobal("window", {});
    const adapter = new FreighterAdapter();

    await expect(adapter.signTransaction(MOCK_XDR, "TESTNET")).rejects.toThrow(
      FreighterNotInstalledError
    );
  });

  it("getAddress() throws FreighterNotInstalledError", async () => {
    vi.stubGlobal("window", {});
    const adapter = new FreighterAdapter();

    await expect(adapter.getAddress()).rejects.toThrow(FreighterNotInstalledError);
  });

  it("carries the install URL in the message, the context and a typed field", async () => {
    vi.stubGlobal("window", {});
    const adapter = new FreighterAdapter();

    const error = await adapter.connect().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(FreighterNotInstalledError);
    const typed = error as FreighterNotInstalledError;
    expect(typed.installUrl).toBe("https://www.freighter.app");
    expect(FREIGHTER_INSTALL_URL).toBe("https://www.freighter.app");
    expect(typed.message).toContain("https://www.freighter.app");
    expect(typed.code).toBe("FREIGHTER_NOT_INSTALLED");
    expect(typed.name).toBe("FreighterNotInstalledError");
    expect(typed.context).toEqual({ installUrl: "https://www.freighter.app" });
  });

  it("remains catchable as StellarSplitError and by the type guard", async () => {
    vi.stubGlobal("window", {});
    const adapter = new FreighterAdapter();

    const error = await adapter.connect().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(StellarSplitError);
    expect(error).toBeInstanceOf(Error);
    expect(isFreighterNotInstalledError(error)).toBe(true);
    expect(isFreighterNotInstalledError(new Error("other"))).toBe(false);
  });
});

describe("FreighterAdapter — non-browser contexts", () => {
  // The reported crash: `window` present but undefined made `window.freighter`
  // throw `TypeError: Cannot read properties of undefined` before any guard ran.
  it("throws the typed error, not a TypeError, when window is undefined", async () => {
    vi.stubGlobal("window", undefined);
    const adapter = new FreighterAdapter();

    const error = await adapter.connect().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(FreighterNotInstalledError);
    expect(error).not.toBeInstanceOf(TypeError);
  });

  it("throws the typed error from sign() and getAddress() with no window", async () => {
    vi.stubGlobal("window", undefined);
    const adapter = new FreighterAdapter();

    await expect(adapter.sign(MOCK_XDR, "TESTNET")).rejects.toThrow(
      FreighterNotInstalledError
    );
    await expect(adapter.getAddress()).rejects.toThrow(FreighterNotInstalledError);
  });
});

describe("FreighterAdapter — extension present, behaviour unchanged", () => {
  it("connect() returns the public key and starts account-change polling", async () => {
    const freighter = installedFreighter();
    vi.stubGlobal("window", { freighter });
    const adapter = new FreighterAdapter();

    const address = await adapter.connect();

    expect(address).toBe(MOCK_PUBLIC_KEY);
    expect(freighter.getPublicKey).toHaveBeenCalledTimes(1);
    adapter.disconnect();
  });

  it("sign() delegates to signTransaction with the same arguments", async () => {
    const freighter = installedFreighter();
    vi.stubGlobal("window", { freighter });
    const adapter = new FreighterAdapter();

    await expect(adapter.sign(MOCK_XDR, "TESTNET")).resolves.toBe("signed-xdr");
    expect(freighter.signTransaction).toHaveBeenCalledWith(MOCK_XDR, "TESTNET");
  });

  it("getAddress() returns the public key", async () => {
    const freighter = installedFreighter();
    vi.stubGlobal("window", { freighter });
    const adapter = new FreighterAdapter();

    await expect(adapter.getAddress()).resolves.toBe(MOCK_PUBLIC_KEY);
  });

  it("notifies account-change handlers when the address changes", async () => {
    vi.useFakeTimers();
    const freighter = installedFreighter();
    freighter.getPublicKey
      .mockResolvedValueOnce(MOCK_PUBLIC_KEY)
      .mockResolvedValue("GC-SECOND-ADDRESS");
    vi.stubGlobal("window", { freighter });

    const adapter = new FreighterAdapter();
    const handler = vi.fn();
    adapter.onAccountChange(handler);
    await adapter.connect();

    await vi.advanceTimersByTimeAsync(2000);

    expect(handler).toHaveBeenCalledWith("GC-SECOND-ADDRESS");
    adapter.disconnect();
    vi.useRealTimers();
  });

  it("polling stops quietly if the extension goes away mid-session", async () => {
    vi.useFakeTimers();
    const freighter = installedFreighter();
    vi.stubGlobal("window", { freighter });

    const adapter = new FreighterAdapter();
    const handler = vi.fn();
    adapter.onAccountChange(handler);
    await adapter.connect();

    // User disables the extension while the page is still open.
    vi.stubGlobal("window", {});
    await expect(vi.advanceTimersByTimeAsync(4000)).resolves.not.toThrow();

    expect(handler).not.toHaveBeenCalled();
    adapter.disconnect();
    vi.useRealTimers();
  });
});
