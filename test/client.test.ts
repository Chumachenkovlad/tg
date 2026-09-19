import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StringSession } from "teleproto/sessions/index.js";
import { TelegramAccountClient } from "../src/telegram/client.js";
import type { SessionStore, TelegramConfig } from "../src/telegram/types.js";

const CONFIG: TelegramConfig = {
  apiId: 12345,
  apiHash: "test-hash",
  sessionPath: "/tmp/tg-test/.telegram/session",
};

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

describe("TelegramAccountClient session restore", () => {
  it("starts with an empty session when nothing is stored", () => {
    const { result, warnings } = captureWarnings(() =>
      TelegramAccountClient.fromConfig(CONFIG, new FakeStore("")),
    );

    assert.ok(result instanceof TelegramAccountClient);
    assert.deepEqual(warnings, []);
  });

  it("reuses a valid stored session without warning", () => {
    const valid = new StringSession("").save();

    const { result, warnings } = captureWarnings(() =>
      TelegramAccountClient.fromConfig(CONFIG, new FakeStore(valid)),
    );

    assert.ok(result instanceof TelegramAccountClient);
    assert.deepEqual(warnings, []);
  });

  it("falls back to a fresh login when the stored session is corrupt", () => {
    const { result, warnings } = captureWarnings(() =>
      TelegramAccountClient.fromConfig(CONFIG, new FakeStore("NOT_A_VALID_SESSION")),
    );

    assert.ok(result instanceof TelegramAccountClient);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /unreadable/);
  });

  it("falls back to a fresh login when the session cannot be read", () => {
    const failing = new FakeStore(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });

    const { result, warnings } = captureWarnings(() =>
      TelegramAccountClient.fromConfig(CONFIG, failing),
    );

    assert.ok(result instanceof TelegramAccountClient);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /unreadable/);
  });

  it("never leaks the stored session through the warning", () => {
    const secret = "SUPER_SECRET_SESSION_VALUE";

    const { warnings } = captureWarnings(() =>
      TelegramAccountClient.fromConfig(CONFIG, new FakeStore(secret)),
    );

    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0]?.includes(secret));
  });

  it("reports the session location from the store", () => {
    const client = TelegramAccountClient.fromConfig(
      CONFIG,
      new FakeStore("", ".telegram/session"),
    );

    assert.equal(client.sessionLocation, ".telegram/session");
  });
});
