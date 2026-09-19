/**
 * Shared wiring for `telegram:plan` and `telegram:apply`.
 *
 * Holds no Telegram logic of its own: it builds the real client, prompt,
 * console and state store, and hands them to runReconcileCommand().
 *
 * Nothing sensitive is printed: no API hash, no session string, no login
 * code, no 2FA password, no access hashes.
 */
import { createInterface } from "node:readline";
import { CliUsageError, parseBooleanFlags } from "../../src/cli/flags.js";
import {
  flagsFor,
  runReconcileCommand,
  usageFor,
  type ForumSession,
  type ReconcileMode,
} from "../../src/cli/reconcile-command.js";
import { TelegramAccountClient } from "../../src/telegram/client.js";
import { loadLocalEnv, readConfig } from "../../src/telegram/config.js";
import { FileManagedStateStore, statePathFor } from "../../src/telegram/managed-state.js";
import type { TelegramConfig } from "../../src/telegram/types.js";

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

async function connect(config: TelegramConfig, mode: ReconcileMode): Promise<ForumSession> {
  // requestRetries: 1 for the mutating command. `channels.createChannel`
  // carries no random_id for Telegram to deduplicate on, so a retried call
  // could create a second group; one clean failure is the better outcome.
  const client = TelegramAccountClient.fromConfig(
    config,
    mode === "apply" ? { requestRetries: 1 } : {},
  );

  try {
    await client.connect();
    if (!(await client.isAuthorized())) {
      throw new Error("No valid session. Run `npm run telegram:auth` first.");
    }
  } catch (error) {
    await client.disconnect();
    throw error;
  }

  return { api: client, close: () => client.disconnect() };
}

async function main(mode: ReconcileMode): Promise<void> {
  const argv = process.argv.slice(2);

  // Parsed here first so `--help` and a mistyped flag are answered without
  // credentials — reading the config would otherwise fail before the command
  // ever got the chance to print its usage.
  if (parseBooleanFlags(argv, flagsFor(mode)).has("help")) {
    console.log(usageFor(mode));
    return;
  }

  loadLocalEnv();
  const config = readConfig();

  await runReconcileCommand(argv, {
    mode,
    connect: () => connect(config, mode),
    confirm,
    log: (message) => {
      console.log(message);
    },
    stateStore: new FileManagedStateStore(statePathFor(config.sessionPath), {
      ownsDirectory: config.ownsSessionDirectory,
    }),
  });
}

export function runReconcileScript(mode: ReconcileMode): void {
  // Everything runs inside the promise chain, so a configuration error comes
  // out as a one-line message and an exit code, not an unhandled stack trace.
  main(mode)
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      if (error instanceof CliUsageError) {
        console.error(error.message);
        console.error("");
        console.error(usageFor(mode));
        process.exit(2);
      }
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
