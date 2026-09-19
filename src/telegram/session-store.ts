import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { SessionStore } from "./types.js";

/** Owner-only permissions: the session is an auth key, treat it like a password. */
export const SESSION_FILE_MODE = 0o600;
export const SESSION_DIR_MODE = 0o700;

/**
 * Keeps the session on disk with owner-only permissions.
 *
 * The `mode` option of mkdir/writeFile only applies when the entry is created
 * (and is masked by umask), so permissions are re-applied explicitly on every
 * read and write. That also tightens a session file left permissive earlier.
 */
export class FileSessionStore implements SessionStore {
  constructor(private readonly path: string) {}

  load(): string {
    if (!existsSync(this.path)) return "";
    this.enforcePermissions();
    return readFileSync(this.path, "utf8").trim();
  }

  save(session: string): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: SESSION_DIR_MODE });
    writeFileSync(this.path, `${session}\n`, { encoding: "utf8", mode: SESSION_FILE_MODE });
    this.enforcePermissions();
  }

  describe(): string {
    const relativePath = relative(process.cwd(), this.path);
    return relativePath.startsWith("..") ? this.path : relativePath;
  }

  /** Re-applies 0700 on the directory and 0600 on the session file. */
  private enforcePermissions(): void {
    const dir = dirname(this.path);
    if (existsSync(dir) && (statSync(dir).mode & 0o777) !== SESSION_DIR_MODE) {
      chmodSync(dir, SESSION_DIR_MODE);
    }
    if (existsSync(this.path) && (statSync(this.path).mode & 0o777) !== SESSION_FILE_MODE) {
      chmodSync(this.path, SESSION_FILE_MODE);
    }
  }
}
