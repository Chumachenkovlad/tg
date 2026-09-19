import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuthKey } from "teleproto/crypto/AuthKey.js";
import { StringSession } from "teleproto/sessions/index.js";
import { TelegramAccountClient } from "../src/telegram/client.js";
import { SessionReadError } from "../src/telegram/types.js";
import type { SessionStore, TelegramConfig } from "../src/telegram/types.js";

const CONFIG: TelegramConfig = {
  apiId: 12345,
  apiHash: "test-hash",
  sessionPath: "/tmp/tg-test/session",
  ownsSessionDirectory: true,
};

/**
 * Builds a session string the way a real login would: a DC address plus a
 * 256-byte auth key. `new StringSession("").save()` returns "" — there is
 * nothing to serialize — so it cannot stand in for a stored session.
 * No network access is involved.
 */
async function serializableSession(): Promise<string> {
  const session = new StringSession("");
  session.setDC(2, "149.154.167.50", 443);
  const authKey = new AuthKey();
  await authKey.setKey(Buffer.alloc(256, 0x2a));
  session.setAuthKey(authKey);
  return session.save();
}

/** In-memory store so these tests never touch the filesystem or the network. */
class FakeStore implements SessionStore {
  saved: string | undefined;

  constructor(
    private readonly value: string | (() => never),
    private readonly location = "fake/session",
  ) {}

  load(): string {
    return typeof this.value === "function" ? this.value() : this.value;
  }

  save(session: string): void {
    this.saved = session;
  }

  describe(): string {
    return this.location;
  }
}

/** Runs `fn` while collecting console.warn output. */
function captureWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

describe("serializableSession helper", () => {
  it("produces a non-empty session string that round-trips", async () => {
    const serialized = await serializableSession();

    assert.ok(serialized.length > 0, "the fixture must serialize to a real session string");
    assert.equal(serialized[0], "1", "expected the current StringSession version prefix");

    const restored = new StringSession(serialized);
    assert.equal(restored.dcId, 2);
    assert.equal(restored.serverAddress, "149.154.167.50");
    assert.equal(restored.port, 443);

    // load() rebuilds the auth key from the decoded bytes; it is local work,
    // no connection is opened.
    await restored.load();
    assert.equal(restored.save(), serialized);
  });

  it("confirms an empty session serializes to nothing", () => {
    assert.equal(new StringSession("").save(), "");
  });
});

describe("TelegramAccountClient session restore", () => {
  it("starts with an empty session when nothing is stored", () => {
    const { result, warnings } = captureWarnings(() =>
      TelegramAccountClient.fromConfig(CONFIG, new FakeStore("")),
    );

    assert.ok(result instanceof TelegramAccountClient);
    assert.deepEqual(warnings, []);
  });

  it("reuses a valid stored session without warning", async () => {
    const stored = await serializableSession();

    const { result, warnings } = captureWarnings(() =>
      TelegramAccountClient.fromConfig(CONFIG, new FakeStore(stored)),
    );

    assert.ok(result instanceof TelegramAccountClient);
    assert.deepEqual(warnings, []);
    assert.equal(result.hasStoredSession, true, "the stored session must be the one in use");
  });

  it("falls back to a fresh login when the stored session is malformed", () => {
    const { result, warnings } = captureWarnings(() =>
      TelegramAccountClient.fromConfig(CONFIG, new FakeStore("NOT_A_VALID_SESSION")),
    );

    assert.ok(result instanceof TelegramAccountClient);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /malformed/);
    assert.equal(result.hasStoredSession, false, "a malformed session must not be reused");
  });

  it("never leaks the stored session through the warning", () => {
    const secret = "SUPER_SECRET_SESSION_VALUE";

    const { warnings } = captureWarnings(() =>
      TelegramAccountClient.fromConfig(CONFIG, new FakeStore(secret)),
    );

    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0]?.includes(secret));
  });

  it("fails loudly when the session cannot be read, instead of logging in again", () => {
    const failing = new FakeStore(() => {
      throw new SessionReadError("Cannot read the session file at /tmp/x (EACCES).");
    });

    const { warnings } = captureWarnings(() => {
      assert.throws(
        () => TelegramAccountClient.fromConfig(CONFIG, failing),
        (error: unknown) => {
          assert.ok(error instanceof SessionReadError);
          assert.match(error.message, /Cannot read the session file/);
          return true;
        },
      );
    });

    assert.deepEqual(warnings, [], "a read failure must not be downgraded to a warning");
  });

  it("propagates any other read failure as well", () => {
    const failing = new FakeStore(() => {
      throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    });

    assert.throws(() => TelegramAccountClient.fromConfig(CONFIG, failing), /EIO/);
  });

  it("reports the session location from the store", () => {
    const client = TelegramAccountClient.fromConfig(
      CONFIG,
      new FakeStore("", "~/.tg-8042/session"),
    );

    assert.equal(client.sessionLocation, "~/.tg-8042/session");
  });
});
