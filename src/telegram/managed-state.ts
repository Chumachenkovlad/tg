import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";

/**
 * The identity mapping between logical keys and Telegram ids.
 *
 * This is **not** the source of truth. It records nothing but "the resource
 * with key X was created as Telegram id Y"; whether Y still exists is a
 * question only Telegram can answer, and the planner asks it every run.
 *
 * It holds no credentials: no access hash, no session. An access hash is
 * recovered from the chat list when a forum is resolved, so losing this file
 * costs the mapping and nothing more.
 */

export interface ManagedTopicState {
  topicId: number;
  /** Managed message key → Telegram message id. */
  messages: Record<string, number>;
}

export interface ManagedForumState {
  /** Telegram channel id, as a decimal string. */
  id: string;
  /** Managed topic key → its record. */
  topics: Record<string, ManagedTopicState>;
}

export interface ManagedState {
  version: 1;
  /** Forum key → its record. */
  forums: Record<string, ManagedForumState>;
}

export const STATE_VERSION = 1;
export const STATE_FILE_NAME = "managed-state.json";
/** Not a credential, but it maps out the account's managed chats. */
export const STATE_FILE_MODE = 0o600;
export const STATE_DIR_MODE = 0o700;

export function emptyState(): ManagedState {
  return { version: STATE_VERSION, forums: {} };
}

/** The state file sits next to the session, in the app's own directory. */
export function statePathFor(sessionPath: string): string {
  return join(dirname(sessionPath), STATE_FILE_NAME);
}

/**
 * Raised when the state file exists but cannot be read or understood.
 *
 * Deliberately fatal. Silently falling back to "no state" would make the
 * next run believe nothing had been created yet and build a second forum —
 * exactly the duplicate this whole model exists to prevent.
 */
export class ManagedStateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ManagedStateError";
  }
}

export interface ManagedStateStore {
  /** The recorded mapping, or an empty one when nothing was ever created. */
  load(): ManagedState;
  save(state: ManagedState): void;
  /** Human-readable location, for log messages. */
  describe(): string;
}

// ---------------------------------------------------------------------------
// Pure updates. Every one returns a new state; nothing is mutated in place,
// so a half-applied plan can never leave a caller holding a spliced object.
// ---------------------------------------------------------------------------

/**
 * Records a freshly created forum, dropping anything previously recorded
 * under that key: when a forum is recreated, its old topic and message ids
 * belong to the group that is gone.
 */
export function recordForum(state: ManagedState, forumKey: string, id: string): ManagedState {
  return {
    ...state,
    forums: { ...state.forums, [forumKey]: { id, topics: {} } },
  };
}

/** Records a freshly created topic, dropping any message ids from its predecessor. */
export function recordTopic(
  state: ManagedState,
  forumKey: string,
  topicKey: string,
  topicId: number,
): ManagedState {
  const forum = requireForum(state, forumKey);
  return {
    ...state,
    forums: {
      ...state.forums,
      [forumKey]: {
        ...forum,
        topics: { ...forum.topics, [topicKey]: { topicId, messages: {} } },
      },
    },
  };
}

/** Records a freshly sent managed message. */
export function recordMessage(
  state: ManagedState,
  forumKey: string,
  topicKey: string,
  messageKey: string,
  messageId: number,
): ManagedState {
  const forum = requireForum(state, forumKey);
  const topic = forum.topics[topicKey];
  if (!topic) {
    throw new ManagedStateError(
      `Cannot record message "${messageKey}": topic "${forumKey}/${topicKey}" is not in the state.`,
    );
  }

  return {
    ...state,
    forums: {
      ...state.forums,
      [forumKey]: {
        ...forum,
        topics: {
          ...forum.topics,
          [topicKey]: { ...topic, messages: { ...topic.messages, [messageKey]: messageId } },
        },
      },
    },
  };
}

function requireForum(state: ManagedState, forumKey: string): ManagedForumState {
  const forum = state.forums[forumKey];
  if (!forum) {
    throw new ManagedStateError(`Cannot record into unknown forum key "${forumKey}".`);
  }
  return forum;
}

// ---------------------------------------------------------------------------
// Parsing. Strict on purpose — see ManagedStateError.
// ---------------------------------------------------------------------------

