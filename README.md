# tg

Telegram MTProto automation for a personal (user) account, built on
[teleproto](https://www.npmjs.com/package/teleproto) (the maintained fork of GramJS).

Current scope:

1. **Authentication** — log in, store a local session, verify it with `getMe()`.
2. **Read-only inspection** — list the groups and channels the account is in.
3. **Desired-state reconciliation** — declare the forums, topics and managed
   messages that should exist; `telegram:plan` shows the difference and
   `telegram:apply` closes it.

Reconciliation is convergent: applying an unchanged configuration a second
time sends no mutating request at all. No user is ever added or invited, no
private message is sent, and nothing the state file does not know as managed
is read into, written to, modified or deleted.

## Layout

The MTProto library is isolated behind a small wrapper, so library details do not
leak into the rest of the project:

| File | Role |
| --- | --- |
| `src/telegram/types.ts` | Library-agnostic types (`TelegramAccount`, `AuthPrompts`, `SessionStore`) |
| `src/telegram/forum-types.ts` | Library-agnostic forum types (`DialogSummary`, `ForumRef`, `ForumApi`) |
| `src/telegram/client.ts` | **The only module that imports `teleproto`** — connect / sign-in / `getMe` / dialogs / existence checks / creation |
| `src/telegram/config.ts` | Environment configuration |
| `src/telegram/session-store.ts` | Session persistence on disk |
| `src/telegram/format-dialogs.ts` | Rendering for the inspection output |
| `src/telegram/desired-state.ts` | **What should exist**, by stable key |
| `src/telegram/managed-state.ts` | **What was created**: logical key → Telegram id, persisted |
| `src/telegram/planner.ts` | Compares the two against Telegram and produces the plan |
| `src/telegram/reconcile.ts` | Executes a plan and records ids as they are confirmed |
| `src/cli/flags.ts` | Strict flag parsing — anything unrecognised is an error |
| `src/cli/reconcile-command.ts` | `plan` and `apply`, with their side effects injected |
| `scripts/telegram/auth.ts` | CLI: prompts + login flow |
| `scripts/telegram/inspect.ts` | CLI: read-only inspection |
| `scripts/telegram/reconcile.ts` | Wires the real client, prompt, console and state store |
| `scripts/telegram/plan.ts`, `apply.ts` | The two entry points |

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

## Desired state and reconciliation

What should exist is declared in `src/telegram/desired-state.ts`:

```ts
{
  forums: [{
    key: "tsc8042",
    title: "TSC 8042 Test",
    topics: [{
      key: "test",
      title: "🧪 Тест",
      messages: [{ key: "intro", text: "Тест автоматизації Telegram API" }],
    }],
  }],
}
```

Every resource is identified by its **stable key**, never by its title. Titles
and message text are content; renaming one must not make the reconciler think
it is looking at a different resource, and it does not.

### Plan

```bash
npm run telegram:plan
```

Read-only. It connects, reads the recorded mapping, **verifies every id in it
against Telegram**, compares the result with the desired state and prints the
plan. It sends no request that could change anything.

```
  CREATE forum   tsc8042             (not created yet)
  CREATE topic   tsc8042/test        (the forum is being created)
  CREATE message tsc8042/test/intro  (the forum is being created)

Plan: 3 to create, 0 to update, 0 to delete, 0 unchanged.
```

### Apply

```bash
npm run telegram:apply
npm run telegram:apply -- --yes
```

Builds the same plan, shows it, and — after you type `yes`, unless `--yes` is
given — executes exactly the actions in it. Each Telegram id is recorded and
persisted immediately after Telegram confirms that creation, so a failure
halfway through leaves the mapping describing exactly what exists.

Run it again with an unchanged configuration and everything comes out `NOOP`:

```
  NOOP   forum   tsc8042             (exists as 2000000042)
  NOOP   topic   tsc8042/test        (exists as 100)
  NOOP   message tsc8042/test/intro  (exists as 101)

Already up to date. Nothing to do.
```

No confirmation is asked for in that case — there is nothing to confirm.

### The state file is not the source of truth

The mapping lives at `~/.tg-8042/managed-state.json` (mode `600`, next to the
session, outside the repository and git-ignored):

```json
{
  "version": 1,
  "forums": {
    "tsc8042": {
      "id": "2000000042",
      "topics": { "test": { "topicId": 123, "messages": { "intro": 124 } } }
    }
  }
}
```

It records nothing but "the resource with key X was created as id Y". Whether
Y still exists is a question only Telegram can answer, and the planner asks it
every run: delete the topic by hand in the Telegram app and the next plan says
`CREATE topic … (recorded topic 123 no longer exists in Telegram)`. Delete the
group and the whole tree is planned again. After apply, the mapping is
rewritten — the dead ids are replaced, never kept alongside the new ones.

The file holds **no credentials**: no access hash, no session. A forum's access
hash is recovered from the chat list when its id is resolved, so losing this
file costs the mapping and nothing more. Losing it does mean the next run
believes nothing was created, which is why a corrupt or unreadable file is a
hard error rather than a silent fallback to "empty".

The shape differs from the sketch in the milestone brief in one way: forums are
a map keyed by forum key rather than a single `forum` object with a `key`
field. Same nesting, but the key cannot drift out of sync with its position,
and a second forum is a config change rather than a format change.

### Planner actions

`NOOP`, `CREATE`, `UPDATE`, `DELETE`. This iteration plans only `NOOP` and
`CREATE` — the test configuration needs nothing else. `UPDATE` and `DELETE`
are declared in the action union and handled explicitly in the executor, where
they throw "not implemented yet", so adding them is a contained change in the
planner and the executor rather than a hunt through the code.

A resource dropped from the desired state is **not** planned for deletion, and
a chat that the state does not record as managed is never looked at — not even
one that happens to carry the configured title. Destructive rebuild
(`rebuild-managed`) comes separately.

### Telegram methods used

| Step | MTProto |
| --- | --- |
| inspection | `client.getDialogs()` (read-only) |
| resolve a recorded forum | `client.getDialogs()` (read-only) |
| does a topic still exist | `messages.getForumTopicsByID` (read-only) |
| does a message still exist | `channels.getMessages` (read-only) |
| forum | `channels.createChannel` with `megagroup: true, forum: true` |
| topic | `messages.createForumTopic` |
| message | `messages.sendMessage` |

A new **top-level** message in a non-General forum topic is addressed with the
topic id in `replyToMsgId` and **no** `topMsgId`:

```ts
replyTo: new Api.InputReplyToMessage({ replyToMsgId: topicId })
```

`topMsgId` is for replying to another message *inside* a topic — there
`replyToMsgId` is that message and `topMsgId` is the topic containing it.
Setting both for a root message would claim it replies to the topic's own
service message within itself.

That construction lives in `src/telegram/client.ts`; everything above it just
calls `sendMessageToTopic(forum, topicId, text)`.

### Safeguards

- **`plan` cannot mutate.** It calls only read methods, and it does not write
  the state file either.
- **`apply` requires confirmation**, unless `--yes`. It asks only when the plan
  actually contains something to do.
- **Unknown flags are rejected** with exit code 2. A typo like `--yse` is an
  error, never a silent fall-through to the default. `telegram:plan` rejects
  `--yes` outright: it has nothing to confirm.
- **Convergence, not idempotence by luck.** Identity is the recorded id,
  verified against Telegram; nothing is matched by title, so a second run
  cannot create a second anything.
- **No retries on creating calls.** `apply` uses `requestRetries: 1`, and the
  executor has no loop and no `catch`: a failure stops the run.
  `channels.createChannel` carries no `random_id` for Telegram to deduplicate
  on, so a retry there could create a second group; `createForumTopic` and
  `sendMessage` do send a `random_id`.
- **Unmanaged entities are untouchable.** The executor acts only on planned
  actions, and the planner only ever names resources by key from the desired
  state, resolved through the recorded mapping.
- **A corrupt state file stops the run**, because treating it as empty would
  create duplicates.
- **Nothing sensitive is printed** — not the session, the `api_hash`, the login
  code, the 2FA password, the auth key, or any access hash. A forum's access
  hash lives in a private field of `ForumRef`, whose `toString()`, `toJSON()`
  and `util.inspect` output all expose the id only, so even an accidental
  `console.log(ref)` cannot leak it.
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
- The reconciliation state file gets the same treatment: `600`, atomic replace,
  and a directory the app does not own is never chmod-ed. It holds no
  credential, but it does map out which chats this project manages.
- `.env` is git-ignored, as are `.telegram/` and `managed-state.json` in case
  you point `TELEGRAM_SESSION_PATH` inside the repository.

The session file is an auth key: anyone who has it can act as your Telegram account.
Do not commit or share it. To revoke it, terminate the session in Telegram →
*Settings → Devices*, then delete `~/.tg-8042/` and log in again.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run telegram:auth` | Interactive login / session check |
| `npm run telegram:inspect` | Read-only: account + group/channel dialogs |
| `npm run telegram:plan` | Read-only: print the reconciliation plan |
| `npm run telegram:apply` | Execute the plan after confirmation (`--yes` to skip) |
| `npm run typecheck` | `tsc --noEmit` over `src`, `scripts` and `test` |
| `npm test` | Node's built-in test runner (`test/*.test.ts`) |

Tests cover session file and directory permissions (including that a directory the
app does not own is left alone), atomic replacement and survival of a failed write,
the preflight that stops a login when the session could not be stored, the
malformed-session fallback, read failures being fatal, and configuration validation.

For reconciliation they also cover: a first run planning three creates; a second
run against the applied state planning zero mutations, repeatedly and with no
duplicate group, topic or message; a stale topic mapping and a stale message
mapping each being detected and recreated; a deleted forum putting the whole
tree back; unmanaged chats being ignored even when one carries the configured
title; `plan` mutating nothing and writing no state; a refused confirmation
mutating nothing; a failed mutation recording only what really was created and
the next run resuming without a duplicate; `UPDATE`/`DELETE` refusing to run
rather than guessing; and — against the real request object — the topic send
setting `replyToMsgId` and **not** `topMsgId`.

They never open a network connection and need no credentials: the Telegram layer
is substituted by an in-memory fake, and the two client-level tests stub `invoke`
to inspect the request that would have been sent. CI runs `npm ci`,
`npm run typecheck` and `npm test` on pushes and pull requests.
