import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  SessionReadError,
  SessionWriteError,
  type SessionStore,
  type TelegramConfig,
} from "./types.js";

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
 * Writes go to a temporary file in the same directory and are renamed over the
 * destination, so an interrupted or failing write can never leave a truncated
 * session behind: the previous one stays intact.
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
      throw new SessionReadError(
        `Cannot read the session file at ${this.path}${describeCause(cause)}. ` +
          `Fix its permissions or remove it, then run the login again.`,
        { cause },
      );
    }
  }

  /**
   * Proves a session could be written here by creating and removing a probe
   * file next to it. The session file itself is never opened or replaced, so a
   * stored session survives this check untouched.
   */
  ensureWritable(): void {
    try {
      this.ensureDirectory();
    } catch (cause) {
      throw new SessionWriteError(
        `Cannot create the session directory ${dirname(this.path)}${describeCause(cause)}. ` +
          `Fix it before logging in, or point TELEGRAM_SESSION_PATH somewhere writable.`,
        { cause },
      );
    }

    const probe = this.temporaryPath();
    try {
      writeFileSync(probe, "", { encoding: "utf8", mode: SESSION_FILE_MODE, flag: "wx" });
    } catch (cause) {
      throw new SessionWriteError(
        `Cannot write the session to ${this.path}${describeCause(cause)}. ` +
          `Fix it before logging in, or point TELEGRAM_SESSION_PATH somewhere writable.`,
        { cause },
      );
    } finally {
      removeQuietly(probe);
    }
  }

  /**
   * Writes the session atomically: a fresh temporary file with 0600 in the same
   * directory, renamed over the destination only once the write succeeded. On
   * failure the temporary file is removed and the previous session is left as
   * it was.
   */
  save(session: string): void {
    this.ensureDirectory();
    const temporary = this.temporaryPath();
    try {
      writeFileSync(temporary, `${session}\n`, {
        encoding: "utf8",
        mode: SESSION_FILE_MODE,
        flag: "wx",
      });
      // The rename carries the temporary file's 0600 over the destination.
      renameSync(temporary, this.path);
    } catch (cause) {
      removeQuietly(temporary);
      throw new SessionWriteError(
        `Cannot write the session to ${this.path}${describeCause(cause)}. ` +
          `The previous session, if any, was left unchanged.`,
        { cause },
      );
    }
    this.enforceFileMode();
  }

  describe(): string {
    const relativePath = relative(process.cwd(), this.path);
    return relativePath.startsWith("..") ? this.path : relativePath;
  }

  /** A unique, unused path next to the session file. Overridable in tests. */
  protected temporaryPath(): string {
    const unique = `${process.pid}-${randomBytes(6).toString("hex")}`;
    return join(dirname(this.path), `.${basename(this.path)}.${unique}.tmp`);
  }

  /** Creates the session directory, tightening it only when the app owns it. */
  private ensureDirectory(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: SESSION_DIR_MODE });
      return;
    }
    if (!this.ownsDirectory) return;
    const stats = statSync(dir);
    // Only a real directory is ours to tighten; anything else (a stray file at
    // that path) is left alone and fails the write on its own terms.
    if (stats.isDirectory() && (stats.mode & 0o777) !== SESSION_DIR_MODE) {
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

/** Best-effort cleanup: it must never mask the error that triggered it. */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Nothing useful to do here; the caller is already reporting a failure.
  }
}

/** " (EACCES)" when the cause carries an errno code, "" otherwise. */
function describeCause(cause: unknown): string {
  return cause instanceof Error && "code" in cause ? ` (${String(cause.code)})` : "";
}