export function parseManagedState(raw: string, location: string): ManagedState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ManagedStateError(
      `The state file at ${location} is not valid JSON. Fix or delete it — ` +
        `deleting it makes the next run create a second forum.`,
      { cause: error },
    );
  }

  if (!isRecord(parsed)) throw malformed(location, "expected an object");
  if (parsed.version !== STATE_VERSION) {
    throw malformed(location, `unsupported version ${JSON.stringify(parsed.version)}`);
  }
  if (!isRecord(parsed.forums)) throw malformed(location, "`forums` must be an object");

  const forums: Record<string, ManagedForumState> = {};
  for (const [forumKey, rawForum] of Object.entries(parsed.forums)) {
    if (!isRecord(rawForum)) throw malformed(location, `forum "${forumKey}" must be an object`);
    if (typeof rawForum.id !== "string" || rawForum.id === "") {
      throw malformed(location, `forum "${forumKey}" needs a non-empty string id`);
    }
    if (!isRecord(rawForum.topics)) {
      throw malformed(location, `forum "${forumKey}" needs a \`topics\` object`);
    }

    const topics: Record<string, ManagedTopicState> = {};
    for (const [topicKey, rawTopic] of Object.entries(rawForum.topics)) {
      const path = `${forumKey}/${topicKey}`;
      if (!isRecord(rawTopic)) throw malformed(location, `topic "${path}" must be an object`);
      if (!Number.isInteger(rawTopic.topicId)) {
        throw malformed(location, `topic "${path}" needs an integer topicId`);
      }
      if (!isRecord(rawTopic.messages)) {
        throw malformed(location, `topic "${path}" needs a \`messages\` object`);
      }

      const messages: Record<string, number> = {};
      for (const [messageKey, id] of Object.entries(rawTopic.messages)) {
        if (!Number.isInteger(id)) {
          throw malformed(location, `message "${path}/${messageKey}" needs an integer id`);
        }
        messages[messageKey] = id as number;
      }

      topics[topicKey] = { topicId: rawTopic.topicId as number, messages };
    }

    forums[forumKey] = { id: rawForum.id, topics };
  }

  return { version: STATE_VERSION, forums };
}

function malformed(location: string, detail: string): ManagedStateError {
  return new ManagedStateError(
    `The state file at ${location} is malformed (${detail}). Fix or delete it — ` +
      `deleting it makes the next run create a second forum.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface FileManagedStateStoreOptions {
  /** True only for the app's own directory; a user's own directory is left alone. */
  ownsDirectory?: boolean;
}

/**
 * Keeps the mapping in a JSON file next to the session.
 *
 * Writes go through a temporary file in the same directory and are renamed
 * over the destination, so an interrupted write leaves the previous mapping
 * intact rather than a truncated one — losing the mapping means the next run
 * creates duplicates.
 */
export class FileManagedStateStore implements ManagedStateStore {
  private readonly ownsDirectory: boolean;

  constructor(
    private readonly path: string,
    options: FileManagedStateStoreOptions = {},
  ) {
    this.ownsDirectory = options.ownsDirectory ?? false;
  }

  load(): ManagedState {
    if (!existsSync(this.path)) return emptyState();

    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      throw new ManagedStateError(
        `Cannot read the state file at ${this.describe()}. ` +
          `Refusing to continue: treating it as empty would create duplicates.`,
        { cause: error },
      );
    }

    if (raw.trim() === "") return emptyState();
    return parseManagedState(raw, this.describe());
  }

  save(state: ManagedState): void {
    const directory = dirname(this.path);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true, mode: STATE_DIR_MODE });
    } else if (this.ownsDirectory) {
      chmodSync(directory, STATE_DIR_MODE);
    }

    const temporary = join(directory, `.${basename(this.path)}.${randomBytes(6).toString("hex")}`);
    try {
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: STATE_FILE_MODE,
      });
      // `mode` only applies when the file is created; make it explicit.
      chmodSync(temporary, STATE_FILE_MODE);
      renameSync(temporary, this.path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw new ManagedStateError(`Cannot write the state file at ${this.describe()}.`, {
        cause: error,
      });
    }
  }

  describe(): string {
    const here = relative(process.cwd(), this.path);
    return here && !here.startsWith("..") ? here : this.path;
  }
}

/** An in-memory store. Used by the tests, and by nothing else. */
export class MemoryManagedStateStore implements ManagedStateStore {
  constructor(private state: ManagedState = emptyState()) {}

  load(): ManagedState {
    // Hand back a copy: a caller must not be able to edit the store in place.
    return parseManagedState(JSON.stringify(this.state), this.describe());
  }

  save(state: ManagedState): void {
    this.state = state;
  }

  describe(): string {
    return "(in memory)";
  }
}
