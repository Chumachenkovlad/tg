import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runReconcileCommand, type ForumSession } from "../src/cli/reconcile-command.js";
import { DESIRED_STATE, type DesiredState } from "../src/telegram/desired-state.js";
import {
  ForumRef,
  GENERAL_TOPIC_ID,
  type CreatedForum,
  type CreatedTopic,
  type DialogSummary,
  type ExistingMessage,
  type ExistingTopic,
  type ForumApi,
  type GeneralTopicState,
  type PostedMessage,
  type ResolvedForum,
} from "../src/telegram/forum-types.js";
import {
  ManagedStateError,
  MemoryManagedStateStore,
  emptyState,
  recordForum,
  type ManagedState,
  type ManagedStateStore,
} from "../src/telegram/managed-state.js";
import { MutationLockedError } from "../src/telegram/mutation-lock.js";
import {
  buildPlan,
  countByType,
  hasMutations,
  type Plan,
  type PlannedAction,
} from "../src/telegram/planner.js";
import { applyPlan } from "../src/telegram/reconcile.js";

/**
 * The configuration these tests reconcile.
 *
 * Deliberately **not** the real one from `desired-state.ts`: this file is
 * about the engine — CREATE, UPDATE, NOOP, convergence, failure handling —
 * and rewording a paragraph of Ukrainian community copy must not break a
 * test about action ordering. The real configuration is covered separately in
 * `desired-state.test.ts`, and one test at the end of this file reconciles it
 * end to end.
 */
const FIXTURE: DesiredState = {
  forums: [
    {
      key: "fixture",
      title: "Fixture forum",
      description: "fixture description",
      hideBuiltInGeneralTopic: false,
      topics: [
        {
          key: "alpha",
          title: "Alpha",
          messages: [{ key: "intro", text: "first intro" }],
        },
      ],
    },
  ],
};

/**
 * A fake Telegram that behaves like the real one for reconciliation purposes:
 * it holds forums, topics and messages, hands out fresh ids, and answers the
 * existence queries honestly. Every call is recorded, so a test can assert
 * that a run made no mutating call at all.
 *
 * Nothing here touches the network.
 */
interface FakeTopic {
  title: string;
  /** message id → its current text. */
  messages: Map<number, string>;
}

interface FakeForum {
  title: string;
  description: string;
  /**
   * Telegram's built-in General topic, which every forum has and none can
   * delete. It is not in `topics`: the fake models it the way Telegram does,
   * as a flag on the forum, so a test cannot accidentally create, recreate or
   * delete it through the topic paths.
   */
  generalHidden: boolean;
  topics: Map<number, FakeTopic>;
}

class FakeTelegram implements ForumApi {
  readonly calls: string[] = [];
  /** channel id → what Telegram currently holds for it. */
  readonly forums = new Map<string, FakeForum>();
  /** Chats this account is in but does not manage. */
  unmanagedDialogs: DialogSummary[] = [];
  failAt: { call: string; error: Error } | undefined;
  /** Makes Telegram not report the General topic, which should not happen. */
  generalTopicMissing = false;

  private nextChannelId = 2000000001;
  private nextMessageId = 100;

  /** Mutating calls only — what the invariant is actually about. */
  get mutations(): string[] {
    return this.calls.filter(
      (call) => call.startsWith("create") || call.startsWith("send") || call.startsWith("set"),
    );
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
    this.forums.get(channelId)?.topics.get(topicId)?.messages.delete(messageId);
  }

  /** Removes the whole group, as leaving or deleting it would. */
  deleteForum(channelId: string): void {
    this.forums.delete(channelId);
  }

  /** Unhides General behind the reconciler's back, as a person would. */
  setGeneralHiddenByHand(channelId: string, hidden: boolean): void {
    this.forum(channelId).generalHidden = hidden;
  }

