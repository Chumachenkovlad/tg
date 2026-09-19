import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { TelegramConfig } from "./types.js";

const DEFAULT_SESSION_PATH = ".telegram/session";

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
