import { inspect } from "node:util";

/**
 * Library-agnostic types for forum inspection and creation.
 *
 * As with `./types.js`, nothing here depends on the MTProto library: only
 * `client.ts` imports it. The CLI and the orchestration talk to Telegram
 * through {@link ForumApi} and never see an `Api.*` object.
 */

/** A chat as shown by the read-only inspection. Safe to print in full. */
export interface DialogSummary {
  /** Telegram entity id, as a decimal string. */
  id: string;
  title: string;
  /** What the entity is, in plain words. */
  kind: "group" | "supergroup" | "forum" | "channel";
  /** Public @username, when the chat has one. Private chats have none. */
  username?: string;
}

/**
 * A handle on a channel/supergroup, carrying whatever the MTProto layer needs
 * to address it — including its access hash.
 *
 * The access hash is a credential: paired with the id it grants access to the
 * entity. So it lives in a private field and, on top of that, every way Node
 * has of turning an object into text is overridden to expose the id only:
 *
 * - `String(ref)` / template literals  → `toString()`
 * - `JSON.stringify(ref)`              → `toJSON()`
 * - `console.log(ref)` / `util.inspect`→ `[inspect.custom]()`
 *
 * Accidentally logging a ref therefore cannot leak the hash; `unwrap()` is the
 * single, deliberate way back to the payload, and only `client.ts` calls it.
 */
export class ForumRef {
  readonly #handle: unknown;

  constructor(
    readonly id: string,
    handle: unknown,
  ) {
    this.#handle = handle;
  }

  /** The MTProto payload. For `client.ts` only — never for output. */
  unwrap(): unknown {
    return this.#handle;
  }

  toString(): string {
    return `ForumRef(${this.id})`;
  }

  toJSON(): { id: string } {
    return { id: this.id };
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/** A supergroup created as a forum. */
export interface CreatedForum {
  ref: ForumRef;
  /** Telegram channel id, as a decimal string. Safe to print. */
  id: string;
  title: string;
}

/**
 * A forum recorded in local state, found alive in Telegram.
 *
 * Carries the title and description Telegram currently holds, which is what
 * the planner compares the desired ones against.
 */
export interface ResolvedForum {
  ref: ForumRef;
  title: string;
  /** The group's "about" text. Empty when it has none. */
  description: string;
}

/**
 * Telegram's built-in "General" topic.
 *
 * Every forum has one, it is always this id, and it cannot be deleted. It is
 * therefore never created by this project and never recorded in the managed
 * state: it is not ours, it merely exists, and the only thing reconciled
 * about it is whether it is hidden.
 */
export const GENERAL_TOPIC_ID = 1;

/**
 * What Telegram currently holds for the built-in General topic.
 *
 * Only `hidden` is carried, because only `hidden` is reconciled. Telegram
 * closes General by itself when it is hidden, so its `closed` flag follows
 * from this one and is deliberately not read: treating a close the server
 * performed as a divergence would make the plan never converge.
 */
export interface GeneralTopicState {
  /** True when the topic is hidden from the forum's topic list. */
  hidden: boolean;
}

/** A topic found alive in Telegram, with the title it currently has. */
export interface ExistingTopic {
  id: number;
  title: string;
}

/** A message found alive in Telegram, with the text it currently has. */
export interface ExistingMessage {
  id: number;
  text: string;
}

/** A topic created inside a forum. */
export interface CreatedTopic {
  /** Message id of the topic's service message — this is the topic id. */
  id: number;
  title: string;
}

/** A message posted into a topic. */
export interface PostedMessage {
  id: number;
  /** Topic the message went into. */
  topicId: number;
}

/**
 * The Telegram operations this milestone needs.
 *
 * `TelegramAccountClient` implements it; the tests substitute a recording fake,
 * so no test ever reaches the network.
 */
export interface ForumApi {
  /** Read-only: groups, supergroups, forums and channels in the chat list. */
  listGroupDialogs(): Promise<DialogSummary[]>;

  /**
   * Read-only: resolves a recorded channel id back to a usable reference and
   * its current title, or undefined when the forum no longer exists or is out
   * of reach.
   *
   * This is what keeps the local state file from being treated as the truth:
   * every recorded id is looked up here before the planner believes it. The
   * values come back with it, so the planner compares against Telegram rather
   * than against anything it remembered.
   */
  findForumById(id: string): Promise<ResolvedForum | undefined>;
  /**
   * Read-only: the current state of the built-in General topic, or undefined
   * when Telegram does not report it.
   *
   * Deliberately separate from {@link listExistingTopics}: General is not one
   * of the topics this project owns, and must not be mixed into the list of
   * recorded ids that drives creation and recreation.
   */
  readGeneralTopic(forum: ForumRef): Promise<GeneralTopicState | undefined>;
  /** Read-only: which of these topics still exist, and their current titles. */
  listExistingTopics(forum: ForumRef, topicIds: readonly number[]): Promise<ExistingTopic[]>;
  /** Read-only: which of these messages still exist, and their current text. */
  listExistingMessages(
    forum: ForumRef,
    messageIds: readonly number[],
  ): Promise<ExistingMessage[]>;

  /**
   * Creates a private supergroup with forum topics enabled.
   *
   * The description is set by the same call, so a freshly created forum is
   * never briefly public-facing with the wrong "about" text.
   */
  createForumSupergroup(title: string, description: string): Promise<CreatedForum>;
  /** Creates one topic in a forum. */
  createForumTopic(forum: ForumRef, title: string): Promise<CreatedTopic>;
  /** Sends one top-level message into a specific forum topic. */
  sendMessageToTopic(forum: ForumRef, topicId: number, text: string): Promise<PostedMessage>;

  /** Renames a forum in place. Its channel id does not change. */
  setForumTitle(forum: ForumRef, title: string): Promise<void>;
  /** Rewrites a forum's description in place. Its channel id does not change. */
  setForumDescription(forum: ForumRef, description: string): Promise<void>;
  /** Renames a topic in place. Its topic id does not change. */
  setTopicTitle(forum: ForumRef, topicId: number, title: string): Promise<void>;
  /**
   * Hides or shows the built-in General topic. Nothing is created or deleted:
   * `hidden` is a flag on a topic that always exists.
   *
   * Hiding it also closes it, server-side. That is Telegram's behaviour, not
   * a second operation performed here.
   */
  setGeneralTopicHidden(forum: ForumRef, hidden: boolean): Promise<void>;
  /** Edits a message's text in place. Its message id does not change. */
  setMessageText(forum: ForumRef, messageId: number, text: string): Promise<void>;
}
