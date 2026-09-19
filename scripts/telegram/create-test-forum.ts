#!/usr/bin/env tsx
/**
 * Creates one small test forum on the signed-in account.
 *
 *   npm run telegram:create-test-forum -- --dry-run   (also the default)
 *   npm run telegram:create-test-forum -- --apply
 *
 * Without `--apply` nothing is created, sent or modified: the run only prints
 * the intended actions, and does not even open a connection. With `--apply` it
 * asks for confirmation first, unless `--yes` is also given.
 *
 * Scope is exactly three creating calls on brand-new objects. Nothing existing
 * is touched, nobody is invited, no private message is sent, and no step is
 * ever retried — see src/telegram/create-test-forum.ts.
 *
 * Nothing sensitive is printed: no API hash, no session string, no login code,
 * no 2FA password, no access hashes.
 *
 * This script holds no Telegram logic of its own: it wires the real client,
 * prompt and console into runTestForumCommand().
 */
import { createInterface } from "node:readline";
import { CliUsageError } from "../../src/cli/flags.js";
import {
  TEST_FORUM_USAGE,
  runTestForumCommand,
  type ForumSession,
} from "../../src/cli/test-forum-command.js";
import { TelegramAccountClient } from "../../src/telegram/client.js";
import { loadLocalEnv, readConfig } from "../../src/telegram/config.js";

/** Asks for a typed confirmation. Anything but the exact word is a refusal. */
function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolveConfirm) => {
    rl.question(question, (answer) => {
      rl.close();
      resolveConfirm(answer.trim() === "yes");
    });
  });
}

async function connect(): Promise<ForumSession> {
  loadLocalEnv();
  // requestRetries: 1 — one attempt per call. `channels.createChannel` has no
  // random_id for Telegram to deduplicate on, so a retry could create a second
  // group; a failed run that creates nothing is the better outcome.
  const client = TelegramAccountClient.fromConfig(readConfig(), { requestRetries: 1 });

  try {
    await client.connect();
    if (!(await client.isAuthorized())) {
      throw new Error("No valid session. Run `npm run telegram:auth` first.");
    }
  } catch (error) {
    await client.disconnect();
    throw error;
  }

  return {
    api: client,
    close: () => client.disconnect(),
  };
}

runTestForumCommand(process.argv.slice(2), {
  connect,
  confirm,
  log: (message) => {
    console.log(message);
  },
})
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    if (error instanceof CliUsageError) {
      console.error(error.message);
      console.error("");
      console.error(TEST_FORUM_USAGE);
      process.exit(2);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
