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
  private readonly restoredFromStore: boolean;

  private constructor(
    config: TelegramConfig,
    private readonly store: SessionStore,
  ) {
    const restored = TelegramAccountClient.restoreSession(store);
    this.session = restored.session;
    this.restoredFromStore = restored.reused;
    this.client = new MtprotoClient(this.session, config.apiId, config.apiHash, {
      connectionRetries: 5,
      // Keep the library quiet: its info-level output is noise for a CLI.
      baseLogger: new Logger(LogLevel.ERROR),
    });
  }

  /** Builds a client that keeps its session in the configured local file. */
  static fromConfig(config: TelegramConfig, store?: SessionStore): TelegramAccountClient {
    return new TelegramAccountClient(config, store ?? FileSessionStore.fromConfig(config));
  }

  /**
   * Restores a saved session.
   *
   * No session at all means "log in", and a stored value that does not parse is
   * discarded with a warning. A failed *read* (permissions, I/O) is different:
   * it propagates, because starting a fresh login there would silently add
   * another authorized device while the existing session stays in place.
   */
  private static restoreSession(store: SessionStore): {
    session: StringSession;
    reused: boolean;
  } {
    const saved = store.load();
    if (!saved) return { session: new StringSession(""), reused: false };
    try {
      return { session: new StringSession(saved), reused: true };
    } catch {
      console.warn("Stored session is malformed — ignoring it and logging in again.");
      return { session: new StringSession(""), reused: false };
    }
  }

  /**
   * Whether a stored session was accepted and is in use. The session value
   * itself is never exposed — it is a credential.
   */
  get hasStoredSession(): boolean {
    return this.restoredFromStore;
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
