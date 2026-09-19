import { TelegramClient as MtprotoClient, Api } from "teleproto";
import { generateRandomLong } from "teleproto/Helpers.js";
import { StringSession } from "teleproto/sessions/index.js";
import { Logger, LogLevel } from "teleproto/extensions/Logger.js";
import { FileSessionStore } from "./session-store.js";
import {
  ForumRef,
  type CreatedForum,
  type CreatedTopic,
  type DialogSummary,
  type ForumApi,
  type PostedMessage,
} from "./forum-types.js";
import type { AuthPrompts, SessionStore, TelegramAccount, TelegramConfig } from "./types.js";

/** Tuning that callers may override per run. */
export interface TelegramClientOptions {
  store?: SessionStore;
  /**
   * How many times a single RPC may be retried. Defaults to the library's own
   * behaviour; a caller that performs *creating* calls passes 1, because a
   * retried `channels.createChannel` would create a second group — that RPC
   * carries no `random_id` for Telegram to deduplicate on.
   */
  requestRetries?: number;
}

/**
 * Thin wrapper around the MTProto library (`teleproto`).
 *
 * This is the ONLY module that imports the library. Everything else uses the
 * library-agnostic types from `./types.js` and `./forum-types.js`, so swapping
 * the implementation stays a one-file change.
 */
export class TelegramAccountClient implements ForumApi {
  private readonly client: MtprotoClient;
  private readonly session: StringSession;
  private readonly restoredFromStore: boolean;

  private constructor(
    config: TelegramConfig,
    private readonly store: SessionStore,
    requestRetries?: number,
  ) {
    const restored = TelegramAccountClient.restoreSession(store);
    this.session = restored.session;
    this.restoredFromStore = restored.reused;
    this.client = new MtprotoClient(this.session, config.apiId, config.apiHash, {
      connectionRetries: 5,
      ...(requestRetries === undefined ? {} : { requestRetries }),
      // Keep the library quiet: its info-level output is noise for a CLI.
      baseLogger: new Logger(LogLevel.ERROR),
    });
  }

  /** Builds a client that keeps its session in the configured local file. */
  static fromConfig(
    config: TelegramConfig,
    options?: SessionStore | TelegramClientOptions,
  ): TelegramAccountClient {
    // Historically this took a bare store; keep that call shape working.
    const opts: TelegramClientOptions =
      options && "load" in options ? { store: options } : (options ?? {});
    return new TelegramAccountClient(
      config,
      opts.store ?? FileSessionStore.fromConfig(config),
      opts.requestRetries,
    );
  }

  /**
   * Restores a saved session.
   *
   * No session at all means "log in", and a stored value that does not parse is
   * discarded with a warning. A failed *read* (permissions, I/O) is different:
   * it propagates, because starting a fresh login there would silently add
   * another authorized device while the existing session stays in place.
   */
  private static restoreSession(store: SessionStore): {
    session: StringSession;
    reused: boolean;
  } {
    const saved = store.load();
    if (!saved) return { session: new StringSession(""), reused: false };
    try {
      return { session: new StringSession(saved), reused: true };
    } catch {
      console.warn("Stored session is malformed — ignoring it and logging in again.");
      return { session: new StringSession(""), reused: false };
    }
  }

  /**
   * Whether a stored session was accepted and is in use. The session value
   * itself is never exposed — it is a credential.
   */
  get hasStoredSession(): boolean {
    return this.restoredFromStore;
  }

