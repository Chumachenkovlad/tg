import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TSC8042_FORUM } from "../src/telegram/content/tsc8042.js";
import {
  DESIRED_STATE,
  LIMITS,
  characterCount,
  measureLength,
  utf8ByteLength,
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

  it("fits the description in the characters Telegram counts", () => {
    // 182 characters but 326 UTF-8 bytes: the description is the one field
    // where the two measures disagree about this content, so the measure
    // being the documented one is load-bearing rather than incidental.
    const description = forum().description;
    assert.equal(LIMITS.forumDescription.measure, "characters");
    assert.ok(
      characterCount(description) <= LIMITS.forumDescription.max,
      `the description is ${characterCount(description)} characters`,
    );
    assert.ok(
      utf8ByteLength(description) > LIMITS.forumDescription.max,
      "and would not fit if the limit were counted in bytes — kept as a reminder of why",
    );
  });

  it("declares every topic, under the expected key and in order", () => {
    assert.deepEqual(
      forum().topics.map((topic) => topic.key),
      [...TOPIC_KEYS],
    );
  });

  it("hides Telegram's built-in General topic, keeping its own `general` topic", () => {
    assert.equal(forum().hideBuiltInGeneralTopic, true);
    // The managed topic stays: it is ours, it is the one people are pointed
    // at, and it is not the built-in one.
    const general = forum().topics.find((topic) => topic.key === "general");
    assert.ok(general, "the managed general topic must still be declared");
    assert.equal(general.title, "💬 Загальні питання");
  });
});

