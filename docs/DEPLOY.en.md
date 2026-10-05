# Deployment guide (English)

> **Chinese**: [DEPLOY.md](DEPLOY.md) — the two files cover the same ground, section by section.
> Paths, variable names and commands are identical, so snippets transfer as-is.

From zero to production.

## Contents

- [Deployment modes](#deployment-modes)
- [Environment variables](#environment-variables)
- [Mode 1: expose the port directly](#mode-1-expose-the-port-directly)
- [Mode 2: built-in HTTPS](#mode-2-built-in-https)
- [Mode 3: Nginx reverse proxy](#mode-3-nginx-reverse-proxy)
- [Mode 4: Caddy reverse proxy](#mode-4-caddy-reverse-proxy)
- [Mode 5: Traefik reverse proxy](#mode-5-traefik-reverse-proxy)
- [Backup & restore](#backup--restore)
- [Logs & monitoring](#logs--monitoring)
- [Updating & rolling back](#updating--rolling-back)
- [Day-to-day commands](#day-to-day-commands)
- [FAQ](#faq)
- [Hardening](#hardening)
- [Production checklist](#production-checklist)
- [Local development](#local-development)

---

## Deployment modes

| Scenario | Recommended |
|---|---|
| Home / LAN, personal use | Mode 1 (expose the port directly) |
| Public internet with a domain | Mode 2 (built-in HTTPS) |
| You already run Nginx | Mode 3 (Nginx reverse proxy) |
| You already run Caddy | Mode 4 (Caddy reverse proxy) |
| You already run Traefik | Mode 5 (Traefik reverse proxy) |

### Two compose layouts

The `docker-compose.yml` shipped in the repo is the **single-container layout** (default
`image: ghcr.io/yezi8430/chatz:latest`, pulling a ready-made image; the `build: .` line is
commented out). It sits in the project root and covers modes 1 and 2.

Modes 3 / 4 / 5 need an extra proxy container, so they use a **parent-directory layout**: put the
Chatz project into a subdirectory and add a new `docker-compose.yml` in the parent (also using
`image:` by default). Examples below use `/root/chatz/` as the parent and `/root/chatz/chatz/` as
the project directory.

### Image mode vs local build (every command here is written for **image mode**)

| | Image mode (default, recommended) | Local build (only when you change the source) |
|---|---|---|
| in compose | `image: ghcr.io/yezi8430/chatz:latest` | `build: .` (`image:` must be commented out) |
| first start | `docker compose up -d` | `docker compose up -d --build` |
| upgrade | `docker compose pull && docker compose up -d` | `git pull && docker compose up -d --build` |

> 🔴 **Keep exactly one of `image:` and `build:`.** With both enabled, your local build gets tagged
> `ghcr.io/yezi8430/chatz:latest` and pushes the remote image out of the way; from then on
> `docker compose pull` just answers `Skipped - No image to be pulled` (**not an error**) — you
> think you are upgrading while actually re-running your own stale build.
> **Every start command in this guide is written for image mode** (no `--build`).

### No compose at all: plain `docker run`

If you want a single container and no compose file to maintain:

```bash
docker run -d --name chatz \
  -p 20010:20010 \
  -p 20443:20443 \
  -v /root/chatz/data:/app/data \
  -e TRUST_PROXY=auto \
  --restart unless-stopped \
  ghcr.io/yezi8430/chatz:latest
```

Three things to know:

- ⚠️ **Use a bind mount for `-v`, not a named volume.** `data/` *is* the database; the backup
  section below is written around **packing a directory** (`tar -czf ... data`). With a named
  volume none of those steps line up.
- ⚠️ `docker run` has **no `env_file`**, so every variable must be passed with `-e`. The upside is
  that compose's `environment:` precedence no longer applies; the downside is that changing a
  variable means recreating the container — `docker rm -f chatz` and re-run the command above
  (`docker restart` cannot change environment variables).
- Upgrading: `docker pull ghcr.io/yezi8430/chatz:latest && docker rm -f chatz`, then run it again.
  All data lives in `/root/chatz/data` and is not deleted.

> Pick one of the two layouts — do not run both, or the two compose projects will fight over the
> container name `chatz`.

---

## Environment variables

All optional; defaults apply when unset. Put them in `.env` (the file itself is optional too, see
the README).

| Variable | Default | Meaning |
|---|---|---|
| `AUTH_TOKEN` | generated and stored in the DB | Master key (also the super-admin login credential). Unset → the setup page generates a random value (`cz.` + 30 base62 chars, 33 total) and stores it, reusing it afterwards. ⚠️ The plaintext shows up in `docker inspect` / `docker compose config` |
| `AUTH_TOKEN_FILE` | none | ✅ **File** source for the master key. The value is a path inside the container, e.g. `/run/secrets/chatz_auth_token`, so only a path appears in the environment. Ranked below `AUTH_TOKEN`; 🔴 if the file is unreadable or empty the server **refuses to start** |
| `PORT` | `20010` | HTTP port |
| `HTTPS_PORT` | `20443` | HTTPS port (enabled once a certificate is uploaded) |
| `AGG_WINDOW_MS` | `300000` | Message aggregation window in ms, default 5 minutes; `0` disables aggregation |
| `AGG_MAX_LIFETIME_MS` | `1800000` | **Maximum lifetime** of a single aggregated message in ms, default 30 minutes, counted from its creation; `0` = unlimited |
| `DB_PATH` | `./data/app.db` | SQLite file path. The data directory is the directory containing that file |
| `CERTS_UI_ENABLED` | `true` | Set `false` to hide the "HTTPS certificate" panel in the web UI |
| `TRUST_PROXY` | off | Whether to trust `X-Forwarded-For` from a reverse proxy, see the next section |
| `HSTS_MAX_AGE` | `0` (not sent) | HSTS lifetime in seconds. The header is only sent when it is `> 0` and the request is HTTPS |
| `HSTS_INCLUDE_SUBDOMAINS` | `false` | Whether HSTS also carries `includeSubDomains` |
| `AUDIT_RETENTION_DAYS` | `90` | Audit log retention in days; `0` = no time-based trimming |
| `AUDIT_MAX_ROWS` | `50000` | Maximum number of audit rows; the oldest are deleted beyond that, `0` = unlimited |
| `ATTACHMENT_MAX_FILE_MB` | `8` | Per-attachment size cap. Attachments accept **any file type**, so this is the only single-file gate |
| `ATTACHMENT_MAX_TOTAL_MB` | `500` | Total size cap for the attachment directory; uploads beyond it return `507`. Orphaned attachments are only swept **at startup**, so this cap is the main protection against filling the disk |
| `LOG_LANG` | unset (the value in the database is used) | Language of the server log, `zh` / `en`. ⚠️ Setting it is a **hard override** — switching in the web UI cannot move it (see [Log language](#log-language-one-setting-for-the-whole-instance)) |

> ⚠️ **Precedence trap**: inside the same service, `environment:` outranks `env_file:`.
> `docker-compose.yml` hard-codes `PORT`, `HTTPS_PORT` and `TRUST_PROXY` in its `environment:`
> block, so setting those three in `.env` has **no effect** — silently, without any error. To make
> them overridable from `.env`, first convert compose to interpolation, e.g.
> `TRUST_PROXY: ${TRUST_PROXY:-auto}`.

> ⚠️ **The opposite trap (hit for real on 2026-10-01)**: a **command-line prefix** such as
> `AGG_WINDOW_MS=1000 docker compose up -d chatz` does **not** reach the container. That prefix
> only feeds compose's **variable interpolation** (the `${...}` form above), and the
> `environment:` block of `docker-compose.yml` does not contain this key — the other variables get
> into the container through `env_file: .env`. Result: compose decides nothing changed, the
> **container is not recreated at all**, the app keeps the old value, and again there is no error
> (`docker compose up` merely prints `Container chatz Running`).
>
> **How to tell whether it took effect**: read the config endpoint after changing it —
> `curl -s http://192.168.2.100:20010/config`; the aggregation values `aggWindowMs` /
> `aggMaxLifetimeMs` are in the response (`/config` is public).
>
> **Ways that do work**:
> 1. Write it into `.env` and run `docker compose up -d chatz` (a changed `env_file` triggers a
>    recreate).
> 2. One-off test without touching `.env` — use an override file:
>    ```bash
>    cd /root/chatz/chatz
>    cat > docker-compose.vftest.yml <<'EOF'
>    services:
>      chatz:
>        environment:
>          AGG_MAX_LIFETIME_MS: "5000"
>    EOF
>    docker compose -f docker-compose.yml -f docker-compose.vftest.yml up -d chatz
>    # restore when done
>    docker compose up -d chatz && rm -f docker-compose.vftest.yml
>    ```
>    Note that `docker compose exec/logs` without `-f` still finds the same container
>    (`container_name: chatz` is hard-coded), so `verify-full.sh` keeps working.
> 3. `--force-recreate` only forces a recreate — it **cannot** carry in a command-line prefix
>    value, because that value never entered the compose config in the first place.

### `TRUST_PROXY` — the only variable that depends on your layout

Both rate limiting and the audit log need "the client IP". How that IP is derived decides whether
rate limiting means anything.

`X-Forwarded-For` (XFF) is a client-supplied header — **anyone can forge it**. Trusting it
unconditionally lets an attacker switch rate-limit buckets by changing the value on every request,
which disables registration / login limits entirely. Ignoring it completely is not an option either:
behind a proxy, the TCP peer of every request is the proxy itself.

Four kinds of values (measured against express 4 + proxy-addr 2):

| Value | Meaning | Safety |
|---|---|---|
| unset / `false` / `off` / `0` | TCP peer only, XFF ignored entirely | correct when there is no proxy |
| `true` | take the first XFF segment | **not recommended** — in append mode you get the forged value |
| positive integer `N` | take the Nth XFF segment from the end (hop count) | works, but **does not verify the peer** |
| IP / CIDR / network name, comma separated | trust only listed peers, ignore XFF from everyone else | **most robust** |

**`auto` is enough in most setups** — no need to look up your proxy's internal IP. It means "if the
peer is loopback / private, treat it as a proxy and parse its XFF; if the peer is a public address,
ignore XFF":

```bash
TRUST_PROXY=auto
```

| Request path | Peer address | Result |
|---|---|---|
| NPM is a Docker container | `172.17.0.1`, `172.18.0.1` | XFF used ✅ |
| NPM installed on the host | `127.0.0.1` | XFF used ✅ |
| Proxy on another LAN machine | `192.168.x.x` | XFF used ✅ |
| Attacker bypasses the proxy and hits 20010 | their public IP | **XFF ignored, real peer used** ✅ |

**Trade-off**: `auto` trusts the whole private range, so another service on the same machine could
forge XFF too. Irrelevant for home / single-tenant self-hosting; in a multi-tenant environment use
the proxy's exact IP instead.

| Deployment | What to set |
|---|---|
| Port exposed directly (no proxy) | **leave unset** (keep it off) |
| Behind a proxy, no fiddling wanted | **`auto`** |
| Behind a proxy and willing to look up its IP | the proxy's exact internal IP, e.g. `172.17.0.1` |
| Single proxy hop, and 20010 is unreachable from the internet | `1` |
| CDN + proxy (two hops), port not directly reachable | `2` |

#### ⚠️ Hop-count mode: the port must not be directly reachable

`TRUST_PROXY=1` takes the last XFF segment **by position** and does not verify that the peer really
is your proxy. So as long as 20010 is reachable from the internet, an attacker who bypasses the
proxy with a forged XFF wins:

```text
TRUST_PROXY=1   XFF="9.9.9.9"  socket=203.0.113.66  →  IP = 9.9.9.9      ← forgery succeeds
TRUST_PROXY=172.18.0.5, same request                →  IP = 203.0.113.66 ← correct
```

**If you use a hop count you must guarantee the port is only reachable through the proxy**
(firewall allows only 80 and 443). If you cannot, switch to the proxy's internal IP — that mode
verifies the peer first, so an exposed port cannot be forged.

#### Nginx Proxy Manager (NPM)

NPM *is* Nginx, i.e. a single hop, so `TRUST_PROXY` is **required** — without it every user is
logged as NPM's internal IP and one person tripping the limiter 429s the whole site. When 20010 is
still reachable from the internet (very common over IPv6) do **not** use `1`; just write:

```bash
# .env
TRUST_PROXY=auto
```

To use an exact value, look up NPM's IP:

```bash
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' <NPM-container>
TRUST_PROXY=172.18.0.5
```

While you are there, hard-code one line in NPM → Proxy Host → Advanced → Custom Nginx Configuration
so that client-forged XFF is discarded:

```nginx
# ✅ overwrite: the client's forged value is dropped; safe with 1 / explicit IP / true
proxy_set_header X-Forwarded-For $remote_addr;

# ⚠️ append: the forged value stays in the first segment.
#    Still correct with 1 or an explicit IP, but with `true` you hand the IP to the attacker
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

NPM's default (`$proxy_add_x_forwarded_for`, append) does **not** break anything either — only
`true` can be fooled by the forged value.

A wrong or unrecognised value does not crash: a warning is printed at startup and it continues as
"not trusted".

---

## Mode 1: expose the port directly

**Simplest.** For a LAN or a test environment.

```bash
cd /root/chatz/chatz
docker compose up -d
```

Then open `http://<server-IP>:20010/`.

Notes:

- Android 9+ blocks cleartext HTTP by default; the app needs
  `android:usesCleartextTraffic="true"`, or use HTTPS
- Exposing this to the internet is risky — at minimum change `AUTH_TOKEN`

> ℹ️ **`.env` is optional now**: compose declares `env_file: - path: .env / required: false`, so a
> missing file is skipped silently instead of erroring. Only `cp .env.example .env` if you actually
> want to customise variables. The cost is that this mapping syntax requires **Compose ≥ 2.24.0**
> (`docker compose version` tells you).

---

## Mode 2: built-in HTTPS

Chatz ships with HTTPS built in — upload a certificate and you are done, no extra component.

### Steps

1. Prepare the certificate (wildcard or single-domain, either works)

- `fullchain.pem` — certificate + intermediate
- `privkey.pem` — private key

2. Start Chatz

```bash
docker compose up -d
```

3. Open the web UI → avatar (top right) → HTTPS certificate

- upload `fullchain.pem`
- upload `privkey.pem`
- click "Upload certificate"

4. The log prints

```text
✅ Certificate hot-reloaded
🔒 HTTPS started, listening on port 20443
```

5. Open

```text
https://<host>:20443/
```

### Mapping 20443 to 443

Edit the project's `docker-compose.yml`:

```yaml
services:
  chatz:
    ports:
      - "20010:20010"
      - "443:20443"
```

Users then reach it at `https://<domain>/` directly.

### Certificate sources

```bash
# certbot (needs port 80)
certbot certonly --standalone -d your-domain.com

# resulting files
# /etc/letsencrypt/live/your-domain.com/fullchain.pem
# /etc/letsencrypt/live/your-domain.com/privkey.pem
```

Aliyun / Tencent Cloud / DNSPod free certificates: request them in the console and download the
Nginx flavour.

Wildcard certificates (recommended): one certificate covers every subdomain, valid for a long time
(1 year), no frequent renewal.

### Validation on upload

The server rejects these cases with `400`:

| Check | Meaning |
|---|---|
| PEM parses | Must contain a `BEGIN CERTIFICATE` / `PRIVATE KEY` block |
| Validity | Expired or not-yet-valid certificates are refused |
| Pairing | When one of the two already exists, the other is compared against its public key; a mismatch is refused |

Uploading only one of the two files does not start HTTPS; the endpoint answers "waiting for private
key / certificate".

### Pros and cons

Pros:

- single container, simple
- certificate hot-reload, no restart
- no extra component

Cons:

- one port only — awkward to share with other services
- no WAF, no rate limiting, no access log

---

## Mode 3: Nginx reverse proxy

Use it when you already have Nginx or need more (rate limiting, WAF, access logs).

### Topology

```text
user ──HTTPS──▶ Nginx:443 ──HTTP──▶ Chatz:20010
```

### Directory layout

```text
/root/chatz/
├── docker-compose.yml
├── nginx/
│   ├── conf.d/
│   │   └── chatz.conf
│   └── nginx.conf
└── chatz/              # the Chatz project
```

### docker-compose.yml

```yaml
services:
  chatz:
    # default: the ready-made image from GHCR (same convention as the repo's own compose)
    image: ghcr.io/yezi8430/chatz:latest
    # building from source instead: comment the line above and uncomment this one
    # build: ./chatz
    container_name: chatz
    expose:
      - "20010"           # internal network only
    env_file:
      - ./chatz/.env
    environment:
      PORT: 20010
      TRUST_PROXY: auto   # there is an Nginx in front: take the real client IP from XFF
    volumes:
      - ./chatz/data:/app/data
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    container_name: chatz-nginx
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/conf.d:/etc/nginx/conf.d:ro
      - ./nginx/certs:/etc/nginx/certs:ro
      - ./nginx/logs:/var/log/nginx
    depends_on:
      - chatz
    restart: unless-stopped
```

### nginx/conf.d/chatz.conf

```nginx
# HTTP → HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name chatz.your-domain.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name chatz.your-domain.com;

    ssl_certificate     /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    client_max_body_size 10m;

    # WebSocket
    location /stream {
        proxy_pass http://chatz:20010;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # $remote_addr (overwrite) rather than $proxy_add_x_forwarded_for (append):
        # appending keeps the client's forged XFF in the first segment and the server can be fooled
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # everything else
    location / {
        proxy_pass http://chatz:20010;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Client IP and `TRUST_PROXY` (read this)

By default the server does **not** trust `X-Forwarded-For` — it is a client-supplied header and
anyone can forge it. Trusting it blindly means an attacker changes the XFF value per request and
gets a fresh rate-limit bucket each time, disabling the registration / login limits completely. So
the rule for rate limiting and the audit log is:

| `TRUST_PROXY` | Which IP is used |
|---|---|
| unset (default) | TCP peer address. Right when the port is exposed directly with no proxy |
| **`auto`** | **Recommended.** Treat loopback / private peers as proxies and parse XFF; ignore XFF from public peers. Equivalent to `loopback,linklocal,uniquelocal` |
| `1` | Skip one proxy hop, take the peer the proxy saw. **Only usable when 20010 cannot be reached from the internet** |
| `2` | Skip two hops (CDN + Nginx style), same "port not directly reachable" requirement |
| `172.17.0.1` / `172.16.0.0/12` | Trust only proxies at those addresses, ignore XFF from everyone else |
| `true` | Take the first XFF segment. Only when you are sure the proxy **overwrites** XFF (`$remote_addr`) |

`auto` is the lazy option: no `docker inspect` needed to find the proxy's IP, and it stays safe even
if the port (IPv6 included) is reachable from the internet — public peers are not in the trust list,
so XFF is simply ignored. The trade-off is that the whole private range is trusted; in a
multi-tenant environment switch to an exact IP.

⚠️ If you use a proxy you **must** set `TRUST_PROXY`. Otherwise every request is recorded as
Nginx's internal IP and the limiter lumps everyone together — one person trips it and the whole site
gets 429.

#### Hop-count mode: the port must not be directly reachable

`TRUST_PROXY=1` takes the last XFF segment **by position** and never verifies that the peer really
is your proxy. Measured:

```text
TRUST_PROXY=1            XFF="9.9.9.9"  socket=203.0.113.66  →  9.9.9.9        ← forgery succeeds
TRUST_PROXY=auto         XFF="9.9.9.9"  socket=203.0.113.66  →  203.0.113.66   ← correct
TRUST_PROXY=auto         XFF="9.9.9.9"  socket=240e:3b7::1   →  240e:3b7::1     ← IPv6 direct is correct too
TRUST_PROXY=172.18.0.5   XFF="9.9.9.9"  socket=203.0.113.66  →  203.0.113.66   ← correct
```

So a hop count requires **the port to be reachable only through the proxy**: firewall / security
group allows 80 and 443 only. If you cannot guarantee that, use `auto` or the proxy's internal IP —
both verify the peer first, so forging is impossible even with the port open.

#### Nginx Proxy Manager (NPM)

NPM is Nginx, i.e. a single hop, so `TRUST_PROXY` is required. When 20010 can be reached from the
internet (very common over IPv6) do not use `1`; just write:

```bash
# .env — one line, no IP lookup needed
TRUST_PROXY=auto
```

An exact value works too:

```bash
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' <NPM-container>
TRUST_PROXY=172.18.0.5
```

In NPM, pin one line under Proxy Host → Advanced → Custom Nginx Configuration:

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
```

NPM's default (`$proxy_add_x_forwarded_for`, append) is fine as well — in append mode both `1` and
an explicit IP still yield the real address; only `true` gets fooled by the forged value.

A wrong value does not crash: a warning is printed at startup and it continues as "not trusted".

### nginx/nginx.conf

```nginx
user  nginx;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 2048;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';

    access_log /var/log/nginx/access.log main;

    sendfile on;
    tcp_nopush on;
    keepalive_timeout 65;
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    include /etc/nginx/conf.d/*.conf;
}
```

### Placing the certificate

```bash
mkdir -p nginx/certs
cp /path/to/fullchain.pem nginx/certs/
cp /path/to/privkey.pem nginx/certs/
```

Or with Let's Encrypt:

```bash
# generate on the host with certbot
certbot certonly --webroot -w /var/www/certbot -d chatz.your-domain.com

# symlink or copy the result into nginx/certs/
```

### Let's Encrypt auto-renewal

```bash
crontab -e
```

Add one line (checks daily at 03:00):

```text
0 3 * * * docker run --rm \
  -v /root/chatz/nginx/certbot-www:/var/www/certbot \
  -v /etc/letsencrypt:/etc/letsencrypt \
  certbot/certbot renew --webroot -w /var/www/certbot --quiet && \
  docker exec chatz-nginx nginx -s reload
```

### Start-up

```bash
cd /root/chatz
docker compose up -d
docker compose logs -f nginx --tail=20
```

---

## Mode 4: Caddy reverse proxy

Caddy obtains HTTPS certificates automatically — the least configuration of all.

### docker-compose.yml

```yaml
services:
  chatz:
    image: ghcr.io/yezi8430/chatz:latest
    # build: ./chatz
    container_name: chatz
    expose:
      - "20010"
    env_file:
      - ./chatz/.env
    environment:
      PORT: 20010
      TRUST_PROXY: auto   # there is a Caddy in front
    volumes:
      - ./chatz/data:/app/data
    restart: unless-stopped

  caddy:
    image: caddy:alpine
    container_name: chatz-caddy
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy-data:/data
      - ./caddy-config:/config
    depends_on:
      - chatz
    restart: unless-stopped
```

### Caddyfile

```text
chatz.your-domain.com {
    reverse_proxy /stream chatz:20010 {
        header_up Upgrade {http.request.header.Upgrade}
        header_up Connection "upgrade"
    }

    reverse_proxy chatz:20010
}
```

That is all. Caddy automatically: requests a Let's Encrypt certificate, sets up HTTP→HTTPS
redirection, handles WebSocket, and renews.

### Start-up

```bash
docker compose up -d
docker compose logs -f caddy --tail=20
```

The first start prints the certificate request log.

---

## Mode 5: Traefik reverse proxy

Traefik fits when you already run K8s or want dynamic service discovery.

### docker-compose.yml

```yaml
services:
  chatz:
    image: ghcr.io/yezi8430/chatz:latest
    # build: ./chatz
    container_name: chatz
    expose:
      - "20010"
    env_file:
      - ./chatz/.env
    environment:
      PORT: 20010
      TRUST_PROXY: auto   # there is a Traefik in front
    volumes:
      - ./chatz/data:/app/data
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.chatz.rule=Host(`chatz.your-domain.com`)"
      - "traefik.http.routers.chatz.entrypoints=websecure"
      - "traefik.http.routers.chatz.tls.certresolver=letsencrypt"
      - "traefik.http.services.chatz.loadbalancer.server.port=20010"
    restart: unless-stopped

  traefik:
    image: traefik:v3
    container_name: traefik
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./traefik.yml:/etc/traefik/traefik.yml:ro
      - ./acme.json:/acme.json
    restart: unless-stopped
```

### traefik.yml

```yaml
entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
  websecure:
    address: ":443"

certificatesResolvers:
  letsencrypt:
    acme:
      email: your-email@example.com
      storage: /acme.json
      httpChallenge:
        entryPoint: web

providers:
  docker:
    exposedByDefault: false

log:
  level: INFO
```

### Prepare `acme.json`

```bash
touch acme.json
chmod 600 acme.json
```

### Start-up

```bash
docker compose up -d
docker compose logs -f traefik --tail=20
```

---

## Backup & restore

### What to back up

| Path / file | Contents |
|---|---|
| `chatz/data/` | database, icons, avatars, attachments, backgrounds, **HTTPS certificates** |
| `chatz/.env` | `AUTH_TOKEN` configuration |
| `chatz/docker-compose.yml` | deployment configuration |
| `nginx/certs/` | Nginx certificates (when using a proxy) |

The data directory's location is decided by `DB_PATH` (inside the container it is
`/app/data/app.db`), so **mounting the whole `data/` out covers everything** — certificates
included.

### One-command backup

```bash
cat > /root/chatz/backup.sh <<'SCRIPT'
#!/bin/bash
set -e

BACKUP_DIR=/root/chatz-backups
mkdir -p $BACKUP_DIR

DATE=$(date +%Y%m%d-%H%M)
FILE=$BACKUP_DIR/chatz-$DATE.tar.gz

cd /root/chatz

tar -czf $FILE \
  --exclude='chatz/node_modules' \
  --exclude='chatz/data/app.db-wal' \
  --exclude='chatz/data/app.db-shm' \
  chatz/ nginx/ docker-compose.yml 2>/dev/null

echo "✅ backup done: $FILE ($(du -h $FILE | cut -f1))"

# keep the last 7
cd $BACKUP_DIR
ls -t chatz-*.tar.gz | tail -n +8 | xargs -r rm
SCRIPT

chmod +x /root/chatz/backup.sh
```

Add it to cron:

```bash
crontab -e
# add:
# 0 3 * * * /root/chatz/backup.sh >> /var/log/chatz-backup.log 2>&1
```

### Safely backing up the database

A plain `tar` of `app.db` can capture an inconsistent state if the service is writing at that
moment (data still sitting in the WAL). The safer route is SQLite's backup API:

```bash
docker exec chatz node -e '
const db = require("./src/db");
db.backup("/app/data/backup-" + Date.now() + ".db").then(() => {
  console.log("✅ backup done");
  process.exit(0);
});
'

docker cp chatz:/app/data/backup-xxx.db /root/backups/
docker exec chatz rm /app/data/backup-xxx.db
```

> The path in `require("./src/db")` is **relative to the container working directory `/app`**.
> The Dockerfile sets `WORKDIR /app` and `COPY src ./src`, so `/app/src/db.js` exists. There is no
> top-level `db.js` in the project — writing `require("./db")` fails with `MODULE_NOT_FOUND`.

### Restore

```bash
# 1. stop the service (proxy layout: run this in the parent directory)
cd /root/chatz
docker compose down

# 2. keep the current state, just in case
mv chatz chatz-old

# 3. unpack the backup
tar -xzf /root/chatz-backups/chatz-20260921-0300.tar.gz

# 4. start (still in the parent directory, using the parent's compose)
docker compose up -d

# 5. verify
curl http://localhost:20010/health
```

> Step 4 must run in the **parent** directory. If you `cd chatz` first you get the repo's own
> single-container compose and the proxy container is never started.

---

## Logs & monitoring

### What the startup log prints

Only things that carry information — no fixed banner:

| Case | Printed? |
|---|---|
| Startup / ready separator (with timestamp) | ✅ every time. Container logs are appended, so on a repeated `restart` the previous run's shutdown lines run straight into this run's startup lines; the separator is what makes the boundary visible |
| Signal received, shutting down | ✅ every time, same kind of separator |
| Migration check ran, nothing changed | ❌ not printed (idempotent check that runs every boot — nothing to say) |
| A migration **actually** changed the schema / backfilled data | ✅ one line — literal: `🔧 数据库迁移：应用 2 项变更 → messages.tags, users.avatar` ("database migration: applied 2 changes → …") |
| Orphaned attachments were cleaned | ✅ one line, with a count |
| Audit trimming deleted rows | ✅ one line, with a count |
| Current `TRUST_PROXY` state | ✅ every time (you need it when debugging a deployment) |
| `AUTH_TOKEN` full value | ❌ never. On a brand-new data directory the master key **does not exist yet** (the setup page creates it), so there is nothing to print |
| `AUTH_TOKEN` came from DB / file / env | ❌ no plaintext, only an 8-char fingerprint (to match it against other records) |

Log lines are printed **in Chinese** (that is what the server emits, and what you grep for). The
boundaries are the separator lines:

```text
──────── 启动 00:20:11 ────────     ← previous run: start, came up fine
...
──────── 就绪 ────────                                    ← ready
──────── 收到 SIGTERM，正在关闭 ────────   ← "received SIGTERM, shutting down": previous run killed by restart
✅ 数据库已关闭                                              ← database closed
──────── 启动 00:22:03 ────────     ← this run
...
──────── 就绪 ────────
```

`docker compose restart` sometimes sends SIGTERM twice; the second one prints
`（已在关闭中，忽略重复的 SIGTERM）` ("already shutting down, ignoring duplicate SIGTERM") — that is
re-entry protection, it is fine.

On a brand-new data directory (setup page not completed yet) the master key **has not been
generated at all** and the log reads:

```text
⏳ 尚未初始化：主密钥还没生成          ← "not initialised: master key not generated yet"
   → 打开网页版走首次引导，设置管理员账号后会自动生成
     ("open the web UI and complete first-run setup; it is generated after you set the admin account")
```

> 🔴 The key never reaches the container log (changed 2026-10-05). It used to be generated at
> startup and reused as admin's initial password, which forced printing the plaintext once so you
> could fish it out. Now the setup page (`POST /setup`) generates it, so it never appears in
> `docker logs` or any log driver — those get collected, forwarded and backed up, a far bigger
> exposure surface than the key needs.

For headless provisioning (CI / automated deploys), pin `AUTH_TOKEN=<fixed value>` in `.env`
before starting.

To read the full value, two places: the copy button under "Account → Security & sign-in →
Signed-in devices" in the web UI, or the database:

```bash
docker compose exec chatz node -e 'console.log(require("better-sqlite3")("/app/data/app.db").prepare("SELECT value FROM meta WHERE key = ?").get("auth_token").value)'
```

> 💡 SQL string literals must use **single quotes**. `key = "auth_token"` is read by SQLite as a
> **column name** and errors with `no such column: "auth_token"` — three layers of quoting (shell,
> JS, SQL) make this very easy to hit. The command above uses a bound parameter (`?` +
> `.get("auth_token")`), which sidesteps the whole problem; to query another key, change only the
> last argument.

### Log language (one setting for the whole instance)

The server log speaks the same language as the web UI — they share one switch:

| Situation | How the log language is decided |
|---|---|
| English picked on the first-run setup page | Setup writes it to `meta.lang`; **from that moment** the log is English |
| Language button in the sidebar clicked after signing in | The front end calls `PUT /config/lang` in passing; it takes effect **immediately**, no restart |
| You want it pinned at deploy time | Set `LOG_LANG=en` in `.env` (or compose `environment:`) — this is a **hard override** the web UI cannot change |
| Who may change it | **Super-admins only.** Registration is fully open: if any signed-in user could change it, anyone who signs up could decide what language your logs speak |

Changing it leaves two traces: a `🌐 log language switched to English` line in the log itself,
and a `config.set_lang` row in the audit log.

To read the effective value:

```bash
curl -s http://192.168.2.100:20010/config | grep -o '"lang":"[a-z]*"'
# or the dedicated endpoint (requires a token)
curl -s -H "Authorization: Bearer <your-token>" http://192.168.2.100:20010/config/lang
```

> ⚠️ Once `LOG_LANG` is set, `/config/lang` reports `"locked": true` — switching in the UI still
> works (that is the browser's own setting) but the log will not follow. Drop the variable if you
> want the UI to drive the log language.

### Viewing logs

```bash
# live
docker compose logs -f

# last 100 lines
docker compose logs --tail=100

# errors only
docker compose logs --tail=100 | grep -i error

# export to a file
docker compose logs --since=24h > chatz-$(date +%Y%m%d).log
```

### Docker log rotation

Docker logs are unbounded by default and will fill the disk eventually. Add this to
`docker-compose.yml`:

```yaml
services:
  chatz:
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

Or set it globally in `/etc/docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

### Health check

The repo's `docker-compose.yml` already ships one:

```yaml
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://localhost:20010/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
  interval: 30s
  timeout: 5s
  retries: 3
```

Check the status with:

```bash
docker compose ps
docker inspect --format='{{.State.Health.Status}}' chatz
```

### Monitoring Chatz itself with Uptime Kuma

A fun bit of recursion: Uptime Kuma monitors Chatz while Chatz receives Uptime Kuma's alerts.

Add an HTTP monitor in Uptime Kuma:

- URL: `http://your-server:20010/health`
- expected field: `"ok":true`

---

## Updating & rolling back

### Updating code

```bash
cd /root/chatz/chatz

# 1. back up
cp -r . ../chatz.bak-$(date +%Y%m%d)

# 2. fetch the new version (image mode: pull the image; local build: git pull)
docker compose pull

# 3. recreate so the container uses the new image
#    single-container layout: right here
docker compose up -d
#    proxy layout: go back to the parent directory
# cd /root/chatz && docker compose up -d

# 4. verify
docker compose logs -f --tail=30
curl http://localhost:20010/health

#    site-wide endpoint self-test (optional, strongly recommended):
#    it creates and deletes some test channels/apps/messages and contains real tokens
#    ⇒ remember to `rm -f verify-full.sh` afterwards
bash verify-full.sh

#    · section 0c: compares sha256 of local public/ against what the server is **actually serving**
#      — catches "the front end online is not the latest copy" (forgot --build locally, or forgot pull in image mode)
#    · section 8.6: verifies message aggregation (incl. image removal from the parent card, aggChildren containing the original)
#    · section 8.6b (skipped by default): AGG_TEST_LIFETIME=1 bash verify-full.sh
#      — lower AGG_MAX_LIFETIME_MS first, then verify "a new message starts once the lifetime is over, no more renewal"
```

### Database migrations

Automatic. On startup `src/migrate.js` checks every column and adds the missing ones (via
`PRAGMA table_info`, idempotent).

New columns are always nullable, so existing data is never broken. New tables use
`CREATE TABLE IF NOT EXISTS`.

After migrating, a `wal_checkpoint(TRUNCATE)` runs to fold the WAL back into the main database
file, reducing the risk of data loss if the container is killed.

### Rollback

```bash
# 1. stop
docker compose down

# 2. restore from backup
rm -rf chatz
mv chatz.bak-20260921 chatz
cd chatz

# 3. start
docker compose up -d

# 4. verify
curl http://localhost:20010/health
```

---

## Day-to-day commands

```bash
# start
docker compose up -d

# upgrade (image mode: pull first)
docker compose pull && docker compose up -d

# local build mode: after changing src/ or public/ you MUST pass --build; a plain restart does nothing
# docker compose up -d --build

# stop
docker compose down

# logs
docker compose logs -f --tail=50

# enter the container
docker exec -it chatz sh
```

Backup / restore: see [Backup & restore](#backup--restore).

Query the database (inside the container the module path is `./src/db`; `./db` gives
`MODULE_NOT_FOUND`):

```bash
docker exec -it chatz node -e '
const db=require("./src/db");
console.log("users:", db.prepare("SELECT id,username,is_admin FROM users").all());
console.log("channels:", db.prepare("SELECT id,name FROM channels").all());
console.log("apps:", db.prepare("SELECT id,name,token FROM applications").all());
console.log("rules:", db.prepare("SELECT id,name FROM routes").all());
'
```

---

## FAQ

### Port already in use

```text
Error starting userland proxy: listen tcp4 0.0.0.0:20010: bind: address already in use
```

Find what holds it:

```bash
ss -tlnp | grep 20010
```

Change the mapped port in `docker-compose.yml` (left side is the host port):

```yaml
ports:
  - "30010:20010"    # host uses 30010, container still uses 20010
```

### Compose refuses to start: `env file not found`

Your Compose is older than 2.24.0 and does not recognise the `env_file` mapping syntax
(`path` + `required: false`; that field was added in 2.24.0).

```bash
docker compose version
# upgrade Compose, or fall back to the old approach: create a (possibly empty) .env file
cd /root/chatz/chatz
touch .env
```

⚠️ Do not "fix" this error by editing `required: false` in compose — that flag means "skip silently
when the file is missing", not "delete this configuration".

> ⚠️ **Precedence trap**: inside the same service, `environment:` outranks `env_file:`.
> `docker-compose.yml` hard-codes `PORT` / `HTTPS_PORT` / `TRUST_PROXY` in its `environment:`
> block, so setting those three in `.env` is **ineffective and silently ignored**. To make them
> overridable, first convert compose to interpolation: `TRUST_PROXY: ${TRUST_PROXY:-auto}`.

### HTTPS upload fails

- Check the file format (must be PEM)
- Check that the private key matches the certificate

```bash
openssl x509 -noout -modulus -in fullchain.pem | md5sum
openssl rsa -noout -modulus -in privkey.pem | md5sum
# the two md5s must match
```

- Check that `fullchain.pem` carries the full chain (leaf + intermediate), not just the leaf
- The server also checks validity: expired or not-yet-valid certificates are rejected — read the
  `error` field in the response

### WebSocket will not connect

Use DevTools → Network → WS:

- status **101** → success
- status **401** → bad token
- status **502** → the proxy is missing `Upgrade`
- status **429** → that user has more than 10 connections (close some browser tabs)

With an Nginx proxy, check:

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

Also: WebSocket only accepts the path `/stream`; anything else is dropped during the upgrade.

### Removing `AUTH_TOKEN` from `.env` (or switching to `AUTH_TOKEN_FILE`)

Short answer: **the value does not change**. On every boot the server syncs the master key that
actually took effect into the database, so deleting the variable only flips the source from
`[environment]` to `[database]` — the key stays the same and every configured app / script / Gotify
client keeps working.

> ⚠️ Before v1.2.1 that was **not** true: an env-sourced value was never written to the DB, so
> `meta.auth_token` sat on some long-ago value and removing the `.env` line would **silently fall
> back to that old value** (the "Default token" row in `devices` was rewritten along with it).
> On older versions, upgrade first.

#### Option A: just delete it (recommended)

```bash
# 1) restart once with the line still present, so the sync happens
#    (log lines are Chinese; grep for the literal string 同步 = "synced")
docker compose up -d --force-recreate
docker compose logs chatz --tail 20 | grep -E "AUTH_TOKEN|同步"

# 2) note the fingerprint (looks like "fingerprint kR9mX2pQ…"), then delete or comment the line
# AUTH_TOKEN=cz.kR9mX2pQ7tL...

# 3) recreate the container — 🔴 --force-recreate is required, restart does not re-read env_file
docker compose up -d --force-recreate
docker compose logs chatz --tail 20 | grep AUTH_TOKEN
```

The step-3 log should now say `[database]`, **with exactly the same fingerprint as in step 1**. If
the fingerprint changed you fell back to an old value — run step 1 again.

#### Option B: move it to a file (only a path left in the environment)

```bash
mkdir -p ./secrets && chmod 700 ./secrets
printf '%s\n' 'cz.your-master-key' > ./secrets/chatz_auth_token
chmod 600 ./secrets/chatz_auth_token

# in .env: remove the AUTH_TOKEN line and add
# AUTH_TOKEN_FILE=/run/secrets/chatz_auth_token
```

Then uncomment that mount under `volumes:` in `docker-compose.yml`:

```yaml
      - ./secrets/chatz_auth_token:/run/secrets/chatz_auth_token:ro
```

Finally `docker compose up -d --force-recreate`.

- The file holds one line with the key; a trailing newline is fine (it is trimmed on read)
- 🔴 **Unreadable or empty file ⇒ the server refuses to start** rather than quietly reusing an old
  key
- `secrets/` is in `.gitignore` / `.dockerignore`, so it is never committed or baked into the image

The log tells you which branch was taken:

| Log (literal, Chinese) | Meaning |
|---|---|
| `⏳ 尚未初始化：主密钥还没生成` | brand-new data directory, the key **does not exist**; the web setup page creates it |
| `🔑 AUTH_TOKEN 就绪 [数据库] · 指纹 xxxx…` | existing key reused (`[database]`). Copy the full value from Security & sign-in → Signed-in devices |
| `🔑 AUTH_TOKEN 就绪 [文件] · 指纹 xxxx…` | came from the file `AUTH_TOKEN_FILE` points at (`[file]`); the full value only exists in that file |
| `🔑 AUTH_TOKEN 就绪 [环境变量] · 指纹 xxxx…` | came from `AUTH_TOKEN` in `.env` (`[environment]`); the full value is right there in `.env` |

Two easy-to-miss points:

- **Old tokens do not stop working**: it is already the "Default token" row in `devices`, so
  configured apps / scripts keep running; to revoke it, delete that row under
  "Account → Security & sign-in → Signed-in devices"
- **admin's password and the master key are separate things**: the password set on the setup page
  *is* the only password, and rotating the master key does not touch it. If you cannot sign in, use
  "Forgot password" in the web UI or the database method below.

### Data loss

Check the mounts:

```bash
docker inspect chatz | grep -A 5 Mounts
```

You should see:

```json
"Source": "/root/chatz/chatz/data",
"Destination": "/app/data"
```

If not, the data lives inside the container and `docker compose down` deletes it.

### High memory usage

Chatz itself is light, but SQLite + WAL + accumulated messages slowly add up.

Clean up soft-deleted old messages:

```bash
docker exec chatz node -e '
const db = require("./src/db");
const cutoff = Date.now() - 90 * 24 * 3600 * 1000; // 90 days ago
const r = db.prepare("DELETE FROM messages WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoff);
console.log("removed", r.changes, "soft-deleted messages");
'
```

Add it to cron:

```bash
crontab -e
# every Sunday at 03:00
0 3 * * 0 docker exec chatz node -e 'const db=require("./src/db");const c=Date.now()-90*24*3600*1000;db.prepare("DELETE FROM messages WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(c);' >> /var/log/chatz-cleanup.log 2>&1
```

> **Mind the nested quotes in `docker exec`**: single quotes wrap the whole Node script, and the
> cron line's `>> /var/log/...` must sit **outside** those single quotes.

### Forgot the `AUTH_TOKEN`

**If you configured the environment variable**, just read `.env` (this is the full value):

```bash
cat /root/chatz/chatz/.env | grep AUTH_TOKEN
```

**If the server generated it**, the value is in the `meta` table:

```bash
docker exec chatz node -e 'console.log(require("better-sqlite3")("/app/data/app.db").prepare("SELECT value FROM meta WHERE key = ?").get("auth_token").value)'
```

> ⚠️ **Do not** use `docker compose logs | grep AUTH_TOKEN` any more. Since v2.0.x the startup log
> prints the full token **only when the database has none** (brand-new data directory); every later
> boot prints just the 8-char fingerprint
> (`🔑 AUTH_TOKEN 就绪 [环境变量] · 指纹 kR9mX2pQ…`, i.e. "AUTH_TOKEN ready [environment] ·
> fingerprint …").
>
> Why it changed: writing the full key into the container log on every boot leaves it sitting in
> `docker logs`, log drivers and backups — a much bigger exposure surface than needed, and the value
> is already in `.env` or the database, so the log was never the right place to keep it.
>
> If an old log already contains the token, treat it as leaked. To rotate:
> `docker exec chatz node -e 'require("better-sqlite3")("/app/data/app.db").prepare("DELETE FROM meta WHERE key = ?").run("auth_token")'`
> then restart (note: this also resets admin's initial password — set it again via "Forgot a user's
> password" below).

### No "database migration" line in the startup log — is that normal?

Yes. Migration is idempotent and runs a full check on every boot; most of the time it changes
nothing — **and unchanged means nothing is logged**. Only when the schema really changed or data was
backfilled do you get a line (literal, in Chinese):

```text
🔧 数据库迁移：应用 2 项变更 → messages.tags, users.avatar
   ("database migration: applied 2 changes → …")
```

Likewise, orphan cleanup and audit trimming each print a line only when they **actually deleted**
something. The startup log is therefore stable and predictable — an extra line is a signal worth
reading.

### `shutdown` and `startup` interleaved in the log — did startup fail?

No. Docker appends stdout **across container lifetimes**, so on consecutive restarts the previous
shutdown log sits right next to the next startup log and it looks like "started half-way then
stopped". The literal lines look like this (English gloss in parentheses):

```text
──────── 启动 2026-09-28 14:02:11 ────────            ← start
✅ Chatz 已启动，监听端口 20010                          ← Chatz started, listening on port 20010
   数据目录: /app/data/app.db                            ← data directory
   网页版: http://<主机>:20010/                          ← web UI
   推送接口: http://<主机>:20010/hook/<应用Token>        ← push endpoint
   消息聚合窗口: 300000ms（单条最长寿命 1800000ms）      ← aggregation window (single-message max lifetime)
   🛡️  TRUST_PROXY=off  →  限速 / 审计只认 TCP 对端地址（忽略 X-Forwarded-For）
                                                        ← rate limiting / audit use the TCP peer only (XFF ignored)
🔑 AUTH_TOKEN 就绪 [环境变量] · 指纹 kR9mX2pQ…          ← AUTH_TOKEN ready [environment] · fingerprint
──────── 就绪 ────────                                  ← ready

──────── 收到 SIGTERM，正在关闭 ────────                ← received SIGTERM, shutting down
✅ 数据库已关闭                                          ← database closed
```

- between `──────── 启动 <时间> ────────` (start) and `──────── 就绪 ────────` (ready) = one single
  startup
- `──────── 收到 <信号>，正在关闭 ────────` = the tail of the previous run
- `（已在关闭中，忽略重复的 SIGTERM）` ("already shutting down, ignoring duplicate SIGTERM") is normal
  too: `docker compose restart` can send SIGTERM twice, and re-entry protection swallows the second
  one — otherwise the duplicate `db.close()` would throw and bury the real shutdown message

To see only the latest run use `docker compose logs --since 5m`, or page forward to the last
separator group.

### Forgot a user's password

**If you can still sign in**, change it directly: "Account → Security & sign-in → Change password"
in the web UI (being logged in is the proof, so **the old password is not required**), or call the
endpoint:

```bash
curl -X PATCH https://<domain>/user/password \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"new_password":"new-password"}'
```

A super-admin can also reset someone else (no old password needed, and it revokes all of that
user's devices):

```bash
curl -X PATCH https://<domain>/user/password \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"userId":2,"new_password":"new-password"}'
```

**When you cannot sign in at all**, use the built-in reset command (no login, no old password):

```bash
# first see which users exist and what their usernames really are
docker compose exec chatz node src/reset-password.js --list

# reset (password given as an argument)
docker compose exec chatz node src/reset-password.js <username> '<new-password>'

# or read it from stdin, to keep it out of shell history
echo '<new-password>' | docker compose exec -T chatz node src/reset-password.js <username> --stdin
```

It writes with the **exact same** `hashPassword` the login endpoint uses (scrypt exported from
`src/migrate.js`, 64 bytes + random 16-byte salt), so the resulting value always works. No `devices`
row is touched — already signed-in phones / browsers are not kicked.

> Trust model of this command: being able to run it means being able to read and write the container
> and `data/app.db`, i.e. you already have full control. It is not a new attack surface; it just
> turns "hand-write an UPDATE" into a command you cannot typo.

### "Wrong username or password" — how to debug

That one response covers **two different cases** (deliberately, so it does not leak which usernames
exist):

1. **The username does not exist** — a typo, or admin was renamed during first-run setup
2. **The password is wrong**

So confirm the username first, then use this script to check the password itself (it compares
candidate passwords against the stored hash):

```bash
docker compose exec -T -e PW='<the password you are trying>' -e OLD='<an older password or old token>' chatz node -e '
const crypto = require("crypto");
const db = require("better-sqlite3")("/app/data/app.db");
const users = db.prepare("SELECT id, username, is_admin, password_hash FROM users ORDER BY id").all();
const cands = [["new password", process.env.PW], ["old token", process.env.OLD]];
console.log(users.length + " users total");
for (const u of users) {
  const parts = String(u.password_hash || "").split(":");
  const salt = parts[0], hash = parts[1];
  const res = cands.map(function (c) {
    if (!c[1]) return c[0] + "=skipped";
    if (!salt || !hash) return c[0] + "=no hash stored";
    const chk = crypto.scryptSync(c[1], salt, 64).toString("hex");
    return c[0] + (chk === hash ? "=match" : "=no match");
  });
  console.log("#" + u.id + "  " + u.username + "  " + (u.is_admin ? "admin" : "user") + "  " + res.join("  "));
}
'
```

Seeing `#N admin admin new password=match` means the password is correct and the problem is
elsewhere (username case, an invisible character from the IME, or the front end still sending an old
token).

### The web UI suddenly says the session expired and bounces to the login page

That is the front end's blanket 401 handling (`public/app.js`): **any** endpoint returning 401
clears the token in localStorage and returns to the login page. Usually the device token stored in
the browser stopped being valid — commonly because the matching `devices` row was deleted after
rotating `AUTH_TOKEN`. Just sign in again with the new password; no service restart needed.

### After redeploy `AUTH_TOKEN` changed / accounts cannot sign in

The `⏳ not initialised: master key not generated yet` marker only appears when **the database has
no master key** (brand-new data directory, or setup not completed). Tokens, accounts and channels
all live in `data/app.db`, so swapping the data directory starts everything from scratch.

Diagnose:

```bash
# 1. which directory is this container mounting (Source is the host path)
docker inspect chatz --format '{{json .Mounts}}'

# 2. does that directory hold the old database, and do the timestamps look right?
ls -la <the Source above>
```

Common causes: the deployment directory moved (`./data` is relative to the compose file), a fresh
clone was started with `up`, or the volume was wiped.

To make the token independent of the data directory, pin `AUTH_TOKEN=<fixed value>` in `.env` — it
outranks the database. With a brand-new data directory, just open the web UI and complete first-run
setup; there is no token to copy from the log any more.

### Phone not receiving notifications

- Check that the server address configured in the app opens in a browser
- Check that the token is correct
- Android 13+ requires the notification permission

### Message sent but not received

- Check whether a routing rule dropped it
- **Check that you are subscribed to that channel** — without a subscription you receive nothing;
  an admin "seeing" a channel in the list does not mean they are subscribed
- Check that the WebSocket is connected

### How to migrate the database

It happens automatically: `src/migrate.js` runs at startup. Every new column is checked for
existence first, so it is safely idempotent.

### How to send a message with an image

Markdown image syntax: `![alt](https://example.com/img.jpg)`

Or via `extras`: `{"extras": {"image": "https://..."}}`

### How to turn off aggregation

Set `AGG_WINDOW_MS=0`.

If you want to keep aggregation but stop **one old message from being renewed forever** (symptom: it
sits in the same list position and never floats up, hours of newer entries are silently folded into
it, and expanding shows only the last 100), lower `AGG_MAX_LIFETIME_MS` (default `1800000`
= 30 minutes); `0` means unlimited.

### A newly registered account cannot see other people's channels

Registration does **not** auto-subscribe to public channels. Go to "Discover channels" and subscribe
explicitly to receive that channel's messages (the only exception: a channel's creator is
auto-subscribed to it).

### Are attachments kept forever?

No. Deleting a message removes the attachments it exclusively owns, and every startup also sweeps
orphaned attachments.

---

## Hardening

**1. `AUTH_TOKEN`** — recommended: leave it empty and let the server generate one (`cz.` + 30 base62
chars). To pin a known value for automated deployment:

```bash
AUTH_TOKEN="cz.$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 30)"
```

> The `cz.` prefix is not required — verification is a whole-string equality match, so anything
> works. The prefix just makes a Chatz credential recognisable at a glance.

**2. Enable HTTPS** — Account → HTTPS certificate → upload `fullchain.pem` + `privkey.pem`; it takes
effect immediately with no restart.

**3. Close port 20010 to the internet** — only expose 443 (mapped to 20443).

**4. Back up regularly** — see [Backup & restore](#backup--restore).

**5. Add a reverse proxy** — see modes 3 / 4 / 5. With a proxy in front, remember to set
`TRUST_PROXY` too (see [Environment variables](#environment-variables)).

**6. ⚠️ Rate limiting breaks with multiple instances** — `rateLimit` counts **in process memory**:
run N replicas and the registration / login / webhook limits are effectively multiplied by N, and a
restart zeroes the counters. The WebSocket connection caps (`MAX_TOTAL` / `MAX_PER_USER`) behave the
same way — each instance counts its own.

A single-instance deployment is **unaffected**, ignore this. If you scale out, add rate limiting at
the **proxy** layer:

```nginx
# Nginx: per-IP limiting at the proxy (example: 10r/m for login-ish endpoints)
limit_req_zone $binary_remote_addr zone=chatz:10m rate=10r/m;
limit_req zone=chatz burst=5 nodelay;
```

Caddy and Traefik have equivalent rate-limit middleware with the same effect.

**7. Use the audit log to retrace actions** — the server records: login success / failure, device
issuance and revocation, app and channel create/update/delete, routing rule changes, certificate
upload and deletion, message deletion, and invalid-token attempts. Only metadata is stored — **never
private key contents or full tokens**.

```bash
curl -H "X-Gotify-Key: $TOKEN" 'http://<host>:20010/audit?limit=50'
# one user's actions only
curl -H "X-Gotify-Key: $TOKEN" 'http://<host>:20010/audit?userId=1&limit=50'
# failed logins only
curl -H "X-Gotify-Key: $TOKEN" 'http://<host>:20010/audit?action=login&limit=50'
```

**8. Keep temp files out of the image** — the Dockerfile's `COPY` copies whole directories and
**ignores `.gitignore`**, so any `*.bak` under `src/` or `public/` gets baked in. The `public/`
case is the dangerous one: that directory is served by `express.static` **without authentication**,
so `public/app.js.bak` would be published as-is and anyone running
`wget http://<host>:20010/app.js.bak` walks away with the entire front-end source.

```bash
# scan before building; this must print nothing
find . -name "*.bak*" -not -path "./node_modules/*"

# or re-check from the built image
docker run --rm --entrypoint sh chatz -c 'ls -R /app/public /app/src | grep -i bak || echo clean'
```

The repository's root `.dockerignore` already excludes these files — **do not delete it**.

---

## Production checklist

- [ ] `AUTH_TOKEN` is a random value (or confirmed auto-generated and saved)
- [ ] HTTPS enabled (built-in or via proxy)
- [ ] Database backed up regularly (including `data/` and `.env`)
- [ ] Docker log rotation configured
- [ ] Server clock synchronised (NTP) — routing rules' `time_between` depends on server time
- [ ] Security group exposes only 80/443
- [ ] Soft-deleted messages cleaned up periodically
- [ ] Proxy configured `X-Forwarded-For` (prefer overwriting with `$remote_addr`, not appending with
      `$proxy_add_x_forwarded_for`)
- [ ] `TRUST_PROXY` set when using a proxy (otherwise everyone counts as one IP and one person
      tripping the limiter 429s the whole site)
- [ ] Not using `TRUST_PROXY=1` / `2` / `true` when the port is reachable from the internet
      (direct + forged XFF = arbitrary IP)
- [ ] Restore procedure has been tested
- [ ] `verify-full.sh` run once after every deploy (site-wide self-test; section `0c` reveals "the
      front end online is not the latest copy")

---

## Local development

You can run it without Docker:

```bash
npm install
DB_PATH=./data/app.db PORT=20010 node src/index.js
```

> ⚠️ **`--build` is only needed in local build mode**: both `COPY` lines in the Dockerfile
> (`src ./src`, `public ./public`) copy **whole directories**, so changing the back end **or** the
> front end requires a fresh `--build`; a plain `restart` does nothing. After rebuilding, **hard
> refresh** the browser — F5 alone may serve cached files. With the GHCR image this step does not
> exist — `docker compose pull && docker compose up -d` is enough.
>
> ⚠️ `COPY` **ignores `.gitignore`**, so any `*.bak` in those directories gets baked into the image
> as-is. The ones under `public/` are especially dangerous — that directory is served **without
> authentication** by `express.static`, so leaking an `app.js.bak` there publishes the whole
> front-end source. The repository's root `.dockerignore` already excludes them — **do not delete
> it**; see [Hardening](#hardening).

---

## See also

- [README](../README.md) — project overview
- [API reference](API.en.md) — endpoints
- [Template syntax](TEMPLATE.en.md) — webhook templates
- [Routing rules](ROUTES.en.md) — the rule engine
- [Release process](RELEASE.en.md) — tags and GHCR images
