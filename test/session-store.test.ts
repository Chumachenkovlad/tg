import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FileSessionStore } from "../src/telegram/session-store.js";
import { SessionReadError } from "../src/telegram/types.js";

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("FileSessionStore", () => {
  let root: string;
  let sessionPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tg-session-"));
    sessionPath = join(root, "app-dir", "session");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns an empty string when no session is stored", () => {
    assert.equal(new FileSessionStore(sessionPath).load(), "");
  });

  it("creates the session file with 0600 and a new directory with 0700", () => {
    const store = new FileSessionStore(sessionPath, { ownsDirectory: true });
    store.save("SESSION_VALUE");

    assert.equal(mode(sessionPath), 0o600);
    assert.equal(mode(dirname(sessionPath)), 0o700);
    assert.equal(store.load(), "SESSION_VALUE");
  });

  it("creates a new directory with 0700 even when it is not app-owned", () => {
    const store = new FileSessionStore(sessionPath, { ownsDirectory: false });
    store.save("SESSION_VALUE");

    assert.equal(mode(sessionPath), 0o600);
    assert.equal(mode(dirname(sessionPath)), 0o700);
  });

  describe("app-owned directory", () => {
    it("tightens an existing permissive directory to 0700", () => {
      mkdirSync(dirname(sessionPath), { recursive: true });
      chmodSync(dirname(sessionPath), 0o755);

      new FileSessionStore(sessionPath, { ownsDirectory: true }).save("SESSION_VALUE");

      assert.equal(mode(dirname(sessionPath)), 0o700);
      assert.equal(mode(sessionPath), 0o600);
    });
  });

  describe("custom (not app-owned) session path", () => {
    it("never changes the permissions of an existing parent directory", () => {
      const parent = join(root, "shared");
      mkdirSync(parent, { recursive: true });
      chmodSync(parent, 0o755);
      const customPath = join(parent, "session");

      new FileSessionStore(customPath, { ownsDirectory: false }).save("SESSION_VALUE");

      assert.equal(mode(parent), 0o755, "parent directory must be left as the user set it");
      assert.equal(mode(customPath), 0o600, "the session file itself must still be 0600");
    });

    it("leaves the parent directory alone on load too", () => {
      const parent = join(root, "shared");
      mkdirSync(parent, { recursive: true });
      const customPath = join(parent, "session");
      writeFileSync(customPath, "STORED_VALUE\n");
      chmodSync(customPath, 0o644);
      chmodSync(parent, 0o777);

      const loaded = new FileSessionStore(customPath, { ownsDirectory: false }).load();

      assert.equal(loaded, "STORED_VALUE");
      assert.equal(mode(parent), 0o777);
      assert.equal(mode(customPath), 0o600);
    });

    it("defaults to not owning the directory", () => {
      const parent = join(root, "shared");
      mkdirSync(parent, { recursive: true });
      chmodSync(parent, 0o750);

      new FileSessionStore(join(parent, "session")).save("SESSION_VALUE");

      assert.equal(mode(parent), 0o750);
    });
  });

  describe("session file permissions", () => {
    it("tightens an existing permissive session file on save", () => {
      mkdirSync(dirname(sessionPath), { recursive: true });
      writeFileSync(sessionPath, "OLD_VALUE\n");
      chmodSync(sessionPath, 0o644);

      new FileSessionStore(sessionPath, { ownsDirectory: true }).save("NEW_VALUE");

      assert.equal(mode(sessionPath), 0o600);
    });

    it("tightens an existing permissive session file on load", () => {
      mkdirSync(dirname(sessionPath), { recursive: true });
      writeFileSync(sessionPath, "STORED_VALUE\n");
      chmodSync(sessionPath, 0o666);

      const loaded = new FileSessionStore(sessionPath, { ownsDirectory: true }).load();

      assert.equal(loaded, "STORED_VALUE");
      assert.equal(mode(sessionPath), 0o600);
    });

    it("keeps permissions tight across repeated saves", () => {
      const store = new FileSessionStore(sessionPath, { ownsDirectory: true });
      store.save("FIRST");
      chmodSync(sessionPath, 0o664);
      store.save("SECOND");

      assert.equal(mode(sessionPath), 0o600);
      assert.equal(store.load(), "SECOND");
    });
  });

  describe("read failures", () => {
    it("raises SessionReadError instead of reporting 'no session'", () => {
      // A directory where the session file is expected: readFileSync fails with
      // EISDIR for any user, root included.
      mkdirSync(sessionPath, { recursive: true });
      const store = new FileSessionStore(sessionPath, { ownsDirectory: true });

      assert.throws(
        () => store.load(),
        (error: unknown) => {
          assert.ok(error instanceof SessionReadError);
          assert.match(error.message, /Cannot read the session file/);
          assert.match(error.message, /EISDIR/);
          return true;
        },
      );
    });
  });

  it("describes the location relative to the working directory", () => {
    const store = new FileSessionStore(join(process.cwd(), ".telegram", "session"));
    assert.equal(store.describe(), ".telegram/session");
  });

  it("describes a location outside the working directory as an absolute path", () => {
    const store = new FileSessionStore("/var/secrets/session");
    assert.equal(store.describe(), "/var/secrets/session");
  });
});

describe("FileSessionStore.fromConfig", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tg-config-store-"));
    chmodSync(root, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("carries directory ownership from the config", () => {
    const base = { apiId: 1, apiHash: "hash", sessionPath: join(root, "session") };

    FileSessionStore.fromConfig({ ...base, ownsSessionDirectory: false }).save("VALUE");
    assert.equal(mode(root), 0o755, "a custom path must not touch its parent directory");

    FileSessionStore.fromConfig({ ...base, ownsSessionDirectory: true }).save("VALUE");
    assert.equal(mode(root), 0o700, "an app-owned directory is tightened");
  });
});
