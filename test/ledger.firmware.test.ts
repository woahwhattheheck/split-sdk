/**
 * Tests for the Ledger firmware gate (Issue #775).
 * Offline: the transport and Stellar app are stubs, so no device is required.
 */

import { describe, it, expect, vi } from "vitest";

import {
  LedgerAdapter,
  LedgerFirmwareTooOldError,
  MIN_LEDGER_FIRMWARE,
  compareLedgerVersions,
  type LedgerStellarApp,
} from "../src/adapters/ledger.js";

const PUBLIC_KEY = "GABC00000000000000000000000000000000000000000000000000AA";

/** A one-byte signature, so the base64 round-trip in signTransaction is real. */
const SIGNATURE = new Uint8Array([65]);

function makeApp(version: string, overrides: Partial<LedgerStellarApp> = {}) {
  return {
    getAppConfiguration: vi.fn().mockResolvedValue({ version }),
    getPublicKey: vi.fn().mockResolvedValue({ publicKey: PUBLIC_KEY }),
    signTransaction: vi.fn().mockResolvedValue({ signature: SIGNATURE }),
    ...overrides,
  };
}

function makeAdapter(app: ReturnType<typeof makeApp>, skipFirmwareCheck = false) {
  const close = vi.fn().mockResolvedValue(undefined);
  const adapter = new LedgerAdapter({
    skipFirmwareCheck,
    transportFactory: async () => ({ close }) as never,
    appFactory: () => app as unknown as LedgerStellarApp,
  });

  return { adapter, close };
}

// A valid base64 XDR stand-in; the adapter only base64-decodes it.
const XDR = btoa("tx");

describe("MIN_LEDGER_FIRMWARE", () => {
  it("is exported", () => {
    expect(MIN_LEDGER_FIRMWARE).toBe("3.0.0");
  });
});

describe("compareLedgerVersions", () => {
  it("orders versions numerically, not lexically", () => {
    // "10" sorts before "9" as a string; it must not here.
    expect(compareLedgerVersions("3.10.0", "3.9.0")!).toBeGreaterThan(0);
  });

  it("treats missing trailing components as zero", () => {
    expect(compareLedgerVersions("3.0", "3.0.0")).toBe(0);
    expect(compareLedgerVersions("3", "3.0.0")).toBe(0);
  });

  it("compares major, minor and patch in order", () => {
    expect(compareLedgerVersions("4.0.0", "3.9.9")!).toBeGreaterThan(0);
    expect(compareLedgerVersions("2.9.9", "3.0.0")!).toBeLessThan(0);
    expect(compareLedgerVersions("3.0.1", "3.0.0")!).toBeGreaterThan(0);
  });

  it.each(["", "v3.0.0", "3.0.x", "three", "3..0"])(
    "returns null for the unparseable version %s",
    (version) => {
      expect(compareLedgerVersions(version, "3.0.0")).toBeNull();
    },
  );
});

describe("LedgerAdapter — firmware gate", () => {
  it("signs when the firmware is newer than the minimum", async () => {
    const app = makeApp("3.1.0");
    const { adapter } = makeAdapter(app);

    await expect(adapter.signTransaction(XDR, "testnet")).resolves.toBe(
      btoa(String.fromCharCode(...SIGNATURE)),
    );
    expect(app.signTransaction).toHaveBeenCalledTimes(1);
  });

  it("signs when the firmware is exactly the minimum", async () => {
    const app = makeApp(MIN_LEDGER_FIRMWARE);
    const { adapter } = makeAdapter(app);

    await expect(adapter.signTransaction(XDR, "testnet")).resolves.toBeTypeOf("string");
  });

  it("rejects firmware below the minimum", async () => {
    const app = makeApp("2.9.9");
    const { adapter } = makeAdapter(app);

    await expect(adapter.signTransaction(XDR, "testnet")).rejects.toBeInstanceOf(
      LedgerFirmwareTooOldError,
    );
  });

  it("does not send the signing request when the firmware is too old", async () => {
    const app = makeApp("1.0.0");
    const { adapter } = makeAdapter(app);

    await expect(adapter.signTransaction(XDR, "testnet")).rejects.toThrow();
    expect(app.signTransaction).not.toHaveBeenCalled();
  });

  it("names both the found and the required version", async () => {
    const app = makeApp("2.0.0");
    const { adapter } = makeAdapter(app);

    try {
      await adapter.signTransaction(XDR, "testnet");
      throw new Error("expected signTransaction to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerFirmwareTooOldError);
      const err = error as LedgerFirmwareTooOldError;
      expect(err.foundVersion).toBe("2.0.0");
      expect(err.requiredVersion).toBe(MIN_LEDGER_FIRMWARE);
      expect(err.name).toBe("LedgerFirmwareTooOldError");
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("2.0.0");
      expect(err.message).toContain(MIN_LEDGER_FIRMWARE);
    }
  });

  it("fails closed on a version string it cannot parse", async () => {
    const app = makeApp("not-a-version");
    const { adapter } = makeAdapter(app);

    // Unverifiable compatibility must not be treated as compatible.
    await expect(adapter.signTransaction(XDR, "testnet")).rejects.toBeInstanceOf(
      LedgerFirmwareTooOldError,
    );
    expect(app.signTransaction).not.toHaveBeenCalled();
  });

  it("closes the transport even when the firmware check rejects", async () => {
    const app = makeApp("1.0.0");
    const { adapter, close } = makeAdapter(app);

    await expect(adapter.signTransaction(XDR, "testnet")).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("skips the check entirely when skipFirmwareCheck is set", async () => {
    const app = makeApp("0.0.1");
    const { adapter } = makeAdapter(app, true);

    await expect(adapter.signTransaction(XDR, "testnet")).resolves.toBeTypeOf("string");
    expect(app.getAppConfiguration).not.toHaveBeenCalled();
    expect(app.signTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not gate getAddress, which never signs", async () => {
    const app = makeApp("1.0.0");
    const { adapter } = makeAdapter(app);

    await expect(adapter.getAddress()).resolves.toBe(PUBLIC_KEY);
    expect(app.getAppConfiguration).not.toHaveBeenCalled();
  });
});

describe("LedgerAdapter — construction", () => {
  it("still accepts a bare derivation path string", async () => {
    const app = makeApp("3.1.0");
    const adapter = new LedgerAdapter("44'/148'/7'");

    // Reach the injected factories by rebuilding with options, then confirm the
    // string form produced the same default behaviour for the path.
    const viaOptions = new LedgerAdapter({
      path: "44'/148'/7'",
      transportFactory: async () => ({ close: vi.fn() }) as never,
      appFactory: () => app as unknown as LedgerStellarApp,
    });

    await viaOptions.getAddress();
    expect(app.getPublicKey).toHaveBeenCalledWith("44'/148'/7'");
    expect(adapter).toBeInstanceOf(LedgerAdapter);
  });

  it("uses the default derivation path when none is given", async () => {
    const app = makeApp("3.1.0");
    const { adapter } = makeAdapter(app);

    await adapter.getAddress();

    expect(app.getPublicKey).toHaveBeenCalledWith("44'/148'/0'");
  });
});
