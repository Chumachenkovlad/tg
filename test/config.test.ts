import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadLocalEnv, readConfig } from "../src/telegram/config.js";

const KEYS = ["TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_SESSION_PATH"] as const;

describe("readConfig", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("reports every missing variable at once", () => {
    assert.throws(() => readConfig(), /TELEGRAM_API_ID, TELEGRAM_API_HASH/);
  });

  it("reports only the variable that is missing", () => {
    process.env.TELEGRAM_API_ID = "12345";
    assert.throws(() => readConfig(), /Missing environment variable\(s\): TELEGRAM_API_HASH\./);
  });

  it("treats a blank value as missing", () => {
    process.env.TELEGRAM_API_ID = "   ";
    process.env.TELEGRAM_API_HASH = "hash";
    assert.throws(() => readConfig(), /TELEGRAM_API_ID/);
  });

  it("rejects a non-numeric api id", () => {
    process.env.TELEGRAM_API_ID = "not-a-number";
    process.env.TELEGRAM_API_HASH = "hash";
    assert.throws(() => readConfig(), /positive integer/);
  });

  it("rejects a non-positive api id", () => {
    process.env.TELEGRAM_API_HASH = "hash";
    for (const value of ["0", "-1", "1.5"]) {
      process.env.TELEGRAM_API_ID = value;
      assert.throws(() => readConfig(), /positive integer/, `expected ${value} to be rejected`);
    }
  });

  it("defaults the session path to .telegram/session inside the project", () => {
    process.env.TELEGRAM_API_ID = "12345";
    process.env.TELEGRAM_API_HASH = " hash-with-spaces ";

    const config = readConfig("/projects/tg");

    assert.equal(config.apiId, 12345);
    assert.equal(config.apiHash, "hash-with-spaces");
    assert.equal(config.sessionPath, resolve("/projects/tg", ".telegram/session"));
  });

  it("honours TELEGRAM_SESSION_PATH, relative or absolute", () => {
    process.env.TELEGRAM_API_ID = "12345";
    process.env.TELEGRAM_API_HASH = "hash";

    process.env.TELEGRAM_SESSION_PATH = "custom/session";
    assert.equal(readConfig("/projects/tg").sessionPath, resolve("/projects/tg", "custom/session"));

    process.env.TELEGRAM_SESSION_PATH = "/var/secrets/session";
    assert.equal(readConfig("/projects/tg").sessionPath, "/var/secrets/session");
  });
});

describe("loadLocalEnv", () => {
  let root: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tg-env-"));
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("does nothing when there is no .env file", () => {
    loadLocalEnv(root);
    assert.equal(process.env.TELEGRAM_API_ID, undefined);
  });

  it("loads values from a local .env file", () => {
    writeFileSync(join(root, ".env"), "TELEGRAM_API_ID=98765\nTELEGRAM_API_HASH=from-env-file\n");

    loadLocalEnv(root);
    const config = readConfig(root);

    assert.equal(config.apiId, 98765);
    assert.equal(config.apiHash, "from-env-file");
  });
});
