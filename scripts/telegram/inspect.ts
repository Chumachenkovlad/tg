#!/usr/bin/env tsx
/**
 * Read-only inspection of the Telegram account.
 *
 * Reuses the stored session, reports who is logged in and lists the groups,
 * supergroups, forums and channels in the chat list. It performs no mutation
 * whatsoever: no message, no join, no creation, no change to any chat.
 *
 * Nothing sensitive is printed: no API hash, no session string, no access
 * hashes. Telegram details stay behind src/telegram/client.ts.
 */
import { TelegramAccountClient } from "../../src/telegram/client.js";
import { loadLocalEnv, readConfig } from "../../src/telegram/config.js";
import { formatDialogs } from "../../src/telegram/format-dialogs.js";
import { CliUsageError, parseBooleanFlags } from "../../src/cli/flags.js";

const USAGE = `Usage: npm run telegram:inspect

Read-only. Prints the signed-in account and the group/channel dialogs.
Performs no Telegram mutation.

Flags:
  --help    Show this message.`;

async function main(): Promise<void> {
  const flags = parseBooleanFlags(process.argv.slice(2), ["help"]);
  if (flags.has("help")) {
    console.log(USAGE);
    return;
  }

  loadLocalEnv();
  const client = TelegramAccountClient.fromConfig(readConfig());

  try {
    await client.connect();

    if (!(await client.isAuthorized())) {
      throw new Error("No valid session. Run `npm run telegram:auth` first.");
    }

    const me = await client.getMe();
    const name = [me.firstName, me.lastName].filter(Boolean).join(" ");
    console.log("Signed in as:");
    console.log(`  id:       ${me.id}`);
    if (name) console.log(`  name:     ${name}`);
    if (me.username) console.log(`  username: @${me.username}`);
    console.log("");

    for (const line of formatDialogs(await client.listGroupDialogs())) {
      console.log(line);
    }
  } finally {
    await client.disconnect();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    if (error instanceof CliUsageError) {
      console.error(error.message);
      console.error("");
      console.error(USAGE);
      process.exit(2);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
