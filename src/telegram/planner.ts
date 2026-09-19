import type { DesiredForum, DesiredState } from "./desired-state.js";
import { validateDesiredState } from "./desired-state.js";
import type { ForumApi, ForumRef } from "./forum-types.js";
import type { ManagedState, ManagedTopicState } from "./managed-state.js";

/**
 * Builds the plan: what would have to change in Telegram for it to match the
 * desired state.
 *
 * Planning is **read-only**. It calls nothing that creates, edits or deletes;
 * it only resolves recorded ids and asks Telegram whether they still exist.
 *
 * The local state file is treated as a hint, never as the truth. Every id it
 * records is verified before the planner believes it, so a topic deleted by
 * hand in the Telegram app is planned for recreation rather than assumed to
 * be there.
 */

export type ActionType = "NOOP" | "CREATE" | "UPDATE" | "DELETE";
export type ResourceType = "forum" | "topic" | "message";

interface BaseAction {
  type: ActionType;
  resource: ResourceType;
  /** Logical path of stable keys, e.g. `tsc8042/test/intro`. Never a title. */
  path: string;
  /** Why the planner decided this, in plain words. */
  reason: string;
}

export interface CreateForumAction extends BaseAction {
  type: "CREATE";
  resource: "forum";
  forumKey: string;
  title: string;
}

export interface CreateTopicAction extends BaseAction {
  type: "CREATE";
  resource: "topic";
  forumKey: string;
  topicKey: string;
  title: string;
}

export interface CreateMessageAction extends BaseAction {
  type: "CREATE";
  resource: "message";
  forumKey: string;
  topicKey: string;
  messageKey: string;
  text: string;
}

export interface NoopAction extends BaseAction {
  type: "NOOP";
}

/**
 * Not produced yet: this iteration only creates. They are declared so the
 * executor can switch exhaustively over the union, which is what will make
 * adding them a contained change rather than a hunt through the code.
 */
export interface UpdateAction extends BaseAction {
  type: "UPDATE";
}

export interface DeleteAction extends BaseAction {
  type: "DELETE";
}

export type PlannedAction =
  | CreateForumAction
  | CreateTopicAction
  | CreateMessageAction
  | NoopAction
  | UpdateAction
  | DeleteAction;

export interface Plan {
  actions: PlannedAction[];
  /**
   * Forums that already exist, resolved during planning, so the executor does
   * not have to look them up a second time.
   */
  resolvedForums: Map<string, ForumRef>;
}

export function hasMutations(plan: Plan): boolean {
  return plan.actions.some((action) => action.type !== "NOOP");
}

export function countByType(plan: Plan): Record<ActionType, number> {
  const counts: Record<ActionType, number> = { NOOP: 0, CREATE: 0, UPDATE: 0, DELETE: 0 };
  for (const action of plan.actions) counts[action.type] += 1;
  return counts;
}

export async function buildPlan(
  desired: DesiredState,
  state: ManagedState,
  api: ForumApi,
): Promise<Plan> {
  validateDesiredState(desired);

  const actions: PlannedAction[] = [];
  const resolvedForums = new Map<string, ForumRef>();

  for (const forum of desired.forums) {
    await planForum(forum, state, api, actions, resolvedForums);
  }

  return { actions, resolvedForums };
}

