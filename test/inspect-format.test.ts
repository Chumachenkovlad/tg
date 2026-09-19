import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DESIRED_STATE, validateDesiredState } from "../src/telegram/desired-state.js";
import { formatDialogs } from "../src/telegram/format-dialogs.js";
import type { DialogSummary } from "../src/telegram/forum-types.js";

const DIALOGS: DialogSummary[] = [
  { id: "1000000001", title: "Public channel", kind: "channel", username: "some_channel" },
  { id: "1000000002", title: "Private forum", kind: "forum" },
  { id: "1000000003", title: "Old group", kind: "group" },
];

describe("formatDialogs", () => {
  it("prints title, id, type and username for each dialog", () => {
    const output = formatDialogs(DIALOGS).join("\n");

    assert.match(output, /title:\s+Public channel/);
    assert.match(output, /id:\s+1000000001/);
    assert.match(output, /type:\s+channel/);
    assert.match(output, /username:\s+@some_channel/);
  });

  it("marks a dialog without a username as private rather than omitting the row", () => {
    const output = formatDialogs([DIALOGS[1] as DialogSummary]).join("\n");

    assert.match(output, /username:\s+— \(private\)/);
  });

  it("reports how many dialogs there are", () => {
    assert.match(formatDialogs(DIALOGS)[0] ?? "", /^3 group\/channel dialog\(s\):/);
  });

  it("says so plainly when there are none", () => {
    assert.deepEqual(formatDialogs([]), [
      "No groups, supergroups, forums or channels in the chat list.",
    ]);
  });

  it("prints nothing beyond the four safe fields", () => {
    // DialogSummary carries no credential, and the formatter invents none:
    // whatever the entity's access hash was, it cannot appear here.
    const output = formatDialogs(DIALOGS).join("\n").toLowerCase();

    for (const secret of ["accesshash", "access_hash", "authkey", "session"]) {
      assert.ok(!output.includes(secret), `output must not contain ${secret}`);
    }
  });
});

describe("DESIRED_STATE", () => {
  it("holds the milestone's configuration under stable keys", () => {
    const forum = DESIRED_STATE.forums[0];
    assert.ok(forum);
    assert.equal(forum.key, "tsc8042");
    assert.equal(forum.title, "TSC 8042 Test");

    const topic = forum.topics[0];
    assert.ok(topic);
    assert.equal(topic.key, "test");
    assert.equal(topic.title, "🧪 Тест");

    const message = topic.messages[0];
    assert.ok(message);
    assert.equal(message.key, "intro");
    assert.equal(message.text, "Тест автоматизації Telegram API");
  });

  it("passes its own validation", () => {
    assert.doesNotThrow(() => validateDesiredState(DESIRED_STATE));
  });

  it("rejects duplicate keys, which would share one slot in the state file", () => {
    assert.throws(
      () =>
        validateDesiredState({
          forums: [
            { key: "a", title: "A", topics: [] },
            { key: "a", title: "Another A", topics: [] },
          ],
        }),
      /Duplicate forum key/,
    );
  });

  it("rejects duplicate topic and message keys too", () => {
    assert.throws(
      () =>
        validateDesiredState({
          forums: [
            {
              key: "a",
              title: "A",
              topics: [
                { key: "t", title: "T", messages: [] },
                { key: "t", title: "T2", messages: [] },
              ],
            },
          ],
        }),
      /Duplicate topic in forum "a" key/,
    );

    assert.throws(
      () =>
        validateDesiredState({
          forums: [
            {
              key: "a",
              title: "A",
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
            },
          ],
        }),
      /Duplicate message in topic "a\/t" key/,
    );
  });

  it("rejects an empty key", () => {
    assert.throws(
      () => validateDesiredState({ forums: [{ key: "", title: "A", topics: [] }] }),
      /Empty forum key/,
    );
  });
});