  private forum(id: string): FakeForum {
    const entry = this.forums.get(id);
    if (!entry) throw new Error(`fake: no such forum ${id}`);
    return entry;
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

  async findForumById(id: string): Promise<ResolvedForum | undefined> {
    this.record(`findForumById(${id})`);
    const entry = this.forums.get(id);
    return entry
      ? {
          ref: new ForumRef(id, { channelId: id }),
          title: entry.title,
          description: entry.description,
        }
      : undefined;
  }

  async readGeneralTopic(forum: ForumRef): Promise<GeneralTopicState | undefined> {
    this.record(`readGeneralTopic(${forum.id})`);
    if (this.generalTopicMissing) return undefined;
    return { hidden: this.forum(forum.id).generalHidden };
  }

  async listExistingTopics(
    forum: ForumRef,
    topicIds: readonly number[],
  ): Promise<ExistingTopic[]> {
    this.record(`listExistingTopics(${forum.id}, [${topicIds.join(",")}])`);
    const topics = this.forums.get(forum.id)?.topics;
    return topicIds.flatMap((id) => {
      const topic = topics?.get(id);
      return topic ? [{ id, title: topic.title }] : [];
    });
  }

  async listExistingMessages(
    forum: ForumRef,
    messageIds: readonly number[],
  ): Promise<ExistingMessage[]> {
    this.record(`listExistingMessages(${forum.id}, [${messageIds.join(",")}])`);
    const all = new Map(
      [...(this.forums.get(forum.id)?.topics.values() ?? [])].flatMap((topic) => [
        ...topic.messages,
      ]),
    );
    return messageIds.flatMap((id) => {
      const text = all.get(id);
      return text === undefined ? [] : [{ id, text }];
    });
  }

  async createForumSupergroup(title: string, description: string): Promise<CreatedForum> {
    this.record(`createForumSupergroup(${title})`);
    const id = String(this.nextChannelId++);
    // Telegram shows General in a brand-new forum.
    this.forums.set(id, { title, description, generalHidden: false, topics: new Map() });
    return { ref: new ForumRef(id, { channelId: id }), id, title };
  }

  async createForumTopic(forum: ForumRef, title: string): Promise<CreatedTopic> {
    this.record(`createForumTopic(${forum.id}, ${title})`);
    const id = this.nextMessageId++;
    this.forum(forum.id).topics.set(id, { title, messages: new Map() });
    return { id, title };
  }

  async sendMessageToTopic(
    forum: ForumRef,
    topicId: number,
    text: string,
  ): Promise<PostedMessage> {
    this.record(`sendMessageToTopic(${forum.id}, ${topicId}, ${text})`);
    const topic = this.forum(forum.id).topics.get(topicId);
    if (!topic) throw new Error(`fake: no such topic ${topicId}`);
    const id = this.nextMessageId++;
    topic.messages.set(id, text);
    return { id, topicId };
  }

  async setForumTitle(forum: ForumRef, title: string): Promise<void> {
    this.record(`setForumTitle(${forum.id}, ${title})`);
    this.forum(forum.id).title = title;
  }

  async setForumDescription(forum: ForumRef, description: string): Promise<void> {
    this.record(`setForumDescription(${forum.id}, ${description})`);
    this.forum(forum.id).description = description;
  }

  async setTopicTitle(forum: ForumRef, topicId: number, title: string): Promise<void> {
    this.record(`setTopicTitle(${forum.id}, ${topicId}, ${title})`);
    if (topicId === GENERAL_TOPIC_ID) {
      throw new Error("fake: the built-in General topic must never be renamed by this project");
    }
    const topic = this.forum(forum.id).topics.get(topicId);
    if (!topic) throw new Error(`fake: no such topic ${topicId}`);
    topic.title = title;
  }

  async setGeneralTopicHidden(forum: ForumRef, hidden: boolean): Promise<void> {
    this.record(`setGeneralTopicHidden(${forum.id}, ${hidden})`);
    this.forum(forum.id).generalHidden = hidden;
  }

  async setMessageText(forum: ForumRef, messageId: number, text: string): Promise<void> {
    this.record(`setMessageText(${forum.id}, ${messageId}, ${text})`);
    for (const topic of this.forum(forum.id).topics.values()) {
      if (topic.messages.has(messageId)) {
        topic.messages.set(messageId, text);
        return;
      }
    }
    throw new Error(`fake: no such message ${messageId}`);
  }
}

/** Plans and applies once, the way `telegram:apply -- --yes` would. */
async function reconcile(
  api: FakeTelegram,
  store: MemoryManagedStateStore,
  desired: DesiredState = FIXTURE,
): Promise<Plan> {
  const plan = await buildPlan(desired, store.load(), api);
  await applyPlan(plan, api, store);
  return plan;
}

function planShape(plan: Plan): string[] {
  return plan.actions.map((action) => `${action.type} ${action.resource} ${action.path}`);
}

const FIRST_RUN = [
  "CREATE forum fixture",
  "CREATE topic fixture/alpha",
  "CREATE message fixture/alpha/intro",
];

const CONVERGED = [
  "NOOP forum fixture",
  "NOOP general-topic fixture/(general)",
  "NOOP topic fixture/alpha",
  "NOOP message fixture/alpha/intro",
];

describe("planner: first run", () => {
  it("plans a create for the forum, the topic and the message", async () => {
    const plan = await buildPlan(FIXTURE, emptyState(), new FakeTelegram());

    assert.deepEqual(planShape(plan), FIRST_RUN);
    assert.equal(countByType(plan).CREATE, 3);
  });

  it("explains why, without inventing ids", async () => {
    const plan = await buildPlan(FIXTURE, emptyState(), new FakeTelegram());

    assert.match(plan.actions[0]?.reason ?? "", /not created yet/);
  });

  it("plans without calling Telegram at all when nothing is recorded", async () => {
    const api = new FakeTelegram();

    await buildPlan(FIXTURE, emptyState(), api);

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

    const second = await buildPlan(FIXTURE, store.load(), api);
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
    assert.equal(
      [...(forum?.topics.values() ?? [])][0]?.messages.size,
      1,
      "exactly one managed message",
    );
  });

  it("records the mapping in the documented shape", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();

    await reconcile(api, store);
    const state = store.load();

    const forum = state.forums.fixture;
    assert.ok(forum, "the forum must be recorded under its key, not its title");
    assert.match(forum.id, /^\d+$/);
    const topic = forum.topics.alpha;
    assert.ok(topic);
    assert.equal(typeof topic.topicId, "number");
    assert.equal(typeof topic.messages.intro, "number");
  });

  it("keys the mapping by logical key, so a retitle is not a new resource", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);

    const plan = await buildPlan(edited({ forumTitle: "Fixture forum (renamed)" }), store.load(), api);

    assert.equal(countByType(plan).CREATE, 0, "a retitle must not plan a duplicate");
  });
});

