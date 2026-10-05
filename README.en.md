# Chatz

> **中文**: [README.md](README.md) ｜ Docs in English: [docs/](docs/)

A self-hosted **notification routing hub**. Webhook in, routing rules decide, channels deliver,
and state stays in sync across every client in real time.

```text
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  GitHub ─┐                                               │
│  Uptime ─┼──▶ Webhook ──▶ Routing ──▶ Channel ──▶ Web / Android
│  Grafana ┘   (template)  (cond+act)  (subscribe) (realtime)│
│                                                          │
└──────────────────────────────────────────────────────────┘
```

## Features

| Feature | Notes |
|---|---|
| **Multi-user** | Username + password sign-in; one login token per user (reused across sessions, replaceable at will) |
| **Channels** | Apps post into channels, users subscribe to channels; a channel can be shared by many people; channel names may duplicate (ID disambiguates) |
| **Channel password** | A channel can require a password to subscribe (creator / super admin are exempt); discovery supports search by name or ID |
| **Apps & rules are per-user** | Everyone manages their own apps and routing rules and cannot see other people's (**admins included**); a rule only applies to its owner's messages |
| **State sync** | Read / unread / archived / deleted all sync across clients in real time (WebSocket broadcast) |
| **Webhook + templates** | Accepts third parties (GitHub, Uptime Kuma, Grafana…) and renders Mustache-style templates into readable notifications |
| **Routing engine** | 11 conditions × 8 actions: change priority, add tags, silence, forward, drop, call back |
| **Aggregation** | Messages that share channel + app + title within 5 minutes collapse into one (a single card lives at most 30 minutes so it cannot renew forever — see `AGG_MAX_LIFETIME_MS`; the parent card shows no cover image, images live in the expanded children) |
| **Attachments** | Images / files upload to `/attachments/` and are referenced from the body or `extras`; deleting a message reclaims them |
| **Custom background** | Each user uploads their own background image; the accent color is sampled from it |
| **Built-in HTTPS** | Upload a certificate to enable WSS, hot-reload supported |
| **Bilingual UI** | The web UI speaks Chinese and English; it follows the browser language and the sidebar "EN / 中" button switches at any time (dictionary: `public/i18n.js`) |
| **Audit log** | Sign-in, sign-up, rule changes, message deletion and other key actions are recorded; admins can query them |
| **Android compatible** | Keeps the Gotify wire protocol, so existing clients work out of the box |

### Three roles

| role | Name | Can do |
|---|---|---|
| 0 | User | Their own subscribed channels + **manage their own apps and routing rules** |
| 1 | Admin | Same as above (apps / rules are per-user, admins have **no** global privilege); cannot see private channels they are not subscribed to |
| 2 | Super admin | Certificates / audit / channel management + **promote others** + **admin page** shows everything site-wide (the everyday UI still only shows their own) |

