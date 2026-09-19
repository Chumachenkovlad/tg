#!/usr/bin/env tsx
/**
 * Telegram MTProto login for a personal (user) account.
 *
 * First run: asks for phone number, login code and — when Telegram requires it —
 * the 2FA password, then stores the session locally.
 * Later runs: reuses the stored session and only verifies it with getMe().
 *
 * Nothing sensitive is printed: no API hash, no session string, no code, no password.
 * This script never touches the MTProto library directly — it goes through
 * the wrapper in src/telegram/client.ts.
 */
import { createInterface } from "node:readline";
import { TelegramAccountClient } from "../../src/telegram/client.js";
import { loadLocalEnv, readConfig } from "../../src/telegram/config.js";
import type { AuthPrompts, TelegramAccount } from "../../src/telegram/types.js";

/** Asks a question and echoes what is typed. */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolvePrompt) => {
    rl.question(question, (answer) => {
      rl.close();
      resolvePrompt(answer.trim());
    });
  });
}

/** Asks a question without echoing the typed characters. */
function promptSecret(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // The typed value is a secret, so suppress the terminal echo readline does by default.
  (rl as unknown as { _writeToOutput: (chunk: string) => void })._writeToOutput = (chunk) => {
    if (chunk.includes(question)) process.stdout.write(question);
  };
  return new Promise<string>((resolvePrompt) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolvePrompt(answer.trim());
    });
  });
}

const prompts: AuthPrompts = {
  phoneNumber: () => prompt("Phone number (international format, e.g. +380...): "),
  loginCode: () => prompt("Login code from Telegram: "),
  password: (hint?: string) =>
    promptSecret(hint ? `2FA password (hint: ${hint}): ` : "2FA password: "),
  onError: (message: string) => {
    console.error(`Login error: ${message}`);
  },
};

function describeAccount(account: TelegramAccount): string {
  const lines = [`  id:       ${account.id}`];
  const name = [account.firstName, account.lastName].filter(Boolean).join(" ");
  if (name) lines.push(`  name:     ${name}`);
  if (account.username) lines.push(`  username: @${account.username}`);
  if (account.isBot) lines.push("  type:     bot");
  return lines.join("\n");
}

async function main(): Promise<void> {
  loadLocalEnv();
  const client = TelegramAccountClient.fromConfig(readConfig());

  try {
    await client.connect();

    if (await client.isAuthorized()) {
      console.log(`Reusing saved session (${client.sessionLocation}).`);
    } else {
      console.log("No valid session found — starting interactive login.");
      await client.signIn(prompts);
      console.log(
        `Session saved to ${client.sessionLocation} (keep it secret, it is git-ignored).`,
      );
    }

    console.log("Authenticated as:");
    console.log(describeAccount(await client.getMe()));
  } finally {
    await client.disconnect();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
