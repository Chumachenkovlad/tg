import { TelegramClient as MtprotoClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { Logger, LogLevel } from "teleproto/extensions/Logger.js";
import { FileSessionStore } from "./session-store.js";
import type { AuthPrompts, SessionStore, TelegramAccount, TelegramConfig } from "./types.js";

/**
 * Thin wrapper around the MTProto library (`teleproto`).
 *
 * This is the ONLY module that imports the library. Everything else uses the
 * library-agnostic types from `./types.js`, so swapping the implementation
 * stays a one-file change.
 */
export class TelegramAccountClient {
  private readonly client: MtprotoClient;
  private readonly session: StringSession;

  private constructor(
    config: TelegramConfig,
    private readonly store: SessionStore,
  ) {
    this.session = TelegramAccountClient.restoreSession(store);
    this.client = new MtprotoClient(this.session, config.apiId, config.apiHash, {
      connectionRetries: 5,
      // Keep the library quiet: its info-level output is noise for a CLI.
      baseLogger: new Logger(LogLevel.ERROR),
    });
  }

  /** Builds a client that keeps its session in the configured local file. */
  static fromConfig(config: TelegramConfig, store?: SessionStore): TelegramAccountClient {
    return new TelegramAccountClient(config, store ?? new FileSessionStore(config.sessionPath));
  }

  /**
   * Restores a saved session, falling back to an empty one when the stored
   * value is missing or unreadable (which just means "log in again").
   */
  private static restoreSession(store: SessionStore): StringSession {
    try {
      const saved = store.load();
      if (!saved) return new StringSession("");
      return new StringSession(saved);
    } catch {
      // Covers both a failed read (permissions, I/O) and a malformed value.
      console.warn("Stored session is unreadable — ignoring it and logging in again.");
      return new StringSession("");
    }
  }

  /** Where the session is persisted, for log messages. */
  get sessionLocation(): string {
    return this.store.describe();
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async isAuthorized(): Promise<boolean> {
    return this.client.isUserAuthorized();
  }

  /**
   * Runs the interactive login and persists the resulting session.
   * Only called when there is no valid session yet.
   */
  async signIn(prompts: AuthPrompts): Promise<void> {
    await this.client.start({
      phoneNumber: () => prompts.phoneNumber(),
      phoneCode: () => prompts.loginCode(),
      password: (hint?: string) => prompts.password(hint),
      onError: (error: Error) => {
        prompts.onError?.(error.message);
      },
    });
    this.store.save(this.session.save());
  }

  /** Verifies the session and returns only non-sensitive account fields. */
  async getMe(): Promise<TelegramAccount> {
    const me = await this.client.getMe();
    return {
      id: me.id.toString(),
      ...(me.firstName ? { firstName: me.firstName } : {}),
      ...(me.lastName ? { lastName: me.lastName } : {}),
      ...(me.username ? { username: me.username } : {}),
      isBot: me.bot === true,
    };
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
    await this.client.destroy();
  }
}
