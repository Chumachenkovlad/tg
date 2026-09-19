import assert from "node:assert/strict";
import { inspect } from "node:util";
import { describe, it } from "node:test";
import { runTestForumCommand, type ForumSession } from "../src/cli/test-forum-command.js";
import { createTestForum } from "../src/telegram/create-test-forum.js";
import {
  ForumRef,
  type CreatedForum,
  type CreatedTopic,
  type ForumApi,
  type PostedMessage,
} from "../src/telegram/forum-types.js";
import { TEST_FORUM_PLAN } from "../src/telegram/test-forum-plan.js";

/** The access hash the fake hides inside its ref — must never reach output. */
const SECRET_ACCESS_HASH = "7766554433221100";

/**
 * Records every call instead of making one. Nothing here touches the network,
 * so "zero mutations" in these tests means literally zero calls attempted.
 */
class RecordingForumApi implements ForumApi {
  readonly calls: string[] = [];
  readonly ref = new ForumRef("2000000042", { accessHash: SECRET_ACCESS_HASH });
  /** Name of the call that should throw, and what it throws. */
  failAt: { call: string; error: Error } | undefined;

  private record(call: string): void {
    this.calls.push(call);
    if (this.failAt?.call === call) throw this.failAt.error;
  }

  async listGroupDialogs() {
    this.record("listGroupDialogs");
    return [];
  }

  async createForumSupergroup(title: string): Promise<CreatedForum> {
    this.record(`createForumSupergroup(${title})`);
    return { ref: this.ref, id: "2000000042", title };
  }

  async createForumTopic(forum: ForumRef, title: string): Promise<CreatedTopic> {
    assert.equal(forum, this.ref, "the topic must go into the forum that was just created");
    this.record(`createForumTopic(${title})`);
    return { id: 17, title };
  }

  async sendMessageToTopic(
    forum: ForumRef,
    topicId: number,
    text: string,
  ): Promise<PostedMessage> {
    assert.equal(forum, this.ref, "the message must go into the forum that was just created");
    this.record(`sendMessageToTopic(${topicId}, ${text})`);
    return { id: 18, topicId };
  }
}

/** Drives the command with fakes and collects everything it printed. */
function runCommand(
  argv: readonly string[],
  options: { api?: RecordingForumApi; confirmWith?: boolean } = {},
): Promise<{ api: RecordingForumApi; output: string; connects: number; closes: number }> {
  const api = options.api ?? new RecordingForumApi();
  const lines: string[] = [];
  let connects = 0;
  let closes = 0;

  const session: ForumSession = {
    api,
    close: async () => {
      closes += 1;
    },
  };

  return runTestForumCommand(argv, {
    connect: async () => {
      connects += 1;
      return session;
    },
    confirm: async () => {
      if (options.confirmWith === undefined) {
        assert.fail("the command must not ask for confirmation in this mode");
      }
      return options.confirmWith;
    },
    log: (message) => lines.push(message),
  }).then(() => ({ api, output: lines.join("\n"), connects, closes }));
}

/** The three calls an approved --apply is supposed to make, in order. */
const EXPECTED_CALLS = [
  `createForumSupergroup(${TEST_FORUM_PLAN.forumTitle})`,
  `createForumTopic(${TEST_FORUM_PLAN.topicTitle})`,
  `sendMessageToTopic(17, ${TEST_FORUM_PLAN.message})`,
];

describe("create-test-forum: dry run", () => {
  it("performs zero Telegram mutations by default", async () => {
    const { api, connects } = await runCommand([]);

    assert.deepEqual(api.calls, [], "a dry run must not call Telegram at all");
    assert.equal(connects, 0, "a dry run must not even open a connection");
  });

  it("performs zero Telegram mutations with an explicit --dry-run", async () => {
    const { api, connects } = await runCommand(["--dry-run"]);

    assert.deepEqual(api.calls, []);
    assert.equal(connects, 0);
  });

  it("prints the intended actions, and says nothing happened", async () => {
    const { output } = await runCommand(["--dry-run"]);

    assert.match(output, /DRY RUN/);
    assert.match(output, new RegExp(TEST_FORUM_PLAN.forumTitle));
    assert.match(output, new RegExp(TEST_FORUM_PLAN.topicTitle));
    assert.match(output, new RegExp(TEST_FORUM_PLAN.message));
    assert.match(output, /Nothing was created/);
  });

  it("does not print anything that looks like a created id", async () => {
    const { output } = await runCommand(["--dry-run"]);

    assert.ok(!output.includes("forum id:"), "a dry run creates nothing, so it has no ids");
  });
});

describe("create-test-forum: --apply", () => {
  it("invokes exactly the three expected creation steps, in order", async () => {
    const { api } = await runCommand(["--apply", "--yes"]);

    assert.deepEqual(api.calls, EXPECTED_CALLS);
  });

  it("sends the message into the topic it just created, not into the forum root", async () => {
    const { api } = await runCommand(["--apply", "--yes"]);

    assert.ok(
      api.calls.some((call) => call.startsWith("sendMessageToTopic(17,")),
      "the topic id from step 2 must address the message in step 3",
    );
  });

  it("prints the resulting identifiers", async () => {
    const { output } = await runCommand(["--apply", "--yes"]);

    assert.match(output, /forum id:\s+2000000042/);
    assert.match(output, /topic id:\s+17/);
    assert.match(output, /message id:\s+18/);
  });

  it("disconnects afterwards", async () => {
    const { closes } = await runCommand(["--apply", "--yes"]);

    assert.equal(closes, 1);
  });

  it("reads nothing and touches no existing chat", async () => {
    const { api } = await runCommand(["--apply", "--yes"]);

    assert.ok(!api.calls.includes("listGroupDialogs"));
    assert.equal(api.calls.length, 3, "exactly three calls, no bulk work");
  });
});