/** The fixture with one or more values changed. Keys stay the same. */
function edited(changes: {
  forumTitle?: string;
  forumDescription?: string;
  hideGeneral?: boolean;
  topicTitle?: string;
  messageText?: string;
}): DesiredState {
  return {
    forums: [
      {
        key: "fixture",
        title: changes.forumTitle ?? "Fixture forum",
        description: changes.forumDescription ?? "fixture description",
        hideBuiltInGeneralTopic: changes.hideGeneral ?? false,
        topics: [
          {
            key: "alpha",
            title: changes.topicTitle ?? "Alpha",
            messages: [
              {
                key: "intro",
                text: changes.messageText ?? "first intro",
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("UPDATE reconciliation", () => {
  /** Applies the default config, then returns the ids it produced. */
  async function established(): Promise<{
    api: FakeTelegram;
    store: MemoryManagedStateStore;
    forumId: string;
    topicId: number;
    messageId: number;
  }> {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);
    const state = store.load();
    return {
      api,
      store,
      forumId: state.forums.fixture?.id as string,
      topicId: state.forums.fixture?.topics.alpha?.topicId as number,
      messageId: state.forums.fixture?.topics.alpha?.messages.intro as number,
    };
  }

  it("plans exactly one UPDATE and zero CREATE when the message text changes", async () => {
    const { api, store } = await established();

    const plan = await buildPlan(edited({ messageText: "v2" }), store.load(), api);

    assert.deepEqual(planShape(plan), [
      "NOOP forum fixture",
      "NOOP general-topic fixture/(general)",
      "NOOP topic fixture/alpha",
      "UPDATE message fixture/alpha/intro",
    ]);
    assert.deepEqual(countByType(plan), { NOOP: 3, CREATE: 0, UPDATE: 1, DELETE: 0 });
  });

  it("plans an UPDATE and zero CREATE when the topic title changes", async () => {
    const { api, store } = await established();

    const plan = await buildPlan(edited({ topicTitle: "Alpha renamed" }), store.load(), api);

    assert.deepEqual(planShape(plan), [
      "NOOP forum fixture",
      "NOOP general-topic fixture/(general)",
      "UPDATE topic fixture/alpha",
      "NOOP message fixture/alpha/intro",
    ]);
    assert.equal(countByType(plan).CREATE, 0);
  });

  it("plans an UPDATE and zero CREATE when the forum title changes", async () => {
    const { api, store } = await established();

    const plan = await buildPlan(edited({ forumTitle: "Fixture forum v2" }), store.load(), api);

    assert.deepEqual(planShape(plan), [
      "UPDATE forum fixture",
      "NOOP general-topic fixture/(general)",
      "NOOP topic fixture/alpha",
      "NOOP message fixture/alpha/intro",
    ]);
    assert.equal(countByType(plan).CREATE, 0);
  });

  it("says what the current value is and what it should become", async () => {
    const { api, store } = await established();

    const plan = await buildPlan(edited({ messageText: "v2" }), store.load(), api);

    assert.match(plan.actions[3]?.reason ?? "", /text is "first intro"/);
    assert.match(plan.actions[3]?.reason ?? "", /should be "v2"/);
  });

  it("edits the existing message id rather than sending a new message", async () => {
    const { api, store, messageId } = await established();
    const before = api.mutations.length;

    await reconcile(api, store, edited({ messageText: "v2" }));

    const performed = api.mutations.slice(before);
    assert.deepEqual(performed, [
      `setMessageText(${api.forums.keys().next().value as string}, ${messageId}, v2)`,
    ]);
    assert.ok(
      !performed.some((call) => call.startsWith("sendMessageToTopic")),
      "an edit must not send a second message",
    );
  });

  it("keeps every id unchanged across all three updates", async () => {
    const context = await established();
    const { api, store, forumId, topicId, messageId } = context;

    await reconcile(
      api,
      store,
      edited({
        forumTitle: "Fixture forum v2",
        topicTitle: "Alpha renamed",
        messageText: "v2",
      }),
    );

    const after = store.load();
    assert.equal(after.forums.fixture?.id, forumId, "the channel id must not change");
    assert.equal(after.forums.fixture?.topics.alpha?.topicId, topicId, "the topic id must not change");
    assert.equal(
      after.forums.fixture?.topics.alpha?.messages.intro,
      messageId,
      "the message id must not change",
    );
  });

  it("converges: the plan right after applying the edit is all NOOP", async () => {
    const { api, store } = await established();
    const desired = edited({
      forumTitle: "Fixture forum v2",
      topicTitle: "Alpha renamed",
      messageText: "v2",
    });

    await reconcile(api, store, desired);
    const plan = await buildPlan(desired, store.load(), api);

    assert.deepEqual(planShape(plan), CONVERGED);
    assert.equal(hasMutations(plan), false);
  });

  it("actually changes the values in Telegram", async () => {
    const { api, store, forumId, topicId, messageId } = await established();

    await reconcile(
      api,
      store,
      edited({ forumTitle: "Fixture forum v2", topicTitle: "Alpha renamed", messageText: "v2" }),
    );

    const forum = api.forums.get(forumId);
    assert.equal(forum?.title, "Fixture forum v2");
    assert.equal(forum?.topics.get(topicId)?.title, "Alpha renamed");
    assert.equal(forum?.topics.get(topicId)?.messages.get(messageId), "v2");
  });

  it("creates nothing new in Telegram while updating", async () => {
    const { api, store, forumId, topicId } = await established();

    await reconcile(api, store, edited({ messageText: "v2" }));

    assert.equal(api.forums.size, 1);
    assert.equal(api.forums.get(forumId)?.topics.size, 1);
    assert.equal(api.forums.get(forumId)?.topics.get(topicId)?.messages.size, 1);
  });

  it("recreates rather than updates when the resource is actually gone", async () => {
    const { api, store, forumId, topicId, messageId } = await established();
    // Deleted and edited at once: gone beats changed, there is nothing to edit.
    api.deleteMessage(forumId, topicId, messageId);

    const plan = await buildPlan(edited({ messageText: "v2" }), store.load(), api);

    assert.deepEqual(planShape(plan), [
      "NOOP forum fixture",
      "NOOP general-topic fixture/(general)",
      "NOOP topic fixture/alpha",
      "CREATE message fixture/alpha/intro",
    ]);
  });

  it("writes no state for an update, since no id changed", async () => {
    const { api, store } = await established();
    const before = JSON.stringify(store.load());
    let writes = 0;
    const counting: ManagedStateStore = {
      load: () => store.load(),
      ensureWritable: () => store.ensureWritable(),
      save: (state) => {
        writes += 1;
        store.save(state);
      },
      describe: () => store.describe(),
    };

    const plan = await buildPlan(edited({ messageText: "v2" }), store.load(), api);
    await applyPlan(plan, api, counting);

    assert.equal(writes, 0, "an in-place edit changes no mapping");
    assert.equal(JSON.stringify(store.load()), before);
  });
});

describe("the state file is not the source of truth", () => {
  it("detects a stale topic mapping and plans recreation", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);

    const before = store.load();
    const channelId = before.forums.fixture?.id as string;
    const topicId = before.forums.fixture?.topics.alpha?.topicId as number;
    api.deleteTopic(channelId, topicId);

    const plan = await buildPlan(FIXTURE, before, api);

    assert.deepEqual(planShape(plan), [
      "NOOP forum fixture",
      "NOOP general-topic fixture/(general)",
      "CREATE topic fixture/alpha",
      "CREATE message fixture/alpha/intro",
    ]);
    assert.match(plan.actions[2]?.reason ?? "", /no longer exists in Telegram/);
  });

  it("re-records the new topic id after applying, and converges again", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);

    const before = store.load();
    const oldTopicId = before.forums.fixture?.topics.alpha?.topicId as number;
    api.deleteTopic(before.forums.fixture?.id as string, oldTopicId);

    await reconcile(api, store);

    const after = store.load();
    assert.notEqual(after.forums.fixture?.topics.alpha?.topicId, oldTopicId);
    assert.equal(hasMutations(await buildPlan(FIXTURE, after, api)), false);
  });

  it("detects a stale message mapping and plans only the message", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);

    const before = store.load();
    api.deleteMessage(
      before.forums.fixture?.id as string,
      before.forums.fixture?.topics.alpha?.topicId as number,
      before.forums.fixture?.topics.alpha?.messages.intro as number,
    );

    const plan = await buildPlan(FIXTURE, before, api);

    assert.deepEqual(planShape(plan), [
      "NOOP forum fixture",
      "NOOP general-topic fixture/(general)",
      "NOOP topic fixture/alpha",
      "CREATE message fixture/alpha/intro",
    ]);
    assert.match(plan.actions[3]?.reason ?? "", /no longer exists in Telegram/);
  });

  it("detects a forum that is gone and plans the whole tree again", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);

    const before = store.load();
    api.deleteForum(before.forums.fixture?.id as string);

    const plan = await buildPlan(FIXTURE, before, api);

    assert.deepEqual(planShape(plan), FIRST_RUN);
    assert.match(plan.actions[0]?.reason ?? "", /no longer exists in Telegram/);
  });

  it("drops the dead ids rather than keeping them alongside the new ones", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);

    const before = store.load();
    const deadChannelId = before.forums.fixture?.id as string;
    api.deleteForum(deadChannelId);
    await reconcile(api, store);

    const after = store.load();
    assert.notEqual(after.forums.fixture?.id, deadChannelId);
    assert.equal(Object.keys(after.forums).length, 1, "one entry per key, never two");
  });
});

