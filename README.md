# tg

Telegram MTProto automation for a personal (user) account, built on
[GramJS](https://www.npmjs.com/package/telegram).

Current scope: **authentication only**. The script logs in, stores a local session
and verifies it with `getMe()`. It does not send messages or modify anything.

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
`.telegram/session` (file mode `600`). Later runs reuse that session and go straight
to `getMe()`.

The script prints only the account id, first name and username — never the API hash,
the session string, the login code or the 2FA password.

## Security

`.telegram/` and `.env` are git-ignored. The session file is an auth key: anyone who
has it can act as your Telegram account. Do not commit or share it. To revoke it,
terminate the session in Telegram → *Settings → Devices*, then delete `.telegram/`
and log in again.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run telegram:auth` | Interactive login / session check |
| `npm run typecheck` | `tsc --noEmit` |
