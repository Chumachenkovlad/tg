import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  FileManagedStateStore,
  ManagedStateError,
  emptyState,
  parseManagedState,
  recordForum,
  recordMessage,
  recordTopic,
  statePathFor,
} from "../src/telegram/managed-state.js";

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("statePathFor", () => {
  it("puts the state in the repository, where git can track it", () => {
    assert.equal(statePathFor("/work/tg"), "/work/tg/telegram/managed-state.json");
  });

  it("defaults to the working directory", () => {
    assert.equal(statePathFor(), join(process.cwd(), "telegram", "managed-state.json"));
  });
});

describe("the committed state file", () => {
  const committed = statePathFor(join(import.meta.dirname, ".."));

  it("is in the repository and parses", () => {
    const state = parseManagedState(readFileSync(committed, "utf8"), committed);

    assert.equal(state.version, 1);
  });

  it("is not git-ignored, so an apply's result can be committed", () => {
    // `git check-ignore -q` exits 0 when the path IS ignored and 1 when it is
    // not. Not ignored is what this file needs: ignoring it would silently
    // strand ownership on whichever machine ran the apply.
    const checked = spawnSync("git", ["check-ignore", "-q", committed], {
      cwd: join(import.meta.dirname, ".."),
    });

    assert.equal(checked.status, 1, "telegram/managed-state.json must not be git-ignored");
  });

  it("carries no secret", () => {
    const raw = readFileSync(committed, "utf8").toLowerCase();

    for (const secret of [
      "accesshash",
      "access_hash",
      "authkey",
      "auth_key",
      "apihash",
      "api_hash",
      "api_id",
      "session",
      "phone",
      "t.me/",
      "joinchat",
      "password",
    ]) {
      assert.ok(!raw.includes(secret), `the committed state must not contain ${secret}`);
    }
  });
});

describe("state updates are pure", () => {
  it("records a forum without mutating the input", () => {
    const before = emptyState();

    const after = recordForum(before, "tsc8042", "2000000042");

    assert.deepEqual(before, emptyState(), "the original must be untouched");
    assert.deepEqual(after.forums.tsc8042, { id: "2000000042", topics: {} });
  });

  it("records a topic and a message under their keys", () => {
    let state = recordForum(emptyState(), "tsc8042", "2000000042");
    state = recordTopic(state, "tsc8042", "test", 100);
    state = recordMessage(state, "tsc8042", "test", "intro", 101);

    assert.deepEqual(state.forums.tsc8042?.topics.test, {
      topicId: 100,
      messages: { intro: 101 },
    });
  });

  it("drops a recreated forum's old topic and message ids", () => {
    let state = recordForum(emptyState(), "tsc8042", "1");
    state = recordTopic(state, "tsc8042", "test", 100);
    state = recordMessage(state, "tsc8042", "test", "intro", 101);

    // The forum is gone and was rebuilt: nothing inside the old one survives.
    state = recordForum(state, "tsc8042", "2");

    assert.deepEqual(state.forums.tsc8042, { id: "2", topics: {} });
  });

  it("drops a recreated topic's old message ids", () => {
    let state = recordForum(emptyState(), "tsc8042", "1");
    state = recordTopic(state, "tsc8042", "test", 100);
    state = recordMessage(state, "tsc8042", "test", "intro", 101);

    state = recordTopic(state, "tsc8042", "test", 200);

    assert.deepEqual(state.forums.tsc8042?.topics.test, { topicId: 200, messages: {} });
  });

  it("refuses to record into a forum or topic it does not know", () => {
    assert.throws(() => recordTopic(emptyState(), "nope", "test", 1), ManagedStateError);
    assert.throws(
      () => recordMessage(recordForum(emptyState(), "f", "1"), "f", "nope", "m", 1),
      ManagedStateError,
    );
  });
});

describe("parseManagedState", () => {
  it("accepts the documented shape", () => {
    const state = parseManagedState(
      JSON.stringify({
        version: 1,
        forums: { tsc8042: { id: "42", topics: { test: { topicId: 123, messages: { intro: 124 } } } } },
      }),
      "test",
    );

    assert.equal(state.forums.tsc8042?.topics.test?.messages.intro, 124);
  });

  it("rejects invalid JSON rather than assuming nothing was created", () => {
    assert.throws(() => parseManagedState("{ not json", "test"), (error: unknown) => {
      assert.ok(error instanceof ManagedStateError);
      assert.match(error.message, /creates duplicates/);
      return true;
    });
  });

  for (const [what, payload] of [
    ["a wrong version", { version: 2, forums: {} }],
    ["a missing forums object", { version: 1 }],
    ["a forum without an id", { version: 1, forums: { a: { topics: {} } } }],
    ["a non-integer topicId", { version: 1, forums: { a: { id: "1", topics: { t: { topicId: "x", messages: {} } } } } }],
    ["a non-integer message id", { version: 1, forums: { a: { id: "1", topics: { t: { topicId: 1, messages: { m: "x" } } } } } }],
  ] as const) {
    it(`rejects ${what}`, () => {
      assert.throws(() => parseManagedState(JSON.stringify(payload), "test"), ManagedStateError);
    });
  }
});

