/**
 * Tests for stellar.toml schema version validation (Issue #779).
 * Network-free: `fetch` is stubbed, so no HTTP request is made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  StellarTomlParser,
  SUPPORTED_TOML_VERSIONS,
  UnsupportedTomlVersionError,
} from "../src/anchors/StellarTomlParser.js";

const DOMAIN = "example.com";

function stubToml(body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => body,
    })
  );
}

describe("SUPPORTED_TOML_VERSIONS", () => {
  it("lists the supported major.minor versions", () => {
    expect(SUPPORTED_TOML_VERSIONS).toEqual(["2.0", "2.1"]);
  });
});

describe("StellarTomlParser — VERSION validation", () => {
  let parser: StellarTomlParser;

  beforeEach(() => {
    parser = new StellarTomlParser();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts a document with no VERSION field", async () => {
    stubToml(`ACCOUNTS = ["GABC"]\n`);
    const meta = await parser.fetch(DOMAIN);
    expect(meta.domain).toBe(DOMAIN);
  });

  it.each(['"2.0"', '"2.1"', '"2.0.0"', '"2.1.3"', '"2"'])(
    "accepts VERSION = %s",
    async (version) => {
      stubToml(`VERSION = ${version}\n`);
      await expect(parser.fetch(DOMAIN)).resolves.toMatchObject({
        domain: DOMAIN,
      });
    }
  );

  it("accepts an unquoted VERSION, which TOML parses as a number", async () => {
    stubToml(`VERSION = 2.0\n`);
    await expect(parser.fetch(DOMAIN)).resolves.toMatchObject({
      domain: DOMAIN,
    });
  });

  it.each(["2.04", "2.14"])(
    "rejects unsupported unquoted VERSION = %s without rounding it into support",
    async (version) => {
      stubToml(`VERSION = ${version}\n`);
      await expect(parser.fetch(DOMAIN)).rejects.toBeInstanceOf(
        UnsupportedTomlVersionError
      );
    }
  );

  it("rejects a future schema version", async () => {
    stubToml(`VERSION = "3.0"\n`);
    await expect(parser.fetch(DOMAIN)).rejects.toBeInstanceOf(
      UnsupportedTomlVersionError
    );
  });

  it("rejects an older schema version", async () => {
    stubToml(`VERSION = "1.9"\n`);
    await expect(parser.fetch(DOMAIN)).rejects.toBeInstanceOf(
      UnsupportedTomlVersionError
    );
  });

  it("rejects a malformed minor rather than degrading it to .0", async () => {
    // "2.x" must not be read as "2.0".
    stubToml(`VERSION = "2.x"\n`);
    await expect(parser.fetch(DOMAIN)).rejects.toBeInstanceOf(
      UnsupportedTomlVersionError
    );
  });

  it.each(['"2.1.x"', '"2.1."', '"2.1.0.extra"'])(
    "rejects malformed or extra patch components in VERSION = %s",
    async (version) => {
      stubToml(`VERSION = ${version}\n`);
      await expect(parser.fetch(DOMAIN)).rejects.toBeInstanceOf(
        UnsupportedTomlVersionError
      );
    }
  );

  it("names the encountered version, the domain, and the supported set", async () => {
    stubToml(`VERSION = "3.0"\n`);
    try {
      await parser.fetch(DOMAIN);
      throw new Error("expected fetch to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedTomlVersionError);
      const err = error as UnsupportedTomlVersionError;
      expect(err.version).toBe("3.0");
      expect(err.domain).toBe(DOMAIN);
      expect(err.supportedVersions).toEqual(SUPPORTED_TOML_VERSIONS);
      expect(err.name).toBe("UnsupportedTomlVersionError");
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("3.0");
      expect(err.message).toContain(DOMAIN);
    }
  });

  it("does not cache a document it rejected", async () => {
    stubToml(`VERSION = "3.0"\n`);
    await expect(parser.fetch(DOMAIN)).rejects.toBeInstanceOf(
      UnsupportedTomlVersionError
    );

    // A poisoned cache entry would mask a later corrected document.
    expect(parser.isCached(DOMAIN)).toBe(false);

    stubToml(`VERSION = "2.0"\n`);
    await expect(parser.fetch(DOMAIN)).resolves.toMatchObject({
      domain: DOMAIN,
    });
  });
});
