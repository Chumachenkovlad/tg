/**
 * The desired state: what should exist in Telegram, described declaratively.
 *
 * Every resource is identified by a stable `key`. Keys are the logical
 * identity and never change; titles and message text are just content, and
 * renaming one must not make the reconciler think it is looking at a
 * different resource. Nothing here is a Telegram id — the mapping from keys
 * to ids lives in `./managed-state.js`.
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
  topics: DesiredTopic[];
}

export interface DesiredState {
  forums: DesiredForum[];
}

/** The configuration this milestone reconciles. */
export const DESIRED_STATE: DesiredState = {
  forums: [
    {
      key: "tsc8042",
      title: "TSC 8042 Test",
      topics: [
        {
          key: "test",
          title: "🧪 Тест",
          messages: [{ key: "intro", text: "Тест автоматизації Telegram API" }],
        },
      ],
    },
  ],
};

/**
 * Rejects a configuration that cannot be reconciled unambiguously.
 *
 * Duplicate keys would make two different resources share one slot in the
 * state file, which is exactly how duplicates in Telegram get created.
 */
export function validateDesiredState(desired: DesiredState): void {
  assertUniqueKeys(
    desired.forums.map((forum) => forum.key),
    "forum",
  );

  for (const forum of desired.forums) {
    assertUniqueKeys(
      forum.topics.map((topic) => topic.key),
      `topic in forum "${forum.key}"`,
    );
    for (const topic of forum.topics) {
      assertUniqueKeys(
        topic.messages.map((message) => message.key),
        `message in topic "${forum.key}/${topic.key}"`,
      );
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
