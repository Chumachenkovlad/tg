import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";

const DEFAULT_SESSION_PATH = ".telegram/session";

export interface TelegramConfig {
  apiId: number;
  apiHash: string;
  sessionPath: string;
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
export function readConfig(cwd: string = process.cwd()): TelegramConfig {
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

  const configured = process.env.TELEGRAM_SESSION_PATH?.trim() || DEFAULT_SESSION_PATH;
  const sessionPath = isAbsolute(configured) ? configured : resolve(cwd, configured);

  return { apiId, apiHash: apiHash as string, sessionPath };
}

/** Reads a previously saved session string, or "" when there is none. */
export function readSession(sessionPath: string): string {
  if (!existsSync(sessionPath)) return "";
  return readFileSync(sessionPath, "utf8").trim();
}

/**
 * Persists the session string with owner-only permissions.
 * The session is an auth key: treat it like a password.
 */
export function saveSession(sessionPath: string, session: string): void {
  mkdirSync(dirname(sessionPath), { recursive: true, mode: 0o700 });
  writeFileSync(sessionPath, `${session}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * Builds a session from the stored string, falling back to an empty one
 * when the file is missing or unreadable (which just means "log in again").
 */
function restoreSession(sessionPath: string): StringSession {
  const saved = readSession(sessionPath);
  if (!saved) return new StringSession("");
  try {
    return new StringSession(saved);
  } catch {
    console.warn(`Stored session is unreadable — ignoring it and logging in again.`);
    return new StringSession("");
  }
}

/** Creates a GramJS client bound to the local session file. */
export function createClient(config: TelegramConfig): TelegramClient {
  const session = restoreSession(config.sessionPath);
  return new TelegramClient(session, config.apiId, config.apiHash, {
    connectionRetries: 5,
    // Keep GramJS quiet: its info-level output is noise for a CLI login.
    baseLogger: new Logger(LogLevel.ERROR),
  });
}
