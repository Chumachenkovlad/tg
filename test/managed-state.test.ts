import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
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
  it("puts the state next to the session, in the app's own directory", () => {
    assert.equal(statePathFor("/home/t/.tg-8042/session"), "/home/t/.tg-8042/managed-state.json");
  });

  it("follows a custom session path", () => {
    assert.equal(statePathFor("/var/secrets/session"), "/var/secrets/managed-state.json");
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
      assert.match(error.message, /create a second forum/);
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

  it("writes the file owner-only, in an owner-only directory", () => {
    const store = new FileManagedStateStore(path, { ownsDirectory: true });

    store.save(emptyState());

    assert.equal(mode(path), 0o600);
    assert.equal(mode(dirname(path)), 0o700);
  });

  it("leaves a directory it does not own alone", () => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });

    new FileManagedStateStore(path, { ownsDirectory: false }).save(emptyState());

    assert.equal(mode(dirname(path)), 0o755, "a directory the user set up is not chmod-ed");
    assert.equal(mode(path), 0o600, "the file is still ours to protect");
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
      assert.match(error.message, /create a second forum/);
      return true;
    });
  });

  it("treats an empty file as no state, since nothing was recorded in it", () => {
    new FileManagedStateStore(path).save(emptyState());
    writeFileSync(path, "", "utf8");

    assert.deepEqual(new FileManagedStateStore(path).load(), emptyState());
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
