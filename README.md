# tg

Telegram MTProto automation for a personal (user) account, built on
[teleproto](https://www.npmjs.com/package/teleproto) (the maintained fork of GramJS).

Current scope: **authentication only**. The script logs in, stores a local session
and verifies it with `getMe()`. It does not send messages or modify anything.

## Layout

The MTProto library is isolated behind a small wrapper, so library details do not
leak into the rest of the project:

| File | Role |
| --- | --- |
| `src/telegram/types.ts` | Library-agnostic types (`TelegramAccount`, `AuthPrompts`, `SessionStore`) |
| `src/telegram/client.ts` | **The only module that imports `teleproto`** — wraps connect / sign-in / `getMe` |
| `src/telegram/config.ts` | Environment configuration |
| `src/telegram/session-store.ts` | Session persistence on disk |
| `scripts/telegram/auth.ts` | CLI: prompts + login flow |

Swapping the MTProto library means rewriting `src/telegram/client.ts` only.

## Requirements

- Node.js >= 20.12
- npm
- API credentials from https://my.telegram.org → *API development tools*

## Setup

```bash
npm install
cp .env.example .env    # then fill in TELEGRAM_API_ID and TELEGRAM_API_HASH
```

## Login

```bash
npm run telegram:auth
```

On the first run it asks for your phone number, the login code Telegram sends you,
and your 2FA password if your account has one. The resulting session is written to
`~/.tg-8042/session` (file mode `600`). Later runs reuse that session and go straight
to `getMe()`.

The login code and the 2FA password are typed without terminal echo. The script
prints only the account id, first name and username — never the API hash, the
session string, the login code or the 2FA password.

## Where the session lives

By default in `~/.tg-8042/` — a directory this app creates and owns, outside the
repository, kept at `700`.

`TELEGRAM_SESSION_PATH` overrides the location. That path is yours, not the app's:
the session file is still written with `600`, but the permissions of an existing
parent directory are never changed. A directory the app has to create for you is
created with `700`.

## Security

- The session file is always forced to `600` — on write and on read, so a file left
  permissive earlier is tightened. `mode` alone is not enough: it only applies when
  the file is created.
- A **missing** session simply starts a login. A session that is **read but does not
  parse** is discarded with a warning and a login starts. A session that **cannot be
  read** (permissions, I/O) is a hard error: the CLI stops instead of quietly
  authorizing another device while the old session stays in place.
- `.env` is git-ignored, as is `.telegram/` in case you point
  `TELEGRAM_SESSION_PATH` inside the repository.

The session file is an auth key: anyone who has it can act as your Telegram account.
Do not commit or share it. To revoke it, terminate the session in Telegram →
*Settings → Devices*, then delete `~/.tg-8042/` and log in again.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run telegram:auth` | Interactive login / session check |
| `npm run typecheck` | `tsc --noEmit` over `src`, `scripts` and `test` |
| `npm test` | Node's built-in test runner (`test/*.test.ts`) |

Tests cover session file and directory permissions (including that a directory the
app does not own is left alone), the malformed-session fallback, read failures being
fatal, and configuration validation. They never open a network connection and need no
credentials. CI runs `npm ci`, `npm run typecheck` and `npm test` on pushes and pull
requests.
