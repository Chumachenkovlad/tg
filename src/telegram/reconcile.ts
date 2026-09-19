import type { ForumApi, ForumRef } from "./forum-types.js";
import {
  recordForum,
  recordMessage,
  recordTopic,
  type ManagedState,
  type ManagedStateStore,
} from "./managed-state.js";
import type { Plan, PlannedAction } from "./planner.js";

/**
 * Executes a plan.
 *
 * Two rules shape everything here:
 *
 * 1. **Only what was planned runs.** The executor never looks at Telegram to
 *    decide anything; it walks the actions the planner produced. Resources
 *    the state does not know about are not in the plan, so they cannot be
 *    touched.
 * 2. **The mapping is written after the fact, one resource at a time.** Each
 *    id is recorded and persisted immediately after Telegram confirms that
 *    creation, before the next one starts. A failure therefore leaves the
 *    state describing exactly what exists — never more. On the next run the
 *    planner sees the resources that did get created and plans only the rest.
 */

export interface ApplyOptions {
  onStep?: (message: string) => void;
}

export interface ApplyResult {
  /** Actions actually executed, in order. NOOPs are not included. */
  executed: PlannedAction[];
  state: ManagedState;
}

export async function applyPlan(
  plan: Plan,
  api: ForumApi,
  store: ManagedStateStore,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const step = options.onStep ?? (() => {});
  const forums = new Map<string, ForumRef>(plan.resolvedForums);
  const executed: PlannedAction[] = [];
  let state = store.load();

  for (const action of plan.actions) {
    switch (action.type) {
      case "NOOP":
        continue;

      case "CREATE": {
        switch (action.resource) {
          case "forum": {
            step(`CREATE forum ${action.path} ("${action.title}")`);
            const created = await api.createForumSupergroup(action.title);
            forums.set(action.forumKey, created.ref);
            state = recordForum(state, action.forumKey, created.id);
            break;
          }

          case "topic": {
            step(`CREATE topic ${action.path} ("${action.title}")`);
            const topic = await api.createForumTopic(
              forumRef(forums, action.forumKey),
              action.title,
            );
            state = recordTopic(state, action.forumKey, action.topicKey, topic.id);
            break;
          }

          case "message": {
            step(`CREATE message ${action.path}`);
            const topicId = state.forums[action.forumKey]?.topics[action.topicKey]?.topicId;
            if (topicId === undefined) {
              throw new Error(
                `Cannot send "${action.path}": topic "${action.forumKey}/${action.topicKey}" ` +
                  `has no recorded id.`,
              );
            }
            const message = await api.sendMessageToTopic(
              forumRef(forums, action.forumKey),
              topicId,
              action.text,
            );
            state = recordMessage(
              state,
              action.forumKey,
              action.topicKey,
              action.messageKey,
              message.id,
            );
            break;
          }
        }
        break;
      }

      // Not produced by this iteration's planner. Kept explicit so adding
      // them is a change here and in the planner, and nowhere else.
      case "UPDATE":
      case "DELETE":
        throw new Error(
          `${action.type} is not implemented yet (${action.resource} ${action.path}).`,
        );
    }

    // Persisted per resource, not per run: a later failure must not undo the
    // record of what already exists, and must not claim anything more.
    store.save(state);
    executed.push(action);
  }

  return { executed, state };
}

function forumRef(forums: Map<string, ForumRef>, forumKey: string): ForumRef {
  const ref = forums.get(forumKey);
  if (!ref) {
    throw new Error(`No Telegram reference for forum "${forumKey}".`);
  }
  return ref;
}
