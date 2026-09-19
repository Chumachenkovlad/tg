import { createTestForum } from "../telegram/create-test-forum.js";
import type { ForumApi } from "../telegram/forum-types.js";
import { TEST_FORUM_PLAN, describePlan, type TestForumPlan } from "../telegram/test-forum-plan.js";
import { parseTestForumArgs } from "./test-forum-args.js";

/**
 * The `telegram:create-test-forum` command, with its side effects injected.
 *
 * The script passes the real client, prompt and console; the tests pass a
 * recording fake, so they can assert on the exact thing that matters here —
 * that a dry run and a refused confirmation reach Telegram zero times, and
 * that `--apply` performs exactly the three expected steps.
 *
 * The connection itself is behind `connect`: it is only called on an approved
 * `--apply`, so a dry run does not even open a session.
 */

/** A connected client plus the way to close it. */
export interface ForumSession {
  api: ForumApi;
  close(): Promise<void>;
}

export interface TestForumCommandDeps {
  /** Opens a Telegram connection. Called only for an approved --apply. */
  connect(): Promise<ForumSession>;
  /** Asks the user to confirm. Called only for --apply without --yes. */
  confirm(question: string): Promise<boolean>;
  log(message: string): void;
  plan?: TestForumPlan;
}

export const TEST_FORUM_USAGE = `Usage: npm run telegram:create-test-forum -- [--dry-run | --apply [--yes]]

  --dry-run   Print the intended actions and change nothing. This is the default.
  --apply     Actually create the forum, the topic and the message.
  --yes       Skip the confirmation prompt. Only valid with --apply.
  --help      Show this message.`;

export async function runTestForumCommand(
  argv: readonly string[],
  deps: TestForumCommandDeps,
): Promise<void> {
  const args = parseTestForumArgs(argv);
  const { log } = deps;

  if (args.help) {
    log(TEST_FORUM_USAGE);
    return;
  }

  const plan = deps.plan ?? TEST_FORUM_PLAN;
  const steps = describePlan(plan);

  if (!args.apply) {
    log("DRY RUN — no Telegram request will be sent. Intended actions:");
    log("");
    for (const line of steps) log(`  ${line}`);
    log("");
    log("Nothing was created. Re-run with --apply to execute.");
    return;
  }

  log("About to perform these actions on your Telegram account:");
  log("");
  for (const line of steps) log(`  ${line}`);
  log("");

  if (!args.assumeYes && !(await deps.confirm('Type "yes" to proceed: '))) {
    log("Cancelled. Nothing was created.");
    return;
  }

  const session = await deps.connect();
  try {
    const result = await createTestForum(session.api, { plan, onStep: log });

    log("");
    log("Done:");
    log(`  forum id:    ${result.forumId}`);
    log(`  forum title: ${result.forumTitle}`);
    log(`  topic id:    ${result.topicId}`);
    log(`  topic title: ${result.topicTitle}`);
    log(`  message id:  ${result.messageId}`);
  } finally {
    await session.close();
  }
}