describe("create-test-forum: confirmation", () => {
  it("performs zero mutations when the confirmation is refused", async () => {
    const { api, output, connects } = await runCommand(["--apply"], { confirmWith: false });

    assert.deepEqual(api.calls, [], "a refused confirmation must not call Telegram");
    assert.equal(connects, 0, "a refused confirmation must not open a connection");
    assert.match(output, /Cancelled/);
  });

  it("proceeds when the confirmation is accepted", async () => {
    const { api } = await runCommand(["--apply"], { confirmWith: true });

    assert.deepEqual(api.calls, EXPECTED_CALLS);
  });

  it("shows the plan before asking", async () => {
    const { output } = await runCommand(["--apply"], { confirmWith: false });

    assert.match(output, new RegExp(TEST_FORUM_PLAN.forumTitle));
  });

  it("skips the prompt only for --yes", async () => {
    // runCommand fails the test if confirm() is called without confirmWith,
    // so reaching the three calls here proves the prompt was skipped.
    const { api } = await runCommand(["--apply", "--yes"]);

    assert.deepEqual(api.calls, EXPECTED_CALLS);
  });
});

describe("create-test-forum: failures stop the sequence", () => {
  it("does not create a topic when the group creation fails", async () => {
    const api = new RecordingForumApi();
    api.failAt = {
      call: `createForumSupergroup(${TEST_FORUM_PLAN.forumTitle})`,
      error: new Error("CHAT_TITLE_INVALID"),
    };

    await assert.rejects(() => runCommand(["--apply", "--yes"], { api }), /CHAT_TITLE_INVALID/);

    assert.deepEqual(api.calls, [`createForumSupergroup(${TEST_FORUM_PLAN.forumTitle})`]);
  });

  it("does not send a message when the topic creation fails", async () => {
    const api = new RecordingForumApi();
    api.failAt = {
      call: `createForumTopic(${TEST_FORUM_PLAN.topicTitle})`,
      error: new Error("TOPIC_TITLE_INVALID"),
    };

    await assert.rejects(() => runCommand(["--apply", "--yes"], { api }), /TOPIC_TITLE_INVALID/);

    assert.deepEqual(api.calls, EXPECTED_CALLS.slice(0, 2), "no message may be sent");
  });

  it("never retries a failed creation, so no duplicate group can appear", async () => {
    const api = new RecordingForumApi();
    api.failAt = {
      call: `createForumSupergroup(${TEST_FORUM_PLAN.forumTitle})`,
      error: new Error("FLOOD_WAIT_30"),
    };

    await assert.rejects(() => createTestForum(api), /FLOOD_WAIT_30/);

    assert.equal(api.calls.length, 1, "exactly one attempt, never a second one");
  });

  it("still disconnects when a step fails", async () => {
    const api = new RecordingForumApi();
    api.failAt = {
      call: `createForumTopic(${TEST_FORUM_PLAN.topicTitle})`,
      error: new Error("boom"),
    };
    let closes = 0;

    await assert.rejects(
      () =>
        runTestForumCommand(["--apply", "--yes"], {
          connect: async () => ({
            api,
            close: async () => {
              closes += 1;
            },
          }),
          confirm: async () => assert.fail("--yes must skip the prompt"),
          log: () => {},
        }),
      /boom/,
    );

    assert.equal(closes, 1);
  });
});

describe("create-test-forum: nothing sensitive is printed", () => {
  const FORBIDDEN = [SECRET_ACCESS_HASH, "accessHash", "authKey", "apiHash", "session"];

  for (const argv of [[], ["--dry-run"], ["--apply", "--yes"]]) {
    it(`keeps secrets out of the output for \`${argv.join(" ") || "(no flags)"}\``, async () => {
      const { output } = await runCommand(argv);

      for (const secret of FORBIDDEN) {
        assert.ok(
          !output.toLowerCase().includes(secret.toLowerCase()),
          `output must not contain ${secret}`,
        );
      }
    });
  }

  it("keeps the access hash out of a ForumRef, however it is stringified", () => {
    const ref = new ForumRef("2000000042", { accessHash: SECRET_ACCESS_HASH });

    for (const rendered of [
      String(ref),
      `${ref}`,
      JSON.stringify(ref),
      inspect(ref),
      inspect({ ref }, { depth: 5 }),
    ]) {
      assert.ok(!rendered.includes(SECRET_ACCESS_HASH), `leaked through: ${rendered}`);
      assert.match(rendered, /2000000042/, "the id itself is safe and should survive");
    }
  });

  it("still hands the payload back through unwrap()", () => {
    // The hash is not lost — it is just not printable by accident.
    const handle = { accessHash: SECRET_ACCESS_HASH };

    assert.equal(new ForumRef("1", handle).unwrap(), handle);
  });
});