describe("unmanaged entities are left alone", () => {
  it("ignores chats that are not in the state, however they are titled", async () => {
    const api = new FakeTelegram();
    // A forum with exactly the configured title, created by someone else.
    // Identity is the recorded id, not the title, so this must not be adopted.
    api.forums.set("999000111", {
      title: "Fixture forum",
      description: "fixture description",
      generalHidden: false,
      topics: new Map([[5, { title: "Alpha", messages: new Map([[6, "someone else's"]]) }]]),
    });

    const plan = await buildPlan(FIXTURE, emptyState(), api);

    assert.deepEqual(planShape(plan), FIRST_RUN);
    assert.ok(
      !plan.actions.some((action) => action.reason.includes("999000111")),
      "an unmanaged chat must not appear in the plan",
    );
  });

  it("does not touch the unmanaged chat when the plan is applied", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const unmanaged: FakeForum = {
      title: "Fixture forum",
      description: "fixture description",
      generalHidden: false,
      topics: new Map([[5, { title: "Alpha", messages: new Map([[6, "someone else's"]]) }]]),
    };
    api.forums.set("999000111", unmanaged);

    await reconcile(api, store);

    assert.equal(unmanaged.title, "Fixture forum", "its title is untouched");
    assert.deepEqual([...unmanaged.topics.keys()], [5], "its topics are untouched");
    assert.equal(unmanaged.topics.get(5)?.title, "Alpha", "its topic title is untouched");
    assert.equal(unmanaged.topics.get(5)?.messages.get(6), "someone else's", "its text is untouched");
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

    await buildPlan(FIXTURE, emptyState(), api);
    assert.deepEqual(api.mutations, []);

    await reconcile(api, store);
    const afterApply = api.mutations.length;

    await buildPlan(FIXTURE, store.load(), api);
    assert.equal(api.mutations.length, afterApply, "planning alone must mutate nothing");
  });

  it("does not write the state file while planning", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);
    const recorded = JSON.stringify(store.load());

    await buildPlan(FIXTURE, store.load(), api);

    assert.equal(JSON.stringify(store.load()), recorded);
  });
});

