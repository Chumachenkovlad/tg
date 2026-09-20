# tg

Telegram MTProto automation for a personal (user) account, built on
[teleproto](https://www.npmjs.com/package/teleproto) (the maintained fork of GramJS).

Current scope:

1. **Authentication** — log in, store a local session, verify it with `getMe()`.
2. **Read-only inspection** — list the groups and channels the account is in.
3. **Desired-state reconciliation** — declare the forums, topics and managed
   messages that should exist; `telegram:plan` shows the difference and
   `telegram:apply` closes it.

What it currently manages: **ТСЦ 8042 — практичний іспит**, a private Telegram
forum for candidates taking the practical driving exam at service centre 8042.
Its structure and all of its Ukrainian copy live in
[`src/telegram/content/tsc8042.ts`](src/telegram/content/tsc8042.ts).

Reconciliation is convergent: applying an unchanged configuration a second
time sends no mutating request at all. Editing a title or a message text in
the configuration produces an in-place `UPDATE` of the existing resource, not
a second one. No user is ever added or invited, no private message is sent,
and nothing the state file does not know as managed is read into, written to,
modified or deleted.

Duplicate safety is conditional on the committed `telegram/managed-state.json`
being kept, and applies are serialized only per machine — see
[Known limitations](#known-limitations).

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
| `src/telegram/desired-state.ts` | **What should exist**, by stable key — shape, types and validation |
| `src/telegram/content/tsc8042.ts` | **The TSC 8042 community itself**: every title, description and message, in Ukrainian |
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

`src/telegram/desired-state.ts` holds the shape, the types and the validation.
The configuration itself — the TSC 8042 community — lives in
`src/telegram/content/tsc8042.ts`, so long Telegram copy never ends up in the
client or the reconciler:

```ts
{
  key: "tsc8042",
  title: "ТСЦ 8042 — практичний іспит",
  description: "Неофіційна спільнота кандидатів у водії ТСЦ 8042. …",
  topics: [
    { key: "rules",        title: "📌 Правила та навігація", messages: [{ key: "intro", text: "…" }] },
    { key: "registration", title: "🎫 Реєстрація на іспит",  messages: [{ key: "intro", text: "…" }] },
    // … 14 topics, each with one managed `intro` message
  ],
}
```

Every resource is identified by its **stable key**, never by its title. Keys
are lowercase ASCII slugs (`rules`, `difficult-places`, `exam-reports`);
titles carry the emoji and the wording and may be rewritten freely. Renaming
one must not make the reconciler think it is looking at a different resource,
and it does not.

All user-facing Telegram content is Ukrainian. Only the keys are English, and
only because they are machine names.

### What is configured

One private forum, `tsc8042` — "ТСЦ 8042 — практичний іспит" — for candidates
taking the practical driving exam at service centre 8042, with fourteen topics
and one managed `intro` message in each:

| Key | Title |
| --- | --- |
| `rules` | 📌 Правила та навігація |
| `announcements` | 📢 Оголошення |
| `registration` | 🎫 Реєстрація на іспит |
| `routes` | 🗺 Маршрути 8042 |
| `difficult-places` | 🚧 Складні місця маршрутів |
| `exam-reports` | 📝 Звіти з іспитів |
| `successful-exams` | ✅ Успішні іспити |
| `mistakes` | ⚠️ Помилки та втручання |
| `examiners` | 👮 Екзаменатори — досвід |
| `appeals` | ⚖️ Оскарження |
| `recordings` | 🎥 Відеозаписи іспиту |
| `statistics` | 📊 Статистика |
| `general` | 💬 Загальні питання |
| `moderation` | 🚨 Модерація / шахрайство |

The group is private: `channels.createChannel` is called without a username,
so nothing is public, and no user is ever invited or added by this project.

Topic order in the file is the order they are created in on a first apply. It
is not enforced afterwards — Telegram sorts a forum's topic list by activity,
and nothing here reorders topics.

### Plan

```bash
npm run telegram:plan
```

Read-only. It connects, reads the committed mapping, **verifies every id in
it against Telegram** — including the title, description and text each
resource currently has — compares that with the desired state and prints the
plan. It sends no request that could change anything, and takes no lock.

```
  CREATE forum   tsc8042                     (not created yet)
  CREATE topic   tsc8042/rules               (the forum is being created)
  CREATE message tsc8042/rules/intro         (the forum is being created)
  CREATE topic   tsc8042/announcements       (the forum is being created)
  CREATE message tsc8042/announcements/intro (the forum is being created)
  …

Plan: 29 to create, 0 to update, 0 to delete, 0 unchanged.
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
  NOOP   forum   tsc8042              (exists as 2000000042, title and description match)
  NOOP   topic   tsc8042/rules        (exists as 100, title matches)
  NOOP   message tsc8042/rules/intro  (exists as 101, text matches)
  …

Already up to date. Nothing to do.
```

No confirmation is asked for in that case — there is nothing to confirm.

### Editing the configuration

**Edit the text, keep the key.** Change a title, a description or a message
body in `src/telegram/content/tsc8042.ts` and the next plan is an `UPDATE` of
the resource that already exists — never a second one:

```
  UPDATE forum   tsc8042              (description is "Неофіційна спільнота…", should be "…")
  UPDATE topic   tsc8042/routes       (title is "🗺 Маршрути 8042", should be "🗺 Маршрути ТСЦ 8042")
  UPDATE message tsc8042/routes/intro (text is "Тут збираємо…", should be "…")
  NOOP   topic   tsc8042/rules        (exists as 100, title matches)
```

Applying it edits the description, renames the topic and rewrites the message
**in place**: `channels.editTitle`, `messages.editChatAbout`,
`messages.editForumTopic` and `messages.editMessage`. The channel id, the
topic id and the message id are all unchanged, so no new group, topic or
message appears, the mapping in `telegram/managed-state.json` does not move,
and the run after it is all `NOOP` again.

This is what makes the two commands safe to re-run: identity is the recorded
Telegram id, so **a changed title is an edit of an existing resource, not a
duplicate of it**. The only thing that produces a `CREATE` for a key that was
already applied is the resource genuinely being gone from Telegram.

A forum has two editable attributes, and each is a separate Telegram method,
so the plan carries one `UPDATE` per attribute that actually differs — change
only the description and only `messages.editChatAbout` is sent.

Adding a new topic or a new managed message is a `CREATE` for that key alone;
everything already applied stays `NOOP`.

The comparison is against what Telegram currently holds, not against anything
remembered locally: rename a topic by hand in the Telegram app and the next
plan offers to put the configured title back.

Removing a topic from the configuration currently plans nothing at all — see
[Planner actions](#planner-actions).

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

**The lock is machine-local.** It is a file on one filesystem, so it
serializes applies on one machine only. Two Codespaces, two CI runners, or a
laptop and a container running `telegram:apply` at the same time each take
their own lock and neither sees the other — and both would plan from the same
committed mapping and both create the forum. Nothing here prevents that; only
a lock held somewhere both can reach would, and this PR does not add one.
Until then, applying from one place at a time is a convention, not something
the code enforces. Both commands print this alongside the durability
warning.

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

The error says to **restore the file from git**
(`git checkout -- telegram/managed-state.json`, or take it from an earlier
commit) or repair it by hand. It never suggests deleting it: the file may be
the only record that live Telegram chats belong to this project, and deleting
it does not clean anything up — it orphans those chats and makes the next
apply build a second set beside them.

The shape differs from the sketch in the milestone brief in one way: forums
are a map keyed by forum key rather than a single `forum` object with a `key`
field. Same nesting, but the key cannot drift out of sync with its position,
and a second forum is a config change rather than a format change.

### Planner actions

`NOOP`, `CREATE`, `UPDATE`, `DELETE`. This iteration plans the first three.
`DELETE` is declared in the action union and handled explicitly in the
executor, where it refuses to run, so adding it is a contained change.

A forum `UPDATE` names the single attribute it changes (`title` or
`description`), because each one is a different Telegram method. A topic or
message `UPDATE` has only one attribute to change.

A resource dropped from the desired state is **not** planned for deletion, and
a chat the state does not record as managed is never looked at — not even one
that happens to carry the configured title. Destructive reconciliation
(`rebuild-managed`) comes separately.

### Telegram methods used

| Step | MTProto |
| --- | --- |
| inspection | `client.getDialogs()` (read-only) |
| resolve a recorded forum + its title | `client.getDialogs()` (read-only) |
| its current description | `channels.getFullChannel` (read-only, only for the forum that matched) |
| do these topics exist, and their titles | `messages.getForumTopicsByID` (read-only) |
| do these messages exist, and their text | `channels.getMessages` (read-only) |
| create forum | `channels.createChannel` with `megagroup: true, forum: true` and `about` |
| create topic | `messages.createForumTopic` |
| send message | `messages.sendMessage` |
| rename forum | `channels.editTitle` |
| rewrite the forum description | `messages.editChatAbout` |
| rename topic | `messages.editForumTopic` |
| edit message | `messages.editMessage` |

The description goes out with `channels.createChannel` rather than as a
follow-up edit, so a freshly created group never sits there with the wrong
"about" text because a second request failed. There is no `channels.editAbout`
in the schema: editing one afterwards is `messages.editChatAbout`, which takes
a `peer`, not a `channel`.

#### InputPeer vs. InputChannel

`messages.*` takes `peer:InputPeer`; `channels.*` takes `channel:InputChannel`.
The two carry the same channel id and access hash but are different
constructors on the wire, so handing a `channels.*` method an
`InputPeerChannel` produces a malformed request. The library types both
parameters as the loose `TypeEntityLike`, which means the compiler will not
catch the mistake.

A `ForumRef` therefore carries the raw ids and nothing else, and
`src/telegram/client.ts` keeps two helpers that wrap them per call site:

```ts
peerOf(forum)    // -> Api.InputPeerChannel, for messages.*
channelOf(forum) // -> Api.InputChannel,     for channels.*
```

A test drives every call that takes a forum reference, captures the request
objects and asserts each one got the constructor its TL line specifies.

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
- **The mapping is proved writable before the first creating call.** A plan
  that creates anything runs `ensureWritable()` first, which writes a
  throwaway probe file next to the state file — never over it. If the state
  could not be saved, zero Telegram mutations are attempted: a forum created
  against a read-only checkout would exist with nothing owning it, and the
  next run would build a second one.
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

### Known limitations

Duplicate safety is **conditional on `telegram/managed-state.json` being kept
and committed**. There is no recovery of ownership from Telegram yet: nothing
inspects the account and works out which existing chats correspond to which
keys. If the file is lost — not committed after an apply, or gone with the
machine or Codespace that ran it — the next apply will create a second forum.
Both commands print this warning. Whether the mapping should become
recoverable from Telegram, or be persisted somewhere else as well, is an open
decision.

**Applies are serialized per machine only.** The lock is a local file; two
Codespaces or CI runners applying at the same time do not see each other's
lock, would plan from the same committed mapping and would each create the
forum. Apply from one place at a time until a shared lock exists.
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

The engine tests run against a small neutral fixture, not against the real
community configuration, so rewording a paragraph of Ukrainian copy cannot
break a test about action ordering. `test/desired-state.test.ts` covers the
shipped configuration itself: unique topic keys, keys that are lowercase ASCII
slugs carrying no emoji or display wording, non-empty and distinct titles,
exactly one `intro` per topic with unique message keys, text that is non-empty,
Ukrainian and inside Telegram's 4096-character limit, and no leftover of the
old test forum. `test/reconcile.test.ts` then drives the real configuration end
to end: 29 creates, convergence on the second run, a reworded title,
description and intro reconciling as four in-place `UPDATE`s that move no id,
and a description-only change sending nothing but `setForumDescription`.

For reconciliation they also cover: a first run planning three creates; a second
run against the applied state planning zero mutations, repeatedly and with no
duplicate group, topic or message; a changed forum title, forum description,
topic title and message text each planning exactly one `UPDATE` and zero
`CREATE`, editing the existing id, leaving every id unchanged and converging to
all-`NOOP` afterwards; a stale topic mapping and a stale message mapping each being
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
