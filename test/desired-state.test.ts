import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TSC8042_FORUM } from "../src/telegram/content/tsc8042.js";
import {
  DESIRED_STATE,
  validateDesiredState,
  type DesiredForum,
} from "../src/telegram/desired-state.js";

/**
 * Tests for the configuration itself, not for the reconciliation engine.
 *
 * The engine's behaviour is covered in `reconcile.test.ts` against a neutral
 * fixture, so editing a title or a paragraph of Ukrainian copy here cannot
 * break tests that are about CREATE/UPDATE/NOOP. What this file guards is the
 * content: keys stay stable and unique, nothing is blank, every topic gets
 * its intro, and no leftover from the test forum is still shipped.
 */

/** The one forum this repository manages. */
function forum(): DesiredForum {
  const only = DESIRED_STATE.forums[0];
  assert.ok(only, "the desired state must declare the forum");
  return only;
}

/** The topic keys, in the order they are declared. */
const TOPIC_KEYS = [
  "rules",
  "announcements",
  "registration",
  "routes",
  "difficult-places",
  "exam-reports",
  "successful-exams",
  "mistakes",
  "examiners",
  "appeals",
  "recordings",
  "statistics",
  "general",
  "moderation",
] as const;

describe("the TSC 8042 desired state", () => {
  it("declares exactly one forum, and it is the TSC 8042 one", () => {
    assert.equal(DESIRED_STATE.forums.length, 1);
    assert.equal(forum(), TSC8042_FORUM);
    assert.equal(forum().key, "tsc8042");
  });

  it("passes its own validation", () => {
    assert.doesNotThrow(() => validateDesiredState(DESIRED_STATE));
  });

  it("carries the community title and description", () => {
    assert.equal(forum().title, "ТСЦ 8042 — практичний іспит");
    assert.match(forum().description, /^Неофіційна спільнота кандидатів у водії ТСЦ 8042\./);
    assert.match(forum().description, /не пов’язана з ГСЦ МВС або ТСЦ 8042\.$/);
  });

  it("declares every topic, under the expected key and in order", () => {
    assert.deepEqual(
      forum().topics.map((topic) => topic.key),
      [...TOPIC_KEYS],
    );
  });
});

describe("topic keys are stable and machine-friendly", () => {
  it("has no duplicate topic key", () => {
    const keys = forum().topics.map((topic) => topic.key);
    assert.equal(new Set(keys).size, keys.length, "every topic key must be unique");
  });

  it("keeps every key to lowercase ASCII words, so it never depends on the title", () => {
    for (const topic of forum().topics) {
      assert.match(
        topic.key,
        /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
        `topic key "${topic.key}" must be a lowercase, hyphenated ASCII slug`,
      );
    }
  });

  it("puts no emoji or display wording in a key", () => {
    for (const topic of forum().topics) {
      assert.ok(
        !/[^ -~]/u.test(topic.key),
        `topic key "${topic.key}" must contain no non-ASCII character`,
      );
    }
  });
});

describe("topic titles", () => {
  it("are all non-empty", () => {
    for (const topic of forum().topics) {
      assert.notEqual(topic.title.trim(), "", `topic "${topic.key}" must have a title`);
    }
  });

  it("are all distinct, so the forum has no two identically named topics", () => {
    const titles = forum().topics.map((topic) => topic.title);
    assert.equal(new Set(titles).size, titles.length);
  });
});

