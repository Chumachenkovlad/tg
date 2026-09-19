import { openSync, closeSync, readFileSync, rmSync, mkdirSync, existsSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * An exclusive lock around a mutating run.
 *
 * Two applies starting from an empty state would each plan `CREATE forum` and
 * each execute it, leaving two groups and one mapping. The window is real:
 * planning takes several round-trips, so the second run reads the state file
 * long before the first writes to it. The lock closes that window by covering
 * the whole lifecycle — plan, confirm and execute — not just the write.
 *
 * It is a file created with `wx`, which is a single atomic syscall: either
 * this process created it or somebody else holds it. Read-only planning does
 * not take it; nothing it does can collide.
 *
 * The lock is advisory, and deliberately not self-expiring. A run that dies
 * without releasing leaves the file behind, and the next apply refuses and
 * says so, naming the file. That is the safe way round: an automatic takeover
 * cannot tell a dead run from a slow one, and guessing wrong here means a
 * duplicate group.
 */

export const LOCK_FILE_NAME = "apply.lock";
const LOCK_FILE_MODE = 0o600;

export class MutationLockedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MutationLockedError";
  }
}

export function lockPathFor(sessionPath: string): string {
  return join(dirname(sessionPath), LOCK_FILE_NAME);
}

export interface MutationLock {
  release(): void;
}

/** What is written into the lock file, to make a stale one diagnosable. */
interface LockHolder {
  pid: number;
  startedAt: string;
  host: string;
}

export function acquireMutationLock(path: string): MutationLock {
  const directory = dirname(path);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });

  const holder: LockHolder = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    host: process.env.HOSTNAME ?? "unknown",
  };

  let handle: number;
  try {
    // `wx` fails if the file exists. One syscall, so two processes racing
    // here cannot both win.
    handle = openSync(path, "wx", LOCK_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new MutationLockedError(describeHeldLock(path));
    }
    throw new MutationLockedError(`Cannot take the apply lock at ${path}.`, { cause: error });
  }

  try {
    writeSync(handle, `${JSON.stringify(holder, null, 2)}\n`);
  } finally {
    closeSync(handle);
  }

  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      rmSync(path, { force: true });
    },
  };
}

/** Runs `fn` while holding the lock, releasing it whatever happens. */
export async function withMutationLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = acquireMutationLock(path);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

function describeHeldLock(path: string): string {
  const holder = readHolder(path);
  const who = holder
    ? `Held by pid ${holder.pid} on ${holder.host}, since ${holder.startedAt}` +
      `${isRunning(holder.pid) ? " (that process is still running)" : " (that process is gone)"}.`
    : "The lock file could not be read.";

  return (
    `Another apply is already running: ${path} exists. ${who} ` +
    `Refusing to reconcile concurrently — two applies from the same state would ` +
    `each create the forum. If no apply is running, delete that file and retry.`
  );
}

function readHolder(path: string): LockHolder | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { pid, startedAt, host } = parsed as Partial<LockHolder>;
    if (typeof pid !== "number" || typeof startedAt !== "string") return undefined;
    return { pid, startedAt, host: typeof host === "string" ? host : "unknown" };
  } catch {
    return undefined;
  }
}

/** Whether a pid is alive. Signal 0 checks without sending anything. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
