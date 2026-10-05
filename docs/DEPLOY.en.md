# Deployment guide (English outline)

> **中文完整版**: [DEPLOY.md](DEPLOY.md)
>
> This file is a **section-level outline**: every heading of the Chinese deployment guide with a
> one-line English summary. Config snippets, commands and troubleshooting details live in the
> Chinese file — paths, variable names and commands are identical in both.

## Deployment modes

- **Two compose layouts** — a single-container layout (chatz only) and a reverse-proxy layout
  (a parent compose with nginx/caddy/traefik + chatz)

## Environment variables

- **`TRUST_PROXY` — the only variable that depends on your layout.** Use `auto` (trusts
  loopback/private-network proxies, ignores XFF from the public internet), `1` (hop count, only
  if 20010 is unreachable from the internet), or an explicit IP. Getting this wrong makes rate
  limiting and audit log every user as the proxy's address
- ⚠️ `VAR=x docker compose up -d` does **not** work (that prefix only feeds compose
  interpolation). Change `.env` and run `up -d`, or use an override file
- **Master key (`AUTH_TOKEN`)** — leave it unset and the setup page generates one into the
  database. To pin one headlessly, prefer `AUTH_TOKEN_FILE=/run/secrets/chatz_auth_token`
  (only a path appears in the environment) over `AUTH_TOKEN=<plaintext>` (the value shows up in
  `docker inspect`, `docker compose config`, dashboards and monitoring).
  🔴 If the file is missing or empty the server **refuses to start** instead of silently
  reusing an old key. On every boot the effective key is synced into `meta.auth_token`, so
  removing the variable later does **not** change the key

## Mode 1: expose the port directly

- Publish `20010` and let clients connect straight to it; simplest, no TLS by default

## Mode 2: built-in HTTPS

- **Steps** — upload the certificate in the UI (Settings → HTTPS certificate)
- **Mapping 20443 to 443**
- **Certificate sources** — own cert, or certbot
- **Validation on upload** — leaf + chain checks; an incomplete chain is reported
- **Pros and cons** — no extra container, but certificate management lives in the app

## Mode 3: Nginx reverse proxy

- **Topology** — nginx terminates TLS, forwards to `chatz:20010` on a shared Docker network
- **Directory layout**
- **`docker-compose.yml`**
- **`nginx/conf.d/chatz.conf`**
- **Client IP and `TRUST_PROXY` (read this)** — `auto` vs `1` vs explicit IP, and why
- **`nginx/nginx.conf`**
- **Placing the certificate**
- **Let's Encrypt auto-renewal**
- **Start-up**

## Mode 4: Caddy reverse proxy

- **`docker-compose.yml`** / **`Caddyfile`** / **Start-up** — automatic TLS, least configuration

## Mode 5: Traefik reverse proxy

- **`docker-compose.yml`** / **`traefik.yml`** / **Prepare `acme.json`** / **Start-up**

## Backup & restore

- **What to back up** — the whole `data/` directory (SQLite + icons + attachments + certs)
- **One-command backup** — stop-or-hot copy; keep the last 7 copies
- **Safely backing up the database** — use `sqlite3 .backup` (or `VACUUM INTO`) rather than
  copying a live WAL file
- **Restore** — stop, replace `data/`, start, verify

## Logs & monitoring

- **What the startup log prints** — whether `AUTH_TOKEN` is printed in full, and how to recover
  it (env value, DB `meta` row, or the "Default token" row in the UI)
- **Viewing logs** — live tail, last N lines, errors only, export to a file
- **Docker log rotation**
- **Health check** — the container pings `/health`
- **Monitoring Chatz itself with Uptime Kuma**

## Updating & rolling back

- **Updating code** — `docker compose pull && docker compose up -d` (image deploys);
  `restart` alone does nothing
- **Database migrations** — applied on startup by `src/migrate.js`; the log shows what ran
- **Rollback** — use the `sha-xxxx` image tag. Relying on `latest` makes rollback a coin flip

## Day-to-day commands

- Start / stop / rebuild / open a SQL shell — all against `192.168.2.100` in this setup

## FAQ

- Port already in use
- Compose refuses to start: `env file not found` (use `required: false`, or ship an empty `.env`)
- HTTPS upload fails
- WebSocket will not connect
- Removing `AUTH_TOKEN` from `.env` (or switching to `AUTH_TOKEN_FILE`) — the key does not change
- Data loss
- High memory usage
- Forgot the `AUTH_TOKEN`
- No "database migration" line in the startup log — is that normal?
- `shutdown` and `startup` interleaved in the log — did startup fail?
- Forgot a user's password (CLI escape hatch: `node src/reset-password.js`)
- "Wrong username or password" — how to debug
- The web UI suddenly says the session expired and bounces to the login page
- After redeploy `AUTH_TOKEN` changed / accounts cannot sign in
- Phone not receiving notifications (usually the foreground service was killed by battery
  optimisation — messages arrive over a WebSocket, not FCM)
- Message sent but not received
- How to migrate the database
- How to send a message with an image
- How to turn off aggregation
- A newly registered account cannot see other people's channels
- Are attachments kept forever?

## Hardening

- Put 20010 behind a proxy, set `TRUST_PROXY`, enable HTTPS, rotate the master key, remember that
  registration is **open to everyone**

## Production checklist

- A short go-live checklist mirroring the hardening section

## Local development

- Run `node src/index.js` directly without Docker (needs `better-sqlite3` built locally)

## See also

- [API reference](API.md) · [Routing rules](ROUTES.en.md) · [Template syntax](TEMPLATE.en.md) ·
  [Release process](RELEASE.en.md)
