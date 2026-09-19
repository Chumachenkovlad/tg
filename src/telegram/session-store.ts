import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { SessionReadError, type SessionStore, type TelegramConfig } from "./types.js";

/** Owner-only permissions: the session is an auth key, treat it like a password. */
export const SESSION_FILE_MODE = 0o600;
export const SESSION_DIR_MODE = 0o700;

export interface FileSessionStoreOptions {
  /**
   * True only for the app's own session directory. When false — a custom
   * TELEGRAM_SESSION_PATH, which may point at any directory on the machine —
   * an existing parent directory is never chmod-ed.
   */
  ownsDirectory?: boolean;
}

/**
 * Keeps the session on disk.
 *
 * The session file itself is always forced to 0600: it belongs to this app.
 * Directory handling depends on ownership:
 * - a directory this app creates gets 0700 from `mkdir` (umask can only remove
 *   bits, never add them, so no chmod is needed);
 * - an existing directory is tightened only when the app owns it;
 * - an existing directory behind a custom path is left untouched.
 */
export class FileSessionStore implements SessionStore {
  private readonly ownsDirectory: boolean;

  constructor(
    private readonly path: string,
    options: FileSessionStoreOptions = {},
  ) {
    this.ownsDirectory = options.ownsDirectory ?? false;
  }

  static fromConfig(config: TelegramConfig): FileSessionStore {
    return new FileSessionStore(config.sessionPath, {
      ownsDirectory: config.ownsSessionDirectory,
    });
  }

  load(): string {
    if (!existsSync(this.path)) return "";
    try {
      const contents = readFileSync(this.path, "utf8").trim();
      this.enforceFileMode();
      return contents;
    } catch (cause) {
      const code = cause instanceof Error && "code" in cause ? ` (${String(cause.code)})` : "";
      throw new SessionReadError(
        `Cannot read the session file at ${this.path}${code}. ` +
          `Fix its permissions or remove it, then run the login again.`,
        { cause },
      );
    }
  }

  save(session: string): void {
    this.ensureDirectory();
    writeFileSync(this.path, `${session}\n`, { encoding: "utf8", mode: SESSION_FILE_MODE });
    this.enforceFileMode();
  }

  describe(): string {
    const relativePath = relative(process.cwd(), this.path);
    return relativePath.startsWith("..") ? this.path : relativePath;
  }

  /** Creates the session directory, tightening it only when the app owns it. */
  private ensureDirectory(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: SESSION_DIR_MODE });
      return;
    }
    if (!this.ownsDirectory) return;
    if ((statSync(dir).mode & 0o777) !== SESSION_DIR_MODE) {
      chmodSync(dir, SESSION_DIR_MODE);
    }
  }

  /**
   * Re-applies 0600 on the session file: the `mode` option only applies when
   * the file is created, so a file left permissive earlier is tightened here.
   */
  private enforceFileMode(): void {
    if ((statSync(this.path).mode & 0o777) !== SESSION_FILE_MODE) {
      chmodSync(this.path, SESSION_FILE_MODE);
    }
  }
}
