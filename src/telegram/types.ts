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
}

/** Safe subset of the signed-in account. Never carries credentials. */
export interface TelegramAccount {
  id: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  isBot: boolean;
}

/** Where the session credential is kept between runs. */
export interface SessionStore {
  /** Previously saved session, or "" when there is none. */
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