describe("managed messages", () => {
  it("gives every topic exactly one intro message", () => {
    for (const topic of forum().topics) {
      assert.deepEqual(
        topic.messages.map((message) => message.key),
        ["intro"],
        `topic "${topic.key}" must carry exactly one managed message, keyed intro`,
      );
    }
  });

  it("has unique message keys within each topic", () => {
    for (const topic of forum().topics) {
      const keys = topic.messages.map((message) => message.key);
      assert.equal(new Set(keys).size, keys.length, `duplicate message key in "${topic.key}"`);
    }
  });

  it("has non-empty text everywhere", () => {
    for (const topic of forum().topics) {
      for (const message of topic.messages) {
        assert.notEqual(
          message.text.trim(),
          "",
          `message "${topic.key}/${message.key}" must not be blank`,
        );
      }
    }
  });

  it("stays inside Telegram's 4096-character limit for a single message", () => {
    for (const topic of forum().topics) {
      for (const message of topic.messages) {
        const length = [...message.text].length;
        assert.ok(
          length <= 4096,
          `message "${topic.key}/${message.key}" is ${length} characters, ` +
            `which Telegram would reject or split`,
        );
      }
    }
  });

  it("writes the intros in Ukrainian", () => {
    for (const topic of forum().topics) {
      for (const message of topic.messages) {
        assert.match(
          message.text,
          /[а-яіїєґА-ЯІЇЄҐ]/u,
          `message "${topic.key}/${message.key}" must be Ukrainian user-facing copy`,
        );
      }
    }
  });
});

describe("no test-forum content is left in the configuration", () => {
  /** Everything the throwaway test forum used to ship. */
  const LEFTOVERS = ["TSC 8042 Test", "🧪 Тест", "Тест автоматизації Telegram API"];

  it("ships none of the placeholder titles or text", () => {
    const serialized = JSON.stringify(DESIRED_STATE);
    for (const leftover of LEFTOVERS) {
      assert.ok(!serialized.includes(leftover), `"${leftover}" must no longer be configured`);
    }
  });

  it("has no topic keyed test", () => {
    assert.ok(!forum().topics.some((topic) => topic.key === "test"));
  });

  it("names the forum in Ukrainian rather than in the placeholder Latin title", () => {
    assert.match(forum().title, /[А-ЯІЇЄҐ]/u);
  });
});

describe("validateDesiredState", () => {
  const forumOf = (over: Partial<DesiredForum>): DesiredForum => ({
    key: "a",
    title: "A",
    description: "",
    topics: [],
    ...over,
  });

  it("rejects duplicate forum keys, which would share one slot in the state file", () => {
    assert.throws(
      () =>
        validateDesiredState({
          forums: [forumOf({}), forumOf({ title: "Another A" })],
        }),
      /Duplicate forum key/,
    );
  });

  it("rejects duplicate topic keys", () => {
    assert.throws(
      () =>
        validateDesiredState({
          forums: [
            forumOf({
              topics: [
                { key: "t", title: "T", messages: [] },
                { key: "t", title: "T2", messages: [] },
              ],
            }),
          ],
        }),
      /Duplicate topic in forum "a" key/,
    );
  });

  it("rejects duplicate message keys within a topic", () => {
    assert.throws(
      () =>
        validateDesiredState({
          forums: [
            forumOf({
              topics: [
                {
                  key: "t",
                  title: "T",
                  messages: [
                    { key: "m", text: "one" },
                    { key: "m", text: "two" },
                  ],
                },
              ],
            }),
          ],
        }),
      /Duplicate message in topic "a\/t" key/,
    );
  });

  it("rejects an empty key", () => {
    assert.throws(() => validateDesiredState({ forums: [forumOf({ key: "" })] }), /Empty forum key/);
  });

  it("rejects a blank title, rather than letting Telegram refuse it mid-apply", () => {
    assert.throws(
      () => validateDesiredState({ forums: [forumOf({ title: "  " })] }),
      /Empty title of forum "a"/,
    );
    assert.throws(
      () =>
        validateDesiredState({
          forums: [forumOf({ topics: [{ key: "t", title: "", messages: [] }] })],
        }),
      /Empty title of topic "a\/t"/,
    );
  });

  it("rejects blank message text", () => {
    assert.throws(
      () =>
        validateDesiredState({
          forums: [
            forumOf({ topics: [{ key: "t", title: "T", messages: [{ key: "m", text: "\n" }] }] }),
          ],
        }),
      /Empty text of message "a\/t\/m"/,
    );
  });

  it("accepts an empty description, which is a legitimate choice", () => {
    assert.doesNotThrow(() => validateDesiredState({ forums: [forumOf({ description: "" })] }));
  });
});
