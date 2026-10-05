# 部署指南

> **English**: [DEPLOY.en.md](DEPLOY.en.md)（章节级英文目录）

从零到生产环境的完整指南。

## 目录

- [部署模式](#部署模式)
- [环境变量](#环境变量)
- [方式一：直接暴露端口](#方式一直接暴露端口)
- [方式二：内置 HTTPS](#方式二内置-https)
- [方式三：Nginx 反代](#方式三nginx-反代)
- [方式四：Caddy 反代](#方式四caddy-反代)
- [方式五：Traefik 反代](#方式五traefik-反代)
- [备份与恢复](#备份与恢复)
- [日志与监控](#日志与监控)
- [更新与回滚](#更新与回滚)
- [日常运维命令](#日常运维命令)
- [常见问题](#常见问题)
- [安全加固](#安全加固)
- [生产环境检查清单](#生产环境检查清单)
- [本地开发](#本地开发)

---

## 部署模式

| 场景 | 推荐方案 |
|---|---|
| 局域网自用 | 方式一（直接暴露） |
| 公网有域名 | 方式二（内置 HTTPS） |
| 已有 Nginx | 方式三（Nginx 反代） |
| 已有 Caddy | 方式四（Caddy 反代） |
| 已有 Traefik | 方式五（Traefik 反代） |

### 两种 compose 布局

仓库里自带的 `docker-compose.yml` 是**单容器版**（默认 `image: ghcr.io/yezi8430/chatz:latest`，
拉现成镜像；`build: .` 那行是注释掉的），直接放在项目根目录，对应方式一和方式二。

方式三 / 四 / 五需要额外挂一个反代容器，用的是**父目录布局**：把 Chatz 项目
放进一个子目录，父目录放一个新的 `docker-compose.yml`（同样默认走 `image:`）。
本文示例以 `/root/chatz/` 作为父目录、`/root/chatz/chatz/` 作为项目目录。

### 镜像模式 vs 本地构建（本文所有命令按**镜像模式**写）

| | 镜像模式（默认，推荐） | 本地构建（改源码时才用） |
|---|---|---|
| compose 里 | `image: ghcr.io/yezi8430/chatz:latest` | `build: .`（`image:` 必须注释掉） |
| 首次启动 | `docker compose up -d` | `docker compose up -d --build` |
| 升级 | `docker compose pull && docker compose up -d` | `git pull && docker compose up -d --build` |

> 🔴 **`image:` 和 `build:` 只能留一个。** 两个同时开着时，本地构建产物会被打上
> `ghcr.io/yezi8430/chatz:latest` 标签、把远端镜像顶掉，此后 `docker compose pull`
> 只回一句 `Skipped - No image to be pulled`（**不报错**）—— 你以为在升级，
> 其实一直在跑自己那份旧构建。**本文的启动命令一律按镜像模式写**（不带 `--build`）。

> 两种布局二选一，不要同时跑 —— 否则两个 compose 会抢同一个容器名 `chatz`。

---

## 环境变量

全部可选，不填就用默认值。写在 `.env` 里（文件本身也可不建，见 README）。

| 变量 | 默认 | 说明 |
|---|---|---|
| `AUTH_TOKEN` | 自动生成并存库 | 管理员 Token。不设则首次启动生成随机值（`cz.` + 30 位 base62，共 33 字符），之后复用 |
| `PORT` | `20010` | HTTP 端口 |
| `HTTPS_PORT` | `20443` | HTTPS 端口（上传证书后启用） |
| `AGG_WINDOW_MS` | `300000` | 消息聚合时间窗口（毫秒），默认 5 分钟；设为 `0` 关闭聚合 |
| `AGG_MAX_LIFETIME_MS` | `1800000` | 单条聚合消息的**最长寿命**（毫秒），默认 30 分钟，从它诞生时算起；设为 `0` 不限制 |
| `DB_PATH` | `./data/app.db` | SQLite 文件路径。数据目录 = 该文件所在目录 |
| `CERTS_UI_ENABLED` | `true` | 设为 `false` 可隐藏网页端的「HTTPS 证书」面板 |
| `TRUST_PROXY` | 关闭 | 是否信任反向代理的 `X-Forwarded-For`，见下节 |
| `HSTS_MAX_AGE` | `0`（不发） | HSTS 有效期秒数。> `0` 且请求为 HTTPS 时才下发该头 |
| `HSTS_INCLUDE_SUBDOMAINS` | `false` | HSTS 是否附带 `includeSubDomains` |
| `AUDIT_RETENTION_DAYS` | `90` | 审计日志保留天数，`0` = 不按时间清理 |
| `AUDIT_MAX_ROWS` | `50000` | 审计日志最大条数，超出后从最旧的开始删，`0` = 不限 |
| `ATTACHMENT_MAX_FILE_MB` | `8` | 单个附件大小上限。附件支持**任意文件类型**，这个值是唯一的单文件闸门 |
| `ATTACHMENT_MAX_TOTAL_MB` | `500` | 附件目录总容量上限，超出后上传返回 `507`。孤儿附件只在**启动时**扫一次，所以这个上限是防止磁盘被写满的主要手段 |

> ⚠️ **优先级坑**：同一个服务里 `environment:` 的优先级高于 `env_file:`。
> `docker-compose.yml` 的 `environment:` 段已经写死了 `PORT`、`HTTPS_PORT`、`TRUST_PROXY`，
> 在 `.env` 里再填这三个是**没有效果**的，而且不会有任何报错。
> 要让它们可被 `.env` 覆盖，得先把 compose 改成插值写法，例如 `TRUST_PROXY: ${TRUST_PROXY:-auto}`。

> ⚠️ **反过来的坑（2026-10-01 实测踩到）**：`AGG_WINDOW_MS=1000 docker compose up -d chatz`
> 这种**命令行前缀写法对容器无效**。那个前缀只喂给 compose 的**变量插值**（就是上一段说的
> `${...}` 写法），而 `docker-compose.yml` 的 `environment:` 里并没有这一项 —— 其余变量是经
> `env_file: .env` 进容器的。结果：compose 认为配置没变，**容器压根不重建**，应用里还是旧值，
> 同样没有任何报错（`docker compose up` 只会打印一行 `Container chatz Running`）。
>
> **怎么判断生效没有**：改完直接读配置接口 —— `curl -s http://192.168.2.100:20010/config`，
> 聚合相关的 `aggWindowMs` / `aggMaxLifetimeMs` 就在响应里（`/config` 是公开接口）。
>
> **靠谱的改法**：
> 1. 写进 `.env` 再 `docker compose up -d chatz`（`env_file` 内容变了会触发重建）。
> 2. 只想临时试一次、不想动 `.env` —— 用 override 文件：
>    ```bash
>    cd /root/chatz/chatz
>    cat > docker-compose.vftest.yml <<'EOF'
>    services:
>      chatz:
>        environment:
>          AGG_MAX_LIFETIME_MS: "5000"
>    EOF
>    docker compose -f docker-compose.yml -f docker-compose.vftest.yml up -d chatz
>    # 测完还原
>    docker compose up -d chatz && rm -f docker-compose.vftest.yml
>    ```
>    注意 `docker compose exec/logs` 不带 `-f` 也能找到同一个容器（`container_name: chatz` 写死了），
>    所以 `verify-full.sh` 照常跑。
> 3. `--force-recreate` 只是强制重建，**不能**把命令行前缀那种值带进去（那本来就没进 compose 配置）。

### `TRUST_PROXY` —— 唯一需要按部署方式判断的变量

限速和审计日志都取「客户端 IP」。这个 IP 怎么来，决定了限速是不是形同虚设：

`X-Forwarded-For`（XFF）是客户端自带的头，**谁都能伪造**。无条件采信的话，
攻击者每发一个请求换一个值就能换一个限速桶，注册 / 登录限速全部失效。
但完全不看它也不行 —— 前面有反代时所有请求的 TCP 对端都是反代自己。

四种取值（以下用 express 4 + proxy-addr 2 实测过）：

| 取值 | 含义 | 安全性 |
|---|---|---|
| 不设 / `false` / `off` / `0` | 只认 TCP 对端，完全不看 XFF | 无反代时正确 |
| `true` | 直接取 XFF 第一段 | **不推荐**，追加模式下拿到的是伪造值 |
| 正整数 `N` | 取 XFF 倒数第 N 段（跳数） | 可以，但**不校验对端** |
| IP / CIDR / 网段名，逗号分隔 | 只信任列表内的对端，其它来源一律忽略 XFF | **最稳** |

**大多数场景填 `auto` 就够了**，不用去查反代的内网 IP。含义是
「对端是本机 / 内网就当它是代理、解析它写的 XFF；对端是公网地址就忽略 XFF」：

```bash
TRUST_PROXY=auto
```

| 请求来源 | 对端地址 | 结果 |
|---|---|---|
| NPM 是 Docker 容器 | `172.17.0.1`、`172.18.0.1` | 取 XFF ✅ |
| NPM 装在宿主机 | `127.0.0.1` | 取 XFF ✅ |
| 反代在局域网另一台机器 | `192.168.x.x` | 取 XFF ✅ |
| 攻击者绕过反代直连 20010 | 他的公网 IP | **忽略 XFF，取真实对端** ✅ |

**取舍**：`auto` 等于信任整个内网网段，同一台机器上的别的服务也能伪造 XFF。
家用 / 单机自托管基本不用在意；多租户环境请改成填反代的精确 IP。

| 部署方式 | 该设成什么 |
|---|---|
| 端口直接对外（无反代） | **不要设**（保持关闭） |
| 有反代，不想折腾 | **`auto`** |
| 有反代，且能接受查一次 IP | 反代的精确内网 IP，如 `172.17.0.1` |
| 单层反代，且 20010 无法被公网直连 | `1` |
| CDN + 反代（两层），端口不直连 | `2` |

#### ⚠️ 跳数模式的坑：端口不能同时直连

`TRUST_PROXY=1` 是**按位置**取 XFF 倒数第 1 段，不校验对端是不是你的反代。
所以只要 20010 还能被公网直接访问，攻击者绕过反代带上伪造 XFF 就能成功：

```text
TRUST_PROXY=1   XFF="9.9.9.9"  socket=203.0.113.66  →  认定 IP = 9.9.9.9   ← 伪造成功
TRUST_PROXY=172.18.0.5 同样请求                      →  认定 IP = 203.0.113.66 ← 正确
```

**配了跳数就必须保证本端口只能由反代到达**（防火墙只放行 80、443）。
做不到就改成填反代的内网 IP —— 那种模式先校验对端，端口暴露也不会被伪造。

#### Nginx Proxy Manager（NPM）

NPM 本身就是 Nginx，属单层反代，**必须设** `TRUST_PROXY`，否则审计日志里
所有人都是 NPM 的内网 IP，一个人触发限速就全站 429。20010 还能被公网直连时
（IPv6 尤其常见）**不要填 `1`**，直接填 `auto`：

```bash
# .env
TRUST_PROXY=auto
```

想知道 NPM 的具体 IP、改填精确值也行：

```bash
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' <NPM容器名>
TRUST_PROXY=172.18.0.5
```

顺手在 NPM 的 Proxy Host → Advanced → Custom Nginx Configuration 里写死一行，
确保客户端伪造的 XFF 被丢掉：

```nginx
# ✅ 覆盖：客户端伪造的值被丢掉，配 1 / 填 IP / 配 true 都安全
proxy_set_header X-Forwarded-For $remote_addr;

# ⚠️ 追加：第一段保留客户端伪造值。配 1 或填 IP 仍正确，配 true 会把 IP 交给攻击者
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

NPM 默认用 `$proxy_add_x_forwarded_for`（追加）也**不会**出问题 ——
只有配 `true` 才会被伪造值坑到。

填错或填了认不出来的值不会崩：启动时会打一条 warning，然后按「不信任」继续跑。

---

## 方式一：直接暴露端口

**最简单**。局域网或测试环境用。

```bash
cd /root/chatz/chatz
docker compose up -d
```

访问 `http://<服务器IP>:20010/`。

注意：

- Android 9+ 默认禁止明文 HTTP，需要 App 里加 `android:usesCleartextTraffic="true"`，或者用 HTTPS
- 公网暴露有风险，至少要改 `AUTH_TOKEN`

> ℹ️ **`.env` 现在是可选的**：compose 里写的是 `env_file: - path: .env / required: false`，
> 文件不存在时 Compose 会静默跳过而不是报错。要自定义变量再 `cp .env.example .env`。
> 代价是这个 mapping 写法要求 **Compose ≥ 2.24.0**（`docker compose version` 可查）。

---

## 方式二：内置 HTTPS

Chatz 自带 HTTPS，上传证书即可，不用额外组件。

### 步骤

1. 准备证书（通配符或单域名都行）

- `fullchain.pem` — 证书 + 中间证书
- `privkey.pem` — 私钥

2. 启动 Chatz

```bash
docker compose up -d
```

3. 登录网页 → 右上角 👤 → HTTPS 证书

- 上传 `fullchain.pem`
- 上传 `privkey.pem`
- 点「上传证书」

4. 日志会打印

```text
✅ 证书已热更新
🔒 HTTPS 已启动，监听端口 20443
```

5. 访问

```text
https://<host>:20443/
```

### 把 20443 映射到 443

改项目里的 `docker-compose.yml`：

```yaml
services:
  chatz:
    ports:
      - "20010:20010"
      - "443:20443"
```

这样用户直接访问 `https://<域名>/` 就行。

### 证书来源

```bash
# 用 certbot 申请（需要 80 端口）
certbot certonly --standalone -d your-domain.com

# 证书在
# /etc/letsencrypt/live/your-domain.com/fullchain.pem
# /etc/letsencrypt/live/your-domain.com/privkey.pem
```

阿里云 / 腾讯云 / DNSPod 免费证书：控制台申请，下载 Nginx 版本。

通配符证书（推荐）：一张证书搞定所有子域名，有效期长（1 年），不用频繁换。

### 上传时的校验

服务端会拦掉这几种情况，直接返回 400：

| 校验项 | 说明 |
|---|---|
| PEM 可解析 | 必须含 `BEGIN CERTIFICATE` / `PRIVATE KEY` 块 |
| 有效期 | 已过期、尚未生效都拒绝 |
| 配对 | 已存在一个时，会用公钥比对另一个；不匹配拒绝 |

只上传了其中一个文件时不会启动 HTTPS，接口返回「等待上传私钥 / 证书」。

### 优缺点

优点：

- 单容器，部署简单
- 证书热更新，不用重启
- 不需要额外组件

缺点：

- 只有一个端口，多个服务难共享
- 没有 WAF、限流、访问日志

---

## 方式三：Nginx 反代

已有 Nginx 或需要更多功能（限流、WAF、访问日志）。

### 拓扑

```text
用户 ──HTTPS──▶ Nginx:443 ──HTTP──▶ Chatz:20010
```

### 目录结构

```text
/root/chatz/
├── docker-compose.yml
├── nginx/
│   ├── conf.d/
│   │   └── chatz.conf
│   └── nginx.conf
└── chatz/              # Chatz 项目
```

### docker-compose.yml

```yaml
services:
  chatz:
    build: ./chatz
    container_name: chatz
    expose:
      - "20010"           # 只对内网暴露
    env_file:
      - ./chatz/.env
    environment:
      PORT: 20010
      TRUST_PROXY: auto   # 前面有一层 Nginx：按 XFF 取真实客户端 IP
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
        # 用 $remote_addr（覆盖）而不是 $proxy_add_x_forwarded_for（追加）：
        # 追加会把客户端伪造的 XFF 保留在第一段，服务端就可能被骗
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # 其他
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

### 客户端 IP 与 `TRUST_PROXY`（必读）

服务端默认**不信任** `X-Forwarded-For` —— 这个头是客户端自带的，谁都能伪造。
如果无条件采信，攻击者每发一个请求换一个 XFF 值就能换一个限速桶，
注册 / 登录的限速会完全失效。所以限速和审计日志取 IP 的规则是：

| `TRUST_PROXY` | 取哪个 IP |
|---|---|
| 不设（默认） | TCP 对端地址。适合端口直接暴露、前面没有反代的场景 |
| **`auto`** | **推荐**。对端是本机 / 内网就当代理解析 XFF，公网对端一律忽略 XFF。等价于 `loopback,linklocal,uniquelocal` |
| `1` | 跳过 1 跳反代，取反代看到的对端地址。**仅在 20010 无法被公网直连时可用** |
| `2` | 跳过 2 跳（CDN + Nginx 这类两层结构），同样要求端口不直连 |
| `172.17.0.1` / `172.16.0.0/12` | 只信任这些地址来的代理，其它来源一律忽略 XFF |
| `true` | 直接取 XFF 第一段。只在确认反代**覆盖** XFF（`$remote_addr`）时才用 |

想省事就填 `auto`：不用去 `docker inspect` 查反代 IP，而且端口（含 IPv6）公网直连也安全 ——
公网来源的对端不在信任列表里，XFF 会被直接忽略。代价是整个内网网段都被信任，
多租户环境请改成填精确 IP。

⚠️ 用反代就必须设 `TRUST_PROXY`。不设的话所有请求都记成 Nginx 的内网 IP，
限速会把所有人算成同一个 —— 一个人触发限速，全站都 429。

#### 跳数模式的坑：端口不能同时直连

`TRUST_PROXY=1` 是按位置取 XFF 倒数第 1 段，**不校验对端是不是真的反代**。
实测结果：

```text
TRUST_PROXY=1            XFF="9.9.9.9"  socket=203.0.113.66  →  9.9.9.9        ← 伪造成功
TRUST_PROXY=auto         XFF="9.9.9.9"  socket=203.0.113.66  →  203.0.113.66   ← 正确
TRUST_PROXY=auto         XFF="9.9.9.9"  socket=240e:3b7::1   →  240e:3b7::1     ← IPv6 直连同样正确
TRUST_PROXY=172.18.0.5   XFF="9.9.9.9"  socket=203.0.113.66  →  203.0.113.66   ← 正确
```

所以配跳数的前提是**本端口只能由反代到达**：防火墙 / 安全组只放行 80、443。
做不到就填 `auto` 或反代的内网 IP —— 这两种先校验对端，端口开着也伪造不了。

#### 用 Nginx Proxy Manager（NPM）

NPM 就是 Nginx，属于单层反代，必须设 `TRUST_PROXY`。20010 能被公网直连（IPv6 很常见）
时别用 `1`，直接写：

```bash
# .env  —— 不用查 IP，一行搞定
TRUST_PROXY=auto
```

想填精确值也行：

```bash
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' <NPM容器名>
TRUST_PROXY=172.18.0.5
```

NPM 里建议在 Proxy Host → Advanced → Custom Nginx Configuration 写死一行：

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
```

NPM 默认的 `$proxy_add_x_forwarded_for`（追加）也不会出问题 —— 追加模式下配 `1`
或填 IP 都能拿到真实地址，只有配 `true` 才会被伪造值坑到。

填错不会崩：启动时打一条 warning，然后按「不信任」继续跑。

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

### 放置证书

```bash
mkdir -p nginx/certs
cp /path/to/fullchain.pem nginx/certs/
cp /path/to/privkey.pem nginx/certs/
```

或用 Let's Encrypt：

```bash
# 用 certbot 生成到宿主机
certbot certonly --webroot -w /var/www/certbot -d chatz.your-domain.com

# 把证书软链或复制到 nginx/certs/
```

### Let's Encrypt 自动续期

```bash
crontab -e
```

加一行（每天凌晨 3 点检查）：

```text
0 3 * * * docker run --rm \
  -v /root/chatz/nginx/certbot-www:/var/www/certbot \
  -v /etc/letsencrypt:/etc/letsencrypt \
  certbot/certbot renew --webroot -w /var/www/certbot --quiet && \
  docker exec chatz-nginx nginx -s reload
```

### 启动

```bash
cd /root/chatz
docker compose up -d
docker compose logs -f nginx --tail=20
```

---

## 方式四：Caddy 反代

Caddy 自动申请 HTTPS 证书，配置最少。

### docker-compose.yml

```yaml
services:
  chatz:
    build: ./chatz
    container_name: chatz
    expose:
      - "20010"
    env_file:
      - ./chatz/.env
    environment:
      PORT: 20010
      TRUST_PROXY: auto   # 前面有一层 Caddy
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

就这么简单。Caddy 会自动：申请 Let's Encrypt 证书、配置 HTTP→HTTPS 跳转、
处理 WebSocket、自动续期。

### 启动

```bash
docker compose up -d
docker compose logs -f caddy --tail=20
```

第一次启动会打印证书申请日志。

---

## 方式五：Traefik 反代

Traefik 适合已有 K8s 或需要动态服务发现的场景。

### docker-compose.yml

```yaml
services:
  chatz:
    build: ./chatz
    container_name: chatz
    expose:
      - "20010"
    env_file:
      - ./chatz/.env
    environment:
      PORT: 20010
      TRUST_PROXY: auto   # 前面有一层 Traefik
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

### 准备 acme.json

```bash
touch acme.json
chmod 600 acme.json
```

### 启动

```bash
docker compose up -d
docker compose logs -f traefik --tail=20
```

---

## 备份与恢复

### 备份什么

| 目录/文件 | 内容 |
|---|---|
| `chatz/data/` | 数据库、图标、头像、附件、背景、**HTTPS 证书** |
| `chatz/.env` | `AUTH_TOKEN` 配置 |
| `chatz/docker-compose.yml` | 部署配置 |
| `nginx/certs/` | Nginx 证书（用反代的话） |

数据目录的位置由 `DB_PATH` 决定（容器里是 `/app/data/app.db`），
**整个 `data/` 挂出来就全保住了**，证书也在里面。

### 一键备份

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

echo "✅ 备份完成：$FILE ($(du -h $FILE | cut -f1))"

# 保留最近 7 份
cd $BACKUP_DIR
ls -t chatz-*.tar.gz | tail -n +8 | xargs -r rm
SCRIPT

chmod +x /root/chatz/backup.sh
```

加入定时任务：

```bash
crontab -e
# 加一行：
# 0 3 * * * /root/chatz/backup.sh >> /var/log/chatz-backup.log 2>&1
```

### 安全备份数据库

直接 `tar` 打包 `app.db` 时，如果服务正在写入，可能打包到不一致的状态
（数据还留在 WAL 里）。更安全的方式是用 SQLite 的 backup API：

```bash
docker exec chatz node -e '
const db = require("./src/db");
db.backup("/app/data/backup-" + Date.now() + ".db").then(() => {
  console.log("✅ 备份完成");
  process.exit(0);
});
'

docker cp chatz:/app/data/backup-xxx.db /root/backups/
docker exec chatz rm /app/data/backup-xxx.db
```

> `require("./src/db")` 的路径是**相对容器工作目录 `/app`** 的。
> Dockerfile 里 `WORKDIR /app`、`COPY src ./src`，所以 `/app/src/db.js` 存在。
> 项目里没有顶层的 `db.js`，写成 `require("./db")` 会直接 `MODULE_NOT_FOUND`。

### 恢复

```bash
# 1. 停服务（反代布局：在父目录执行）
cd /root/chatz
docker compose down

# 2. 备份当前状态（以防万一）
mv chatz chatz-old

# 3. 解压备份
tar -xzf /root/chatz-backups/chatz-20260921-0300.tar.gz

# 4. 启动（仍在父目录，用父级的 compose）
docker compose up -d

# 5. 验证
curl http://localhost:20010/health
```

> 第 4 步要在**父目录**跑。若 `cd chatz` 后执行，用的是仓库自带的那份
> 单容器 compose，反代容器不会被拉起来。

---

## 日志与监控

### 启动日志都打印什么

只打印**有信息量**的内容，固定横幅一律不打：

| 情况 | 是否打印 |
|---|---|
| 启动 / 就绪分隔线（带时间戳） | ✅ 每次打。容器日志是 append 的，连续 `restart` 时上一轮的退出日志会和这一轮的启动日志粘在一起，加分隔线才能看出边界 |
| 收到信号、正在关闭 | ✅ 每次打，是同级分隔线 |
| 数据库迁移检查跑过一遍、没改动 | ❌ 不打（幂等检查，每次启动都跑，没改就没必要说） |
| 迁移**真的**改了表结构 / 补了数据 | ✅ 打一行，形如 `🔧 数据库迁移：应用 2 项变更 → messages.tags, users.avatar` |
| 清理掉孤儿附件 | ✅ 打一行，带数量 |
| 审计日志裁剪删了记录 | ✅ 打一行，带数量 |
| `TRUST_PROXY` 当前状态 | ✅ 每次打（部署排查要看） |
| `AUTH_TOKEN` 完整值 | 仅「数据库里没有 Token」（全新数据目录）时打一次，之后只给指纹 |
| `AUTH_TOKEN` 来自环境变量 / 数据库 | ❌ 不打完整值（环境变量去 `.env` 看） |

**连着重启时日志看起来"交错"是正常的**，不是启动失败。用分隔线切就行：

```text
──────── 启动 00:20:11 ────────     ← 上一轮，成功起来了
...
──────── 就绪 ────────
──────── 收到 SIGTERM，正在关闭 ────────   ← 上一轮被 restart 干掉
✅ 数据库已关闭
──────── 启动 00:22:03 ────────     ← 这一轮
...
──────── 就绪 ────────
```

`docker compose restart` 有时会连发两次 SIGTERM，第二次会打
`（已在关闭中，忽略重复的 SIGTERM）` —— 那是防重入保护，正常。

全新数据目录（数据库里没有 Token）时会**完整打印一次** Token，之后永远只给 8 位指纹：

```text
🔑 AUTH_TOKEN [本次启动自动生成]
   cz.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ⚠️  请立即妥善保存，之后不会再打印完整值
```

> 只在这一次打印是刻意的：每次启动都往日志里写完整密钥，等于让密钥长期留在
> `docker logs` / 日志驱动里 —— 日志会被采集、转发、备份，暴露面比它需要的大得多。

之后想拿完整值，两个地方：网页端「账户 → 安全与登录 → 登录设备」的复制按钮，或数据库：

```bash
docker compose exec chatz node -e 'console.log(require("better-sqlite3")("/app/data/app.db").prepare("SELECT value FROM meta WHERE key = ?").get("auth_token").value)'
```

> 💡 SQL 的字符串字面量必须用**单引号**。写成 `key = "auth_token"` 会被 SQLite 当成**列名**，
> 报 `no such column: "auth_token"` —— shell、JS、SQL 三层引号叠在一起极容易踩到。
> 上面用绑定参数（`?` + `.get("auth_token")`）天然绕开这一层，查别的 key 只改最后一处。

### 查看日志

```bash
# 实时
docker compose logs -f

# 最近 100 行
docker compose logs --tail=100

# 只过滤错误
docker compose logs --tail=100 | grep -i error

# 导出到文件
docker compose logs --since=24h > chatz-$(date +%Y%m%d).log
```

### Docker 日志轮转

默认 Docker 日志不限制大小，跑久了会占满磁盘。在 `docker-compose.yml` 里加：

```yaml
services:
  chatz:
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

或全局改 `/etc/docker/daemon.json`：

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

### 健康检查

仓库自带的 `docker-compose.yml` 里已经配了：

```yaml
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://localhost:20010/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
  interval: 30s
  timeout: 5s
  retries: 3
```

查看健康状态：

```bash
docker compose ps
docker inspect --format='{{.State.Health.Status}}' chatz
```

### 用 Uptime Kuma 监控 Chatz 本身

好玩的递归：用 Uptime Kuma 监控 Chatz，同时 Chatz 又收 Uptime Kuma 的告警。

Uptime Kuma 里添加一个 HTTP 监控：

- URL：`http://your-server:20010/health`
- 检查字段：`"ok":true`

---

## 更新与回滚

### 更新代码

```bash
cd /root/chatz/chatz

# 1. 备份
cp -r . ../chatz.bak-$(date +%Y%m%d)

# 2. 拉新版本（镜像模式：拉镜像；本地构建模式：git pull）
docker compose pull

# 3. 重建（让容器用上新镜像）
#    单容器布局：就在当前目录
docker compose up -d
#    反代布局：回到父目录
# cd /root/chatz && docker compose up -d

# 4. 验证
docker compose logs -f --tail=30
curl http://localhost:20010/health

#    全站接口自检（可选，但强烈建议）：
#    会创建并删除若干测试频道/应用/消息，文件里含真实 token ⇒ 跑完记得 rm -f verify-full.sh
bash verify-full.sh

#    · 0c 段：把本地 public/ 与线上**正在伺服**的字节比 sha256
#      —— 专门用来抓「线上前端不是最新那份」（本地构建忘 --build / 镜像模式忘 pull）
#    · 8.6 段：验证消息聚合（含主卡去图、aggChildren 含原消息本身）
#    · 8.6b 段（默认跳过）：AGG_TEST_LIFETIME=1 bash verify-full.sh
#      需先把 AGG_MAX_LIFETIME_MS 临时调小，验「寿命到了就另起一条、不再续命」
```

### 数据库迁移

自动执行。服务启动时 `src/migrate.js` 会检查所有字段并补齐缺失的列
（用 `PRAGMA table_info` 判断，幂等）。

新增字段都是可空的，不会破坏现有数据。加新表用 `CREATE TABLE IF NOT EXISTS`。

迁移完成后会执行一次 `wal_checkpoint(TRUNCATE)`，把 WAL 落回主库文件，
降低容器被强杀时丢数据的风险。

### 回滚

```bash
# 1. 停服务
docker compose down

# 2. 从备份恢复
rm -rf chatz
mv chatz.bak-20260921 chatz
cd chatz

# 3. 重启
docker compose up -d

# 4. 验证
curl http://localhost:20010/health
```

---

## 日常运维命令

```bash
# 启动
docker compose up -d

# 升级（镜像模式：先拉镜像）
docker compose pull && docker compose up -d

# 本地构建模式：改了 src/ 或 public/ 之后必须带 --build，只 restart 不生效
# docker compose up -d --build

# 停止
docker compose down

# 看日志
docker compose logs -f --tail=50

# 进入容器
docker exec -it chatz sh
```

备份 / 恢复见 [备份与恢复](#备份与恢复)。

查数据库（容器里模块路径是 `./src/db`，写 `./db` 会 MODULE_NOT_FOUND）：

```bash
docker exec -it chatz node -e '
const db=require("./src/db");
console.log("用户:", db.prepare("SELECT id,username,is_admin FROM users").all());
console.log("频道:", db.prepare("SELECT id,name FROM channels").all());
console.log("应用:", db.prepare("SELECT id,name,token FROM applications").all());
console.log("规则:", db.prepare("SELECT id,name FROM routes").all());
'
```

---

## 常见问题

### 端口被占用

```text
Error starting userland proxy: listen tcp4 0.0.0.0:20010: bind: address already in use
```

查占用：

```bash
ss -tlnp | grep 20010
```

改 `docker-compose.yml` 里映射的端口（左边是宿主机端口）：

```yaml
ports:
  - "30010:20010"    # 宿主用 30010，容器仍用 20010
```

### compose 起不来：env file not found

说明你的 compose 版本低于 2.24.0，不认 `env_file` 的 mapping 写法
（`path` + `required: false`，这个字段是 2.24.0 才加的）。

```bash
docker compose version
# 升级 Compose，或者退回老办法：建一个（可以是空的）.env 文件
cd /root/chatz/chatz
touch .env
```

⚠️ 不要为了绕开这个报错就去改 compose 里的 `required: false`，
那是「文件缺失时静默跳过」的意思，不是把你这条配置删掉。

> ⚠️ **优先级坑**：同一个服务里 `environment:` 的优先级高于 `env_file:`。
> `docker-compose.yml` 的 `environment:` 段已经写死了 `PORT` / `HTTPS_PORT` / `TRUST_PROXY`，
> 在 `.env` 里再填这三个值是**无效的、会被静默忽略**。
> 想让它们可被 `.env` 覆盖，先把 compose 改成插值写法：`TRUST_PROXY: ${TRUST_PROXY:-auto}`。

### HTTPS 上传失败

- 检查证书文件格式（必须是 PEM）
- 检查私钥是否与证书匹配

```bash
openssl x509 -noout -modulus -in fullchain.pem | md5sum
openssl rsa -noout -modulus -in privkey.pem | md5sum
# 两个 md5 必须一致
```

- 检查 `fullchain.pem` 是否包含完整链（证书 + 中间证书），不是只有叶子证书
- 服务端还会检查有效期，过期 / 未生效都会被拒 —— 看接口返回的 `error` 字段

### WebSocket 连不上

用浏览器 DevTools → Network → WS：

- 状态码 **101** → 成功
- 状态码 **401** → Token 错
- 状态码 **502** → 反代没配 `Upgrade`
- 状态码 **429** → 该用户连接数超过 10（关掉几个浏览器标签页）

nginx 反代时检查：

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

另外，WebSocket 只接受路径 `/stream`，其他路径会在 upgrade 阶段就被断掉。

### 想把 `AUTH_TOKEN` 从 `.env` 挪到数据库自动生成

不设这个环境变量就会自动生成（`cz.` + 30 位 base62，存 `meta` 表），所以只要删掉它：

```bash
# .env 里把这行删掉或注释掉
# AUTH_TOKEN=cz.kR9mX2pQ7tL...

docker compose restart
```

日志会告诉你走到了哪条分支：

| 日志 | 含义 |
|---|---|
| `🔑 AUTH_TOKEN [本次启动自动生成]` + 完整值 | 数据库里没有 Token（全新数据目录），这次新生成，**立刻保存** |
| `🔑 AUTH_TOKEN 就绪 [数据库（首次生成时已打印）] · 指纹 xxxx…` | 复用旧值，到「安全与登录 → 登录设备」复制 |

两个容易忽略的点：

- **旧 Token 不会失效**：它已经是 `devices` 表里的「默认 Token」，已配好的 App / 脚本继续可用；
  要作废就去「账户 → 安全与登录 → 登录设备」删掉那条记录
- **admin 的初始密码仍然是旧 Token**：首次安装时 admin 密码 = 当时的 Token，换 Token 不会跟着变。
  这个值在 `.env` / 备份里躺了很久的话建议换掉 —— 网页端「账户 → 安全与登录 → 修改密码」就行，
  登不进去再用下面的改数据库方法。

### 数据丢失

检查挂载：

```bash
docker inspect chatz | grep -A 5 Mounts
```

应该看到：

```json
"Source": "/root/chatz/chatz/data",
"Destination": "/app/data"
```

如果没有，数据在容器里，`docker compose down` 就删了。

### 内存占用高

Chatz 本身很轻，但 SQLite + WAL + 消息累积会慢慢占内存。

清理软删的老消息：

```bash
docker exec chatz node -e '
const db = require("./src/db");
const cutoff = Date.now() - 90 * 24 * 3600 * 1000; // 90 天前
const r = db.prepare("DELETE FROM messages WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(cutoff);
console.log("清理了", r.changes, "条软删消息");
'
```

加定时任务：

```bash
crontab -e
# 每周日凌晨 3 点清理
0 3 * * 0 docker exec chatz node -e 'const db=require("./src/db");const c=Date.now()-90*24*3600*1000;db.prepare("DELETE FROM messages WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(c);' >> /var/log/chatz-cleanup.log 2>&1
```

> **注意 `docker exec` 里的引号嵌套**：外层单引号包住整段 Node 脚本，
> cron 那一行的 `>> /var/log/...` 必须写在单引号**外面**。

### 忘记 AUTH_TOKEN

**配了环境变量**的情况，直接看 `.env`（这是全文）：

```bash
cat /root/chatz/chatz/.env | grep AUTH_TOKEN
```

**没配、由服务端自动生成**的情况，值在数据库 `meta` 表：

```bash
docker exec chatz node -e 'console.log(require("better-sqlite3")("/app/data/app.db").prepare("SELECT value FROM meta WHERE key = ?").get("auth_token").value)'
```

> ⚠️ **不要**再用 `docker compose logs | grep AUTH_TOKEN` 了。
> 从 v2.0.x 起启动日志只在**数据库里没有 Token（全新数据目录）时**打印完整 Token，之后每次启动只打印
> 8 位指纹（形如 `🔑 AUTH_TOKEN 就绪 [环境变量] · 指纹 kR9mX2pQ…`）。
>
> 改这么做的原因：每次启动都往容器日志写完整密钥，会让密钥长期留在
> `docker logs` / 日志驱动 / 备份里 —— 日志的暴露面比它需要的大得多，
> 而且值本身要么在 `.env` 里、要么在数据库里，本来就不用靠日志记。
>
> 老版本日志里已经出现过的 Token，可视为已泄漏。想轮换：
> `docker exec chatz node -e 'require("better-sqlite3")("/app/data/app.db").prepare("DELETE FROM meta WHERE key = ?").run("auth_token")'`
> 然后重启（注意：这会同时改掉 admin 的初始密码，需按下方「忘记用户密码」重设）。

### 启动日志里没有「数据库迁移」那一行，正常吗？

正常。迁移是幂等的，每次启动都会完整跑一遍检查，绝大多数时候什么都没改 ——
**没改就不打日志**。只有真的动了表结构或补了数据时才会出现一行：

```text
🔧 数据库迁移：应用 2 项变更 → messages.tags, users.avatar
```

同理，孤儿附件清理和审计日志裁剪也只在**确实删了东西**时才各打一行。
这样启动日志基本是稳定可预期的，多出来的行就是值得看一眼的信号。

### 日志里 shutdown 和 startup 混在一起，是启动失败了吗？

不是。Docker 的 stdout 是**跨容器生命周期追加**的，连续重启时上一次的关闭日志会
紧挨着下一次的启动日志，看起来像"启动一半又关了"。用分隔行区分每一次运行：

```text
──────── 启动 2026-09-28 14:02:11 ────────
✅ Chatz 已启动，监听端口 20010
   数据目录: /app/data/app.db
   网页版: http://<主机>:20010/
   推送接口: http://<主机>:20010/hook/<应用Token>
   消息聚合窗口: 300000ms（单条最长寿命 1800000ms）
   🛡️  TRUST_PROXY=off  →  限速 / 审计只认 TCP 对端地址（忽略 X-Forwarded-For）
🔑 AUTH_TOKEN 就绪 [环境变量] · 指纹 kR9mX2pQ…
──────── 就绪 ────────

──────── 收到 SIGTERM，正在关闭 ────────
✅ 数据库已关闭
```

- `──────── 启动 <时间> ────────` 到 `──────── 就绪 ────────` 之间 = 同一次启动
- `──────── 收到 <信号>，正在关闭 ────────` = 上一次运行的收尾
- 出现 `（已在关闭中，忽略重复的 SIGTERM）` 也是正常的：`docker compose restart`
  可能连发两次 SIGTERM，第二次会被重入保护拦掉，否则重复的 `db.close()` 会抛异常
  把真正的关闭信息盖掉

要看最近一次运行，用 `docker compose logs --since 5m`，或者按分隔行往后翻到最后一组。

### 忘记用户密码

**能登录**的话，直接改：网页端「账户 → 安全与登录 → 修改密码」（已登录即身份，**不用填旧密码**），或调接口：

```bash
curl -X PATCH https://<域名>/user/password \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"new_password":"新密码"}'
```

管理员还能重置别人（不需要旧密码，并且会吊销对方全部设备）：

```bash
curl -X PATCH https://<域名>/user/password \
  -H "Authorization: Bearer <管理员token>" \
  -H "Content-Type: application/json" \
  -d '{"userId":2,"new_password":"新密码"}'
```

**完全登不进去**时，用内置的重置命令（不需要登录、不需要旧密码）：

```bash
# 先看有哪些用户、用户名到底叫什么
docker compose exec chatz node src/reset-password.js --list

# 重置（密码直接写在参数里）
docker compose exec chatz node src/reset-password.js <用户名> '<新密码>'

# 不想让密码进 shell 历史，就从标准输入读
echo '<新密码>' | docker compose exec -T chatz node src/reset-password.js <用户名> --stdin
```

它会用和登录接口**完全相同**的 `hashPassword`（`src/migrate.js` 导出的 scrypt，
64 字节 + 随机 16 字节 salt）写库，所以重置出来的值一定能登录。
重置后 `devices` 一行都不动 —— 已登录的手机/浏览器不会被踢下线。

> 这套命令的信任模型：能执行它 = 能读写容器和 `data/app.db` = 本来就有完全控制权。
> 所以它不是新增的攻击面，只是把「手写一条 UPDATE」变成了不会打错的命令。

### 登录时报「用户名或密码错误」怎么排查

这个响应**同时覆盖两种情况**（这是刻意的，避免泄露"哪些用户名存在"）：

1. **用户名不存在** —— 打错字、或者首次引导时把 admin 改成了别的名字
2. **密码不对**

所以先确认用户名，再用这个脚本核对密码到底对不对（它会拿候选密码去比库里的哈希）：

```bash
docker compose exec -T -e PW='<你正在试的密码>' -e OLD='<以前的密码或旧token>' chatz node -e '
const crypto = require("crypto");
const db = require("better-sqlite3")("/app/data/app.db");
const users = db.prepare("SELECT id, username, is_admin, password_hash FROM users ORDER BY id").all();
const cands = [["新密码", process.env.PW], ["旧token", process.env.OLD]];
console.log("共 " + users.length + " 个用户");
for (const u of users) {
  const parts = String(u.password_hash || "").split(":");
  const salt = parts[0], hash = parts[1];
  const res = cands.map(function (c) {
    if (!c[1]) return c[0] + "=跳过";
    if (!salt || !hash) return c[0] + "=库里没有哈希";
    const chk = crypto.scryptSync(c[1], salt, 64).toString("hex");
    return c[0] + (chk === hash ? "=匹配" : "=不匹配");
  });
  console.log("#" + u.id + "  " + u.username + "  " + (u.is_admin ? "管理员" : "普通用户") + "  " + res.join("  "));
}
'
```

看到 `#N admin 管理员 新密码=匹配` 就说明密码是对的，问题在别处（用户名大小写、
输入法带进了不可见字符、或者前端还在发旧 token）。

### 网页端突然提示「登录状态已失效」并弹回登录页

这是前端的统一 401 处理（`public/app.js`）：**任何一个**接口返回 401，
就清掉 localStorage 里的 token 并回到登录页。原因通常是浏览器里存的那枚设备
Token 已经失效 —— 常见于轮换 `AUTH_TOKEN` 后把对应的 `devices` 行删掉了。
用新密码重新登录即可；不需要重启服务。

### 重新部署后 AUTH_TOKEN 变了 / 账号登录不上了

启动日志里 `🔑 AUTH_TOKEN [本次启动自动生成]` 这个标记只在
**数据库里没有 Token** 时才出现 —— 也就是说这次连的是个**全新数据目录**。
Token、账号、频道全都在 `data/app.db` 里，数据目录一换就全部从零开始。

排查：

```bash
# 1. 这次容器挂的是哪个目录（Source 就是宿主机路径）
docker inspect chatz --format '{{json .Mounts}}'

# 2. 那个目录里有没有旧的数据库、时间对不对
ls -la <上面的Source>
```

常见原因：换了部署目录（`./data` 是相对 compose 文件的）、
克隆了一份新仓库再 `up`、或者数据卷被清掉了。

想让 Token 不随数据目录变：在 `.env` 里写死 `AUTH_TOKEN=<固定值>`，
它的优先级高于数据库。全新数据目录配合首次引导页，打开网页直接设管理员账号即可，
不需要抄日志里的 Token。

### 手机收不到通知？

- 检查 App 里配置的服务器地址能不能在浏览器打开
- 检查 Token 是否正确
- Android 13+ 需要允许通知权限

### 消息发出去没收到？

- 检查是否被路由规则丢弃
- **检查你自己是否订阅了该频道** —— 没订阅就收不到，管理员在列表里「看得到」不等于「订阅了」
- 检查 WebSocket 是否连接

### 数据库怎么迁移？

服务启动时自动执行 `src/migrate.js`。所有新增字段都先判断列是否存在，安全幂等。

### 怎么发带图片的消息？

Markdown 图片语法：`![alt](https://example.com/img.jpg)`

或 extras：`{"extras": {"image": "https://..."}}`

### 消息聚合怎么关掉？

设置 `AGG_WINDOW_MS=0`。

如果想保留聚合、只是不想让**一条老消息被无限「续命」**（表现为：它永远停在列表原位不上浮，
后续几小时的新条目全被静默折进去，展开却只看得到最后 100 条），
把 `AGG_MAX_LIFETIME_MS` 调小即可（默认 `1800000` = 30 分钟）；设为 `0` 表示不限制。

### 注册的新账号看不到别人的频道？

注册**不会**自动订阅公开频道。去「发现频道」里显式订阅才会收到该频道消息
（唯一的例外：建频道的人自动订阅自己建的频道）。

### 附件会被一直留着吗？

不会。删消息时该消息独占的附件会跟着删；服务启动时还会全量扫一遍孤儿附件并清理。

---

## 安全加固

**1. `AUTH_TOKEN`** —— 推荐留空让服务端自动生成（`cz.` + 30 位 base62）。
要在自动化部署里钉死一个已知值，用：

```bash
AUTH_TOKEN="cz.$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 30)"
```

> 格式不必严格是 `cz.` 开头 —— 校验是整串等值匹配，填什么都能用。
> 统一成 `cz.` 只是为了一眼认出是 Chatz 凭据。

**2. 启用 HTTPS** —— 账户 → HTTPS 证书 → 上传 `fullchain.pem` + `privkey.pem`，立刻生效不用重启。

**3. 关掉公网 20010 端口** —— 只开放 443（映射到 20443）。

**4. 定期备份** —— 脚本见 [备份与恢复](#备份与恢复)。

**5. 反向代理加一层** —— 见方式三 / 四 / 五。配了反代记得同时设 `TRUST_PROXY`（见[环境变量](#环境变量)）。

**6. ⚠️ 多实例部署时限流会失效** —— `rateLimit` 是**进程内内存计数**：
跑 N 个副本，注册 / 登录 / webhook 的限流就被放大 N 倍；实例重启计数清零。
WebSocket 的连接数上限（`MAX_TOTAL` / `MAX_PER_USER`）同理，也是各实例各算各的。

单实例部署**没有影响**，不用管。要横向扩容就在**反代层**补限流：

```nginx
# Nginx：在反代上按 IP 限流（示例：登录类接口 10r/m）
limit_req_zone $binary_remote_addr zone=chatz:10m rate=10r/m;
limit_req zone=chatz burst=5 nodelay;
```

Caddy / Traefik 也有对应的 rate limit 中间件，效果一样。

**7. 用审计日志回溯操作** —— 服务端记录：登录成功 / 失败、设备签发与吊销、应用和频道的增删改、
路由规则改动、证书上传与删除、消息删除、无效 token 尝试。只记元信息，**不记私钥内容和完整 token**。

```bash
curl -H "X-Gotify-Key: $TOKEN" 'http://<host>:20010/audit?limit=50'
# 只看某个人的操作
curl -H "X-Gotify-Key: $TOKEN" 'http://<host>:20010/audit?userId=1&limit=50'
# 只看登录失败
curl -H "X-Gotify-Key: $TOKEN" 'http://<host>:20010/audit?action=login&limit=50'
```

**7. 别让临时文件混进镜像** —— `Dockerfile` 的 `COPY` 是整目录拷贝且**不看 `.gitignore`**，
`src/`、`public/` 下任何 `*.bak` 都会被打包进容器。`public/` 那条尤其要命：该目录由
`express.static` **免鉴权伺服**，`public/app.js.bak` 会被原样挂在公网上，
任何人 `wget http://<host>:20010/app.js.bak` 就能拿到整份前端源码。

```bash
# 构建前扫一遍，必须没有输出
find . -name "*.bak*" -not -path "./node_modules/*"

# 从已构建的镜像侧复查也可以
docker run --rm --entrypoint sh chatz -c 'ls -R /app/public /app/src | grep -i bak || echo 干净'
```

仓库根目录的 `.dockerignore` 已经排掉这类文件，**别删它**。

---

## 生产环境检查清单

- [ ] `AUTH_TOKEN` 已改为随机值（或确认已自动生成并保存）
- [ ] HTTPS 已启用（内置或反代）
- [ ] 数据库定期备份（含 `data/` 与 `.env`）
- [ ] Docker 日志轮转已配置
- [ ] 服务器时间已同步（NTP）—— 路由规则的 `time_between` 依赖服务器时间
- [ ] 安全组只开放 80/443
- [ ] 定期清理软删消息
- [ ] 反代已配置 `X-Forwarded-For`（建议用 `$remote_addr` 覆盖，而不是 `$proxy_add_x_forwarded_for` 追加）
- [ ] 用了反代就设了 `TRUST_PROXY`（否则所有人被算成同一个 IP，一人触发限速全站 429）
- [ ] 端口能被公网直连时没用 `TRUST_PROXY=1` / `2` / `true`（直连 + 伪造 XFF 可取任意 IP）
- [ ] 已测试恢复流程
- [ ] 每次部署后跑过一次 `verify-full.sh`（全站接口自检；`0c` 段能照出「线上前端不是最新那份」）

---

## 本地开发

不用 Docker 也能跑：

```bash
npm install
DB_PATH=./data/app.db PORT=20010 node src/index.js
```

> ⚠️ **只在本地构建模式下才需要 `--build`**：`Dockerfile` 里两条 `COPY`
> （`src ./src`、`public ./public`）都是**整目录拷贝**，所以改了后端**或**前端
> 都必须重新 `--build`，只 `restart` 不会生效；改完还要**硬刷新**浏览器，别只按 F5 拿缓存。
> 用 GHCR 镜像的话没有这一步 —— `docker compose pull && docker compose up -d` 就行。
>
> ⚠️ `COPY` **不看 `.gitignore`**，目录下任何 `*.bak` 都会被原样打包进镜像。
> 其中 `public/` 下的尤其危险 —— 这个目录由 `express.static` **免鉴权**伺服，
> 往里漏一个 `app.js.bak` 就等于把整份前端源码公开挂在公网上。
> 仓库根目录的 `.dockerignore` 已经把这类文件排掉了，**别删它**；
> 详见 [安全加固](DEPLOY.md#安全加固)。

---

## 相关

- [README](../README.md) — 项目总览
- [API 参考](API.md) — 接口文档
- [模板语法](TEMPLATE.md) — Webhook 模板
- [路由规则](ROUTES.md) — 规则引擎
