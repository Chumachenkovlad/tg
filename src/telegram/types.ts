/**
 * Library-agnostic Telegram types.
 *
 * Nothing here depends on the MTProto library: only `client.ts` imports it,
 * so the rest of the project talks to Telegram through these shapes.
 */

export interface TelegramConfig {
  apiId: number;
  apiHash: string;
  sessionPath: string;
  /**
   * True when the session directory is the app's own default location, and its
   * permissions may therefore be enforced. False for a custom session path:
   * that directory belongs to the user and is never modified.
   */
  ownsSessionDirectory: boolean;
}

/** Safe subset of the signed-in account. Never carries credentials. */
export interface TelegramAccount {
  id: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  isBot: boolean;
}

/**
 * Raised when a session exists but cannot be read (permissions, I/O, ...).
 *
 * This is deliberately fatal: silently starting a new login would leave the
 * unreadable session behind and add another authorized device to the account.
 */
export class SessionReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionReadError";
  }
}

/** Where the session credential is kept between runs. */
export interface SessionStore {
  /**
   * Previously saved session, or "" when there is none.
   * Throws {@link SessionReadError} when a session exists but cannot be read.
   */
  load(): string;
  save(session: string): void;
  /** Human-readable location, for log messages. */
  describe(): string;
}

/** Interactive answers the login flow asks for. */
export interface AuthPrompts {
  phoneNumber(): Promise<string>;
  loginCode(): Promise<string>;
  /** `hint` is the 2FA hint set on the account, when Telegram provides one. */
  password(hint?: string): Promise<string>;
  onError?(message: string): void;
}
