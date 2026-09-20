import { TSC8042_FORUM } from "./content/tsc8042.js";

/**
 * The desired state: what should exist in Telegram, described declaratively.
 *
 * Every resource is identified by a stable `key`. Keys are the logical
 * identity and never change; titles and message text are just content, and
 * renaming one must not make the reconciler think it is looking at a
 * different resource. Nothing here is a Telegram id — the mapping from keys
 * to ids lives in `./managed-state.js`.
 *
 * This module carries the *shape* and the rules. The copy itself — titles,
 * descriptions, message bodies — lives under `./content/`, so long Telegram
 * text never ends up in the client or the reconciler.
 */

export interface DesiredMessage {
  /** Stable identity. Never a title. */
  key: string;
  text: string;
}

export interface DesiredTopic {
  key: string;
  title: string;
  /** Messages this project manages in the topic. Nothing else is touched. */
  messages: DesiredMessage[];
}

export interface DesiredForum {
  key: string;
  title: string;
  /**
   * The group's description ("about"), as shown in its profile.
   *
   * Reconciled like every other attribute: set when the forum is created,
   * and edited in place afterwards when this text changes.
   */
  description: string;
  /**
   * Whether Telegram's built-in "General" topic is hidden.
   *
   * Every forum has one and it cannot be deleted, so this is the only thing
   * there is to decide about it. It is **not** one of `topics`: it is not
   * created here, never recorded in the managed state, and never treated as
   * content this project owns. Reconciled both ways — unhide it by hand and
   * the next plan offers to hide it again.
   */
  hideBuiltInGeneralTopic: boolean;
  topics: DesiredTopic[];
}

export interface DesiredState {
  forums: DesiredForum[];
}

/** The configuration this repository reconciles. */
export const DESIRED_STATE: DesiredState = {
  forums: [TSC8042_FORUM],
};

/**
 * What Telegram accepts, in **code points**.
 *
 * Telegram counts characters, not UTF-8 bytes, and emoji and Cyrillic are
 * exactly as expensive as ASCII — so every check below counts `[...value]`
 * rather than `value.length`, which would count a non-BMP emoji twice and
 * reject a title Telegram would have taken.
 */
export const LIMITS = {
  forumTitle: 128,
  topicTitle: 128,
  forumDescription: 255,
  messageText: 4096,
} as const;

/** Code points, not UTF-16 units: `"👮".length` is 2, this returns 1. */
export function characterCount(value: string): number {
  return [...value].length;
}

/**
 * Rejects a configuration that cannot be reconciled unambiguously, or that
 * Telegram would refuse.
 *
 * Duplicate keys would make two different resources share one slot in the
 * state file, which is exactly how duplicates in Telegram get created. Blank
 * or over-long titles and message bodies are rejected here rather than by
 * Telegram, halfway through an apply that has already created things: the
 * planner runs this before the first mutating call, so a configuration that
 * cannot be applied fully is not applied at all.
 */
export function validateDesiredState(desired: DesiredState): void {
  assertUniqueKeys(
    desired.forums.map((forum) => forum.key),
    "forum",
  );

  for (const forum of desired.forums) {
    assertNonEmpty(forum.title, `title of forum "${forum.key}"`);
    assertWithinLimit(forum.title, LIMITS.forumTitle, `title of forum "${forum.key}"`);
    assertWithinLimit(
      forum.description,
      LIMITS.forumDescription,
      `description of forum "${forum.key}"`,
    );
    assertUniqueKeys(
      forum.topics.map((topic) => topic.key),
      `topic in forum "${forum.key}"`,
    );
    for (const topic of forum.topics) {
      const topicPath = `${forum.key}/${topic.key}`;
      assertNonEmpty(topic.title, `title of topic "${topicPath}"`);
      assertWithinLimit(topic.title, LIMITS.topicTitle, `title of topic "${topicPath}"`);
      assertUniqueKeys(
        topic.messages.map((message) => message.key),
        `message in topic "${topicPath}"`,
      );
      for (const message of topic.messages) {
        assertNonEmpty(message.text, `text of message "${topicPath}/${message.key}"`);
        assertWithinLimit(
          message.text,
          LIMITS.messageText,
          `text of message "${topicPath}/${message.key}"`,
        );
      }
    }
  }
}

function assertUniqueKeys(keys: readonly string[], what: string): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (!key) throw new Error(`Empty ${what} key in the desired state.`);
    if (seen.has(key)) throw new Error(`Duplicate ${what} key in the desired state: "${key}".`);
    seen.add(key);
  }
}

/** A description may be empty; a title or a message body may not. */
function assertNonEmpty(value: string, what: string): void {
  if (value.trim() === "") throw new Error(`Empty ${what} in the desired state.`);
}

/** Exactly at the limit is fine; one code point past it is not. */
function assertWithinLimit(value: string, limit: number, what: string): void {
  const length = characterCount(value);
  if (length > limit) {
    throw new Error(
      `The ${what} is ${length} characters, over Telegram's limit of ${limit}. ` +
        `Shorten it in the desired state.`,
    );
  }
}
