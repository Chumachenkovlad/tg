import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  MutationLockedError,
  acquireMutationLock,
  lockPathFor,
  withMutationLock,
} from "../src/telegram/mutation-lock.js";

describe("lockPathFor", () => {
  it("keeps the lock next to the session, outside the repository", () => {
    // Transient machine state, unlike the identity mapping, which is
    // committed. A lock file in the repo would be noise at best.
    assert.equal(lockPathFor("/home/t/.tg-8042/session"), "/home/t/.tg-8042/apply.lock");
  });
});

describe("acquireMutationLock", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tg-lock-test-"));
    path = join(root, "app-dir", "apply.lock");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates the lock file and removes it on release", () => {
    const lock = acquireMutationLock(path);
    assert.ok(existsSync(path));

    lock.release();

    assert.ok(!existsSync(path));
  });

  it("refuses a second holder while the first has it", () => {
    const first = acquireMutationLock(path);

    try {
      assert.throws(() => acquireMutationLock(path), (error: unknown) => {
        assert.ok(error instanceof MutationLockedError);
        assert.match(error.message, /Another apply is already running/);
        assert.match(error.message, /apply\.lock/);
        return true;
      });
    } finally {
      first.release();
    }
  });

  it("lets the next run in once the first released", () => {
    acquireMutationLock(path).release();

    const second = acquireMutationLock(path);
    second.release();

    assert.ok(!existsSync(path));
  });

  it("names the holder so a stale lock is diagnosable", () => {
    const lock = acquireMutationLock(path);

    try {
      assert.throws(() => acquireMutationLock(path), new RegExp(`pid ${process.pid}`));
    } finally {
      lock.release();
    }
  });

  it("says when the holder is gone, without taking over by itself", () => {
    // Guessing that a lock is stale is how two applies end up running: a
    // dead pid and a slow one look the same from here, so this only reports.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ pid: 2 ** 22, startedAt: "2020-01-01T00:00:00.000Z", host: "old" }),
      "utf8",
    );

    assert.throws(() => acquireMutationLock(path), /that process is gone/);
    assert.ok(existsSync(path), "the lock must not be removed on our own initiative");
  });

  it("still reports a lock whose contents make no sense", () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not json", "utf8");

    assert.throws(() => acquireMutationLock(path), /could not be read/);
  });

  it("stores no secret in the lock file", () => {
    const lock = acquireMutationLock(path);

    try {
      const raw = readFileSync(path, "utf8").toLowerCase();
      for (const secret of ["accesshash", "authkey", "apihash", "session"]) {
        assert.ok(!raw.includes(secret));
      }
    } finally {
      lock.release();
    }
  });

  it("is released even when the guarded work throws", async () => {
    await assert.rejects(
      () =>
        withMutationLock(path, async () => {
          throw new Error("boom");
        }),
      /boom/,
    );

    assert.ok(!existsSync(path), "a failed run must not leave the lock behind");
  });

  it("tolerates a double release", () => {
    const lock = acquireMutationLock(path);
    lock.release();

    assert.doesNotThrow(() => lock.release());
  });
});