  /** Where the session is persisted, for log messages. */
  get sessionLocation(): string {
    return this.store.describe();
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async isAuthorized(): Promise<boolean> {
    return this.client.isUserAuthorized();
  }

  /**
   * Runs the interactive login and persists the resulting session.
   * Only called when there is no valid session yet.
   *
   * The storage location is checked first: authorizing the account and only
   * then discovering that the session cannot be saved would leave a live
   * device registered on the account with nothing to reuse it.
   */
  async signIn(prompts: AuthPrompts): Promise<void> {
    this.store.ensureWritable();
    await this.client.start({
      phoneNumber: () => prompts.phoneNumber(),
      phoneCode: () => prompts.loginCode(),
      password: (hint?: string) => prompts.password(hint),
      onError: (error: Error) => {
        prompts.onError?.(error.message);
      },
    });
    this.store.save(this.session.save());
  }

  /** Verifies the session and returns only non-sensitive account fields. */
  async getMe(): Promise<TelegramAccount> {
    const me = await this.client.getMe();
    return {
      id: me.id.toString(),
      ...(me.firstName ? { firstName: me.firstName } : {}),
      ...(me.lastName ? { lastName: me.lastName } : {}),
      ...(me.username ? { username: me.username } : {}),
      isBot: me.bot === true,
    };
  }

  /**
   * Read-only: every group, supergroup, forum and channel in the chat list.
   *
   * Private chats with people are skipped — they are none of this milestone's
   * business. Only non-sensitive fields are returned; the access hash each
   * entity carries is deliberately left behind.
   */
  async listGroupDialogs(): Promise<DialogSummary[]> {
    const dialogs = await this.client.getDialogs();
    const summaries: DialogSummary[] = [];

    for (const dialog of dialogs) {
      const entity = dialog.entity;
      // Users, deleted chats and anything else are not this command's business.
      if (!(entity instanceof Api.Channel) && !(entity instanceof Api.Chat)) continue;

      const username = entity instanceof Api.Channel ? entity.username : undefined;
      summaries.push({
        id: (dialog.id ?? entity.id).toString(),
        title: dialog.title ?? entity.title,
        kind: TelegramAccountClient.classify(entity),
        ...(username ? { username } : {}),
      });
    }

    return summaries;
  }

  /** Maps an entity to a plain-words kind. */
  private static classify(entity: Api.Channel | Api.Chat): DialogSummary["kind"] {
    if (entity instanceof Api.Chat) return "group";
    if (entity.broadcast) return "channel";
    if (entity.forum) return "forum";
    return "supergroup";
  }

  /**
   * Creates a **private** supergroup with forum topics enabled.
   *
   * Private is the default: no username is requested, so the group is not
   * public and nobody is invited. Nothing else on the account is touched.
   */
  async createForumSupergroup(title: string): Promise<CreatedForum> {
    const updates = await this.client.invoke(
      new Api.channels.CreateChannel({
        title,
        about: "",
        megagroup: true,
        forum: true,
      }),
    );

    const channel = TelegramAccountClient.chatsOf(updates).find(
      (chat): chat is Api.Channel => chat instanceof Api.Channel,
    );
    if (!channel) {
      throw new Error("Telegram did not return the created supergroup.");
    }
    if (channel.accessHash === undefined) {
      // Without it the channel cannot be addressed; stop rather than guess.
      throw new Error("Telegram returned the supergroup without an access hash.");
    }

    const peer = new Api.InputPeerChannel({
      channelId: channel.id,
      accessHash: channel.accessHash,
    });

    return {
      ref: new ForumRef(channel.id.toString(), peer),
      id: channel.id.toString(),
      title: channel.title,
    };
  }

  /**
   * Creates one forum topic. Its id is the id of the service message Telegram
   * posts for it — that same id addresses the topic when sending.
   */
  async createForumTopic(forum: ForumRef, title: string): Promise<CreatedTopic> {
    const updates = await this.client.invoke(
      new Api.messages.CreateForumTopic({
        peer: TelegramAccountClient.peerOf(forum),
        title,
        // Telegram deduplicates on random_id, so a redelivered request cannot
        // produce a second topic.
        randomId: generateRandomLong(),
      }),
    );

    const id = TelegramAccountClient.newMessageId(updates);
    if (id === undefined) {
      throw new Error("Telegram did not return the created topic id.");
    }
    return { id, title };
  }

  /**
   * Sends one top-level message into a forum topic.
   *
   * Telegram's forum API addresses a new top-level message in a non-General
   * topic with `replyToMsgId` set to the topic id and **no** `topMsgId`:
   * `topMsgId` is for replying to another message *inside* a topic, where
   * `replyToMsgId` is that message and `topMsgId` is the topic containing it.
   * Setting both here would claim this message replies to the topic's own
   * service message within itself.
   */
  async sendMessageToTopic(
    forum: ForumRef,
    topicId: number,
    text: string,
  ): Promise<PostedMessage> {
    const updates = await this.client.invoke(
      new Api.messages.SendMessage({
        peer: TelegramAccountClient.peerOf(forum),
        message: text,
        randomId: generateRandomLong(),
        replyTo: new Api.InputReplyToMessage({ replyToMsgId: topicId }),
      }),
    );

    const id = TelegramAccountClient.newMessageId(updates);
    if (id === undefined) {
      throw new Error("Telegram did not return the sent message id.");
    }
    return { id, topicId };
  }

  /**
   * Read-only: resolves a channel id recorded in local state back to a usable
   * reference, or undefined when the account can no longer reach it.
   *
   * The access hash is not persisted anywhere, so it is recovered here from
   * the chat list. That doubles as the existence check: a forum that was
   * deleted, or that this account has left, simply is not in the list.
   */
  async findForumById(id: string): Promise<ForumRef | undefined> {
    const dialogs = await this.client.getDialogs();

    for (const dialog of dialogs) {
      const entity = dialog.entity;
      if (!(entity instanceof Api.Channel)) continue;
      if (entity.id.toString() !== id) continue;
      if (entity.accessHash === undefined) continue;
      // A channel that is no longer a forum cannot hold topics: treat it as
      // gone rather than trying to put topics into it.
      if (!entity.forum) continue;

      return new ForumRef(
        id,
        new Api.InputPeerChannel({ channelId: entity.id, accessHash: entity.accessHash }),
      );
    }

    return undefined;
  }

  /** Read-only: which of these topic ids still exist in the forum. */
  async listExistingTopicIds(forum: ForumRef, topicIds: readonly number[]): Promise<number[]> {
    if (topicIds.length === 0) return [];

    const result = await this.client.invoke(
      new Api.messages.GetForumTopicsByID({
        peer: TelegramAccountClient.peerOf(forum),
        topics: [...topicIds],
      }),
    );

    // Deleted topics come back as ForumTopicDeleted, not as ForumTopic.
    const alive = new Set(
      result.topics.filter((topic) => topic instanceof Api.ForumTopic).map((topic) => topic.id),
    );
    return topicIds.filter((id) => alive.has(id));
  }

  /** Read-only: which of these message ids still exist in the forum. */
  async listExistingMessageIds(
    forum: ForumRef,
    messageIds: readonly number[],
  ): Promise<number[]> {
    if (messageIds.length === 0) return [];

    const result = await this.client.invoke(
      new Api.channels.GetMessages({
        channel: TelegramAccountClient.peerOf(forum),
        id: messageIds.map((id) => new Api.InputMessageID({ id })),
      }),
    );

    // A deleted message comes back as MessageEmpty in its slot.
    const messages =
      result instanceof Api.messages.ChannelMessages || result instanceof Api.messages.Messages
        ? result.messages
        : [];
    const alive = new Set(
      messages.filter((message) => !(message instanceof Api.MessageEmpty)).map((m) => m.id),
    );
    return messageIds.filter((id) => alive.has(id));
  }

  /** Unwraps a ref back into the MTProto peer. The only place that may. */
  private static peerOf(forum: ForumRef): Api.TypeInputPeer {
    const peer = forum.unwrap();
    if (!(peer instanceof Api.InputPeerChannel)) {
      throw new Error(`Not a usable forum reference: ${forum}`);
    }
    return peer;
  }

  private static chatsOf(updates: Api.TypeUpdates): Api.TypeChat[] {
    if (updates instanceof Api.Updates) return updates.chats;
    if (updates instanceof Api.UpdatesCombined) return updates.chats;
    return [];
  }

  /**
   * Message id out of an Updates box.
   *
   * `UpdateMessageID` is the direct random_id → id answer; the new-message
   * updates are the fallback for responses that omit it.
   */
  private static newMessageId(updates: Api.TypeUpdates): number | undefined {
    const list =
      updates instanceof Api.Updates || updates instanceof Api.UpdatesCombined
        ? updates.updates
        : [];

    for (const update of list) {
      if (update instanceof Api.UpdateMessageID) return update.id;
    }
    for (const update of list) {
      if (update instanceof Api.UpdateNewChannelMessage || update instanceof Api.UpdateNewMessage) {
        return update.message.id;
      }
    }
    return undefined;
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
    await this.client.destroy();
  }
}
