import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { TelegramConfig } from "./types.js";

/**
 * The app's own session directory, kept in the user's home rather than in the
 * repository: it is created and owned by this app, so its permissions can be
 * enforced without touching directories that belong to the user.
 */
export const APP_DIR_NAME = ".tg-8042";
const SESSION_FILE_NAME = "session";

export function defaultSessionPath(home: string = homedir()): string {
  return join(home, APP_DIR_NAME, SESSION_FILE_NAME);
}

/**
 * Loads variables from a local .env file, if present.
 * Uses the built-in loader so no extra dependency is needed.
 * Real environment variables always win over the file.
 */
export function loadLocalEnv(cwd: string = process.cwd()): void {
  const envFile = resolve(cwd, ".env");
  if (!existsSync(envFile)) return;
  if (typeof process.loadEnvFile !== "function") return;
  process.loadEnvFile(envFile);
}

/**
 * Reads the MTProto credentials from the environment.
 * Secrets are never logged — only their absence is reported.
 */
export function readConfig(
  cwd: string = process.cwd(),
  home: string = homedir(),
): TelegramConfig {
  const rawApiId = process.env.TELEGRAM_API_ID?.trim();
  const apiHash = process.env.TELEGRAM_API_HASH?.trim();

  const missing: string[] = [];
  if (!rawApiId) missing.push("TELEGRAM_API_ID");
  if (!apiHash) missing.push("TELEGRAM_API_HASH");
  if (missing.length > 0) {
    throw new Error(
      `Missing environment variable(s): ${missing.join(", ")}. ` +
        `Copy .env.example to .env and fill in the values from https://my.telegram.org.`,
    );
  }

  const apiId = Number(rawApiId);
  if (!Number.isInteger(apiId) || apiId <= 0) {
    throw new Error("TELEGRAM_API_ID must be a positive integer.");
  }

  const custom = process.env.TELEGRAM_SESSION_PATH?.trim();
  if (custom) {
    // A path the user chose: the app writes the session file there, but the
    // surrounding directory stays exactly as the user set it up.
    return {
      apiId,
      apiHash: apiHash as string,
      sessionPath: isAbsolute(custom) ? custom : resolve(cwd, custom),
      ownsSessionDirectory: false,
    };
  }

  return {
    apiId,
    apiHash: apiHash as string,
    sessionPath: defaultSessionPath(home),
    ownsSessionDirectory: true,
  };
}
