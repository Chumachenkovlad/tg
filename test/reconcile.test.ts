import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runReconcileCommand, type ForumSession } from "../src/cli/reconcile-command.js";
import { DESIRED_STATE, type DesiredState } from "../src/telegram/desired-state.js";
import {
  ForumRef,
  type CreatedForum,
  type CreatedTopic,
  type DialogSummary,
  type ForumApi,
  type PostedMessage,
} from "../src/telegram/forum-types.js";
import {
  MemoryManagedStateStore,
  emptyState,
  type ManagedState,
} from "../src/telegram/managed-state.js";
import { buildPlan, countByType, hasMutations, type Plan } from "../src/telegram/planner.js";
import { applyPlan } from "../src/telegram/reconcile.js";

/**
 * A fake Telegram that behaves like the real one for reconciliation purposes:
 * it holds forums, topics and messages, hands out fresh ids, and answers the
 * existence queries honestly. Every call is recorded, so a test can assert
 * that a run made no mutating call at all.
 *
 * Nothing here touches the network.
 */
class FakeTelegram implements ForumApi {
  readonly calls: string[] = [];
  /** channel id → its live topics and messages. */
  readonly forums = new Map<string, { title: string; topics: Map<number, Set<number>> }>();
  /** Chats this account is in but does not manage. */
  unmanagedDialogs: DialogSummary[] = [];
  failAt: { call: string; error: Error } | undefined;

  private nextChannelId = 2000000001;
  private nextMessageId = 100;

  /** Mutating calls only — what the invariant is actually about. */
  get mutations(): string[] {
    return this.calls.filter((call) => call.startsWith("create") || call.startsWith("send"));
  }

  private record(call: string): void {
    this.calls.push(call);
    if (this.failAt?.call === call) throw this.failAt.error;
  }

  /** Deletes a topic behind the reconciler's back, as a person would. */
  deleteTopic(channelId: string, topicId: number): void {
    this.forums.get(channelId)?.topics.delete(topicId);
  }

  /** Deletes one message behind the reconciler's back. */
  deleteMessage(channelId: string, topicId: number, messageId: number): void {
    this.forums.get(channelId)?.topics.get(topicId)?.delete(messageId);
  }

  /** Removes the whole group, as leaving or deleting it would. */
  deleteForum(channelId: string): void {
    this.forums.delete(channelId);
  }

  async listGroupDialogs(): Promise<DialogSummary[]> {
    this.record("listGroupDialogs");
    return [
      ...this.unmanagedDialogs,
      ...[...this.forums].map(([id, forum]): DialogSummary => ({
        id,
        title: forum.title,
        kind: "forum",
      })),
    ];
  }

  async findForumById(id: string): Promise<ForumRef | undefined> {
    this.record(`findForumById(${id})`);
    return this.forums.has(id) ? new ForumRef(id, { channelId: id }) : undefined;
  }

  async listExistingTopicIds(forum: ForumRef, topicIds: readonly number[]): Promise<number[]> {
    this.record(`listExistingTopicIds(${forum.id}, [${topicIds.join(",")}])`);
    const topics = this.forums.get(forum.id)?.topics;
    return topicIds.filter((id) => topics?.has(id) === true);
  }

  async listExistingMessageIds(forum: ForumRef, messageIds: readonly number[]): Promise<number[]> {
    this.record(`listExistingMessageIds(${forum.id}, [${messageIds.join(",")}])`);
    const topics = this.forums.get(forum.id)?.topics;
    const alive = new Set([...(topics?.values() ?? [])].flatMap((set) => [...set]));
    return messageIds.filter((id) => alive.has(id));
  }

  async createForumSupergroup(title: string): Promise<CreatedForum> {
    this.record(`createForumSupergroup(${title})`);
    const id = String(this.nextChannelId++);
    this.forums.set(id, { title, topics: new Map() });
    return { ref: new ForumRef(id, { channelId: id }), id, title };
  }

  async createForumTopic(forum: ForumRef, title: string): Promise<CreatedTopic> {
    this.record(`createForumTopic(${forum.id}, ${title})`);
    const entry = this.forums.get(forum.id);
    if (!entry) throw new Error(`fake: no such forum ${forum.id}`);
    const id = this.nextMessageId++;
    entry.topics.set(id, new Set());
    return { id, title };
  }

