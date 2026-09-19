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
time sends no mutating request at all. Editing a title or a message text in
the configuration produces an in-place `UPDATE` of the existing resource, not
a second one. No user is ever added or invited, no private message is sent,
and nothing the state file does not know as managed is read into, written to,
modified or deleted.

Duplicate safety is conditional on the committed `telegram/managed-state.json`
being kept — see [Known limitation](#known-limitation).

## Layout

The MTProto library is isolated behind a small wrapper, so library details do not
leak into the rest of the project:

| File | Role |
| --- | --- |
| `src/telegram/types.ts` | Library-agnostic types (`TelegramAccount`, `AuthPrompts`, `SessionStore`) |
| `src/telegram/forum-types.ts` | Library-agnostic forum types (`DialogSummary`, `ForumRef`, `ForumApi`) |
| `src/telegram/client.ts` | **The only module that imports `teleproto`** — connect / sign-in / `getMe` / dialogs / reads / creation / edits |
| `src/telegram/config.ts` | Environment configuration |
| `src/telegram/session-store.ts` | Session persistence on disk |
| `src/telegram/format-dialogs.ts` | Rendering for the inspection output |
| `src/telegram/desired-state.ts` | **What should exist**, by stable key |
| `src/telegram/managed-state.ts` | **What was created**: logical key → Telegram id, committed to git |
| `src/telegram/mutation-lock.ts` | Exclusive lock serializing applies |
| `src/telegram/planner.ts` | Compares the two against Telegram and produces the plan |
| `src/telegram/reconcile.ts` | Executes a plan and records ids as they are confirmed |
| `telegram/managed-state.json` | **The committed identity mapping** |
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

Read-only. It connects, reads the committed mapping, **verifies every id in
it against Telegram** — including the title and text each resource currently
has — compares that with the desired state and prints the plan. It sends no
request that could change anything, and takes no lock.

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
  NOOP   forum   tsc8042             (exists as 2000000042, title matches)
  NOOP   topic   tsc8042/test        (exists as 100, title matches)
  NOOP   message tsc8042/test/intro  (exists as 101, text matches)

Already up to date. Nothing to do.
```

No confirmation is asked for in that case — there is nothing to confirm.

### Editing the configuration

Change a title or a message text, keep the key, and the next plan is an
`UPDATE` of the resource that already exists:

```
  NOOP   forum   tsc8042             (exists as 2000000042, title matches)
  UPDATE topic   tsc8042/test        (title is "🧪 Тест", should be "🗺 Маршрути 8042")
  UPDATE message tsc8042/test/intro  (text is "v1", should be "v2")
```

Applying it renames the topic and edits the message **in place**. The channel
id, the topic id and the message id are unchanged, so the mapping does not
move and the run after it is all `NOOP` again.

The comparison is against what Telegram currently holds, not against anything
remembered locally: rename a topic by hand in the Telegram app and the next
plan offers to put the configured title back.

### Concurrency

`telegram:apply` takes an exclusive lock for its whole lifecycle — acquire,
load state, inspect Telegram, build the plan, confirm, apply, persist,
release. Planning inside the lock is the point: two applies that each planned
from an empty mapping would each create the forum, and the window between
reading the state and writing it is several round-trips wide.

The lock is a file created with `wx` (a single atomic syscall) at
`~/.tg-8042/apply.lock` — transient machine state, so it lives next to the
session and is never committed. A second apply fails with the holder's pid,
host and start time, and whether that process still looks alive:

```
Another apply is already running: /home/you/.tg-8042/apply.lock exists.
Held by pid 4711 on box, since 2026-09-19T10:04:00.000Z (that process is
still running). Refusing to reconcile concurrently …
```

It does not expire on its own. A dead holder and a slow one look identical
from the outside, and guessing wrong means a duplicate group — so a stale
lock is reported and left for you to delete.

On top of the lock, the executor runs against the exact mapping snapshot the
approved plan was computed from, and refuses if the stored mapping no longer
matches it. That closes the time-of-check-to-time-of-use gap directly rather
than relying only on the lock.

`telegram:plan` is read-only and takes no lock.

### The state file: identity in git, truth in Telegram

The mapping lives in the repository at `telegram/managed-state.json` **and is
committed**:

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

It is deployment identity metadata, which is why it belongs in git: a fresh
clone — or a new Codespace — then knows which chats are already ours. A
machine-local file would not survive that, and losing it means the next apply
creates duplicates.

**Commit and push it after every apply.** The apply prints a reminder. An
apply whose result is never committed has created chats that nothing records
as owned.

It contains only: the schema version, logical keys, the channel id, topic ids
and managed message ids. It contains **no** api id or hash, no session or auth
key, no access hash, no login or 2FA data, no phone number, no invite link and
no personal data — which is what makes committing it safe. A test asserts the
committed file is free of all of those, and another asserts it is not
git-ignored.

**The access hash is deliberately not persisted.** It is resolved from
Telegram on every run from the stored channel id, by looking the channel up in
the chat list. That keeps a credential out of the repository, and doubles as
the existence check.

The file records only "the resource with key X was created as id Y". Whether Y
still exists, and what it currently says, are questions only Telegram can
answer, and the planner asks every run: delete the topic by hand and the next
plan says `CREATE topic … (recorded topic 123 no longer exists in Telegram)`.
Delete the group and the whole tree is planned again. After apply the mapping
is rewritten — dead ids are replaced, never kept alongside the new ones.

#### Missing vs. empty

- **Missing file** → initial bootstrap: a deployment that has never created
  anything. This is the one supported way to start from empty. The repository
  ships the file with no forums in it, so in practice it only happens before
  that file was first committed.
- **File that exists but is empty or whitespace-only** → `ManagedStateError`,
  and the run stops. A truncated write is not a clean slate, and reading it as
  one is precisely how a second forum gets built on top of the first.
- **File that exists but does not parse, or has the wrong shape** → the same
  hard error, for the same reason.

The shape differs from the sketch in the milestone brief in one way: forums
are a map keyed by forum key rather than a single `forum` object with a `key`
field. Same nesting, but the key cannot drift out of sync with its position,
and a second forum is a config change rather than a format change.

### Planner actions

`NOOP`, `CREATE`, `UPDATE`, `DELETE`. This iteration plans the first three.
`DELETE` is declared in the action union and handled explicitly in the
executor, where it refuses to run, so adding it is a contained change.

A resource dropped from the desired state is **not** planned for deletion, and
a chat the state does not record as managed is never looked at — not even one
that happens to carry the configured title. Destructive reconciliation
(`rebuild-managed`) comes separately.

### Telegram methods used

| Step | MTProto |
| --- | --- |
| inspection | `client.getDialogs()` (read-only) |
| resolve a recorded forum + its title | `client.getDialogs()` (read-only) |
| do these topics exist, and their titles | `messages.getForumTopicsByID` (read-only) |
| do these messages exist, and their text | `channels.getMessages` (read-only) |
| create forum | `channels.createChannel` with `megagroup: true, forum: true` |
| create topic | `messages.createForumTopic` |
| send message | `messages.sendMessage` |
| rename forum | `channels.editTitle` |
| rename topic | `messages.editForumTopic` |
| edit message | `messages.editMessage` |

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
- **Applies are serialized** by an exclusive lock held across the whole
  lifecycle, and the executor additionally refuses a plan whose base mapping
  has changed.
- **Unknown flags are rejected** with exit code 2. A typo like `--yse` is an
  error, never a silent fall-through to the default. `telegram:plan` rejects
  `--yes` outright: it has nothing to confirm.
- **Convergence, not idempotence by luck.** Identity is the recorded id,
  verified against Telegram; nothing is matched by title, so a second run
  cannot create a second anything, and a changed title is an edit rather than
  a new resource.
- **No retries on creating calls.** `apply` uses `requestRetries: 1`, and the
  executor has no loop and no `catch`: a failure stops the run.
  `channels.createChannel` carries no `random_id` for Telegram to deduplicate
  on, so a retry there could create a second group; `createForumTopic` and
  `sendMessage` do send a `random_id`.
- **Unmanaged entities are untouchable.** The executor acts only on planned
  actions, and the planner only ever names resources by key from the desired
  state, resolved through the recorded mapping.
- **A corrupt or truncated state file stops the run**, because treating it as
  empty would create duplicates.
- **Nothing sensitive is printed or persisted** — not the session, the
  `api_hash`, the login code, the 2FA password, the auth key, or any access
  hash. A forum's access hash lives in a private field of `ForumRef`, whose
  `toString()`, `toJSON()` and `util.inspect` output all expose the id only,
  so even an accidental `console.log(ref)` cannot leak it, and it never
  reaches the committed state file.

### Known limitation

Duplicate safety is **conditional on `telegram/managed-state.json` being kept
and committed**. There is no recovery of ownership from Telegram yet: nothing
inspects the account and works out which existing chats correspond to which
keys. If the file is lost — not committed after an apply, or gone with the
machine or Codespace that ran it — the next apply will create a second forum.
Both commands print this warning. Whether the mapping should become
recoverable from Telegram, or be persisted somewhere else as well, is an open
decision.
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
- The reconciliation state file is an ordinary `644` repository file, written
  atomically. It is committed on purpose and holds no credential — see
  [the state file](#the-state-file-identity-in-git-truth-in-telegram).
- `.env` is git-ignored, as is `.telegram/` in case you point
  `TELEGRAM_SESSION_PATH` inside the repository, and `apply.lock`.
  `telegram/managed-state.json` is deliberately **not** ignored.

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
duplicate group, topic or message; a changed forum title, topic title and
message text each planning exactly one `UPDATE` and zero `CREATE`, editing the
existing id, leaving every id unchanged and converging to all-`NOOP`
afterwards; a stale topic mapping and a stale message mapping each being
detected and recreated; a deleted forum putting the whole tree back; unmanaged
chats being ignored even when one carries the configured title; `plan` mutating
nothing, writing no state and taking no lock; a refused confirmation mutating
nothing; a second apply being refused while the first holds the lock, and the
lock being released on failure; a plan refusing to execute against a mapping
that changed after it was built; an existing empty or whitespace-only state
file being a hard error while a missing one bootstraps; the committed state
file parsing, carrying no secret and not being git-ignored; and — against the
real request object — the topic send setting `replyToMsgId` and **not**
`topMsgId`.

They never open a network connection and need no credentials: the Telegram layer
is substituted by an in-memory fake, and the two client-level tests stub `invoke`
to inspect the request that would have been sent. CI runs `npm ci`,
`npm run typecheck` and `npm test` on pushes and pull requests.