> 📌 Since 2026-10-01: **apps and routing rules are isolated per user**. Every signed-in user can
> create their own apps and rules, but only sees the ones they created (admins cannot see other
> people's either). A rule **only applies to its owner's messages**.
> To see who created what site-wide, use the sidebar "Admin" page (`GET /admin/*`).

The first account created is the **super admin** (existing instances are migrated from `is_admin`
on upgrade). To grant someone privileges, go to "Account → Users" and change their role.

### ⚠️ Private for whom?

`is_public = false` applies to **everyone** — nobody can see or subscribe to someone else's
private channel, **not even the super admin** (narrowed on 2026-10-01).

The super admin used to be "all-seeing": they could list every channel and read any channel's
messages. The cost was a drawer stuffed with other people's channels plus a stream of update
events for them (battery drain, noise). That ability has been taken back:

- **Everyday endpoints are subscription-based**: `GET /channel`, `GET /channel/:id`,
  `GET /message`, `GET /message/search`, `GET /message/deleted`, `POST /message/read-all`
  — the super admin sees exactly what anyone else does: only what they subscribed to.
- **Site-wide data moved to the admin page**: sidebar "Admin"
  (`GET /admin/channels|applications|routes`) lists all channels / apps / rules with their owners.
- Channel metadata broadcasts (`channelCreated/Updated/Deleted`) have long been narrowed to
  "subscribers ∪ creator"; the super admin no longer receives all of them.

The upside: the super admin's daily UI is finally quiet. The cost: you cannot inspect a user's
channel content directly when troubleshooting — use the admin page to list channels, or subscribe
to that channel temporarily.

**Do not hand out the super admin account to someone you do not fully trust.** If you want to
share operations work, grant "Admin": that role cannot touch other people's private channels and
cannot see their apps or rules.

## Quick start

### Requirements

- Docker 20+
- Docker Compose v2
- (optional) a domain name + SSL certificate

### Deploy: three ways, pick one

The shipped `docker-compose.yml` defaults to **option 1** (`image: ghcr.io/yezi8430/chatz:latest`,
with `build: .` commented out). Use option 2 only if you want to edit the source and build locally;
use option 3 if you would rather not touch compose at all.

#### Option 1: docker compose + the GHCR image (default, recommended)

Every push to the main branch makes GitHub Actions build and push
`ghcr.io/yezi8430/chatz` (image is `linux/amd64`).

```bash
git clone https://github.com/yezi8430/Chatz.git chatz
cd chatz
docker compose up -d
```

Upgrade (after a new release):

```bash
docker compose pull && docker compose up -d
```

No `--build` here — on this path there is no local build step at all.

#### Option 2: docker compose + local build (when editing the source)

First change `docker-compose.yml` (**keep only one** of `image` / `build`):

```yaml
services:
  chatz:
    # image: ghcr.io/yezi8430/chatz:latest   ← comment out
    build: .                                 ← uncomment
    container_name: chatz
    ...
```

Then:

```bash
docker compose up -d --build
```

After touching `src/` or `public/` you **must `--build` again**: both directories are `COPY`ed
into the image, so a plain `restart` has no effect (and hard-refresh the browser for the frontend).

> 🔴 **Never leave both enabled — that means options 1 and 2 are mutually exclusive.** With `image:`
> and `build:` present at the same time, the locally built image gets tagged
> `ghcr.io/yezi8430/chatz:latest` and shadows the remote one. From then on `docker compose pull`
> just prints `Skipped - No image to be pulled` (**no error**) — you think you are upgrading while
> actually running your own stale build.

#### Option 3: docker run (no compose, no clone)

When a single container is all you want:

```bash
docker run -d --name chatz \
  -p 20010:20010 \
  -p 20443:20443 \
  -v ./data:/app/data \
  -e TRUST_PROXY=auto \
  --restart unless-stopped \
  ghcr.io/yezi8430/chatz:latest

# confirm it is up
curl http://<your-server-IP>:20010/health   # → {"ok":true,...}
docker logs chatz --tail 30                 # or just read the startup log
```

> 🔑 **No need to fish the token out of the logs.** The full value is printed **only on the very
> first start**; every later start prints just an 8-char fingerprint (`· fingerprint kR9m2pQ…`).
> That is deliberate — a secret should not sit in `docker logs` forever. When you need it, go to
> "Account → Security & sessions → Devices" and copy the row named "Default token".

Four things to know:

- To **build from source**, run `docker build -t chatz .` first and replace the last line with `chatz`.
- ⚠️ `-v ./data:/app/data` is a **bind mount**, matching what compose does by default — `data/` *is*
  the database (accounts, tokens, messages), so tarring that directory is the whole backup. Do not
  switch to a named volume (`chatz-data:/app/data`); the backup steps in the deployment guide work
  on a directory.
- `docker run` has no `env_file`, so every variable must be passed with `-e`. The upside is that
  `environment:` precedence in compose does not apply; the cost is that **changing a variable means
  recreating the container**: `docker rm -f chatz`, then re-run the command above (`docker restart`
  cannot change `-e`). Same for upgrades — `docker pull ghcr.io/yezi8430/chatz:latest`, recreate,
  and the data directory survives.
- `20443` is the built-in HTTPS port (used once you upload a certificate); drop it if unused.

> Tag policy: the main branch produces `latest` + `sha-<short-sha>`; pushing a tag like `v1.2.3`
> additionally produces `1.2.3` / `1.2`. **Roll back using the `sha-xxxx` tag** — relying on
> `latest` alone makes rollback a coin flip.

Open `http://<your-server-IP>:20010/` → first-run setup → pick an admin username and password,
click "Create admin", and you are done. **No `docker logs`, no hunting for a token.**

> **`.env` is optional**: compose declares it `required: false`, so Compose silently skips a
> missing file — a fresh install only needs `clone` + `up`. Create it with `cp .env.example .env`
> when you want to override variables.
> ⚠️ Every line copied from the sample starts with `#` (i.e. inactive). To enable a variable,
> **delete the leading `#`** — a commented-out value is the same as not setting it, and nothing
> complains. Verify with `docker compose config | grep NAME`, and remember to run
> `docker compose up -d --force-recreate` afterwards (`restart` does not re-read `env_file`).
> ⚠️ That syntax requires Docker Compose **≥ 2.24.0**; on older versions just ship an empty `.env`.

Startup log of an already-settled instance:

```text
──────── 启动 2026-09-29 00:22:03 ────────
✅ Chatz 已启动，监听端口 20010
   数据目录: /app/data/app.db
   网页版: http://<主机>:20010/
   推送接口: http://<主机>:20010/hook/<应用Token>
   消息聚合窗口: 300000ms（单条最长寿命 1800000ms）
   🛡️  TRUST_PROXY=auto  →  只信任来自本机 / 内网的代理

🔑 AUTH_TOKEN 就绪 [环境变量] · 指纹 kR9mX2pQ…
   完整值见 .env 里的 AUTH_TOKEN
──────── 就绪 ────────
```

> The `TRUST_PROXY` line follows whatever you configured in compose / `.env`:
> `docker-compose.yml` hardcodes `TRUST_PROXY=auto`, so a factory-fresh instance looks like the
> block above. Only when it is **not configured at all** do you get
> `TRUST_PROXY=off → 限速 / 审计只认 TCP 对端地址` plus an extra reminder to fix it behind a proxy.

> The server also generates an `AUTH_TOKEN` (stored in the `meta` table) for Gotify clients and
> webhook clients. The web UI does not need it — when you do, open
> "Account → Security & sign-in → Devices" and copy the "Default token" row.
> For the full rules about when it is printed and how to recover it from the database, see
> [Deployment guide → "Startup log"](docs/DEPLOY.en.md).

#### Do I need `AUTH_TOKEN` in `.env`?

**No.** By default the master key lives in the database (the `meta` table of `data/app.db`),
generated by the setup page. `AUTH_TOKEN` in `.env` is only for headless / automated installs
where there is no browser to walk through setup.

When you do need to pin one, there are two forms:

| Form | What shows up in the environment | Notes |
|---|---|---|
| `AUTH_TOKEN_FILE=/run/secrets/chatz_auth_token` | a **path** only | ✅ preferred — keep the value in a mounted file (`chmod 600`), works with docker secrets / k8s secrets |
| `AUTH_TOKEN=cz.xxxx` | the **plaintext key** | ⚠️ `docker inspect`, `docker compose config`, dashboards and monitoring all display or collect env vars |

> 🔴 If the file pointed to by `AUTH_TOKEN_FILE` is missing or empty, the server **refuses to
> start** rather than silently falling back to the old key in the database.

Already using `AUTH_TOKEN` and want to drop it? **The value does not change** — on every boot the
server syncs the effective key into the database, so deleting the env var just switches the source
to `[数据库]` with the same key. See `.env.example` for the exact order of operations.

### Recommended after first sign-in

1. **Create channels**: sidebar "+ New channel", e.g. "Work", "Home", "Monitoring"
2. **Add a rule**: sidebar "Routing rules" → "Create from template" → pick "Uptime Kuma escalation"
3. **Wire up the webhook**: sidebar "Apps" → copy the webhook URL, shaped like
   `http://<IP>:20010/hook/<app-token>`
4. **Connect third parties**:
   - Uptime Kuma: notification settings → Webhook → paste the URL above
   - GitHub: repo Settings → Webhooks → paste into Payload URL
   - Grafana: Alerting → Contact points → Webhook

### UI at a glance

```text
┌─────────────┬──────────────────────────────────────────┐
│  Chatz      │  Inbox  Unread  Archived    🔍   Send     │
├─────────────┼──────────────────────────────────────────┤
│ + New chan. │  ● CPU alert            ×5   6h ago       │
│ Discover    │    CPU 95%                                │
│ Apps        │    [default channel] priority 9  #urgent  │
│ Rules       │                                          │
│ Mark all rd │  ● Disk alert                40m ago      │
│             │    Disk 90%, 1st time, path /data1        │
│ 📬 All chan │                                          │
│ # default   │  ● Webhook alert            1h ago        │
│ # work      │    hook, 1st time                         │
│             │                                          │
│ [B] bob     │                                          │
│    ●online   │                                          │
└─────────────┴──────────────────────────────────────────┘
```

## Send a message

`<app-token>` comes from the web UI: sidebar "Apps" → copy webhook URL, or call
`GET /application`.

```bash
# Minimal
curl -d "服务器挂了" http://<host>:20010/hook/<app-token>

# With title, priority, channel
curl -d "CPU 95%" "http://<host>:20010/hook/<app-token>?priority=9&title=紧急&channel_id=1"

# Silent (no notification popup)
curl -d "心跳正常" "http://<host>:20010/hook/<app-token>?silent=true"

# Form style (qBittorrent and friends use curl -F; safer than JSON when filenames
# contain spaces or quotes)
curl -F "title=下载完成" -F "message=xxx.mkv" -F "priority=5" \
  http://<host>:20010/hook/<app-token>

# JSON (legacy form)
curl -H "Content-Type: application/json" \
  -d '{"message":"hello","priority":5}' \
  http://<host>:20010/hook/<app-token>
```

Calling from a program uses the API instead (needs a login token):

```bash
curl -X POST http://<host>:20010/message \
  -H "Authorization: Bearer <auth-token>" \
  -H "Content-Type: application/json" \
  -d '{"title":"标题","message":"内容","priority":5}'
```

Full parameters, response fields and the WebSocket protocol live in the
[API reference](docs/API.en.md).

## Common setups

| Scenario | How |
|---|---|
| **Server monitoring** | Uptime Kuma → Webhook → Chatz. Add a rule "priority ≥ 8 also forwards to the ops channel" |
| **GitHub events** | Repo Settings → Webhooks → Chatz, plus a template (see [template syntax](docs/TEMPLATE.en.md)) |
| **Family sharing** | One account per person + one "Family" channel; fridge / NAS / Raspberry Pi alerts all land there |
| **Quiet hours** | Pick the "night-silent" template: 23:00–07:00, priority ≤ 7 becomes silent |

## Clients

**Web** — open `http://<host>:20010/` and sign in with username/password or a token.

**Android, option A: the official Gotify client**

1. Install Gotify for Android
2. Server URL: `http://<host>:20010`
3. Client Token: `AUTH_TOKEN` from `.env`, or the user's device token
4. Tap "Test" → it should succeed

**Android, option B: your own client** — implement the WebSocket protocol documented in
[docs/API.md](docs/API.md).

**Command line** — the `curl` calls in "Send a message" above.

## Layout

```text
chatz/
├── Dockerfile
├── docker-compose.yml
├── .dockerignore             # COPY ignores .gitignore — keeps *.bak and data/ out of the image
├── package.json
├── .env.example              # sample env file → cp to .env
├── .env                      # optional; read when present, starts fine when absent
├── .gitignore                # excludes .env and data/ — never commit keys or the database
├── src/
│   ├── index.js              # HTTP entry: static assets, apps, message list, audit
│   ├── db.js                 # SQLite bootstrap (v1 schema)
│   ├── migrate.js            # migrations + AUTH_TOKEN resolution + admin bootstrap
│   ├── ws.js                 # WebSocket broadcast
│   ├── auth.js               # auth (device token / AUTH_TOKEN)
│   ├── tokenGen.js           # token generator (app token / device token)
│   ├── channels.js           # channel API
│   ├── messages.js           # read / archive / search / unread-count API
│   ├── users.js              # user / device / avatar / nickname API
│   ├── routes-api.js         # routing rule API + built-in templates
│   ├── admin-api.js          # super-admin page API (/admin/*, read-only site-wide)
│   ├── routing.js            # routing engine (conditions + actions)
│   ├── template.js           # Mustache-style template engine
│   ├── hooks.js              # webhook entry (incl. multipart parsing)
│   ├── messageCreate.js      # unified creation: clean → route → aggregate → store → broadcast
│   ├── certs.js              # HTTPS certificate management
│   ├── background.js         # user background management
│   ├── attachments.js        # attachment upload + orphan cleanup
│   ├── rateLimit.js          # in-memory rate limiting (per instance, see file header)
│   ├── clientIp.js           # client IP resolution (shared by limiting and audit; see TRUST_PROXY)
│   ├── securityHeaders.js    # security headers + CSP
│   ├── sanitize.js           # image magic-number sniffing
│   ├── reset-password.js     # CLI password reset (escape hatch when you forget it)
│   └── audit.js              # audit log (write / throttle / trim)
├── public/                   # frontend (no build step)
│   ├── index.html
│   ├── boot.js               # first-paint script (external — CSP forbids inline scripts)
│   ├── app.js
│   └── style.css
├── docs/
│   ├── API.md
│   ├── TEMPLATE.md
│   ├── ROUTES.md
│   └── DEPLOY.md
└── data/                     # persisted directory (mounted into the container)
    ├── app.db                # SQLite database
    ├── icons/                # app icons
    ├── channel-icons/        # channel icons
    ├── user-avatars/         # user avatars
    ├── attachments/          # message attachments
    ├── background/           # user backgrounds
    │   └── user-1/
    └── certs/                # HTTPS certs (fullchain.pem / privkey.pem)
```

## Stack

- Backend: Node.js 20, Express 4, ws 8, better-sqlite3 11
- Database: SQLite (WAL mode, single file)
- Frontend: plain HTML + CSS + vanilla JS
- Container: Docker + Compose

No Redis, no Postgres, no message queue, no Kafka, no external dependencies.

## Docs

| Doc | Read it when |
|---|---|
| [API reference](docs/API.md) | scripting against the API, writing a client, looking up fields and error codes |
| [Template syntax](docs/TEMPLATE.md) | configuring webhook templates that render third-party JSON into readable notifications |
| [Routing rules](docs/ROUTES.md) | setting up "condition + action" for forwarding / silencing / reprioritizing / dropping |
| [Deployment guide](docs/DEPLOY.md) | going to production: reverse proxy, HTTPS, backup & restore, troubleshooting |

Frequently used entries in the deployment guide:

- [Environment variables](docs/DEPLOY.md#环境变量) — the full list, including how to set `TRUST_PROXY`
- [Startup log](docs/DEPLOY.md#启动日志都打印什么) — when the token is printed in full, how to recover it
- [Day-to-day commands](docs/DEPLOY.md#日常运维命令) — start / stop / rebuild / query the database
- [FAQ](docs/DEPLOY.md#常见问题) — troubleshooting
- [Hardening](docs/DEPLOY.md#安全加固) — what to do before going live
- [Local development](docs/DEPLOY.md#本地开发) — running without Docker

> These anchors point into the Chinese files. English versions:
> [RELEASE.en.md](docs/RELEASE.en.md) (complete),
> [ROUTES.en.md](docs/ROUTES.en.md) (complete),
> [TEMPLATE.en.md](docs/TEMPLATE.en.md) (complete),
> [API.en.md](docs/API.en.md) and [DEPLOY.en.md](docs/DEPLOY.en.md) (section outlines).

## License

**Server** and **Android client** are **[MIT](LICENSE)**:

> Copyright (c) 2026 yezi

Use, modify and redistribute freely (**including commercially and closed-source**); the only
requirement is **keeping the copyright notice and license text**. The software is provided
"as is", without warranty of any kind.

⚠️ **The Jellyfin plugin is not MIT.** It references `Jellyfin.Common` / `Jellyfin.Controller` /
`Jellyfin.Model`, all **GPL-2.0-or-later**, and a plugin loaded into the Jellyfin process may be
considered a GPL derivative ⇒ the plugin is licensed **GPL-2.0-or-later** separately
(see `LICENSE` in the plugin directory).

### Third party

- Runtime dependencies: `express`, `ws`, `better-sqlite3` — all MIT
- Frontend loads from CDN (**not vendored in this repo**):
  [DOMPurify](https://github.com/cure53/DOMPurify) 3.0.6 (MPL-2.0 or Apache-2.0, dual),
  [marked](https://github.com/markedjs/marked) 12.0.2 (MIT)