  async sendMessageToTopic(
    forum: ForumRef,
    topicId: number,
    text: string,
  ): Promise<PostedMessage> {
    this.record(`sendMessageToTopic(${forum.id}, ${topicId}, ${text})`);
    const topic = this.forums.get(forum.id)?.topics.get(topicId);
    if (!topic) throw new Error(`fake: no such topic ${topicId}`);
    const id = this.nextMessageId++;
    topic.add(id);
    return { id, topicId };
  }
}

/** Plans and applies once, the way `telegram:apply -- --yes` would. */
async function reconcile(
  api: FakeTelegram,
  store: MemoryManagedStateStore,
  desired: DesiredState = DESIRED_STATE,
): Promise<Plan> {
  const plan = await buildPlan(desired, store.load(), api);
  await applyPlan(plan, api, store);
  return plan;
}

function planShape(plan: Plan): string[] {
  return plan.actions.map((action) => `${action.type} ${action.resource} ${action.path}`);
}

const FIRST_RUN = [
  "CREATE forum tsc8042",
  "CREATE topic tsc8042/test",
  "CREATE message tsc8042/test/intro",
];

const CONVERGED = [
  "NOOP forum tsc8042",
  "NOOP topic tsc8042/test",
  "NOOP message tsc8042/test/intro",
];

describe("planner: first run", () => {
  it("plans a create for the forum, the topic and the message", async () => {
    const plan = await buildPlan(DESIRED_STATE, emptyState(), new FakeTelegram());

    assert.deepEqual(planShape(plan), FIRST_RUN);
    assert.equal(countByType(plan).CREATE, 3);
  });

  it("explains why, without inventing ids", async () => {
    const plan = await buildPlan(DESIRED_STATE, emptyState(), new FakeTelegram());

    assert.match(plan.actions[0]?.reason ?? "", /not created yet/);
  });

  it("plans without calling Telegram at all when nothing is recorded", async () => {
    const api = new FakeTelegram();

    await buildPlan(DESIRED_STATE, emptyState(), api);

    // There is no id to verify, so there is nothing to ask.
    assert.deepEqual(api.calls, []);
  });
});

describe("the convergence invariant", () => {
  it("creates on the first apply and does nothing on the second", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();

    const first = await reconcile(api, store);
    assert.deepEqual(planShape(first), FIRST_RUN);
    assert.equal(api.mutations.length, 3);

    const second = await buildPlan(DESIRED_STATE, store.load(), api);
    assert.deepEqual(planShape(second), CONVERGED);
    assert.equal(hasMutations(second), false);
  });

  it("stays converged over repeated applies, creating no duplicates", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();

    await reconcile(api, store);
    const mutationsAfterFirst = api.mutations.length;

    await reconcile(api, store);
    await reconcile(api, store);

    assert.equal(api.mutations.length, mutationsAfterFirst, "no further mutation may be sent");
    assert.equal(api.forums.size, 1, "exactly one forum");

    const [forum] = [...api.forums.values()];
    assert.equal(forum?.topics.size, 1, "exactly one topic");
    assert.equal([...(forum?.topics.values() ?? [])][0]?.size, 1, "exactly one managed message");
  });

  it("records the mapping in the documented shape", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();

    await reconcile(api, store);
    const state = store.load();

    const forum = state.forums.tsc8042;
    assert.ok(forum, "the forum must be recorded under its key, not its title");
    assert.match(forum.id, /^\d+$/);
    const topic = forum.topics.test;
    assert.ok(topic);
    assert.equal(typeof topic.topicId, "number");
    assert.equal(typeof topic.messages.intro, "number");
  });

  it("keys the mapping by logical key, so a retitle is not a new resource", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);

    const renamed: DesiredState = {
      forums: [
        {
          key: "tsc8042",
          title: "TSC 8042 Test (renamed)",
          topics: [
            {
              key: "test",
              title: "🧪 Тест (renamed)",
              messages: [{ key: "intro", text: "Тест автоматизації Telegram API" }],
            },
          ],
        },
      ],
    };

    const plan = await buildPlan(renamed, store.load(), api);

    // Renaming is an UPDATE, which this iteration does not plan yet — but it
    // must never look like a second resource that needs creating.
    assert.equal(countByType(plan).CREATE, 0, "a retitle must not plan a duplicate");
  });
});