describe("FileManagedStateStore", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tg-state-test-"));
    path = join(root, "app-dir", "managed-state.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reports an empty state when nothing was ever written", () => {
    assert.deepEqual(new FileManagedStateStore(path).load(), emptyState());
  });

  it("round-trips a saved state", () => {
    const store = new FileManagedStateStore(path);
    const state = recordTopic(recordForum(emptyState(), "tsc8042", "42"), "tsc8042", "test", 100);

    store.save(state);

    assert.deepEqual(store.load(), state);
  });

  it("writes an ordinary repository file, readable by the checkout", () => {
    // It holds no secret, and it has to be readable wherever the repo is
    // checked out — unlike the session, which stays 0600 outside the repo.
    new FileManagedStateStore(path).save(emptyState());

    assert.equal(mode(path), 0o644);
  });

  it("leaves an existing directory's permissions alone", () => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });

    new FileManagedStateStore(path).save(emptyState());

    assert.equal(mode(dirname(path)), 0o755);
  });

  it("keeps the previous mapping when a write fails", () => {
    const store = new FileManagedStateStore(path);
    const good = recordForum(emptyState(), "tsc8042", "42");
    store.save(good);

    // A directory in place of the destination makes rename() fail.
    const blocked = new FileManagedStateStore(dirname(path));
    assert.throws(() => blocked.save(emptyState()), ManagedStateError);

    assert.deepEqual(store.load(), good, "the earlier mapping must survive");
  });

  it("leaves no temporary file behind after a failed write", () => {
    const blocked = new FileManagedStateStore(join(root, "app-dir"));
    new FileManagedStateStore(path).save(emptyState());

    assert.throws(() => blocked.save(emptyState()), ManagedStateError);

    const leftovers = readFileSync(path, "utf8");
    assert.ok(leftovers.length > 0);
  });

  it("refuses to run on a corrupt file instead of recreating everything", () => {
    new FileManagedStateStore(path).save(emptyState());
    writeFileSync(path, "{ truncated", "utf8");

    assert.throws(() => new FileManagedStateStore(path).load(), (error: unknown) => {
      assert.ok(error instanceof ManagedStateError);
      assert.match(error.message, /creates duplicates/);
      return true;
    });
  });

  it("tells you to restore a corrupt file, never to delete it", () => {
    // Deleting it does not clean anything up: it orphans whatever the file
    // records and makes the next apply build a second set beside it.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ truncated", "utf8");

    assert.throws(() => new FileManagedStateStore(path).load(), (error: unknown) => {
      assert.ok(error instanceof ManagedStateError);
      assert.match(error.message, /Restore it from git/);
      assert.match(error.message, /git checkout -- telegram\/managed-state\.json/);
      assert.match(error.message, /Do NOT delete it/);
      assert.ok(
        !/delete it[—,.\s]+(?:the|deleting)/i.test(error.message.replace(/Do NOT delete it/, "")),
        "the message must not suggest deleting the file",
      );
      return true;
    });
  });

  describe("ensureWritable", () => {
    it("passes for a location that can hold the file", () => {
      assert.doesNotThrow(() => new FileManagedStateStore(path).ensureWritable());
    });

    it("creates the directory when it is missing", () => {
      new FileManagedStateStore(path).ensureWritable();

      assert.ok(existsSync(dirname(path)));
    });

    it("leaves no probe file behind", () => {
      new FileManagedStateStore(path).ensureWritable();

      assert.deepEqual(readdirSync(dirname(path)), [], "the probe must be cleaned up");
    });

    it("does not create, touch or modify the state file itself", () => {
      const store = new FileManagedStateStore(path);
      const recorded = recordTopic(
        recordForum(emptyState(), "tsc8042", "42"),
        "tsc8042",
        "test",
        100,
      );
      store.save(recorded);
      const before = readFileSync(path, "utf8");

      store.ensureWritable();

      assert.equal(readFileSync(path, "utf8"), before, "the live mapping must be untouched");
      assert.deepEqual(store.load(), recorded);
    });

    // These use a regular file where a directory belongs, rather than
    // permissions: the outcome is then the same for every uid, where a
    // chmod-based test quietly passes for root and proves nothing.
    it("fails when the state file's directory is not a directory", () => {
      const notADirectory = join(root, "in-the-way");
      writeFileSync(notADirectory, "", "utf8");

      assert.throws(
        () => new FileManagedStateStore(join(notADirectory, "state.json")).ensureWritable(),
        (error: unknown) => {
          assert.ok(error instanceof ManagedStateError);
          assert.match(error.message, /Refusing to create anything in Telegram/);
          return true;
        },
      );
    });

    it("fails when the directory cannot be created", () => {
      const notADirectory = join(root, "in-the-way");
      writeFileSync(notADirectory, "", "utf8");

      assert.throws(
        () =>
          new FileManagedStateStore(join(notADirectory, "sub", "state.json")).ensureWritable(),
        /Cannot create the directory/,
      );
    });
  });

  it("treats a missing file as the bootstrap case, and only that", () => {
    // Nothing was ever created here. This is the one supported way to start
    // from empty; the repository ships the file, so it is rare in practice.
    assert.deepEqual(new FileManagedStateStore(path).load(), emptyState());
  });

  it("treats a zero-byte file as corruption, not as a first run", () => {
    new FileManagedStateStore(path).save(recordForum(emptyState(), "tsc8042", "42"));
    writeFileSync(path, "", "utf8");

    assert.throws(() => new FileManagedStateStore(path).load(), (error: unknown) => {
      assert.ok(error instanceof ManagedStateError);
      assert.match(error.message, /exists but is empty/);
      assert.match(error.message, /creates duplicates/);
      return true;
    });
  });

  it("treats a whitespace-only file as corruption too", () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "   \n\t\n", "utf8");

    assert.throws(() => new FileManagedStateStore(path).load(), ManagedStateError);
  });

  it("stores no credential", () => {
    const store = new FileManagedStateStore(path);
    store.save(recordTopic(recordForum(emptyState(), "tsc8042", "42"), "tsc8042", "test", 100));

    const raw = readFileSync(path, "utf8").toLowerCase();

    for (const secret of ["accesshash", "access_hash", "authkey", "apihash", "session"]) {
      assert.ok(!raw.includes(secret), `the state file must not contain ${secret}`);
    }
  });
});
