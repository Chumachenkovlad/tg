import assert from "node:assert/strict";
import { describe, it } from "node:test";
import bigInt from "big-integer";
import { Api } from "teleproto";
import { AuthKey } from "teleproto/crypto/AuthKey.js";
import { StringSession } from "teleproto/sessions/index.js";
import { TelegramAccountClient } from "../src/telegram/client.js";
import { ForumRef } from "../src/telegram/forum-types.js";
import { SessionReadError, SessionWriteError } from "../src/telegram/types.js";
import type { AuthPrompts, SessionStore, TelegramConfig } from "../src/telegram/types.js";

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
  writableChecked = false;
  writableError: Error | undefined;

  constructor(
    private readonly value: string | (() => never),
    private readonly location = "fake/session",
  ) {}

  load(): string {
    return typeof this.value === "function" ? this.value() : this.value;
  }

  ensureWritable(): void {
    this.writableChecked = true;
    if (this.writableError) throw this.writableError;
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

describe("TelegramAccountClient.signIn", () => {
  /** Prompts that fail the test if the login flow ever reaches them. */
  const forbiddenPrompts: AuthPrompts = {
    phoneNumber: () => assert.fail("the login must not ask for a phone number"),
    loginCode: () => assert.fail("the login must not ask for a code"),
    password: () => assert.fail("the login must not ask for a password"),
  };

  /**
   * Replaces the underlying MTProto `start` call so nothing touches the
   * network, and records whether a login was attempted.
   */
  function stubStart(client: TelegramAccountClient): { started: () => boolean } {
    let started = false;
    const internals = client as unknown as { client: { start: () => Promise<void> } };
    internals.client.start = async () => {
      started = true;
    };
    return { started: () => started };
  }

  it("does not attempt a login when the session cannot be persisted", async () => {
    const store = new FakeStore("");
    store.writableError = new SessionWriteError("Cannot write the session to /tmp/x (EACCES).");
    const client = TelegramAccountClient.fromConfig(CONFIG, store);
    const login = stubStart(client);

    await assert.rejects(() => client.signIn(forbiddenPrompts), SessionWriteError);

    assert.equal(store.writableChecked, true, "the location must be checked first");
    assert.equal(login.started(), false, "no authorization may be attempted");
    assert.equal(store.saved, undefined);
  });

  it("checks the location before logging in, then stores the session", async () => {
    const order: string[] = [];
    const store = new FakeStore("");
    const originalEnsure = store.ensureWritable.bind(store);
    store.ensureWritable = () => {
      order.push("ensureWritable");
      originalEnsure();
    };

    const client = TelegramAccountClient.fromConfig(CONFIG, store);
    const internals = client as unknown as { client: { start: () => Promise<void> } };
    internals.client.start = async () => {
      order.push("start");
    };

    await client.signIn(forbiddenPrompts);

    assert.deepEqual(order, ["ensureWritable", "start"]);
    assert.equal(typeof store.saved, "string", "the session must be persisted after the login");
  });
});

describe("TelegramAccountClient.sendMessageToTopic", () => {
  const forum = new ForumRef(
    "2000000042",
    new Api.InputPeerChannel({ channelId: bigInt(2000000042), accessHash: bigInt(99) }),
  );

  /**
   * Replaces the underlying `invoke` so the request can be inspected without
   * a connection, and answers with the Updates box Telegram would return.
   */
  function captureInvoke(client: TelegramAccountClient): { request: () => Api.AnyRequest } {
    let captured: Api.AnyRequest | undefined;
    const internals = client as unknown as {
      client: { invoke: (request: Api.AnyRequest) => Promise<unknown> };
    };
    internals.client.invoke = async (request) => {
      captured = request;
      return new Api.Updates({
        updates: [new Api.UpdateMessageID({ id: 501, randomId: bigInt(1) })],
        users: [],
        chats: [],
        date: 0,
        seq: 0,
      });
    };
    return {
      request: () => {
        assert.ok(captured, "invoke was never called");
        return captured;
      },
    };
  }

  it("does not set topMsgId when sending the root managed message", async () => {
    const client = TelegramAccountClient.fromConfig(CONFIG, new FakeStore(""));
    const captured = captureInvoke(client);

    await client.sendMessageToTopic(forum, 123, "hello");

    const request = captured.request() as Api.messages.SendMessage;
    const replyTo = request.replyTo as Api.InputReplyToMessage;

    assert.ok(replyTo instanceof Api.InputReplyToMessage);
    assert.equal(replyTo.replyToMsgId, 123, "the topic id addresses the topic");
    assert.equal(
      replyTo.topMsgId,
      undefined,
      "topMsgId is for replying to a message inside a topic, not for the topic itself",
    );
  });

  it("sends the message to the forum peer with the given text", async () => {
    const client = TelegramAccountClient.fromConfig(CONFIG, new FakeStore(""));
    const captured = captureInvoke(client);

    await client.sendMessageToTopic(forum, 123, "hello");

    const request = captured.request() as Api.messages.SendMessage;
    assert.equal(request.message, "hello");
    assert.equal((request.peer as Api.InputPeerChannel).channelId.toString(), "2000000042");
  });

  it("carries a random_id, so a redelivered send cannot duplicate the message", async () => {
    const client = TelegramAccountClient.fromConfig(CONFIG, new FakeStore(""));
    const captured = captureInvoke(client);

    await client.sendMessageToTopic(forum, 123, "hello");

    const request = captured.request() as Api.messages.SendMessage;
    assert.ok(request.randomId, "random_id must be set");
  });

  it("returns the id Telegram reports, against the topic it was sent to", async () => {
    const client = TelegramAccountClient.fromConfig(CONFIG, new FakeStore(""));
    captureInvoke(client);

    assert.deepEqual(await client.sendMessageToTopic(forum, 123, "hello"), {
      id: 501,
      topicId: 123,
    });
  });
});

describe("TelegramAccountClient.createForumSupergroup", () => {
  it("asks for a megagroup with forum topics enabled", async () => {
    const client = TelegramAccountClient.fromConfig(CONFIG, new FakeStore(""));
    let captured: Api.AnyRequest | undefined;
    const internals = client as unknown as {
      client: { invoke: (request: Api.AnyRequest) => Promise<unknown> };
    };
    internals.client.invoke = async (request) => {
      captured = request;
      return new Api.Updates({
        updates: [],
        users: [],
        chats: [
          new Api.Channel({
            id: bigInt(2000000042),
            accessHash: bigInt(99),
            title: "TSC 8042 Test",
            photo: new Api.ChatPhotoEmpty(),
            date: 0,
            megagroup: true,
            forum: true,
          }),
        ],
        date: 0,
        seq: 0,
      });
    };

    const created = await client.createForumSupergroup("TSC 8042 Test");

    const request = captured as unknown as Api.channels.CreateChannel;
    assert.equal(request.megagroup, true);
    assert.equal(request.forum, true);
    assert.equal(request.broadcast, undefined, "a broadcast channel cannot hold topics");
    assert.equal(request.title, "TSC 8042 Test");
    assert.equal(created.id, "2000000042");
    assert.ok(!String(created.ref).includes("99"), "the access hash must not be printable");
  });
});
