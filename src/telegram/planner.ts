import type { DesiredForum, DesiredState } from "./desired-state.js";
import { validateDesiredState } from "./desired-state.js";
import type { ForumApi, ForumRef } from "./forum-types.js";
import type { ManagedState, ManagedTopicState } from "./managed-state.js";

/**
 * Builds the plan: what would have to change in Telegram for it to match the
 * desired state.
 *
 * Planning is **read-only**. It calls nothing that creates, edits or deletes;
 * it only resolves recorded ids and reads back what Telegram currently holds.
 *
 * Two rules decide every action:
 *
 * - **Identity is the key.** A resource recorded under a key and still alive
 *   in Telegram is that resource, whatever it is called now. Changed content
 *   is an UPDATE of it, never a second one.
 * - **The local state file is a hint, never the truth.** Every id it records
 *   is verified before the planner believes it, so a topic deleted by hand in
 *   the Telegram app is planned for recreation.
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
  /** Set by the creating call itself, not by a follow-up edit. */
  description: string;
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

/**
 * Changes one forum attribute in place. The recorded channel id is unaffected.
 *
 * A forum has more than one editable attribute, and each is a separate
 * Telegram method — so there is one action per attribute that actually
 * differs. Editing the description alone therefore sends no rename.
 */
export interface UpdateForumAction extends BaseAction {
  type: "UPDATE";
  resource: "forum";
  forumKey: string;
  field: "title" | "description";
  value: string;
}

/** Renames a topic in place. The recorded topic id is unaffected. */
export interface UpdateTopicAction extends BaseAction {
  type: "UPDATE";
  resource: "topic";
  forumKey: string;
  topicKey: string;
  topicId: number;
  title: string;
}

/** Edits a message in place. The recorded message id is unaffected. */
export interface UpdateMessageAction extends BaseAction {
  type: "UPDATE";
  resource: "message";
  forumKey: string;
  topicKey: string;
  messageKey: string;
  messageId: number;
  text: string;
}

export interface NoopAction extends BaseAction {
  type: "NOOP";
}

/**
 * Not produced yet. A resource dropped from the desired state is left alone
 * for now; destructive reconciliation arrives with `rebuild-managed`. It is
 * declared so the executor switches exhaustively over the union, which is
 * what will make adding it a contained change.
 */
export interface DeleteAction extends BaseAction {
  type: "DELETE";
}

export type PlannedAction =
  | CreateForumAction
  | CreateTopicAction
  | CreateMessageAction
  | UpdateForumAction
  | UpdateTopicAction
  | UpdateMessageAction
  | NoopAction
  | DeleteAction;

export interface Plan {
  actions: PlannedAction[];
  /**
   * Forums that already exist, resolved during planning, so the executor does
   * not have to look them up a second time.
   */
  resolvedForums: Map<string, ForumRef>;
  /**
   * The exact mapping this plan was computed from.
   *
   * The executor starts from this snapshot rather than re-reading the store,
   * and checks the store still matches it before touching anything. Otherwise
   * a plan approved against one mapping could be executed against another —
   * and "CREATE forum" applied to a mapping that already records one is a
   * duplicate group.
   */
  baseState: ManagedState;
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

  return { actions, resolvedForums, baseState: state };
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
  const resolved = recorded ? await api.findForumById(recorded.id) : undefined;

  if (!recorded || !resolved) {
    actions.push({
      type: "CREATE",
      resource: "forum",
      path: forum.key,
      forumKey: forum.key,
      title: forum.title,
      description: forum.description,
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

  resolvedForums.set(forum.key, resolved.ref);

  // The forum is this one whatever it is called now: a changed title or
  // description is an edit of it, never a second group.
  const changed = ([
    { field: "title", current: resolved.title, desired: forum.title },
    { field: "description", current: resolved.description, desired: forum.description },
  ] as const).filter((attribute) => attribute.current !== attribute.desired);

  if (changed.length === 0) {
    actions.push({
      type: "NOOP",
      resource: "forum",
      path: forum.key,
      reason: `exists as ${recorded.id}, title and description match`,
    });
  } else {
    for (const attribute of changed) {
      actions.push({
        type: "UPDATE",
        resource: "forum",
        path: forum.key,
        forumKey: forum.key,
        field: attribute.field,
        value: attribute.desired,
        reason:
          `${attribute.field} is ${quote(attribute.current)}, ` +
          `should be ${quote(attribute.desired)}`,
      });
    }
  }

  // Two round-trips for the whole forum, not one per topic and message.
  const recordedTopics = forum.topics
    .map((topic) => recorded.topics[topic.key])
    .filter((entry): entry is ManagedTopicState => entry !== undefined);

  const liveTopics = new Map(
    (await api.listExistingTopics(
      resolved.ref,
      recordedTopics.map((entry) => entry.topicId),
    )).map((topic) => [topic.id, topic]),
  );

  // Messages are only worth reading inside topics that survived.
  const messageIdsToCheck = forum.topics.flatMap((topic) => {
    const entry = recorded.topics[topic.key];
    if (!entry || !liveTopics.has(entry.topicId)) return [];
    return topic.messages
      .map((message) => entry.messages[message.key])
      .filter((id): id is number => id !== undefined);
  });
  const liveMessages = new Map(
    (await api.listExistingMessages(resolved.ref, messageIdsToCheck)).map((message) => [
      message.id,
      message,
    ]),
  );

  for (const topic of forum.topics) {
    const recordedTopic = recorded.topics[topic.key];
    const live = recordedTopic ? liveTopics.get(recordedTopic.topicId) : undefined;
    const topicPath = `${forum.key}/${topic.key}`;

    if (!recordedTopic || !live) {
      actions.push({
        type: "CREATE",
        resource: "topic",
        path: topicPath,
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
          path: `${topicPath}/${message.key}`,
          forumKey: forum.key,
          topicKey: topic.key,
          messageKey: message.key,
          text: message.text,
          reason: recordedTopic ? "the topic is being recreated" : "the topic is being created",
        });
      }
      continue;
    }

    actions.push(
      live.title === topic.title
        ? {
            type: "NOOP",
            resource: "topic",
            path: topicPath,
            reason: `exists as ${live.id}, title matches`,
          }
        : {
            type: "UPDATE",
            resource: "topic",
            path: topicPath,
            forumKey: forum.key,
            topicKey: topic.key,
            topicId: live.id,
            title: topic.title,
            reason: `title is ${quote(live.title)}, should be ${quote(topic.title)}`,
          },
    );

    for (const message of topic.messages) {
      const recordedId = recordedTopic.messages[message.key];
      const liveMessage = recordedId === undefined ? undefined : liveMessages.get(recordedId);
      const path = `${topicPath}/${message.key}`;

      if (recordedId === undefined || !liveMessage) {
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
        continue;
      }

      actions.push(
        liveMessage.text === message.text
          ? {
              type: "NOOP",
              resource: "message",
              path,
              reason: `exists as ${liveMessage.id}, text matches`,
            }
          : {
              type: "UPDATE",
              resource: "message",
              path,
              forumKey: forum.key,
              topicKey: topic.key,
              messageKey: message.key,
              messageId: liveMessage.id,
              text: message.text,
              reason: `text is ${quote(liveMessage.text)}, should be ${quote(message.text)}`,
            },
      );
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

/** Keeps a reason on one line, however long the text it quotes. */
function quote(value: string, limit = 40): string {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  const shortened = [...oneLine].length > limit ? `${[...oneLine].slice(0, limit).join("")}…` : oneLine;
  return `"${shortened}"`;
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