describe("the state file is not the source of truth", () => {
  it("detects a stale topic mapping and plans recreation", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);

    const before = store.load();
    const channelId = before.forums.tsc8042?.id as string;
    const topicId = before.forums.tsc8042?.topics.test?.topicId as number;
    api.deleteTopic(channelId, topicId);

    const plan = await buildPlan(DESIRED_STATE, before, api);

    assert.deepEqual(planShape(plan), [
      "NOOP forum tsc8042",
      "CREATE topic tsc8042/test",
      "CREATE message tsc8042/test/intro",
    ]);
    assert.match(plan.actions[1]?.reason ?? "", /no longer exists in Telegram/);
  });

  it("re-records the new topic id after applying, and converges again", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);

    const before = store.load();
    const oldTopicId = before.forums.tsc8042?.topics.test?.topicId as number;
    api.deleteTopic(before.forums.tsc8042?.id as string, oldTopicId);

    await reconcile(api, store);

    const after = store.load();
    assert.notEqual(after.forums.tsc8042?.topics.test?.topicId, oldTopicId);
    assert.equal(hasMutations(await buildPlan(DESIRED_STATE, after, api)), false);
  });

  it("detects a stale message mapping and plans only the message", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);

    const before = store.load();
    api.deleteMessage(
      before.forums.tsc8042?.id as string,
      before.forums.tsc8042?.topics.test?.topicId as number,
      before.forums.tsc8042?.topics.test?.messages.intro as number,
    );

    const plan = await buildPlan(DESIRED_STATE, before, api);

    assert.deepEqual(planShape(plan), [
      "NOOP forum tsc8042",
      "NOOP topic tsc8042/test",
      "CREATE message tsc8042/test/intro",
    ]);
    assert.match(plan.actions[2]?.reason ?? "", /no longer exists in Telegram/);
  });

  it("detects a forum that is gone and plans the whole tree again", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);

    const before = store.load();
    api.deleteForum(before.forums.tsc8042?.id as string);

    const plan = await buildPlan(DESIRED_STATE, before, api);

    assert.deepEqual(planShape(plan), FIRST_RUN);
    assert.match(plan.actions[0]?.reason ?? "", /no longer exists in Telegram/);
  });

  it("drops the dead ids rather than keeping them alongside the new ones", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);

    const before = store.load();
    const deadChannelId = before.forums.tsc8042?.id as string;
    api.deleteForum(deadChannelId);
    await reconcile(api, store);

    const after = store.load();
    assert.notEqual(after.forums.tsc8042?.id, deadChannelId);
    assert.equal(Object.keys(after.forums).length, 1, "one entry per key, never two");
  });
});

describe("unmanaged entities are left alone", () => {
  it("ignores chats that are not in the state, however they are titled", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    // A forum with exactly the configured title, created by someone else.
    // Identity is the recorded id, not the title, so this must not be adopted.
    api.forums.set("999000111", { title: "TSC 8042 Test", topics: new Map([[5, new Set([6])]]) });

    const plan = await buildPlan(DESIRED_STATE, emptyState(), api);

    assert.deepEqual(planShape(plan), FIRST_RUN);
    assert.ok(
      !plan.actions.some((action) => action.reason.includes("999000111")),
      "an unmanaged chat must not appear in the plan",
    );
  });

  it("does not touch the unmanaged chat when the plan is applied", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const unmanaged = { title: "TSC 8042 Test", topics: new Map([[5, new Set([6])]]) };
    api.forums.set("999000111", unmanaged);

    await reconcile(api, store);

    assert.deepEqual([...unmanaged.topics.keys()], [5], "its topics are untouched");
    assert.deepEqual([...(unmanaged.topics.get(5) ?? [])], [6], "its messages are untouched");
    assert.ok(
      !api.calls.some((call) => call.includes("999000111")),
      "no call may even mention an unmanaged chat",
    );
  });

  it("plans no delete for a managed topic that the config no longer lists", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);

    // Removing it from the desired state does not yet mean deleting it: this
    // iteration creates only, and destructive rebuild comes later.
    const plan = await buildPlan({ forums: [] }, store.load(), api);

    assert.deepEqual(plan.actions, []);
    assert.equal(hasMutations(plan), false);
  });
});

