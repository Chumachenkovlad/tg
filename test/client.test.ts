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

/** A ref shaped exactly as the client builds one: raw ids, no TL object. */
const FORUM = new ForumRef("2000000042", {
  channelId: bigInt(2000000042),
  accessHash: bigInt(99),
});

/** The same channel as Telegram would hand it back in the chat list. */
const MANAGED_CHANNEL = new Api.Channel({
  id: bigInt(2000000042),
  accessHash: bigInt(99),
  title: "ТСЦ 8042 — практичний іспит",
  photo: new Api.ChatPhotoEmpty(),
  date: 0,
  megagroup: true,
  forum: true,
});

/** A `channels.getFullChannel` answer carrying the given "about" text. */
function fullChannel(about: string): Api.messages.ChatFull {
  return new Api.messages.ChatFull({
    fullChat: new Api.ChannelFull({
      id: bigInt(2000000042),
      about,
      readInboxMaxId: 0,
      readOutboxMaxId: 0,
      unreadCount: 0,
      chatPhoto: new Api.PhotoEmpty({ id: bigInt(0) }),
      notifySettings: new Api.PeerNotifySettings({}),
      botInfo: [],
      pts: 0,
    }),
    chats: [],
    users: [],
  });
}

describe("TelegramAccountClient.sendMessageToTopic", () => {
  const forum = FORUM;

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
  it("asks for a megagroup with forum topics enabled, carrying the description", async () => {
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

    const created = await client.createForumSupergroup("TSC 8042 Test", "Спільнота 8042");

    const request = captured as unknown as Api.channels.CreateChannel;
    assert.equal(request.megagroup, true);
    assert.equal(request.forum, true);
    assert.equal(request.broadcast, undefined, "a broadcast channel cannot hold topics");
    assert.equal(request.title, "TSC 8042 Test");
    assert.equal(
      request.about,
      "Спільнота 8042",
      "the description must go out with the creating call, not as a follow-up edit",
    );
    assert.equal(created.id, "2000000042");
    assert.ok(!String(created.ref).includes("99"), "the access hash must not be printable");
  });
});

/**
 * Every Telegram RPC this client sends, checked against the official TL
 * parameter type.
 *
 * `InputPeerChannel` and `InputChannel` carry the same two fields but are
 * different constructors on the wire, and the library types both parameters
 * as the loose `TypeEntityLike` — so nothing but a test like this catches a
 * `channels.*` method handed an InputPeer.
 *
 * TL schema, for reference:
 *   channels.createChannel      (no peer parameter)
 *   channels.getMessages        channel:InputChannel
 *   channels.editTitle          channel:InputChannel
 *   channels.getFullChannel     channel:InputChannel
 *   messages.createForumTopic   peer:InputPeer
 *   messages.sendMessage        peer:InputPeer
 *   messages.editMessage        peer:InputPeer
 *   messages.editForumTopic     peer:InputPeer
 *   messages.getForumTopicsByID peer:InputPeer
 *   messages.editChatAbout      peer:InputPeer
 */
