import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { APP_DIR_NAME, defaultSessionPath, loadLocalEnv, readConfig } from "../src/telegram/config.js";

const KEYS = ["TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_SESSION_PATH"] as const;

function stashEnv(): Record<string, string | undefined> {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("readConfig", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = stashEnv();
  });

  afterEach(() => {
    restoreEnv(saved);
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

  describe("default session location", () => {
    beforeEach(() => {
      process.env.TELEGRAM_API_ID = "12345";
      process.env.TELEGRAM_API_HASH = " hash-with-spaces ";
    });

    it("uses an app-owned directory in the user's home, not the repository", () => {
      const config = readConfig("/projects/tg", "/home/tester");

      assert.equal(config.apiId, 12345);
      assert.equal(config.apiHash, "hash-with-spaces");
      assert.equal(config.sessionPath, join("/home/tester", APP_DIR_NAME, "session"));
      assert.equal(config.ownsSessionDirectory, true);
      assert.ok(
        !config.sessionPath.startsWith("/projects/tg"),
        "the default session must live outside the repository",
      );
    });

    it("matches defaultSessionPath", () => {
      assert.equal(readConfig("/projects/tg", "/home/tester").sessionPath, defaultSessionPath("/home/tester"));
    });
  });

  describe("custom session location", () => {
    beforeEach(() => {
      process.env.TELEGRAM_API_ID = "12345";
      process.env.TELEGRAM_API_HASH = "hash";
    });

    it("resolves a relative path against the project and disclaims ownership", () => {
      process.env.TELEGRAM_SESSION_PATH = "custom/session";

      const config = readConfig("/projects/tg", "/home/tester");

      assert.equal(config.sessionPath, resolve("/projects/tg", "custom/session"));
      assert.equal(
        config.ownsSessionDirectory,
        false,
        "a user-chosen directory is never ours to chmod",
      );
    });

    it("keeps an absolute path as given and disclaims ownership", () => {
      process.env.TELEGRAM_SESSION_PATH = "/var/secrets/session";

      const config = readConfig("/projects/tg", "/home/tester");

      assert.equal(config.sessionPath, "/var/secrets/session");
      assert.equal(config.ownsSessionDirectory, false);
    });

    it("falls back to the default when the variable is blank", () => {
      process.env.TELEGRAM_SESSION_PATH = "   ";

      const config = readConfig("/projects/tg", "/home/tester");

      assert.equal(config.sessionPath, defaultSessionPath("/home/tester"));
      assert.equal(config.ownsSessionDirectory, true);
    });
  });
});

describe("loadLocalEnv", () => {
  let root: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tg-env-"));
    saved = stashEnv();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    restoreEnv(saved);
  });

  it("does nothing when there is no .env file", () => {
    loadLocalEnv(root);
    assert.equal(process.env.TELEGRAM_API_ID, undefined);
  });

  it("loads values from a local .env file", () => {
    writeFileSync(join(root, ".env"), "TELEGRAM_API_ID=98765\nTELEGRAM_API_HASH=from-env-file\n");

    loadLocalEnv(root);
    const config = readConfig(root, "/home/tester");

    assert.equal(config.apiId, 98765);
    assert.equal(config.apiHash, "from-env-file");
  });
});