describe("planning performs zero mutations", () => {
  it("sends no creating call, on a first run or a converged one", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();

    await buildPlan(DESIRED_STATE, emptyState(), api);
    assert.deepEqual(api.mutations, []);

    await reconcile(api, store);
    const afterApply = api.mutations.length;

    await buildPlan(DESIRED_STATE, store.load(), api);
    assert.equal(api.mutations.length, afterApply, "planning alone must mutate nothing");
  });

  it("does not write the state file while planning", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);
    const recorded = JSON.stringify(store.load());

    await buildPlan(DESIRED_STATE, store.load(), api);

    assert.equal(JSON.stringify(store.load()), recorded);
  });
});

describe("a failed mutation does not claim later resources exist", () => {
  it("records the forum but not the topic when topic creation fails", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const plan = await buildPlan(DESIRED_STATE, emptyState(), api);
    api.failAt = {
      call: "createForumTopic(2000000001, 🧪 Тест)",
      error: new Error("TOPIC_TITLE_INVALID"),
    };

    await assert.rejects(() => applyPlan(plan, api, store), /TOPIC_TITLE_INVALID/);

    const state = store.load();
    assert.equal(state.forums.tsc8042?.id, "2000000001", "the forum really was created");
    assert.deepEqual(state.forums.tsc8042?.topics, {}, "the topic was not, so it is not recorded");
    assert.ok(!api.mutations.some((call) => call.startsWith("sendMessageToTopic")));
  });

  it("records the topic but not the message when sending fails", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const plan = await buildPlan(DESIRED_STATE, emptyState(), api);
    api.failAt = {
      call: "sendMessageToTopic(2000000001, 100, Тест автоматизації Telegram API)",
      error: new Error("SLOWMODE_WAIT_10"),
    };

    await assert.rejects(() => applyPlan(plan, api, store), /SLOWMODE_WAIT_10/);

    const state = store.load();
    assert.equal(state.forums.tsc8042?.topics.test?.topicId, 100);
    assert.deepEqual(state.forums.tsc8042?.topics.test?.messages, {}, "nothing was sent");
  });

  it("resumes from where it stopped, without a duplicate forum", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const plan = await buildPlan(DESIRED_STATE, emptyState(), api);
    api.failAt = {
      call: "createForumTopic(2000000001, 🧪 Тест)",
      error: new Error("boom"),
    };
    await assert.rejects(() => applyPlan(plan, api, store), /boom/);

    api.failAt = undefined;
    const retry = await buildPlan(DESIRED_STATE, store.load(), api);

    assert.deepEqual(planShape(retry), [
      "NOOP forum tsc8042",
      "CREATE topic tsc8042/test",
      "CREATE message tsc8042/test/intro",
    ]);

    await applyPlan(retry, api, store);
    assert.equal(api.forums.size, 1, "the retry must not create a second forum");
    assert.equal(hasMutations(await buildPlan(DESIRED_STATE, store.load(), api)), false);
  });

  it("never retries a failed creation by itself", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const plan = await buildPlan(DESIRED_STATE, emptyState(), api);
    api.failAt = {
      call: "createForumSupergroup(TSC 8042 Test)",
      error: new Error("FLOOD_WAIT_30"),
    };

    await assert.rejects(() => applyPlan(plan, api, store), /FLOOD_WAIT_30/);

    assert.equal(api.mutations.length, 1, "exactly one attempt");
    assert.deepEqual(store.load(), emptyState(), "nothing may be recorded");
  });
});

describe("UPDATE and DELETE are declared but not implemented", () => {
  it("refuses to execute one rather than guessing", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const plan: Plan = {
      actions: [
        { type: "DELETE", resource: "topic", path: "tsc8042/test", reason: "handwritten" },
      ],
      resolvedForums: new Map(),
    };

    await assert.rejects(() => applyPlan(plan, api, store), /DELETE is not implemented yet/);
    assert.deepEqual(api.mutations, []);
  });
});

