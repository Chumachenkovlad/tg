import { DESIRED_STATE, type DesiredState } from "../telegram/desired-state.js";
import type { ForumApi } from "../telegram/forum-types.js";
import type { ManagedStateStore } from "../telegram/managed-state.js";
import type { MutationLock } from "../telegram/mutation-lock.js";
import { buildPlan, formatPlan, hasMutations } from "../telegram/planner.js";
import { applyPlan } from "../telegram/reconcile.js";
import { parseBooleanFlags } from "./flags.js";

/**
 * `telegram:plan` and `telegram:apply`, with their side effects injected.
 *
 * Both build the same plan from the same code path — `plan` simply stops
 * after printing it. That is deliberate: the plan a person approves is the
 * plan that runs, not a second opinion computed later.
 *
 * Planning connects to Telegram (it has to: the state file is not the truth)
 * but only reads. The first request that can change anything comes after the
 * confirmation.
 */

export type ReconcileMode = "plan" | "apply";

/** A connected client plus the way to close it. */
export interface ForumSession {
  api: ForumApi;
  close(): Promise<void>;
}

export interface ReconcileDeps {
  mode: ReconcileMode;
  connect(): Promise<ForumSession>;
  /** Only called in apply mode, when there is something to do and no --yes. */
  confirm(question: string): Promise<boolean>;
  log(message: string): void;
  stateStore: ManagedStateStore;
  /**
   * Taken for the whole apply lifecycle — reading state, planning, confirming
   * and executing — because two applies that both planned from an empty state
   * would each create the forum. Required rather than optional so no caller
   * can quietly run an apply without it; plan mode never calls it.
   */
  acquireLock(): MutationLock;
  desired?: DesiredState;
}

export const PLAN_USAGE = `Usage: npm run telegram:plan

Read-only. Connects to Telegram, compares the desired state with what exists,
and prints the plan. Performs no mutation.

Flags:
  --help    Show this message.`;

export const APPLY_USAGE = `Usage: npm run telegram:apply -- [--yes]

Builds the same plan as telegram:plan, shows it, and executes it after an
explicit confirmation. Re-running with an unchanged configuration does
nothing: every action comes out as NOOP.

Flags:
  --yes     Skip the confirmation prompt.
  --help    Show this message.`;

export function usageFor(mode: ReconcileMode): string {
  return mode === "plan" ? PLAN_USAGE : APPLY_USAGE;
}

/**
 * The flags a mode accepts. `plan` has nothing to confirm, so it does not
 * take `--yes`; passing it there is a mistake worth reporting.
 */
export function flagsFor(mode: ReconcileMode): string[] {
  return mode === "plan" ? ["help"] : ["yes", "help"];
}

/**
 * Says out loud what the duplicate-safety actually rests on.
 *
 * The mapping is tracked in git, which is what carries ownership across a
 * disposable checkout — but only once it is committed and pushed. An apply
 * whose result stays in a Codespace that is then thrown away is an apply
 * whose ownership is lost, and nothing recovers it from Telegram yet.
 */
export function durabilityWarning(location: string): string[] {
  return [
    "⚠  Ownership of these chats is recorded ONLY in:",
    `     ${location}`,
    "   It is tracked in git — commit and push it after every apply. An apply",
    "   whose state file is never committed, or is lost with the machine or",
    "   Codespace it ran in, leaves chats nothing knows it owns, and the next",
    "   apply creates duplicates. Nothing recovers the mapping from Telegram",
    "   yet, so duplicate safety is conditional on this file being kept.",
  ];
}

export async function runReconcileCommand(
  argv: readonly string[],
  deps: ReconcileDeps,
): Promise<void> {
  const { mode, log } = deps;
  const flags = parseBooleanFlags(argv, flagsFor(mode));

  if (flags.has("help")) {
    log(usageFor(mode));
    return;
  }

  if (mode !== "apply") {
    await reconcile(flags, deps);
    return;
  }

  // Held across reading the state, planning, confirming and executing: a
  // second apply must not plan from the same state this one is about to act
  // on. Planning is read-only and takes no lock.
  const lock = deps.acquireLock();
  try {
    await reconcile(flags, deps);
  } finally {
    lock.release();
  }
}

async function reconcile(flags: ReadonlySet<string>, deps: ReconcileDeps): Promise<void> {
  const { mode, log } = deps;
  const desired = deps.desired ?? DESIRED_STATE;
  // Read before connecting: a malformed state file is a hard stop, and there
  // is no point opening a session just to fail on it.
  const state = deps.stateStore.load();

  const session = await deps.connect();
  try {
    const plan = await buildPlan(desired, state, session.api);

    log(mode === "plan" ? "Plan (read-only, nothing will be changed):" : "Plan:");
    log("");
    for (const line of formatPlan(plan)) log(line);
    log("");

    for (const line of durabilityWarning(deps.stateStore.describe())) log(line);
    log("");

    if (mode === "plan") {
      log("Read-only run. Nothing was changed.");
      return;
    }

    if (!hasMutations(plan)) {
      // Converged. Nothing to confirm, because nothing would happen.
      log("Already up to date. Nothing to do.");
      return;
    }

    if (!flags.has("yes") && !(await deps.confirm('Type "yes" to apply this plan: '))) {
      log("Cancelled. Nothing was changed.");
      return;
    }

    const result = await applyPlan(plan, session.api, deps.stateStore, { onStep: log });

    log("");
    log(`Applied ${result.executed.length} action(s).`);
    log(`Identity state written to ${deps.stateStore.describe()}.`);
    log("Commit and push it now — it is how the next run knows these chats are ours.");
  } finally {
    await session.close();
  }
}
