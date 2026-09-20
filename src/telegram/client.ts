import type bigInt from "big-integer";
import { TelegramClient as MtprotoClient, Api } from "teleproto";
import { generateRandomLong } from "teleproto/Helpers.js";
import { StringSession } from "teleproto/sessions/index.js";
import { Logger, LogLevel } from "teleproto/extensions/Logger.js";
import { FileSessionStore } from "./session-store.js";
import {
  ForumRef,
  GENERAL_TOPIC_ID,
  type CreatedForum,
  type CreatedTopic,
  type DialogSummary,
  type ExistingMessage,
  type ExistingTopic,
  type ForumApi,
  type GeneralTopicState,
  type PostedMessage,
  type ResolvedForum,
} from "./forum-types.js";
import type { AuthPrompts, SessionStore, TelegramAccount, TelegramConfig } from "./types.js";

/**
 * What a {@link ForumRef} carries: the two ids needed to address a channel.
 *
 * Kept as raw ids rather than a built TL object, because `messages.*` wants
 * them as `InputPeerChannel` and `channels.*` as `InputChannel`.
 */
interface ChannelHandle {
  channelId: bigInt.BigInteger;
  accessHash: bigInt.BigInteger;
}

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
   *
   * The description goes out with this same call rather than as a follow-up
   * edit: a second request could fail, leaving a created group carrying no
   * description until the next apply.
   */
  async createForumSupergroup(title: string, description: string): Promise<CreatedForum> {
    const updates = await this.client.invoke(
      new Api.channels.CreateChannel({
        title,
        about: description,
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

    return {
      ref: TelegramAccountClient.refFor(channel.id, channel.accessHash),
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
   *
   * The description is not in the chat list — only the full channel carries
   * it — so one extra read follows for the forum that matched. It is the
   * only way the planner can tell a description that already matches from
   * one that needs editing.
   */
  async findForumById(id: string): Promise<ResolvedForum | undefined> {
    const dialogs = await this.client.getDialogs();

    for (const dialog of dialogs) {
      const entity = dialog.entity;
      if (!(entity instanceof Api.Channel)) continue;
      if (entity.id.toString() !== id) continue;
      if (entity.accessHash === undefined) continue;
      // A channel that is no longer a forum cannot hold topics: treat it as
      // gone rather than trying to put topics into it.
      if (!entity.forum) continue;

      const ref = TelegramAccountClient.refFor(entity.id, entity.accessHash);
      return {
        ref,
        title: entity.title,
        description: await this.readForumDescription(ref),
      };
    }

    return undefined;
  }

  /** Read-only: the group's current "about" text, or "" when it has none. */
  private async readForumDescription(forum: ForumRef): Promise<string> {
    const full = await this.client.invoke(
      // channels.getFullChannel takes `channel:InputChannel`, not an InputPeer.
      new Api.channels.GetFullChannel({ channel: TelegramAccountClient.channelOf(forum) }),
    );

    // Only a ChannelFull carries `about`; anything else means no description
    // this planner could compare against.
    return full.fullChat instanceof Api.ChannelFull ? full.fullChat.about : "";
  }

  /**
   * Read-only: what Telegram currently holds for the built-in General topic.
   *
   * Undefined means Telegram did not report it, which for a forum should not
   * happen — the caller decides what to make of that rather than this method
   * guessing a value the planner would then compare against.
   */
  async readGeneralTopic(forum: ForumRef): Promise<GeneralTopicState | undefined> {
    const result = await this.client.invoke(
      new Api.messages.GetForumTopicsByID({
        peer: TelegramAccountClient.peerOf(forum),
        topics: [GENERAL_TOPIC_ID],
      }),
    );

    const general = result.topics.find(
      (topic): topic is Api.ForumTopic =>
        topic instanceof Api.ForumTopic && topic.id === GENERAL_TOPIC_ID,
    );
    // `hidden` is a TL flag: present means true, absent means false.
    return general ? { hidden: general.hidden === true } : undefined;
  }

  /** Read-only: which of these topics still exist, with their current titles. */
  async listExistingTopics(
    forum: ForumRef,
    topicIds: readonly number[],
  ): Promise<ExistingTopic[]> {
    if (topicIds.length === 0) return [];

    const result = await this.client.invoke(
      new Api.messages.GetForumTopicsByID({
        peer: TelegramAccountClient.peerOf(forum),
        topics: [...topicIds],
      }),
    );

    // Deleted topics come back as ForumTopicDeleted, not as ForumTopic.
    return result.topics
      .filter((topic): topic is Api.ForumTopic => topic instanceof Api.ForumTopic)
      .map((topic) => ({ id: topic.id, title: topic.title }));
  }

  /** Read-only: which of these messages still exist, with their current text. */
  async listExistingMessages(
    forum: ForumRef,
    messageIds: readonly number[],
  ): Promise<ExistingMessage[]> {
    if (messageIds.length === 0) return [];

    const result = await this.client.invoke(
      // channels.getMessages takes `channel:InputChannel`, not an InputPeer.
      new Api.channels.GetMessages({
        channel: TelegramAccountClient.channelOf(forum),
        id: messageIds.map((id) => new Api.InputMessageID({ id })),
      }),
    );

    // A deleted message comes back as MessageEmpty in its slot.
    const messages =
      result instanceof Api.messages.ChannelMessages || result instanceof Api.messages.Messages
        ? result.messages
        : [];
    return messages
      .filter((message): message is Api.Message => message instanceof Api.Message)
      .map((message) => ({ id: message.id, text: message.message }));
  }

  /** Renames the forum in place. The channel id does not change. */
  async setForumTitle(forum: ForumRef, title: string): Promise<void> {
    await this.client.invoke(
      // channels.editTitle takes `channel:InputChannel`, not an InputPeer.
      new Api.channels.EditTitle({ channel: TelegramAccountClient.channelOf(forum), title }),
    );
  }

  /**
   * Rewrites the forum's description in place. The channel id does not change.
   *
   * `messages.editChatAbout` is the method for both chats and channels — there
   * is no `channels.editAbout` — so this one takes `peer:InputPeer`.
   */
  async setForumDescription(forum: ForumRef, description: string): Promise<void> {
    await this.client.invoke(
      new Api.messages.EditChatAbout({
        peer: TelegramAccountClient.peerOf(forum),
        about: description,
      }),
    );
  }

  /** Renames a topic in place. The topic id does not change. */
  async setTopicTitle(forum: ForumRef, topicId: number, title: string): Promise<void> {
    await this.client.invoke(
      new Api.messages.EditForumTopic({
        peer: TelegramAccountClient.peerOf(forum),
        topicId,
        title,
      }),
    );
  }

  /**
   * Hides or shows Telegram's built-in General topic.
   *
   * `hidden` is a flag on `messages.editForumTopic`, and Telegram accepts it
   * only for the General topic. Nothing is created or deleted: General cannot
   * be removed, and this project never claims to own it.
   *
   * **Telegram also closes General when it is hidden.** TDLib documents its
   * `is_hidden` as "hidden above the topic list and closed; for General topic
   * only", and its toggle as "pass true to hide and close". That close is the
   * server's, so the request carries `hidden` alone and never `closed` —
   * which is what TDLib sends as well. Unhiding likewise sends only
   * `hidden: false`; it does not re-open the topic.
   */
  async setGeneralTopicHidden(forum: ForumRef, hidden: boolean): Promise<void> {
    await this.client.invoke(
      new Api.messages.EditForumTopic({
        peer: TelegramAccountClient.peerOf(forum),
        topicId: GENERAL_TOPIC_ID,
        hidden,
      }),
    );
  }

  /** Edits a message's text in place. The message id does not change. */
  async setMessageText(forum: ForumRef, messageId: number, text: string): Promise<void> {
    await this.client.invoke(
      new Api.messages.EditMessage({
        peer: TelegramAccountClient.peerOf(forum),
        id: messageId,
        message: text,
      }),
    );
  }

  /**
   * Builds a reference from what Telegram returned for a channel.
   *
   * The ref carries the raw ids only. Which TL type they are wrapped in
   * depends on the method being called, so that choice is made per call by
   * {@link peerOf} and {@link channelOf} rather than baked in here.
   */
  private static refFor(channelId: bigInt.BigInteger, accessHash: bigInt.BigInteger): ForumRef {
    return new ForumRef(channelId.toString(), { channelId, accessHash } satisfies ChannelHandle);
  }

  /** Unwraps a ref. The only place that may. */
  private static handleOf(forum: ForumRef): ChannelHandle {
    const handle = forum.unwrap();
    if (
      typeof handle !== "object" ||
      handle === null ||
      !("channelId" in handle) ||
      !("accessHash" in handle)
    ) {
      throw new Error(`Not a usable forum reference: ${forum}`);
    }
    return handle as ChannelHandle;
  }

  /**
   * For `messages.*`, whose TL parameter is `peer:InputPeer`.
   *
   * See {@link channelOf}: the two are not interchangeable, and picking the
   * wrong one is a schema error the library's loose `TypeEntityLike` typing
   * will not catch.
   */
  private static peerOf(forum: ForumRef): Api.InputPeerChannel {
    return new Api.InputPeerChannel(TelegramAccountClient.handleOf(forum));
  }

  /**
   * For `channels.*`, whose TL parameter is `channel:InputChannel`.
   *
   * `InputPeerChannel` and `InputChannel` carry the same two fields but are
   * different constructors on the wire, so a `channels.*` call handed an
   * `InputPeerChannel` is malformed.
   */
  private static channelOf(forum: ForumRef): Api.InputChannel {
    return new Api.InputChannel(TelegramAccountClient.handleOf(forum));
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