describe("a failed mutation does not claim later resources exist", () => {
  it("records the forum but not the topic when topic creation fails", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const plan = await buildPlan(FIXTURE, emptyState(), api);
    api.failAt = {
      call: "createForumTopic(2000000001, Alpha)",
      error: new Error("TOPIC_TITLE_INVALID"),
    };

    await assert.rejects(() => applyPlan(plan, api, store), /TOPIC_TITLE_INVALID/);

    const state = store.load();
    assert.equal(state.forums.fixture?.id, "2000000001", "the forum really was created");
    assert.deepEqual(state.forums.fixture?.topics, {}, "the topic was not, so it is not recorded");
    assert.ok(!api.mutations.some((call) => call.startsWith("sendMessageToTopic")));
  });

  it("records the topic but not the message when sending fails", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const plan = await buildPlan(FIXTURE, emptyState(), api);
    api.failAt = {
      call: "sendMessageToTopic(2000000001, 100, first intro)",
      error: new Error("SLOWMODE_WAIT_10"),
    };

    await assert.rejects(() => applyPlan(plan, api, store), /SLOWMODE_WAIT_10/);

    const state = store.load();
    assert.equal(state.forums.fixture?.topics.alpha?.topicId, 100);
    assert.deepEqual(state.forums.fixture?.topics.alpha?.messages, {}, "nothing was sent");
  });

  it("resumes from where it stopped, without a duplicate forum", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const plan = await buildPlan(FIXTURE, emptyState(), api);
    api.failAt = {
      call: "createForumTopic(2000000001, Alpha)",
      error: new Error("boom"),
    };
    await assert.rejects(() => applyPlan(plan, api, store), /boom/);

    api.failAt = undefined;
    const retry = await buildPlan(FIXTURE, store.load(), api);

    assert.deepEqual(planShape(retry), [
      "NOOP forum fixture",
      "NOOP general-topic fixture/(general)",
      "CREATE topic fixture/alpha",
      "CREATE message fixture/alpha/intro",
    ]);

    await applyPlan(retry, api, store);
    assert.equal(api.forums.size, 1, "the retry must not create a second forum");
    assert.equal(hasMutations(await buildPlan(FIXTURE, store.load(), api)), false);
  });

  it("never retries a failed creation by itself", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const plan = await buildPlan(FIXTURE, emptyState(), api);
    api.failAt = {
      call: "createForumSupergroup(Fixture forum)",
      error: new Error("FLOOD_WAIT_30"),
    };

    await assert.rejects(() => applyPlan(plan, api, store), /FLOOD_WAIT_30/);

    assert.equal(api.mutations.length, 1, "exactly one attempt");
    assert.deepEqual(store.load(), emptyState(), "nothing may be recorded");
  });
});

describe("the mapping must be persistable before anything is created", () => {
  it("performs zero Telegram mutations when the state cannot be written", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const plan = await buildPlan(FIXTURE, store.load(), api);
    store.writableError = new ManagedStateError("Cannot write the state file (EACCES).");

    await assert.rejects(() => applyPlan(plan, api, store), /Cannot write the state file/);

    assert.deepEqual(
      api.mutations,
      [],
      "no create, send or edit may go out when the id could not be recorded",
    );
  });

  it("checks before the first call, not after it", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const plan = await buildPlan(FIXTURE, store.load(), api);
    store.writableError = new ManagedStateError("nope");

    await assert.rejects(() => applyPlan(plan, api, store));

    assert.equal(store.writableChecked, true);
    assert.deepEqual(store.load(), emptyState(), "and nothing was recorded either");
  });

  it("checks for a plan that creates", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();

    await applyPlan(await buildPlan(FIXTURE, store.load(), api), api, store);

    assert.equal(store.writableChecked, true);
  });

  it("does not hold up an update-only plan, which records no new id", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);

    const plan = await buildPlan(edited({ messageText: "v2" }), store.load(), api);
    const fresh = new MemoryManagedStateStore(store.load());
    fresh.writableError = new ManagedStateError("read-only checkout");

    await assert.doesNotReject(() => applyPlan(plan, api, fresh));
    assert.equal(fresh.writableChecked, false);
  });

  it("leaves the recorded mapping untouched while checking", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);
    const before = JSON.stringify(store.load());

    store.ensureWritable();

    assert.equal(JSON.stringify(store.load()), before);
  });
});

describe("DELETE is declared but not implemented", () => {
  it("refuses to execute one rather than guessing", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const plan: Plan = {
      actions: [
        { type: "DELETE", resource: "topic", path: "fixture/alpha", reason: "handwritten" },
      ],
      resolvedForums: new Map(),
      baseState: emptyState(),
    };

    await assert.rejects(() => applyPlan(plan, api, store), /DELETE is not implemented yet/);
    assert.deepEqual(api.mutations, []);
  });

  it("is never planned for a resource dropped from the desired state", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);

    const plan = await buildPlan({ forums: [] }, store.load(), api);

    assert.equal(countByType(plan).DELETE, 0);
  });
});