describe("TL parameter types", () => {
  /** Captures every request, answering each with something plausible. */
  function recorder(client: TelegramAccountClient): { requests: Api.AnyRequest[] } {
    const requests: Api.AnyRequest[] = [];
    const internals = client as unknown as {
      client: {
        invoke: (request: Api.AnyRequest) => Promise<unknown>;
        getDialogs: () => Promise<unknown[]>;
      };
    };
    // findForumById reads the chat list through the library's own helper
    // rather than a raw request, so it is stubbed separately. No connection
    // is opened either way.
    internals.client.getDialogs = async () => [{ entity: MANAGED_CHANNEL }];
    internals.client.invoke = async (request) => {
      requests.push(request);
      if (request instanceof Api.messages.GetForumTopicsByID) {
        return new Api.messages.ForumTopics({
          count: 0,
          topics: [],
          messages: [],
          chats: [],
          users: [],
          pts: 0,
        });
      }
      if (request instanceof Api.channels.GetMessages) {
        return new Api.messages.ChannelMessages({
          pts: 0,
          count: 0,
          messages: [],
          topics: [],
          chats: [],
          users: [],
        });
      }
      if (request instanceof Api.channels.GetFullChannel) {
        return fullChannel("the description Telegram holds");
      }
      return new Api.Updates({
        updates: [new Api.UpdateMessageID({ id: 7, randomId: bigInt(1) })],
        users: [],
        chats: [],
        date: 0,
        seq: 0,
      });
    };
    return { requests };
  }

  /** Runs every call that takes a forum reference, once. */
  async function callEverything(): Promise<Api.AnyRequest[]> {
    const client = TelegramAccountClient.fromConfig(CONFIG, new FakeStore(""));
    const recorded = recorder(client);

    await client.createForumTopic(FORUM, "t");
    await client.sendMessageToTopic(FORUM, 1, "m");
    await client.setForumTitle(FORUM, "t");
    await client.setForumDescription(FORUM, "d");
    await client.setGeneralTopicHidden(FORUM, true);
    await client.readGeneralTopic(FORUM);
    await client.setTopicTitle(FORUM, 2, "t");
    await client.setMessageText(FORUM, 1, "m");
    await client.listExistingTopics(FORUM, [1]);
    await client.listExistingMessages(FORUM, [1]);
    await client.findForumById("2000000042");

    return recorded.requests;
  }

  function find<T extends Api.AnyRequest>(
    requests: Api.AnyRequest[],
    kind: new (...args: never[]) => T,
  ): T {
    const found = requests.find((request): request is T => request instanceof kind);
    assert.ok(found, `no ${kind.name} request was sent`);
    return found;
  }

  it("gives every channels.* method an InputChannel", async () => {
    const requests = await callEverything();

    for (const [name, request] of [
      ["channels.getMessages", find(requests, Api.channels.GetMessages).channel],
      ["channels.editTitle", find(requests, Api.channels.EditTitle).channel],
      ["channels.getFullChannel", find(requests, Api.channels.GetFullChannel).channel],
    ] as const) {
      assert.ok(
        request instanceof Api.InputChannel,
        `${name} must take InputChannel, got ${(request as object).constructor.name}`,
      );
      assert.ok(
        !(request instanceof Api.InputPeerChannel),
        `${name} must not be handed an InputPeerChannel`,
      );
    }
  });

  it("gives every messages.* method an InputPeer", async () => {
    const requests = await callEverything();

    for (const [name, peer] of [
      ["messages.createForumTopic", find(requests, Api.messages.CreateForumTopic).peer],
      ["messages.sendMessage", find(requests, Api.messages.SendMessage).peer],
      ["messages.editMessage", find(requests, Api.messages.EditMessage).peer],
      ["messages.editForumTopic", find(requests, Api.messages.EditForumTopic).peer],
      ["messages.getForumTopicsByID", find(requests, Api.messages.GetForumTopicsByID).peer],
      ["messages.editChatAbout", find(requests, Api.messages.EditChatAbout).peer],
    ] as const) {
      assert.ok(
        peer instanceof Api.InputPeerChannel,
        `${name} must take InputPeerChannel, got ${(peer as object).constructor.name}`,
      );
      assert.ok(!(peer instanceof Api.InputChannel), `${name} must not be handed an InputChannel`);
    }
  });

  it("carries the same ids whichever wrapper is used", async () => {
    const requests = await callEverything();

    const channel = find(requests, Api.channels.EditTitle).channel as Api.InputChannel;
    const peer = find(requests, Api.messages.SendMessage).peer as Api.InputPeerChannel;

    assert.equal(channel.channelId.toString(), "2000000042");
    assert.equal(peer.channelId.toString(), "2000000042");
    assert.equal(channel.accessHash.toString(), peer.accessHash.toString());
  });

  /** A `messages.getForumTopicsByID` answer holding just the General topic. */
  function generalTopic(hidden: boolean | undefined): Api.messages.ForumTopics {
    return new Api.messages.ForumTopics({
      count: 1,
      topics: [
        new Api.ForumTopic({
          id: 1,
          date: 0,
          peer: new Api.PeerChannel({ channelId: bigInt(2000000042) }),
          title: "General",
          iconColor: 0,
          topMessage: 0,
          readInboxMaxId: 0,
          readOutboxMaxId: 0,
          unreadCount: 0,
          unreadMentionsCount: 0,
          unreadReactionsCount: 0,
          unreadPollVotesCount: 0,
          fromId: new Api.PeerUser({ userId: bigInt(1) }),
          notifySettings: new Api.PeerNotifySettings({}),
          ...(hidden === undefined ? {} : { hidden }),
        }),
      ],
      messages: [],
      chats: [],
      users: [],
      pts: 0,
    });
  }

  /** Answers every request with the given General topic state. */
  function generalReader(
    client: TelegramAccountClient,
    hidden: boolean | undefined,
  ): { requests: Api.AnyRequest[] } {
    const requests: Api.AnyRequest[] = [];
    const internals = client as unknown as {
      client: { invoke: (request: Api.AnyRequest) => Promise<unknown> };
    };
    internals.client.invoke = async (request) => {
      requests.push(request);
      return generalTopic(hidden);
    };
    return { requests };
  }

  it("reads General's hidden flag, asking for topic id 1 only", async () => {
    const client = TelegramAccountClient.fromConfig(CONFIG, new FakeStore(""));
    const recorded = generalReader(client, true);

    assert.deepEqual(await client.readGeneralTopic(FORUM), { hidden: true });

    const request = recorded.requests[0] as Api.messages.GetForumTopicsByID;
    assert.ok(request instanceof Api.messages.GetForumTopicsByID);
    assert.deepEqual(request.topics, [1], "only General is asked about");
  });

  it("treats an absent `hidden` flag as visible, not as unknown", async () => {
    const client = TelegramAccountClient.fromConfig(CONFIG, new FakeStore(""));
    // TL flags are absent rather than false when unset, so `hidden` comes
    // back undefined for a visible topic.
    generalReader(client, undefined);

    assert.deepEqual(await client.readGeneralTopic(FORUM), { hidden: false });
  });

  it("reports undefined when Telegram does not return General at all", async () => {
    const client = TelegramAccountClient.fromConfig(CONFIG, new FakeStore(""));
    recorder(client);

    assert.equal(await client.readGeneralTopic(FORUM), undefined);
  });

  it("hides General with the `hidden` flag on messages.editForumTopic", async () => {
    const client = TelegramAccountClient.fromConfig(CONFIG, new FakeStore(""));
    const recorded = recorder(client);

    await client.setGeneralTopicHidden(FORUM, true);

    const edits = recorded.requests.filter(
      (request): request is Api.messages.EditForumTopic =>
        request instanceof Api.messages.EditForumTopic,
    );
    assert.equal(edits.length, 1);
    assert.equal(edits[0]?.topicId, 1, "General is always topic id 1");
    assert.equal(edits[0]?.hidden, true);
    assert.equal(edits[0]?.title, undefined, "hiding must not rename it");
    // Telegram closes General by itself when it is hidden. That is the
    // server's doing: the request carries `hidden` alone, never `closed`,
    // which is what TDLib sends too. Setting `closed` here would be this
    // project performing an operation it does not offer.
    assert.equal(edits[0]?.closed, undefined, "the close is Telegram's, not ours to request");
  });

  it("shows General again with the same flag set to false", async () => {
    const client = TelegramAccountClient.fromConfig(CONFIG, new FakeStore(""));
    const recorded = recorder(client);

    await client.setGeneralTopicHidden(FORUM, false);

    const edit = recorded.requests.find(
      (request): request is Api.messages.EditForumTopic =>
        request instanceof Api.messages.EditForumTopic,
    );
    assert.equal(edit?.hidden, false);
  });

  it("reads the description back, so the planner compares against Telegram", async () => {
    const client = TelegramAccountClient.fromConfig(CONFIG, new FakeStore(""));
    recorder(client);

    const resolved = await client.findForumById("2000000042");

    assert.ok(resolved, "the recorded forum must resolve");
    assert.equal(resolved.title, "ТСЦ 8042 — практичний іспит");
    assert.equal(resolved.description, "the description Telegram holds");
  });

  it("asks for the description only for the forum that matched", async () => {
    const client = TelegramAccountClient.fromConfig(CONFIG, new FakeStore(""));
    const recorded = recorder(client);

    await client.findForumById("9999999999");

    assert.ok(
      !recorded.requests.some((request) => request instanceof Api.channels.GetFullChannel),
      "a forum that is not in the chat list must cost no extra round-trip",
    );
  });

  it("rejects a reference that is not one of ours", async () => {
    const client = TelegramAccountClient.fromConfig(CONFIG, new FakeStore(""));
    recorder(client);

    await assert.rejects(
      () => client.setForumTitle(new ForumRef("1", "nonsense"), "t"),
      /Not a usable forum reference/,
    );
  });
});
