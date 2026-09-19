# tg

Telegram MTProto automation for a personal (user) account, built on
[teleproto](https://www.npmjs.com/package/teleproto) (the maintained fork of GramJS).

Current scope:

1. **Authentication** — log in, store a local session, verify it with `getMe()`.
2. **Read-only inspection** — list the groups and channels the account is in.
3. **One controlled mutation** — create a single small test forum, behind an
   explicit `--apply` and a confirmation.

Nothing else mutates. No user is ever added or invited, no private message is
sent, and no existing chat is read into, written to or modified.

## Layout

The MTProto library is isolated behind a small wrapper, so library details do not
leak into the rest of the project:

| File | Role |
| --- | --- |
| `src/telegram/types.ts` | Library-agnostic types (`TelegramAccount`, `AuthPrompts`, `SessionStore`) |
| `src/telegram/forum-types.ts` | Library-agnostic forum types (`DialogSummary`, `ForumRef`, `ForumApi`) |
| `src/telegram/client.ts` | **The only module that imports `teleproto`** — connect / sign-in / `getMe` / dialogs / forum creation |
| `src/telegram/config.ts` | Environment configuration |
| `src/telegram/session-store.ts` | Session persistence on disk |
| `src/telegram/format-dialogs.ts` | Rendering for the inspection output |
| `src/telegram/test-forum-plan.ts` | What the test forum is: titles, message, description |
| `src/telegram/create-test-forum.ts` | The three creation steps, in order, once each |
| `src/cli/flags.ts` | Strict flag parsing — anything unrecognised is an error |
| `src/cli/test-forum-args.ts` | Flags of the test-forum command |
| `src/cli/test-forum-command.ts` | The command itself, with its side effects injected |
| `scripts/telegram/auth.ts` | CLI: prompts + login flow |
| `scripts/telegram/inspect.ts` | CLI: read-only inspection |
| `scripts/telegram/create-test-forum.ts` | CLI: wires the real client, prompt and console into the command |

Swapping the MTProto library means rewriting `src/telegram/client.ts` only. The
CLI scripts construct no Telegram requests of their own.

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

## Inspect (read-only)

```bash
npm run telegram:inspect
```

Reuses the stored session and prints the signed-in account plus every group,
supergroup, forum and channel in the chat list — title, Telegram id, entity type
and the public `@username` where there is one. Private chats with people are left
out.

It performs **no mutation of any kind**: no message, no join, no creation, no
change to any chat. Access hashes are never printed.

## Create the test forum

```bash
npm run telegram:create-test-forum -- --dry-run   # the default; changes nothing
npm run telegram:create-test-forum -- --apply     # asks for confirmation first
npm run telegram:create-test-forum -- --apply --yes
```

Three steps, on brand-new objects only:

1. create a private supergroup configured as a forum, titled `TSC 8042 Test`
2. create one forum topic titled `🧪 Тест`
3. send one message into **that topic**: `Тест автоматизації Telegram API`

A dry run prints those three lines and stops — it does not even open a
connection. `--apply` shows the same three lines, waits for you to type `yes`
(unless `--yes` is given), and only then connects. On success it prints the
forum id, the topic id and the message id.

### Telegram methods used

| Step | MTProto |
| --- | --- |
| inspection | `client.getDialogs()` (read-only) |
| forum | `channels.createChannel` with `megagroup: true, forum: true` |
| topic | `messages.createForumTopic` |
| message | `messages.sendMessage` |

A forum topic is addressed through `reply_to`:

```ts
replyTo: new Api.InputReplyToMessage({
  replyToMsgId: topicId, // the topic's own service message
  topMsgId: topicId,     // the topic the message belongs to
})
```

so the message lands inside the topic rather than in the forum's General.
That construction lives in `src/telegram/client.ts`; everything above it just
calls `sendMessageToTopic(forum, topicId, text)`.

### Safeguards

- **Dry run is the default.** Only `--apply` may mutate; `--yes` skips the
  confirmation prompt and nothing else — it cannot imply `--apply`.
- **Unknown flags are rejected** with exit code 2. A typo like `--aply` is an
  error, never a silent fall-through to the default.
- **No retries on creating calls.** The mutating run uses `requestRetries: 1`,
  and the three steps are a straight line with no loop and no `catch`: a failure
  stops everything after it. `channels.createChannel` carries no `random_id` for
  Telegram to deduplicate on, so a retry there could create a second group;
  `createForumTopic` and `sendMessage` do send a `random_id`.
- **No bulk work.** Exactly one group, one topic, one message.
- **Nothing existing is touched.** No user is added or invited, no private
  message is sent, no existing chat is modified.
- **Nothing sensitive is printed** — not the session, the `api_hash`, the login
  code, the 2FA password, the auth key, or any access hash. The access hash of
  the created group lives in a private field of `ForumRef`, whose `toString()`,
  `toJSON()` and `util.inspect` output all expose the id only, so even an
  accidental `console.log(ref)` cannot leak it.

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
- Writes are atomic: the session goes to a temporary `600` file in the same directory
  and is renamed over the destination only after the write succeeds. A failed or
  interrupted write leaves the previous session intact and removes the temporary file.
- Before a fresh authorization the storage location is probed (a throwaway file next
  to the session, never the session itself). If the session could not be saved, the
  login is not attempted at all — otherwise the account would end up with an
  authorized device whose session was lost.
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
| `npm run telegram:inspect` | Read-only: account + group/channel dialogs |
| `npm run telegram:create-test-forum` | Test forum; dry run unless `--apply` |
| `npm run typecheck` | `tsc --noEmit` over `src`, `scripts` and `test` |
| `npm test` | Node's built-in test runner (`test/*.test.ts`) |

Tests cover session file and directory permissions (including that a directory the
app does not own is left alone), atomic replacement and survival of a failed write,
the preflight that stops a login when the session could not be stored, the
malformed-session fallback, read failures being fatal, and configuration validation.

For this milestone they also cover: a dry run performing zero Telegram calls,
`--apply` invoking exactly the three expected creation steps in order, unknown
flags failing, a refused confirmation performing zero calls, a failed step
stopping every step after it with no retry, and the output containing no access
hash however a `ForumRef` is stringified.

They never open a network connection and need no credentials — the Telegram layer
is substituted by a recording fake. CI runs `npm ci`, `npm run typecheck` and
`npm test` on pushes and pull requests.