describe("the plan is executed against the mapping it was built from", () => {
  it("refuses a plan whose state changed underneath it", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    // Built from an empty mapping: it says CREATE forum.
    const plan = await buildPlan(FIXTURE, store.load(), api);

    // Something else finished a run in the meantime.
    store.save(recordForum(emptyState(), "fixture", "2000000999"));

    await assert.rejects(
      () => applyPlan(plan, api, store),
      (error: unknown) => {
        assert.ok(error instanceof ManagedStateError);
        assert.match(error.message, /changed after this plan was built/);
        return true;
      },
    );
    assert.deepEqual(api.mutations, [], "not one call may go out against stale state");
  });

  it("accepts a mapping that is equal but differently ordered", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store);

    const plan = await buildPlan(edited({ messageText: "v2" }), store.load(), api);
    // Same content, rebuilt: key order is not a change.
    store.save(JSON.parse(JSON.stringify(store.load())) as ManagedState);

    await assert.doesNotReject(() => applyPlan(plan, api, store));
  });
});

describe("the plan and apply commands", () => {
  function harness(api: FakeTelegram, store: MemoryManagedStateStore, lockState = { held: false }) {
    const lines: string[] = [];
    let closes = 0;
    const lockEvents: string[] = [];
    const session: ForumSession = {
      api,
      close: async () => {
        closes += 1;
      },
    };
    return {
      lines,
      lockEvents,
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
          acquireLock: () => {
            if (lockState.held) throw new MutationLockedError("Another apply is already running");
            lockState.held = true;
            lockEvents.push(`acquired:${api.mutations.length}`);
            return {
              release: () => {
                lockState.held = false;
                lockEvents.push("released");
              },
            };
          },
          log: (message) => lines.push(message),
          stateStore: store,
          // These tests are about the command's behaviour — locking, the
          // confirmation, the warnings — so they run against the fixture.
          // That the command defaults to the real configuration is asserted
          // once, separately, below.
          desired: FIXTURE,
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

    assert.match(output, /CREATE\s+forum\s+fixture/);
    assert.match(output, /CREATE\s+topic\s+fixture\/alpha/);
    assert.match(output, /CREATE\s+message\s+fixture\/alpha\/intro/);
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
      call: "createForumSupergroup(Fixture forum)",
      error: new Error("nope"),
    };
    const applyRun = harness(api, store);
    await assert.rejects(() => applyRun.run("apply", ["--yes"]), /nope/);
    assert.equal(applyRun.closes(), 1);
  });

  it("takes the mutation lock before reading state or planning", async () => {
    const api = new FakeTelegram();
    const h = harness(api, new MemoryManagedStateStore());

    await h.run("apply", ["--yes"]);

    // Acquired at zero mutations, i.e. before anything ran, and released.
    assert.deepEqual(h.lockEvents, ["acquired:0", "released"]);
  });

  it("refuses a second apply while the first holds the lock", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    const shared = { held: false };
    const first = harness(api, store, shared);
    const second = harness(api, store, shared);

    // Hold the lock by never letting the first run's confirmation settle.
    let releaseConfirm = (): void => {};
    const firstRun = runReconcileCommand([], {
      mode: "apply",
      connect: async () => first.session,
      confirm: () =>
        new Promise<boolean>((resolveConfirm) => {
          releaseConfirm = () => resolveConfirm(false);
        }),
      acquireLock: () => {
        if (shared.held) throw new MutationLockedError("Another apply is already running");
        shared.held = true;
        return {
          release: () => {
            shared.held = false;
          },
        };
      },
      log: () => {},
      stateStore: store,
    });

    await assert.rejects(() => second.run("apply", ["--yes"]), MutationLockedError);
    assert.deepEqual(api.mutations, [], "the second apply must not touch Telegram");

    releaseConfirm();
    await firstRun;
  });

  it("releases the lock even when the apply fails", async () => {
    const api = new FakeTelegram();
    const shared = { held: false };
    const h = harness(api, new MemoryManagedStateStore(), shared);
    api.failAt = {
      call: "createForumSupergroup(Fixture forum)",
      error: new Error("nope"),
    };

    await assert.rejects(() => h.run("apply", ["--yes"]), /nope/);

    assert.equal(shared.held, false, "a failed apply must not leave the lock held");
    assert.deepEqual(h.lockEvents, ["acquired:0", "released"]);
  });

  it("plan takes no lock, and runs while an apply holds one", async () => {
    const api = new FakeTelegram();
    const h = harness(api, new MemoryManagedStateStore(), { held: true });

    await h.run("plan", []);

    assert.deepEqual(h.lockEvents, [], "read-only work needs no lock");
  });

  it("warns that ownership depends on the committed state file", async () => {
    const h = harness(new FakeTelegram(), new MemoryManagedStateStore());

    await h.run("plan", []);
    const output = h.lines.join("\n");

    assert.match(output, /Ownership of these chats is recorded ONLY in/);
    assert.match(output, /tracked in git — commit and push it after every apply/);
    assert.match(output, /the next\s+apply creates duplicates/);
  });

  it("tells you to commit the state after a successful apply", async () => {
    const h = harness(new FakeTelegram(), new MemoryManagedStateStore());

    await h.run("apply", ["--yes"]);

    assert.match(h.lines.join("\n"), /Commit and push it now/);
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

/**
 * The real TSC 8042 configuration, driven through the same fake Telegram.
 *
 * Everything above runs on a one-topic fixture so that editing community copy
 * cannot break an engine test. This block is the opposite: it proves the
 * configuration this repository actually ships reconciles cleanly, converges,
 * and never touches the network while doing so.
 */
/**
 * Telegram's built-in General topic.
 *
 * It always exists, it cannot be deleted, and it is not ours. The point of
 * every test here is that reconciling it never turns into owning it: no
 * create, no recorded id, no rename, no delete.
 */
describe("the built-in General topic", () => {
  /** The fixture, with General reconciled to `hidden`. */
  const wanting = (hidden: boolean): DesiredState => edited({ hideGeneral: hidden });

  /** Applies `desired` from scratch and hands back what it produced. */
  async function applied(desired: DesiredState): Promise<{
    api: FakeTelegram;
    store: MemoryManagedStateStore;
    forumId: string;
  }> {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store, desired);
    return { api, store, forumId: store.load().forums.fixture?.id as string };
  }

  it("hides it on the first apply, alongside the managed topics", async () => {
    const { api, forumId } = await applied(wanting(true));

    assert.equal(api.forums.get(forumId)?.generalHidden, true);
    assert.ok(
      api.mutations.includes(`setGeneralTopicHidden(${forumId}, true)`),
      "the first apply must hide General",
    );
    assert.ok(
      api.mutations.includes("createForumTopic(2000000001, Alpha)"),
      "and must still create our own topics",
    );
  });

  it("plans it as an UPDATE, never a CREATE — Telegram already made it", async () => {
    const api = new FakeTelegram();

    const plan = await buildPlan(wanting(true), emptyState(), api);

    const general = plan.actions.filter((action) => action.resource === "general-topic");
    assert.equal(general.length, 1);
    assert.equal(general[0]?.type, "UPDATE");
  });

  it("cannot even be expressed as a CREATE action", () => {
    // A compile-time proof rather than a runtime check: `general-topic` is
    // not among the resources a CREATE action can carry, so no code path can
    // plan one. Give CREATE that resource and this stops compiling.
    type CreatableResource = Extract<PlannedAction, { type: "CREATE" }>["resource"];
    const notCreatable: Exclude<"general-topic", CreatableResource> = "general-topic";

    assert.equal(notCreatable, "general-topic");
  });

  it("is NOOP on an unchanged second plan", async () => {
    const { api, store } = await applied(wanting(true));

    const plan = await buildPlan(wanting(true), store.load(), api);

    assert.equal(hasMutations(plan), false);
    const general = plan.actions.find((action) => action.resource === "general-topic");
    assert.equal(general?.type, "NOOP");
    assert.match(general?.reason ?? "", /already hidden/);
  });

  it("hides it again when someone unhides it by hand", async () => {
    const { api, store, forumId } = await applied(wanting(true));
    api.setGeneralHiddenByHand(forumId, false);
    const before = api.mutations.length;

    const plan = await buildPlan(wanting(true), store.load(), api);
    assert.deepEqual(
      plan.actions.filter((action) => action.resource === "general-topic").map((a) => a.type),
      ["UPDATE"],
    );
    assert.match(
      plan.actions.find((action) => action.resource === "general-topic")?.reason ?? "",
      /is visible, should be hidden/,
    );

    await applyPlan(plan, api, store);

    assert.equal(api.forums.get(forumId)?.generalHidden, true, "it must be hidden again");
    assert.deepEqual(api.mutations.slice(before), [`setGeneralTopicHidden(${forumId}, true)`]);
  });

  it("shows it again when the configuration says it should be visible", async () => {
    const { api, store, forumId } = await applied(wanting(true));

    await reconcile(api, store, wanting(false));

    assert.equal(api.forums.get(forumId)?.generalHidden, false);
  });

  it("does nothing at all when a new forum's General should stay visible", async () => {
    const { api, forumId } = await applied(wanting(false));

    assert.equal(api.forums.get(forumId)?.generalHidden, false);
    assert.ok(
      !api.mutations.some((call) => call.startsWith("setGeneralTopicHidden")),
      "Telegram already shows General in a new forum — there is nothing to do",
    );
  });

  it("never records id 1 in the managed state", async () => {
    const { store } = await applied(wanting(true));

    const recorded = store.load().forums.fixture;
    assert.ok(recorded);
    const topicIds = Object.values(recorded.topics).map((topic) => topic.topicId);
    assert.ok(
      !topicIds.includes(GENERAL_TOPIC_ID),
      "General is not ours, so its id must never appear in the mapping",
    );
    assert.deepEqual(Object.keys(recorded.topics), ["alpha"], "only our own topics are recorded");
  });

  it("never creates, renames or deletes it", async () => {
    const { api, forumId } = await applied(wanting(true));
    // The fake throws on a rename of id 1, so reaching that call would fail
    // the test loudly rather than silently pass.
    const touching = api.calls.filter((call) => call.includes(`, ${GENERAL_TOPIC_ID},`));

    assert.deepEqual(touching, [], "no call may address General as an ordinary topic");
    assert.ok(!api.mutations.some((call) => call.startsWith("createForumTopic") && call.endsWith(", General)")));
    assert.equal(api.forums.get(forumId)?.topics.has(GENERAL_TOPIC_ID), false);
  });

  it("is read separately from the topics whose ids we recorded", async () => {
    const { api, store } = await applied(wanting(true));
    api.calls.length = 0;

    await buildPlan(wanting(true), store.load(), api);

    const askedAbout = api.calls
      .filter((call) => call.startsWith("listExistingTopics"))
      .flatMap((call) => (call.match(/\[(.*)\]/u)?.[1] ?? "").split(",").filter(Boolean))
      .map(Number);
    assert.ok(askedAbout.length > 0, "the recorded topic must still be checked");
    assert.ok(
      !askedAbout.includes(GENERAL_TOPIC_ID),
      "General must not be mixed into the recorded-topic existence check",
    );
    assert.equal(api.calls.filter((call) => call.startsWith("readGeneralTopic")).length, 1);
  });

  it("sets it rather than guessing when Telegram does not report it", async () => {
    const { api, store } = await applied(wanting(true));
    api.generalTopicMissing = true;

    const plan = await buildPlan(wanting(true), store.load(), api);

    const general = plan.actions.find((action) => action.resource === "general-topic");
    assert.equal(general?.type, "UPDATE");
    assert.match(general?.reason ?? "", /did not report the built-in General topic/);
  });

  it("writes no state for it, because it owns no id", async () => {
    const { api, store, forumId } = await applied(wanting(true));
    api.setGeneralHiddenByHand(forumId, false);
    const before = JSON.stringify(store.load());
    let writes = 0;
    const counting: ManagedStateStore = {
      load: () => store.load(),
      ensureWritable: () => store.ensureWritable(),
      save: (state) => {
        writes += 1;
        store.save(state);
      },
      describe: () => store.describe(),
    };

    await applyPlan(await buildPlan(wanting(true), store.load(), api), api, counting);

    assert.equal(writes, 0);
    assert.equal(JSON.stringify(store.load()), before);
  });
});

describe("the real TSC 8042 configuration", () => {
  const TSC8042 = DESIRED_STATE.forums[0] as NonNullable<(typeof DESIRED_STATE.forums)[0]>;

  it("is what telegram:plan and telegram:apply use by default", async () => {
    const api = new FakeTelegram();
    const lines: string[] = [];

    await runReconcileCommand([], {
      mode: "plan",
      connect: async () => ({ api, close: async () => {} }),
      confirm: async () => assert.fail("plan must not confirm"),
      acquireLock: () => assert.fail("plan must take no lock"),
      log: (message) => lines.push(message),
      stateStore: new MemoryManagedStateStore(),
    });

    const output = lines.join("\n");
    assert.match(output, /CREATE\s+forum\s+tsc8042/);
    for (const topic of TSC8042.topics) {
      assert.match(
        output,
        new RegExp(`CREATE\\s+message\\s+tsc8042/${topic.key}/intro`),
        `the default plan must include ${topic.key}`,
      );
    }
    assert.deepEqual(api.mutations, [], "planning the real config mutates nothing");
  });

  it("creates the forum, every topic and every intro, once", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();

    const plan = await reconcile(api, store, DESIRED_STATE);

    const creates = 1 + TSC8042.topics.length * 2;
    assert.equal(countByType(plan).CREATE, creates);
    // The creates, plus hiding the built-in General topic — which is an
    // UPDATE, because Telegram already made that topic with the forum.
    assert.equal(countByType(plan).UPDATE, 1);
    assert.equal(api.mutations.length, creates + 1);
    assert.equal(api.forums.size, 1);

    const [forum] = [...api.forums.values()];
    assert.equal(forum?.title, TSC8042.title);
    assert.equal(forum?.description, TSC8042.description);
    assert.equal(forum?.generalHidden, true, "the built-in General topic must end up hidden");
    assert.equal(forum?.topics.size, TSC8042.topics.length);
    for (const topic of forum?.topics.values() ?? []) {
      assert.equal(topic.messages.size, 1, `"${topic.title}" must carry exactly one intro`);
    }
  });

  it("records every topic under its logical key, never its title", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store, DESIRED_STATE);

    const recorded = store.load().forums.tsc8042;
    assert.ok(recorded);
    assert.deepEqual(
      Object.keys(recorded.topics),
      TSC8042.topics.map((topic) => topic.key),
    );
    for (const key of Object.keys(recorded.topics)) {
      assert.equal(typeof recorded.topics[key]?.messages.intro, "number");
    }
  });

  it("converges: a second apply sends nothing at all", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store, DESIRED_STATE);
    const afterFirst = api.mutations.length;

    await reconcile(api, store, DESIRED_STATE);
    const plan = await buildPlan(DESIRED_STATE, store.load(), api);

    assert.equal(api.mutations.length, afterFirst, "no duplicate resource may be created");
    assert.equal(hasMutations(plan), false);
    assert.equal(countByType(plan).NOOP, plan.actions.length);
  });

  it("reconciles a reworded title, description and intro as UPDATEs in place", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store, DESIRED_STATE);
    const before = store.load();

    const reworded: DesiredState = {
      forums: [
        {
          ...TSC8042,
          title: "ТСЦ 8042 — практичний іспит (оновлено)",
          description: "Оновлений опис спільноти.",
          topics: TSC8042.topics.map((topic) =>
            topic.key === "routes"
              ? {
                  ...topic,
                  title: "🗺 Маршрути ТСЦ 8042",
                  messages: [{ key: "intro", text: "Оновлений текст теми маршрутів." }],
                }
              : topic,
          ),
        },
      ],
    };

    const plan = await buildPlan(reworded, before, api);
    assert.equal(countByType(plan).CREATE, 0, "rewording must never create a duplicate");
    assert.deepEqual(countByType(plan).UPDATE, 4, "forum title, description, topic title, intro");

    await applyPlan(plan, api, store);

    const after = store.load();
    assert.deepEqual(after, before, "an in-place edit moves no id");
    const forum = api.forums.get(after.forums.tsc8042?.id as string);
    assert.equal(forum?.title, "ТСЦ 8042 — практичний іспит (оновлено)");
    assert.equal(forum?.description, "Оновлений опис спільноти.");
  });

  it("updates only the description when only the description changed", async () => {
    const api = new FakeTelegram();
    const store = new MemoryManagedStateStore();
    await reconcile(api, store, DESIRED_STATE);
    const before = api.mutations.length;

    await reconcile(api, store, {
      forums: [{ ...TSC8042, description: "Лише опис змінився." }],
    });

    const performed = api.mutations.slice(before);
    assert.equal(performed.length, 1);
    assert.match(performed[0] ?? "", /^setForumDescription\(/);
  });
});
