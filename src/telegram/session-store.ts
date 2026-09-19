import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { SessionStore } from "./types.js";

/**
 * Keeps the session on disk with owner-only permissions.
 * The session is an auth key: treat the file like a password.
 */
export class FileSessionStore implements SessionStore {
  constructor(private readonly path: string) {}

  load(): string {
    if (!existsSync(this.path)) return "";
    return readFileSync(this.path, "utf8").trim();
  }

  save(session: string): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, `${session}\n`, { encoding: "utf8", mode: 0o600 });
  }

  describe(): string {
    const relativePath = relative(process.cwd(), this.path);
    return relativePath.startsWith("..") ? this.path : relativePath;
  }
}
