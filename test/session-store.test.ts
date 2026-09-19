import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FileSessionStore } from "../src/telegram/session-store.js";
import { SessionReadError, SessionWriteError } from "../src/telegram/types.js";

/** Forces the temporary file somewhere unusable, to exercise the failure path. */
class FailingWriteStore extends FileSessionStore {
  constructor(
    path: string,
    private readonly temporary: string,
  ) {
    super(path, { ownsDirectory: true });
  }

  protected override temporaryPath(): string {
    return this.temporary;
  }
}

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

  describe("atomic writes", () => {
    it("replaces an existing session by rename, not in place", () => {
      const store = new FileSessionStore(sessionPath, { ownsDirectory: true });
      store.save("FIRST_SESSION");
      chmodSync(sessionPath, 0o644);
      const before = statSync(sessionPath).ino;

      store.save("SECOND_SESSION");

      assert.equal(store.load(), "SECOND_SESSION");
      assert.notEqual(
        statSync(sessionPath).ino,
        before,
        "an atomic replacement swaps the file, it does not truncate it in place",
      );
      assert.equal(mode(sessionPath), 0o600, "the replacement must not inherit 0644");
    });

    it("leaves no temporary files behind", () => {
      const store = new FileSessionStore(sessionPath, { ownsDirectory: true });
      store.save("FIRST_SESSION");
      store.save("SECOND_SESSION");

      assert.deepEqual(readdirSync(dirname(sessionPath)), ["session"]);
    });

    it("keeps the original session when the write fails", () => {
      const store = new FileSessionStore(sessionPath, { ownsDirectory: true });
      store.save("ORIGINAL_SESSION");
      const original = statSync(sessionPath).ino;

      // Temporary file in a directory that does not exist: the write fails
      // before anything can touch the destination.
      const failing = new FailingWriteStore(sessionPath, join(root, "missing", "tmp"));

      assert.throws(
        () => failing.save("REPLACEMENT_SESSION"),
        (error: unknown) => {
          assert.ok(error instanceof SessionWriteError);
          assert.match(error.message, /left unchanged/);
          return true;
        },
      );

      assert.equal(store.load(), "ORIGINAL_SESSION", "the stored session must survive");
      assert.equal(statSync(sessionPath).ino, original);
      assert.equal(mode(sessionPath), 0o600);
      assert.deepEqual(readdirSync(dirname(sessionPath)), ["session"]);
    });

    it("removes the temporary file when the rename fails", () => {
      const store = new FileSessionStore(sessionPath, { ownsDirectory: true });
      store.save("ORIGINAL_SESSION");

      // A directory at the destination makes rename() fail after a successful
      // temporary write, which is exactly the cleanup path under test.
      const blocked = join(root, "app-dir", "blocked");
      mkdirSync(blocked, { recursive: true });
      const blockedStore = new FileSessionStore(blocked, { ownsDirectory: true });

      assert.throws(() => blockedStore.save("VALUE"), SessionWriteError);

      const leftovers = readdirSync(dirname(sessionPath)).filter((name) => name.endsWith(".tmp"));
      assert.deepEqual(leftovers, [], "no temporary file may be left behind");
    });
  });

  describe("ensureWritable", () => {
    it("passes for a usable location and creates the directory", () => {
      const store = new FileSessionStore(sessionPath, { ownsDirectory: true });

      store.ensureWritable();

      assert.equal(mode(dirname(sessionPath)), 0o700);
      assert.deepEqual(readdirSync(dirname(sessionPath)), [], "the probe must be cleaned up");
    });

    it("does not touch an existing session", () => {
      const store = new FileSessionStore(sessionPath, { ownsDirectory: true });
      store.save("EXISTING_SESSION");
      const before = statSync(sessionPath).ino;

      store.ensureWritable();

      assert.equal(store.load(), "EXISTING_SESSION");
      assert.equal(statSync(sessionPath).ino, before);
      assert.deepEqual(readdirSync(dirname(sessionPath)), ["session"]);
    });

    it("fails when the location cannot hold a session file", () => {
      // The parent of the session file is a regular file, so no directory can
      // be created there.
      const blockedParent = join(root, "not-a-directory");
      writeFileSync(blockedParent, "x");
      const store = new FileSessionStore(join(blockedParent, "session"), { ownsDirectory: true });

      assert.throws(
        () => store.ensureWritable(),
        (error: unknown) => {
          assert.ok(error instanceof SessionWriteError);
          assert.match(error.message, /Cannot (create the session directory|write the session)/);
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