async function planForum(
  forum: DesiredForum,
  state: ManagedState,
  api: ForumApi,
  actions: PlannedAction[],
  resolvedForums: Map<string, ForumRef>,
): Promise<void> {
  const recorded = state.forums[forum.key];

  // Nothing recorded, or recorded but gone from Telegram: everything below it
  // has to be built from scratch, and any ids still in the state belong to
  // the group that no longer exists.
  const ref = recorded ? await api.findForumById(recorded.id) : undefined;

  if (!recorded || !ref) {
    actions.push({
      type: "CREATE",
      resource: "forum",
      path: forum.key,
      forumKey: forum.key,
      title: forum.title,
      reason: recorded
        ? `recorded forum ${recorded.id} no longer exists in Telegram`
        : "not created yet",
    });
    planWholeForumContents(
      forum,
      actions,
      recorded ? "the forum is being recreated" : "the forum is being created",
    );
    return;
  }

  resolvedForums.set(forum.key, ref);
  actions.push({
    type: "NOOP",
    resource: "forum",
    path: forum.key,
    reason: `exists as ${recorded.id}`,
  });

  // Two round-trips for the whole forum, not one per topic and message.
  const recordedTopics = forum.topics
    .map((topic) => recorded.topics[topic.key])
    .filter((entry): entry is ManagedTopicState => entry !== undefined);

  const liveTopicIds = new Set(
    await api.listExistingTopicIds(
      ref,
      recordedTopics.map((entry) => entry.topicId),
    ),
  );

  // Messages are only worth checking inside topics that survived.
  const messageIdsToCheck = forum.topics.flatMap((topic) => {
    const entry = recorded.topics[topic.key];
    if (!entry || !liveTopicIds.has(entry.topicId)) return [];
    return topic.messages
      .map((message) => entry.messages[message.key])
      .filter((id): id is number => id !== undefined);
  });
  const liveMessageIds = new Set(await api.listExistingMessageIds(ref, messageIdsToCheck));

  for (const topic of forum.topics) {
    const recordedTopic = recorded.topics[topic.key];

    if (!recordedTopic || !liveTopicIds.has(recordedTopic.topicId)) {
      actions.push({
        type: "CREATE",
        resource: "topic",
        path: `${forum.key}/${topic.key}`,
        forumKey: forum.key,
        topicKey: topic.key,
        title: topic.title,
        reason: recordedTopic
          ? `recorded topic ${recordedTopic.topicId} no longer exists in Telegram`
          : "not created yet",
      });
      // Messages recorded for a dead topic died with it.
      for (const message of topic.messages) {
        actions.push({
          type: "CREATE",
          resource: "message",
          path: `${forum.key}/${topic.key}/${message.key}`,
          forumKey: forum.key,
          topicKey: topic.key,
          messageKey: message.key,
          text: message.text,
          reason: recordedTopic ? "the topic is being recreated" : "the topic is being created",
        });
      }
      continue;
    }

    actions.push({
      type: "NOOP",
      resource: "topic",
      path: `${forum.key}/${topic.key}`,
      reason: `exists as ${recordedTopic.topicId}`,
    });

    for (const message of topic.messages) {
      const recordedId = recordedTopic.messages[message.key];
      const path = `${forum.key}/${topic.key}/${message.key}`;

      if (recordedId !== undefined && liveMessageIds.has(recordedId)) {
        actions.push({
          type: "NOOP",
          resource: "message",
          path,
          reason: `exists as ${recordedId}`,
        });
        continue;
      }

      actions.push({
        type: "CREATE",
        resource: "message",
        path,
        forumKey: forum.key,
        topicKey: topic.key,
        messageKey: message.key,
        text: message.text,
        reason:
          recordedId === undefined
            ? "not sent yet"
            : `recorded message ${recordedId} no longer exists in Telegram`,
      });
    }
  }
}

/** Every topic and message of a forum that is about to be built from nothing. */
function planWholeForumContents(
  forum: DesiredForum,
  actions: PlannedAction[],
  reason: string,
): void {
  for (const topic of forum.topics) {
    actions.push({
      type: "CREATE",
      resource: "topic",
      path: `${forum.key}/${topic.key}`,
      forumKey: forum.key,
      topicKey: topic.key,
      title: topic.title,
      reason,
    });
    for (const message of topic.messages) {
      actions.push({
        type: "CREATE",
        resource: "message",
        path: `${forum.key}/${topic.key}/${message.key}`,
        forumKey: forum.key,
        topicKey: topic.key,
        messageKey: message.key,
        text: message.text,
        reason,
      });
    }
  }
}

/** Renders a plan for the terminal. Titles and text are shown, ids are not. */
export function formatPlan(plan: Plan): string[] {
  if (plan.actions.length === 0) return ["Plan: nothing is configured."];

  const width = Math.max(...plan.actions.map((action) => action.path.length));
  const lines = plan.actions.map((action) => {
    const resource = action.resource.padEnd(7);
    return `  ${action.type.padEnd(6)} ${resource} ${action.path.padEnd(width)}  (${action.reason})`;
  });

  const counts = countByType(plan);
  lines.push("");
  lines.push(
    `Plan: ${counts.CREATE} to create, ${counts.UPDATE} to update, ` +
      `${counts.DELETE} to delete, ${counts.NOOP} unchanged.`,
  );
  return lines;
}
