import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";

/**
 * The identity mapping between logical keys and Telegram ids.
 *
 * It is **deployment identity metadata**, so it is tracked in git at
 * `telegram/managed-state.json` and committed. That is what makes ownership
 * survive a disposable checkout: a fresh clone knows which chats are already
 * ours, where a machine-local file would not.
 *
 * It is **not** the source of truth about Telegram. It records only "the
 * resource with key X was created as Telegram id Y". Whether Y still exists,
 * and what it is currently called, are questions only Telegram can answer,
 * and the planner asks it every run.
 *
 * It holds **no secrets**, which is what makes committing it safe: no api id
 * or hash, no session, no auth key, no access hash, no invite link, no phone
 * number. An access hash is deliberately *not* persisted — it is resolved
 * from Telegram on each run using the stored channel id.
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
export const STATE_DIR_NAME = "telegram";
export const STATE_FILE_NAME = "managed-state.json";
/**
 * An ordinary repository file: it carries no secret, and making it
 * owner-only would only get in the way of the checkout that has to read it.
 */
export const STATE_FILE_MODE = 0o644;

export function emptyState(): ManagedState {
  return { version: STATE_VERSION, forums: {} };
}

/**
 * The state file lives in the repository, at `telegram/managed-state.json`,
 * and is committed. The session does not, and never will: that one is a
 * credential and stays in the app's own directory outside the checkout.
 */
export function statePathFor(repositoryRoot: string = process.cwd()): string {
  return join(repositoryRoot, STATE_DIR_NAME, STATE_FILE_NAME);
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

/**
 * A stable text form of a state, for comparing two of them.
 *
 * Key order depends on the order things were written or parsed, so plain
 * `JSON.stringify` would report two identical mappings as different. Sorting
 * makes the comparison mean what it says.
 */
export function canonicalize(state: ManagedState): string {
  const forums = Object.fromEntries(
    Object.entries(state.forums)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([forumKey, forum]) => [
        forumKey,
        {
          id: forum.id,
          topics: Object.fromEntries(
            Object.entries(forum.topics)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([topicKey, topic]) => [
                topicKey,
                {
                  topicId: topic.topicId,
                  messages: Object.fromEntries(
                    Object.entries(topic.messages).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
                  ),
                },
              ]),
          ),
        },
      ]),
  );

  return JSON.stringify({ version: state.version, forums });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Keeps the mapping in the repository's `telegram/managed-state.json`.
 *
 * Writes go through a temporary file in the same directory and are renamed
 * over the destination, so an interrupted write leaves the previous mapping
 * intact rather than a truncated one.
 */
export class FileManagedStateStore implements ManagedStateStore {
  constructor(private readonly path: string) {}

  /**
   * The recorded mapping.
   *
   * A **missing** file is the supported bootstrap case: a deployment that has
   * never created anything. The repository ships the file with no forums in
   * it, so in practice this only happens before the first commit of it.
   *
   * A file that **exists but is empty or malformed** is corruption, not a
   * bootstrap, and is fatal — see {@link ManagedStateError}.
   */
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

    if (raw.trim() === "") {
      // A file that exists but holds nothing is a truncated write or a
      // half-finished copy, not a first run. A first run has no file at all.
      // Reading it as "nothing was created" is exactly how a second forum
      // gets built on top of the first.
      throw malformed(this.describe(), "the file exists but is empty");
    }
    return parseManagedState(raw, this.describe());
  }

  save(state: ManagedState): void {
    const directory = dirname(this.path);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });

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
