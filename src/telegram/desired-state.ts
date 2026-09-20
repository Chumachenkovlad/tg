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
 * Rejects a configuration that cannot be reconciled unambiguously.
 *
 * Duplicate keys would make two different resources share one slot in the
 * state file, which is exactly how duplicates in Telegram get created. Blank
 * titles and blank message bodies are rejected here rather than by Telegram,
 * halfway through an apply that has already created things.
 */
export function validateDesiredState(desired: DesiredState): void {
  assertUniqueKeys(
    desired.forums.map((forum) => forum.key),
    "forum",
  );

  for (const forum of desired.forums) {
    assertNonEmpty(forum.title, `title of forum "${forum.key}"`);
    assertUniqueKeys(
      forum.topics.map((topic) => topic.key),
      `topic in forum "${forum.key}"`,
    );
    for (const topic of forum.topics) {
      assertNonEmpty(topic.title, `title of topic "${forum.key}/${topic.key}"`);
      assertUniqueKeys(
        topic.messages.map((message) => message.key),
        `message in topic "${forum.key}/${topic.key}"`,
      );
      for (const message of topic.messages) {
        assertNonEmpty(message.text, `text of message "${forum.key}/${topic.key}/${message.key}"`);
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