describe("the plan and apply commands", () => {
  function harness(api: FakeTelegram, store: MemoryManagedStateStore) {
    const lines: string[] = [];
    let closes = 0;
    const session: ForumSession = {
      api,
      close: async () => {
        closes += 1;
      },
    };
    return {
      lines,
      closes: () => closes,
      session,
      run: (mode: "plan" | "apply", argv: readonly string[], confirmWith?: boolean) =>
        runReconcileCommand(argv, {
          mode,
          connect: async () => session,
          confirm: async () => {
            if (confirmWith === undefined) assert.fail("must not ask for confirmation here");
            return confirmWith;
          },
          log: (message) => lines.push(message),
          stateStore: store,
        }),
    };
  }

  it("telegram:plan performs zero mutations and changes no state", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const h = harness(api, store);

    await h.run("plan", []);

    assert.deepEqual(api.mutations, [], "plan must not mutate Telegram");
    assert.deepEqual(store.load(), emptyState(), "plan must not write state");
    assert.match(h.lines.join("\n"), /Read-only run\. Nothing was changed\./);
  });

  it("telegram:plan prints the exact plan", async () => {
    const api = new FakeTelegram();
    const h = harness(api, new MemoryManagedStateStore());

    await h.run("plan", []);
    const output = h.lines.join("\n");

    assert.match(output, /CREATE\s+forum\s+tsc8042/);
    assert.match(output, /CREATE\s+topic\s+tsc8042\/test/);
    assert.match(output, /CREATE\s+message\s+tsc8042\/test\/intro/);
    assert.match(output, /3 to create, 0 to update, 0 to delete, 0 unchanged/);
  });

  it("telegram:plan rejects --yes, which would mean nothing there", async () => {
    const h = harness(new FakeTelegram(), new MemoryManagedStateStore());

    await assert.rejects(() => h.run("plan", ["--yes"]), /Unknown flag: --yes/);
  });

  it("telegram:apply performs zero mutations when the confirmation is refused", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const h = harness(api, store);

    await h.run("apply", [], false);

    assert.deepEqual(api.mutations, []);
    assert.deepEqual(store.load(), emptyState());
    assert.match(h.lines.join("\n"), /Cancelled\. Nothing was changed\./);
  });

  it("telegram:apply proceeds when the confirmation is accepted", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const h = harness(api, store);

    await h.run("apply", [], true);

    assert.equal(api.mutations.length, 3);
  });

  it("telegram:apply -- --yes converges on the second run without prompting", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();

    // confirmWith is left undefined: the harness fails if a prompt appears,
    // so the second run proving it never prompts is part of the assertion.
    await harness(api, store).run("apply", ["--yes"]);
    const second = harness(api, store);
    await second.run("apply", []);

    assert.equal(api.mutations.length, 3, "the second run must send no mutation");
    assert.match(second.lines.join("\n"), /Already up to date\. Nothing to do\./);
  });

  it("closes the session in every mode, including on failure", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();

    const planRun = harness(api, store);
    await planRun.run("plan", []);
    assert.equal(planRun.closes(), 1);

    api.failAt = {
      call: "createForumSupergroup(TSC 8042 Test)",
      error: new Error("nope"),
    };
    const applyRun = harness(api, store);
    await assert.rejects(() => applyRun.run("apply", ["--yes"]), /nope/);
    assert.equal(applyRun.closes(), 1);
  });

  it("prints no access hash, session or api hash", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const h = harness(api, store);

    await h.run("apply", ["--yes"]);
    const output = h.lines.join("\n").toLowerCase();

    for (const secret of ["accesshash", "access_hash", "authkey", "apihash", "session"]) {
      assert.ok(!output.includes(secret), `output must not contain ${secret}`);
    }
  });
});

describe("the recorded state survives a round trip", () => {
  it("reloads to the same mapping", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);

    const written: ManagedState = store.load();
    const reloaded = new MemoryManagedStateStore(written).load();

    assert.deepEqual(reloaded, written);
  });
});