describe("the rules topic carries the navigation", () => {
  const rules = (): string => {
    const topic = forum().topics.find((entry) => entry.key === "rules");
    assert.ok(topic);
    const intro = topic.messages.find((message) => message.key === "intro");
    assert.ok(intro);
    return intro.text;
  };

  it("has a navigation section, as its title promises", () => {
    assert.match(rules(), /Навігація/u);
  });

  /**
   * Topics the navigation deliberately does not list.
   *
   * `rules` is where the reader already is, `announcements` is read rather
   * than posted to, and `successful-exams` is left out to keep the section
   * short — reports of a passed exam have the obvious home in `exam-reports`.
   */
  const NOT_SIGNPOSTED = ["rules", "announcements", "successful-exams"];

  it("points at every topic a person might need to find", () => {
    const signposted = forum().topics.filter((topic) => !NOT_SIGNPOSTED.includes(topic.key));

    for (const topic of signposted) {
      assert.ok(
        rules().includes(topic.title),
        `the navigation must point at "${topic.title}" (${topic.key})`,
      );
    }
  });

  it("names each destination exactly as the topic is titled", () => {
    // Copy-pasted titles, not paraphrases: retitle a topic and this fails,
    // which is the reminder to update the navigation with it.
    const navigation = rules().slice(rules().indexOf("Навігація"));
    const bullets = navigation.split("\n").filter((line) => line.startsWith("•"));

    assert.equal(bullets.length, 11, "one line per signposted topic");
    for (const bullet of bullets) {
      assert.ok(
        forum().topics.some((topic) => bullet.includes(topic.title)),
        `navigation line does not name a configured topic: ${bullet}`,
      );
    }
  });

  it("stays compact", () => {
    const navigation = rules().slice(rules().indexOf("Навігація"));
    assert.ok(
      characterCount(navigation) < 900,
      `the navigation section is ${characterCount(navigation)} characters, which is not compact`,
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

  it("fit the byte limit with room to spare, emoji and Cyrillic included", () => {
    // Emoji cost four bytes each and Cyrillic two, so a title that looks
    // short can still be long to Telegram. The headroom is asserted rather
    // than just the limit: a title at 127 bytes would pass and still be one
    // small edit away from failing an apply.
    for (const topic of forum().topics) {
      const bytes = utf8ByteLength(topic.title);
      assert.ok(
        bytes <= LIMITS.topicTitle.max,
        `"${topic.title}" is ${bytes} UTF-8 bytes, over the ${LIMITS.topicTitle.max}-byte limit`,
      );
      assert.ok(bytes < 100, `"${topic.title}" is ${bytes} UTF-8 bytes, uncomfortably close`);
    }
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

  it("stays inside Telegram's per-message limit", () => {
    for (const topic of forum().topics) {
      for (const message of topic.messages) {
        const length = measureLength(message.text, LIMITS.messageText);
        assert.ok(
          length <= LIMITS.messageText.max,
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
    hideBuiltInGeneralTopic: false,
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

  describe("Telegram's length limits", () => {
    /**
     * A string of exactly `n` units, under either measure.
     *
     * ASCII is the only filler that weighs 1 as a UTF-8 byte *and* as a
     * character, which is what lets one table drive the boundary cases for
     * fields measured differently. Cyrillic and emoji, where the two measures
     * disagree, get their own blocks below.
     */
    const text = (n: number): string => "a".repeat(n);

    /** The fixture with one over-long value, built at the given length. */
    const withLength: Record<string, (n: number) => DesiredForum> = {
      "forum title": (n) => forumOf({ title: text(n) }),
      "forum description": (n) => forumOf({ description: text(n) }),
      "topic title": (n) => forumOf({ topics: [{ key: "t", title: text(n), messages: [] }] }),
      "message text": (n) =>
        forumOf({
          topics: [{ key: "t", title: "T", messages: [{ key: "m", text: text(n) }] }],
        }),
    };

    const CASES = [
      ["forum title", LIMITS.forumTitle, { max: 128, measure: "utf8-bytes" }],
      ["topic title", LIMITS.topicTitle, { max: 128, measure: "utf8-bytes" }],
      ["forum description", LIMITS.forumDescription, { max: 255, measure: "characters" }],
      ["message text", LIMITS.messageText, { max: 4096, measure: "characters" }],
    ] as const;

    /**
     * One unit of the measure, as the shortest string that weighs exactly 1.
     *
     * ASCII is one byte and one character, so it is the only filler that can
     * land a value exactly on a limit under either measure.
     */
    const unit = "a";

    for (const [what, limit, documented] of CASES) {
      const units = documented.measure === "utf8-bytes" ? "UTF-8 bytes" : "characters";

      it(`measures the ${what} in ${units}, capped at ${documented.max}`, () => {
        assert.deepEqual({ ...limit }, { ...documented }, "the audited limit must not drift");
      });

      it(`accepts a ${what} of exactly ${documented.max} ${units}`, () => {
        const build = withLength[what];
        assert.ok(build);
        const forum = build(limit.max);
        assert.doesNotThrow(() => validateDesiredState({ forums: [forum] }));
      });

      it(`rejects a ${what} one unit over`, () => {
        const build = withLength[what];
        assert.ok(build);
        assert.throws(
          () => validateDesiredState({ forums: [build(limit.max + 1)] }),
          new RegExp(
            `is ${limit.max + 1} ${units}, over Telegram's limit of ${limit.max} ${units}`,
          ),
        );
      });

      it(`counts the ${what} in ${units}, not UTF-16 units`, () => {
        // JavaScript's String.length counts UTF-16 units, so a non-BMP emoji
        // weighs 2 there. Telegram never counts that way under either
        // measure, so using it would be wrong in both directions.
        const build = withLength[what];
        assert.ok(build);
        const naive = unit.repeat(limit.max);
        assert.equal(naive.length, measureLength(naive, limit));
      });
    }

    describe("Cyrillic, which costs two bytes and one character", () => {
      // "я" is 2 UTF-8 bytes and 1 character. Every Ukrainian title and
      // description in this repository is made of characters like it, so the
      // two measures genuinely disagree about the real content.
      it("weighs what each measure says it weighs", () => {
        assert.equal(utf8ByteLength("я"), 2);
        assert.equal(characterCount("я"), 1);
        assert.equal("я".length, 1);
      });

      it("fits 64 Cyrillic characters in a 128-byte topic title, and not 65", () => {
        const fits = "я".repeat(64);
        assert.equal(utf8ByteLength(fits), 128);
        assert.doesNotThrow(() =>
          validateDesiredState({
            forums: [forumOf({ topics: [{ key: "t", title: fits, messages: [] }] })],
          }),
        );

        assert.throws(
          () =>
            validateDesiredState({
              forums: [forumOf({ topics: [{ key: "t", title: "я".repeat(65), messages: [] }] })],
            }),
          /is 130 UTF-8 bytes, over Telegram's limit of 128 UTF-8 bytes/,
        );
      });

      it("fits 255 Cyrillic characters in the description, though they are 510 bytes", () => {
        const description = "я".repeat(255);
        assert.equal(utf8ByteLength(description), 510);
        assert.doesNotThrow(() => validateDesiredState({ forums: [forumOf({ description })] }));

        assert.throws(
          () => validateDesiredState({ forums: [forumOf({ description: "я".repeat(256) })] }),
          /is 256 characters, over Telegram's limit of 255 characters/,
        );
      });
    });

    describe("non-BMP emoji, which cost four bytes and one character", () => {
      // "👮" is 4 UTF-8 bytes, 1 character, and 2 UTF-16 units — all three
      // counts differ, which is what makes it the useful regression case.
      it("weighs what each measure says it weighs", () => {
        assert.equal(utf8ByteLength("👮"), 4);
        assert.equal(characterCount("👮"), 1);
        assert.equal("👮".length, 2);
      });

      it("fits 32 emoji in a 128-byte title, and not 33", () => {
        const fits = "👮".repeat(32);
        assert.equal(utf8ByteLength(fits), 128);
        assert.doesNotThrow(() => validateDesiredState({ forums: [forumOf({ title: fits })] }));

        assert.throws(
          () => validateDesiredState({ forums: [forumOf({ title: "👮".repeat(33) })] }),
          /is 132 UTF-8 bytes, over Telegram's limit of 128 UTF-8 bytes/,
        );
      });

      it("no longer accepts 128 emoji in a title, which the byte limit forbids", () => {
        // This is the regression: counting characters let 128 emoji through
        // as "128 characters", which is 512 UTF-8 bytes.
        const title = "👮".repeat(128);
        assert.equal(characterCount(title), 128, "128 by the character count");
        assert.equal(utf8ByteLength(title), 512, "but 512 UTF-8 bytes");

        assert.throws(
          () => validateDesiredState({ forums: [forumOf({ title })] }),
          /is 512 UTF-8 bytes, over Telegram's limit of 128 UTF-8 bytes/,
        );
      });

      it("counts an emoji as one character in a message, not two", () => {
        // The message limit is in characters, so the UTF-16 count would
        // wrongly halve how much text fits.
        const text = "👮".repeat(LIMITS.messageText.max);
        assert.equal(text.length, LIMITS.messageText.max * 2);
        assert.doesNotThrow(() =>
          validateDesiredState({
            forums: [
              forumOf({ topics: [{ key: "t", title: "T", messages: [{ key: "m", text }] }] }),
            ],
          }),
        );
      });
    });

    it("names the value and the measure it rejected, so a long config is searchable", () => {
      assert.throws(
        () =>
          validateDesiredState({
            forums: [
              forumOf({
                topics: [
                  { key: "t", title: "T", messages: [{ key: "m", text: text(4097) }] },
                ],
              }),
            ],
          }),
        /The text of message "a\/t\/m" is 4097 characters/,
      );

      assert.throws(
        () => validateDesiredState({ forums: [forumOf({ title: "я".repeat(65) })] }),
        /The title of forum "a" is 130 UTF-8 bytes/,
      );
    });
  });
});
