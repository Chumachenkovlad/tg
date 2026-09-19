#!/usr/bin/env tsx
/**
 * Telegram MTProto login for a personal (user) account.
 *
 * First run: asks for phone number, login code and — when Telegram requires it —
 * the 2FA password, then stores the session locally.
 * Later runs: reuses the stored session and only verifies it with getMe().
 *
 * Nothing sensitive is printed: no API hash, no session string, no code, no password.
 */
import { createInterface } from "node:readline";
import { relative } from "node:path";
import { Api } from "telegram";
import type { StringSession } from "telegram/sessions/index.js";
import { createClient, loadLocalEnv, readConfig, saveSession } from "../../src/telegram/client.js";

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

function describeAccount(me: Api.User | Api.InputPeerUser): string {
  if (!(me instanceof Api.User)) {
    return `  id:       ${me.userId}`;
  }
  const lines = [`  id:       ${me.id}`];
  if (me.firstName) lines.push(`  name:     ${me.firstName}`);
  if (me.username) lines.push(`  username: @${me.username}`);
  if (me.bot) lines.push("  type:     bot");
  return lines.join("\n");
}

async function main(): Promise<void> {
  loadLocalEnv();
  const config = readConfig();
  const client = createClient(config);
  const sessionFile = relative(process.cwd(), config.sessionPath);

  try {
    await client.connect();

    if (await client.isUserAuthorized()) {
      console.log(`Reusing saved session (${sessionFile}).`);
    } else {
      console.log("No valid session found — starting interactive login.");
      await client.start({
        phoneNumber: () => prompt("Phone number (international format, e.g. +380...): "),
        phoneCode: () => prompt("Login code from Telegram: "),
        password: (hint?: string) =>
          promptSecret(hint ? `2FA password (hint: ${hint}): ` : "2FA password: "),
        onError: (err: Error) => {
          console.error(`Login error: ${err.message}`);
        },
      });

      saveSession(config.sessionPath, (client.session as StringSession).save());
      console.log(`Session saved to ${sessionFile} (keep it secret, it is git-ignored).`);
    }

    const me = await client.getMe();
    console.log("Authenticated as:");
    console.log(describeAccount(me));
  } finally {
    await client.disconnect();
    await client.destroy();
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
