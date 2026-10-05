# Chatz API reference (English outline)

> **中文完整版**: [API.md](API.md)
>
> This file is a **section-level outline**: every heading of the Chinese API reference with a
> one-line English summary, so you can jump straight to the right section. Field tables,
> request/response bodies and error codes are still documented in the Chinese file — the
> identifiers (paths, JSON keys, header names) are identical in both, so you can read them
> as-is.

## Auth

Three credential types, all sent as `Authorization: Bearer <token>` or `X-Gotify-Key`:

| Credential | Format | Scope |
|---|---|---|
| Master key (`AUTH_TOKEN`) | `cz.` + 30 base62 chars | admin identity; set via `.env` or auto-generated into `meta.auth_token`. Kept compatible with existing clients |
| Device token | same format | issued per device at sign-up / setup / "add device"; **reused across logins** |
| App token | 10 base62 chars | only for `POST /hook/<app-token>`, no `Bearer` prefix |

> Every documentation example uses a placeholder like `cz.xxxxxxxx...`. Never commit a real key.

## Conventions

- **Error responses** — uniform `{ "error": "..." }` shape with HTTP status codes
- **Rate limiting** — in-memory, per instance, per IP; limits are noted next to each endpoint
- **Request body size** — attachments capped at 8 MB each / 500 MB total (413 / 507 on exceed)
- **Image type detection** — decided by magic number sniffing, never by the client-supplied
  extension or `Content-Type`

## 1. Basics

- `GET /health` (public) — liveness probe, used by the container healthcheck
- `GET /config` (public) — runtime flags the UI needs (HTTPS port, whether certs UI is on)
- `GET /version` (login) — server version

## 2. Users & devices

- `GET /setup/status` (public) — is this a fresh install?
- `POST /setup` (public, 20/h/IP) — claim the first admin account
- `POST /auth/register` (public, 3/h/IP) — registration is **open to everyone**
- `POST /auth/login` (public) — returns a device token for this user (reuses the existing one)
- `POST /auth/forgot-password` (public, 10/h/IP) — no SMTP: the reset link is written to the
  container log. Same response whether or not the email exists
- `GET /auth/reset-password/validate` (public) — check a reset token
- `POST /auth/reset-password` (public, 20/10min/IP) — complete the reset
- `GET /auth/me` (login) — current user
- `POST /auth/logout` (login) — keeps the token (returns `keptToken: true`)
- `GET /device` / `POST /device` / `DELETE /device/:id` (login) — list / add / delete devices
- `POST /device/rotate` (login, 20/h/IP) — replace the current token, old value dies at once
- `POST /user/avatar` / `DELETE /user/avatar` (login) — avatar upload / removal
- `PATCH /user/profile` / `PATCH /user/email` / `PATCH /user/username` / `PATCH /user/password`
  (login) — self-service account edits; changing the password does **not** ask for the old one
- `GET /user/list` (super admin) — all users
- `PATCH /user/:id/role` (super admin) — promote / demote; cannot change yourself, at least one
  super admin must remain

## 3. Channels

- `GET /channel` (login) — channels **you are subscribed to** (super admin included)
- `GET /channel/discover` (login) — public channels only
- `GET /channel/:id` (login) — one channel
- `POST /channel` (login) — create; the creator is auto-subscribed
- `PATCH /channel/:id` / `DELETE /channel/:id` (creator / super admin)
- `POST /channel/:id/icon` (creator / super admin)
- `POST|DELETE|PATCH /channel/:id/subscribe` (login) — subscribe, unsubscribe, mute

> `is_public = false` hides a channel from **everyone**, super admin included.

## 4. Messages

- `GET /message` (login) — incremental pull using an **id watermark** (`since=`)
- `GET /message/deleted` (login) — tombstones; watermark is `deleted_at` in **milliseconds** and
  uses a **composite cursor `(deleted_at, id)`** (a single cursor silently misses rows when a
  batch delete shares one timestamp)
- `POST /message` (login) — post a message
- `DELETE /message/:id` (subscriber / admin) — soft delete
- `GET /message/search` (login)
- `POST /message/:id/read` / `unread` / `read-all` (login) — per-user read state
- `POST /message/:id/archive` / `unarchive` (login)
- `GET /message/unread-counts` (login)

## 5. Applications

- `GET /application` (login) — **only your own apps**; the token is never returned in plaintext
- `POST /application` / `PATCH /application/:id` / `DELETE /application/:id` (login)
- `POST /application/:id/icon` (login)

## 6. Attachments

- `POST /attachment?name=xxx.png` (login, 10/min) — 8 MB per file, 500 MB total
- **Attachment reclamation** — orphaned files are cleaned up when a message is deleted. There is
  **no delete endpoint**; to clean up manually, `rm` the file inside the container

## 7. Webhook

- `POST /hook/:token` (public) — the app token goes in the **path**, not the `AUTH_TOKEN`
- **Query parameters** — `title`, `priority`, `channel_id`, `silent`, `tags`
- **Response & processing flow** — parse → template → route → aggregate → store → broadcast.
  ⚠️ validation failures are logged with `console.warn` and still return HTTP 200
- `POST /hook/preview` (public, 30/min) — render a template without storing anything

## 8. Routing rules

- `GET /route` / `POST /route` / `PATCH /route/:id` / `DELETE /route/:id` (login) — you only see
  your own rules
- `POST /route/test` (login) — dry run; only a `{name}` context exists, so `channel_id` and
  `app_id` never match here
- `GET /route/templates` (login) — built-in templates

## 9. HTTPS certificate

- `GET /certs/status` / `POST /certs/fullchain` / `POST /certs/privkey` / `DELETE /certs`
  (admin) — upload a cert to enable WSS, hot-reload

## 10. Background

- `GET /background` / `POST /background` / `DELETE /background` (login) — per-user background

## 11. Audit log

- `GET /audit` (admin) — sign-in, sign-up, rule changes, deletions, …

## 12. WebSocket

- **Connect** — `ws://<host>:20010/` with the token in the query string or subprotocol
- **Server push** — `message`, `messageAggregated`, `messageRead`, `messageArchived`,
  `channelCreated/Updated/Deleted`, `subscriptionChanged`, `userUpdated`
- **Client send** — mostly a keep-alive
- **Per-channel delivery** — broadcast goes to subscribers (admins always receive)
- **Heartbeat** — server pings, client should answer

> ⚠️ `messageDeleted` is intentionally **not** in the client event whitelist: deletions are
> reconciled through `GET /message/deleted`, not through the socket.

## 13. Static assets

- Served from `public/`, no auth. ⚠️ never leave `.bak` files there — they would be downloadable

## 14. Security headers

- CSP without `unsafe-inline` for scripts (hence `boot.js`), plus the usual hardening headers

## 15. Super-admin page (site-wide, read-only)

- `GET /admin/channels` / `GET /admin/applications` / `GET /admin/routes` (super admin) — lists
  everything with owner attribution. This is the **only** place with site-wide visibility

## Message fields

- **`extras` conventions** — `image` cover priority: `image` → `client::display.url` →
  `client::notification.bigImageUrl`. Only the URL is stored, never the image itself
- **Sender snapshot `extras.sender`** — frozen at send time
- **App snapshot `extras.app`** — frozen at send time

## Full examples

- **curl walkthrough** — register → list channels → create → send → pull → read
- **One-line webhook send**
- **Node.js WebSocket** client
- **Android / Kotlin** client
- **Third-party webhooks** — GitHub, Uptime Kuma, Grafana…

## Version

- Returns the running version; keep it in sync with `package.json`
