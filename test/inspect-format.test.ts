import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDialogs } from "../src/telegram/format-dialogs.js";
import type { DialogSummary } from "../src/telegram/forum-types.js";
import { describePlan, TEST_FORUM_PLAN } from "../src/telegram/test-forum-plan.js";

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

describe("describePlan", () => {
  it("describes the three steps in order", () => {
    const lines = describePlan();

    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? "", /^1\. Create a private supergroup configured as a forum/);
    assert.match(lines[1] ?? "", /^2\. Create one forum topic/);
    assert.match(lines[2] ?? "", /^3\. Send one message into that topic/);
  });

  it("quotes exactly the configured titles and message", () => {
    const text = describePlan().join("\n");

    assert.ok(text.includes(`"${TEST_FORUM_PLAN.forumTitle}"`));
    assert.ok(text.includes(`"${TEST_FORUM_PLAN.topicTitle}"`));
    assert.ok(text.includes(`"${TEST_FORUM_PLAN.message}"`));
  });

  it("uses the milestone's agreed names", () => {
    assert.equal(TEST_FORUM_PLAN.forumTitle, "TSC 8042 Test");
    assert.equal(TEST_FORUM_PLAN.topicTitle, "🧪 Тест");
    assert.equal(TEST_FORUM_PLAN.message, "Тест автоматизації Telegram API");
  });
});
