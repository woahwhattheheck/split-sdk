/**
 * Tests for the xBull extension version gate (Issue #771).
 * Offline: `window` is stubbed, so no browser or extension is required.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import {
  ExtensionVersionError,
  MIN_XBULL_VERSION,
  XBullAdapter,
  compareExtensionVersions,
} from "../src/wallets/adapters/XBullAdapter.js";

const PUBLIC_KEY = "GABC00000000000000000000000000000000000000000000000000AA";

function stubXbull(
  options: { version?: string; sdkVersion?: string; omitVersion?: boolean } = {},
) {
  const connect = vi.fn().mockResolvedValue({ public_key: PUBLIC_KEY });
  const sign = vi.fn().mockResolvedValue({ xdr: "signed" });
  const onAccountChange = vi.fn().mockReturnValue(() => undefined);

  const xbull: Record<string, unknown> = { connect, sign, onAccountChange };
  if (!options.omitVersion && options.version !== undefined) {
    xbull["version"] = options.version;
  }

  const win: Record<string, unknown> = { xbull };
  if (options.sdkVersion !== undefined) {
    win["xBullSDK"] = { version: options.sdkVersion };
  }

  vi.stubGlobal("window", win);
  return { connect, sign, onAccountChange };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MIN_XBULL_VERSION", () => {
  it("is exported", () => {
    expect(MIN_XBULL_VERSION).toBe("1.4.0");
  });
});

describe("compareExtensionVersions", () => {
  it("compares numerically rather than lexically", () => {
    expect(compareExtensionVersions("1.10.0", "1.9.0")!).toBeGreaterThan(0);
  });

  it("treats missing trailing components as zero", () => {
    expect(compareExtensionVersions("1.4", "1.4.0")).toBe(0);
    expect(compareExtensionVersions("2", "2.0.0")).toBe(0);
  });

  it("orders major, minor and patch", () => {
    expect(compareExtensionVersions("2.0.0", "1.9.9")!).toBeGreaterThan(0);
    expect(compareExtensionVersions("1.3.9", "1.4.0")!).toBeLessThan(0);
    expect(compareExtensionVersions("1.4.1", "1.4.0")!).toBeGreaterThan(0);
  });

  it.each([undefined, null, "", "v1.4.0", "1.4.x", "latest", 140])(
    "returns null for the unusable version %s",
    (version) => {
      expect(compareExtensionVersions(version, "1.4.0")).toBeNull();
    },
  );
});

describe("XBullAdapter — version gate on connect()", () => {
  it("connects when the extension is newer than the minimum", async () => {
    const { connect } = stubXbull({ version: "1.5.0" });

    await expect(new XBullAdapter().connect()).resolves.toBe(PUBLIC_KEY);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("connects when the extension is exactly the minimum", async () => {
    stubXbull({ version: MIN_XBULL_VERSION });

    await expect(new XBullAdapter().connect()).resolves.toBe(PUBLIC_KEY);
  });

  it("rejects an extension below the minimum", async () => {
    stubXbull({ version: "1.3.9" });

    await expect(new XBullAdapter().connect()).rejects.toBeInstanceOf(
      ExtensionVersionError,
    );
  });

  it("does not call connect() on the extension when the version is too old", async () => {
    const { connect } = stubXbull({ version: "1.0.0" });

    await expect(new XBullAdapter().connect()).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });

  it("names the extension, the found version and the required version", async () => {
    stubXbull({ version: "1.2.3" });

    try {
      await new XBullAdapter().connect();
      throw new Error("expected connect to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ExtensionVersionError);
      const err = error as ExtensionVersionError;
      expect(err.extension).toBe("xBull");
      expect(err.foundVersion).toBe("1.2.3");
      expect(err.requiredVersion).toBe(MIN_XBULL_VERSION);
      expect(err.name).toBe("ExtensionVersionError");
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("1.2.3");
      expect(err.message).toContain(MIN_XBULL_VERSION);
    }
  });

  it("falls back to window.xBullSDK.version when window.xbull has none", async () => {
    const { connect } = stubXbull({ omitVersion: true, sdkVersion: "1.6.0" });

    await expect(new XBullAdapter().connect()).resolves.toBe(PUBLIC_KEY);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("rejects when neither handle reports a version", async () => {
    stubXbull({ omitVersion: true });

    await expect(new XBullAdapter().connect()).rejects.toBeInstanceOf(
      ExtensionVersionError,
    );
  });

  it("says so when the version was not reported at all", async () => {
    stubXbull({ omitVersion: true });

    await expect(new XBullAdapter().connect()).rejects.toThrow(
      /not reported/,
    );
  });

  it("rejects an unparseable version", async () => {
    stubXbull({ version: "beta" });

    await expect(new XBullAdapter().connect()).rejects.toBeInstanceOf(
      ExtensionVersionError,
    );
  });

  it("skips the check when skipVersionCheck is set", async () => {
    const { connect } = stubXbull({ version: "0.0.1" });

    await expect(
      new XBullAdapter({ skipVersionCheck: true }).connect(),
    ).resolves.toBe(PUBLIC_KEY);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("still reports a missing extension before checking any version", async () => {
    vi.stubGlobal("window", {});

    await expect(new XBullAdapter().connect()).rejects.toThrow(
      "xBull wallet not installed",
    );
  });
});

describe("XBullAdapter — version gate on getAddress()", () => {
  it("gates the connect path taken by getAddress()", async () => {
    const { connect } = stubXbull({ version: "1.0.0" });

    await expect(new XBullAdapter().getAddress()).rejects.toBeInstanceOf(
      ExtensionVersionError,
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("returns the address on a supported extension", async () => {
    stubXbull({ version: "1.4.0" });

    await expect(new XBullAdapter().getAddress()).resolves.toBe(PUBLIC_KEY);
  });

  it("does not re-check once already connected", async () => {
    stubXbull({ version: "1.5.0" });
    const adapter = new XBullAdapter();

    await adapter.connect();
    // Drop the version after connecting; the cached key must still be returned.
    vi.stubGlobal("window", { xbull: { connect: vi.fn(), sign: vi.fn(), onAccountChange: vi.fn() } });

    await expect(adapter.getAddress()).resolves.toBe(PUBLIC_KEY);
  });
});

describe("XBullAdapter — existing behaviour", () => {
  it("signs through the extension once connected", async () => {
    const { sign } = stubXbull({ version: "1.5.0" });
    const adapter = new XBullAdapter();

    await adapter.connect();

    await expect(adapter.signTransaction("xdr", "testnet")).resolves.toBe("signed");
    expect(sign).toHaveBeenCalledWith({ xdr: "xdr", publicKey: PUBLIC_KEY });
  });

  it("clears state on disconnect", async () => {
    stubXbull({ version: "1.5.0" });
    const adapter = new XBullAdapter();

    await adapter.connect();
    adapter.disconnect();

    await expect(adapter.sign("xdr")).rejects.toThrow("xBull wallet not connected");
  });
});
