import { DESIRED_STATE, type DesiredState } from "../telegram/desired-state.js";
import type { ForumApi } from "../telegram/forum-types.js";
import type { ManagedStateStore } from "../telegram/managed-state.js";
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
  } finally {
    await session.close();
  }
}
