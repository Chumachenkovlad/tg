import type { ForumApi, ForumRef } from "./forum-types.js";
import {
  ManagedStateError,
  canonicalize,
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

  // Execute against the exact mapping the plan was computed from, not
  // whatever the store holds now. Re-reading here would be a time-of-check to
  // time-of-use gap: a plan that says "CREATE forum" because the mapping was
  // empty, applied to a mapping that meanwhile records one, builds a second
  // group. The lock should already prevent that; this makes it impossible
  // rather than merely unlikely, and catches an edit by hand too.
  const current = store.load();
  if (canonicalize(current) !== canonicalize(plan.baseState)) {
    throw new ManagedStateError(
      `The state at ${store.describe()} changed after this plan was built. ` +
        `Refusing to apply a plan computed from a different mapping — re-run to replan.`,
    );
  }
  let state = plan.baseState;

  // Anything that creates produces an id that has to be recorded. Find out
  // now whether recording is even possible: a forum created against a
  // read-only checkout would exist in Telegram with nothing owning it, and
  // the next run would build a second one. An update-only plan records
  // nothing, so it is not held up by this.
  if (plan.actions.some((action) => action.type === "CREATE")) {
    store.ensureWritable();
  }

  for (const action of plan.actions) {
    const stateBefore = state;

    switch (action.type) {
      case "NOOP":
        continue;

      case "CREATE": {
        switch (action.resource) {
          case "forum": {
            step(`CREATE forum ${action.path} ("${action.title}")`);
            const created = await api.createForumSupergroup(action.title, action.description);
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

      case "UPDATE": {
        // Every update is in place, on the id the state already records, so
        // none of them changes the mapping.
        switch (action.resource) {
          case "forum": {
            step(`UPDATE forum ${action.path} ${action.field}`);
            const ref = forumRef(forums, action.forumKey);
            if (action.field === "title") await api.setForumTitle(ref, action.value);
            else await api.setForumDescription(ref, action.value);
            break;
          }

          case "topic": {
            step(`UPDATE topic ${action.path} → "${action.title}"`);
            await api.setTopicTitle(
              forumRef(forums, action.forumKey),
              action.topicId,
              action.title,
            );
            break;
          }

          case "message": {
            step(`UPDATE message ${action.path}`);
            await api.setMessageText(
              forumRef(forums, action.forumKey),
              action.messageId,
              action.text,
            );
            break;
          }
        }
        break;
      }

      // Not produced by this iteration's planner: a resource dropped from the
      // desired state is left alone until `rebuild-managed` lands. Kept
      // explicit so adding it is a change here and in the planner, nowhere else.
      case "DELETE":
        throw new Error(`DELETE is not implemented yet (${action.resource} ${action.path}).`);
    }

    // Persisted per resource, not per run: a later failure must not undo the
    // record of what already exists, and must not claim anything more. An
    // update changes no id, so there is nothing to write for it.
    if (state !== stateBefore) store.save(state);
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
