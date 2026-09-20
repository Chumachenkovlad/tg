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
   *
   * Telegram closes General as well when it is hidden. That is the server's
   * behaviour; nothing here asks for it, and no other topic is ever closed.
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
 * How Telegram measures a field's length.
 *
 * Neither is `String.length`. JavaScript counts UTF-16 code units, so a
 * non-BMP emoji weighs 2 there and 1 everywhere Telegram counts characters —
 * using it would reject titles Telegram accepts.
 */
export type LengthMeasure = "utf8-bytes" | "characters";

export interface LengthLimit {
  readonly max: number;
  readonly measure: LengthMeasure;
}

/**
 * What Telegram accepts, per field, with the measure it is counted in.
 *
 * The measure is **not** uniform, so each field carries its own rather than
 * sharing one counter:
 *
 * - **Titles** are validated in UTF-8 bytes. The MTProto method pages state
 *   the constraint on `messages.createForumTopic` / `messages.editForumTopic`
 *   as "maximum UTF-8 length: 128". TDLib counts the same limit in Unicode
 *   characters (`MAX_FORUM_TOPIC_TITLE_LENGTH = 128`, applied through
 *   `clean_name` → `utf8_truncate`, "truncates UTF-8 string to the given
 *   length in Unicode characters"), so the two readings differ for non-ASCII
 *   text. Bytes are the stricter of the two and can never exceed what the
 *   character reading allows, so validating in bytes is refused-early rather
 *   than refused-by-Telegram, halfway through an apply.
 * - **The description** is validated in characters: TDLib documents
 *   `setChatDescription` as "0-255 characters" and truncates it with
 *   `strip_empty_characters` → `utf8_truncate`, again by character. Counting
 *   its bytes instead would cut a Ukrainian description to roughly half the
 *   text Telegram accepts.
 * - **Message text** is validated in characters, which is not in dispute:
 *   the limit is the `message_text_length_max` config value (4096) and TDLib
 *   checks it with `utf8_length`, documented as "length of UTF-8 string in
 *   characters".
 */
export const LIMITS = {
  forumTitle: { max: 128, measure: "utf8-bytes" },
  topicTitle: { max: 128, measure: "utf8-bytes" },
  forumDescription: { max: 255, measure: "characters" },
  messageText: { max: 4096, measure: "characters" },
} as const satisfies Record<string, LengthLimit>;

const UTF8 = new TextEncoder();

/** Bytes of the UTF-8 encoding: 1 for "a", 2 for "я", 4 for "👮". */
export function utf8ByteLength(value: string): number {
  return UTF8.encode(value).length;
}

/** Unicode characters, not UTF-16 units: `"👮".length` is 2, this returns 1. */
export function characterCount(value: string): number {
  return [...value].length;
}

/** Measures `value` the way `limit` is counted. */
export function measureLength(value: string, limit: LengthLimit): number {
  return limit.measure === "utf8-bytes" ? utf8ByteLength(value) : characterCount(value);
}

/** The measure's name, for an error a person has to act on. */
function unitsOf(measure: LengthMeasure): string {
  return measure === "utf8-bytes" ? "UTF-8 bytes" : "characters";
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

/** Exactly at the limit is fine; one unit past it is not. */
function assertWithinLimit(value: string, limit: LengthLimit, what: string): void {
  const length = measureLength(value, limit);
  if (length > limit.max) {
    const units = unitsOf(limit.measure);
    throw new Error(
      `The ${what} is ${length} ${units}, over Telegram's limit of ${limit.max} ${units}. ` +
        `Shorten it in the desired state.`,
    );
  }
}
