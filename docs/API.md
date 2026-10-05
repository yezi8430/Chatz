# Chatz API 参考

> **English**: [API.en.md](API.en.md)（逐接口的完整英文版）

所有 HTTP 接口基址：`http://<host>:20010` 或 `https://<host>:20443`

WebSocket：`ws://<host>:20010/stream` 或 `wss://<host>:20443/stream`

## 目录

- [鉴权](#鉴权)
- [通用约定](#通用约定)
- [1. 基础](#1-基础)
- [2. 用户 & 设备](#2-用户--设备)
- [3. 频道](#3-频道)
- [4. 消息](#4-消息)
- [5. 应用](#5-应用)
- [6. 附件](#6-附件)
- [7. Webhook](#7-webhook)
- [8. 路由规则](#8-路由规则)
- [9. HTTPS 证书](#9-https-证书)
- [10. 背景](#10-背景)
- [11. 审计日志](#11-审计日志)
- [12. WebSocket](#12-websocket)
- [13. 静态资源](#13-静态资源)
- [14. 安全响应头](#14-安全响应头)
- [15. 超管管理页（全站只读）](#15-超管管理页全站只读)
- [消息字段](#消息字段)
- [完整示例](#完整示例)

---

## 鉴权

三种方式，任选一种：

```http
Authorization: Bearer <token>
X-Gotify-Key: <token>
?token=<token>
```

`?token=` 对 HTTP 接口同样有效（`extractToken` 三个来源都读），但更推荐用请求头。

Token 来源：

| Token 类型 | 格式 | 说明 |
|---|---|---|
| 主密钥（`AUTH_TOKEN` / `AUTH_TOKEN_FILE` / 首次引导生成） | `cz.` + 30 位 base62（共 33 字符） | 管理员身份，兼容旧 Gotify 客户端。**来源优先级：`AUTH_TOKEN` 明文 → `AUTH_TOKEN_FILE` 指向的文件 → 数据库 `meta.auth_token` → 未初始化**（全新实例走完引导页才有）。无论哪个来源，启动时会把生效值同步回 `meta.auth_token` |
| 登录下发的设备 Token | 同上格式 | 每次密码登录新发一枚，绑定**登录者本人**（管理员亦然） |
| 用户设备 Token | `cz.` + 30 位 base62（共 33 字符） | 注册时生成；普通用户每次登录都会新建一枚。2026-09-30 起统一为此格式 |

> 两类凭据格式统一，前缀 `cz.` 只是**可读性标记**（一眼认出是 Chatz 凭据），
> 不是安全边界 —— 设备 Token 鉴权是整串去 `devices` 表做等值匹配
> （`auth.js:resolveToken`），主密钥则是整串比对 `AUTH_TOKEN`。前缀伪造不出这两件事。
>
> ⚠️ 2026-09-30 有过一次**破坏性迁移**（两个独立标记位）：
> - `device_token_cz_v2`：存量 64 位 hex **设备 Token** 全部重签为 `cz.`；
> - `auth_token_cz_v2`：**主密钥**也换成 `cz.`。
>
> **主密钥换格式的例外**：若 `AUTH_TOKEN` 来自环境变量 / 文件（优先级高于数据库），
> 迁移**不会**动它 —— 改了也会被 env 覆盖回去，只会制造「meta 与实际生效值不一致」
> 这种更难查的状态。要换请用户自己改 `.env`。
> 换完所有持有者（管理员密码登录、粘贴 Token 登录、旧 Gotify 客户端）都需重新取新值。

> `AUTH_TOKEN` 匹配时，身份解析为**数据库里第一个 `is_admin = 1` 的用户**，
> 并标记 `isLegacyAuth = true`（没有具体设备 id，所以 `POST /auth/logout` 对它无效）。

权限级别：

| 级别 | 说明 |
|---|---|
| **公开** | 无需 Token |
| **登录** | 任何有效 Token |
| **管理员** | `role = 1` 的用户（历史上用于管应用、路由规则；**当前 `requireAdmin` 已无任何调用点**） |
| **超级管理员** | `role = 2` 的用户 |
| **创建者/超级管理员** | 频道的创建者，或超级管理员 |
| **频道订阅者/超级管理员** | 订阅了该频道，或超级管理员 |

> ⚠️ 2026-10-01 起：`requireAdmin` 在 `src/` 里**已无任何调用点**（只在 `auth.js` 里定义），
> 所有带权限的接口都走 `requireSuper`。实际上 role 1 的能力与 role 0 几乎一致，
> 网页端角色下拉也不再提供 role 1（已存在的 role 1 账号保留原值直到被改动）。
> 判断「能不能看全部」一律用 `isSuper`（或 `role === 2`）。
>
> ⚠️ 2026-10-01 起：**应用和路由规则改成按用户隔离**，所有登录用户都能管自己的一份，
> 管理员不再有全局特权（只看得到自己的）。
> **超管的「全知」也从日常接口收回**了 —— `GET /channel` / `GET /message` 等一律按订阅，
> 全站数据改在 [第 15 节管理页](#15-超管管理页全站只读) 看。

---

## 通用约定

### 错误响应

所有错误都是 JSON：

```json
{"error": "错误描述"}
```

| 状态码 | 含义 |
|---|---|
| 400 | 参数错误 |
| 401 | Token 无效或缺失 |
| 403 | 权限不足 |
| 404 | 资源不存在 |
| 409 | 冲突（用户名 / 邮箱已存在；频道名已允许重名，不再 409） |
| 429 | 触发限速（响应带 `Retry-After` 头） |
| 500 | 服务器内部错误 |

示例：

```json
{"error": "未登录或登录已过期", "errorCode": 401}
{"error": "需要管理员权限"}
{"error": "需要超级管理员权限"}
{"error": "请求过于频繁，请稍后再试", "retryAfter": 37}
```

**角色越权会记审计**（`auth.forbidden` / `auth.forbidden_super`，按「用户 + 路径」5 分钟节流），
所以有人拿普通账号反复试探管理接口时，`GET /audit` 里能查到痕迹。
（业务越权如"访问未订阅的频道"只回 403、不记审计，避免正常误触产生噪音。）

未匹配任何路由时返回 `404 {"error": "资源不存在"}`。

### 限速

限速按内存计数，**重启即清零**。

计数维度里用的客户端 IP 由 `clientIp.js` 统一判定，规则和审计日志完全一致：
**默认只认 TCP 对端地址**，只有显式配置了 `TRUST_PROXY` 才会采信 `X-Forwarded-For`
（详见 README / DEPLOY 的「客户端 IP」章节）。

⚠️ **每个限速规则各有独立的计数器**（key 形如 `password:192.168.2.5`），
互不干扰 —— 普通 API 流量不会吃掉注册 / 改密码的额度。
如果发现某接口第一次调用就返回 429，先确认是不是真的请求过频，
而不要假设是「被别的流量挤掉了」（这个坑 2026-09-29 已经修掉）。

| 接口 | 维度 | 上限 |
|---|---|---|
| 全局兜底 | 每 IP | 600 次 / 60 秒 |
| `POST /hook/:token` | 每个应用 Token | 60 次 / 60 秒 |
| `POST /hook/preview` | 每 IP | 30 次 / 60 秒 |
| `POST /attachment` | 每个用户 | **10 次** / 60 秒（2026-09-30 从 30 降下来，配合容量上限一起收） |
| `POST /route/test` | 每 IP | 20 次 / 60 秒 |
| `POST /channel` | 每 IP | 20 次 / 1 小时 |
| `POST /application` | 每 IP | 30 次 / 1 小时（2026-10-01 起普通用户也能建，原先是管理员专用所以没限） |
| `POST /route` | 每 IP | 30 次 / 1 小时（同上） |
| `POST /device` | 每 IP | 20 次 / 1 小时 |
| `POST /device/rotate` | 每 IP | 20 次 / 1 小时 |
| `POST /auth/register` | 每 IP | 3 次 / 1 小时 |
| `POST /auth/login` | 每 IP | 30 次 / 5 分钟 |
| `POST /auth/login` | 每 IP + 用户名 | 5 次 / 5 分钟 |
| `POST /setup` | 每 IP | 20 次 / 1 小时 |
| `POST /auth/forgot-password` | 每 IP | 10 次 / 1 小时 |
| `POST /auth/reset-password` | 每 IP | 20 次 / 10 分钟 |
| `PATCH /user/password` | 每 IP | 10 次 / 10 分钟 |
| `PATCH /user/username` | 每 IP | 10 次 / 10 分钟 |
| WebSocket 连接 | 全局 / 单用户 | 1000 条 / 每用户 10 条 |

上面 18 行对应 **18 个 `rateLimit({ name })` 调用点**（`src/*.js` 16 个 + `rateLimit.js`
里 login 专用的 2 个），逐个核出来的；最后那行 WebSocket 不走这套机制，是 `ws.js` 里的连接数上限。

（2026-09-30 补记：加 `route_test` / `channel_create` / `device_create` 三个的时候
差点忘了回这张表 —— 这张表本身就是为了防这种漏记才列的。**改限流阈值也要回来看**，
不只是新增。）

（2026-10-01 补记：`device_rotate` 加的时候**又漏了**；这次加 `app_create` / `route_create`
才发现，一并补上。同一个坑踩两次 —— 以后动限流，直接
`grep -rn "rateLimit({" src/` 和这张表逐行对照，别靠记性。）

**新增限速器时记得回这张表补一行** —— 每个都带 `name`、各自计数，漏记不会有任何报错。

`429` 响应会带 `Retry-After`（秒）和 `retryAfter` 字段：

```json
{"error": "操作过于频繁，请稍后再试", "retryAfter": 512}
```

### 请求体大小限制

超出会返回 `413`（由 Express 的 raw / json 解析器处理）。

| 路径 | 限制 |
|---|---|
| `/hook`、`/certs` | 1 MB |
| `/application/:id/icon`、`/channel/:id/icon`、`/user/avatar` | 5 MB |
| `/background` | 8 MB |
| `/attachment` | 20 MB（raw 层）／**8 MB**（业务层，见下） |
| 其余 JSON 接口 | 1 MB |

> 二进制上传（图标、头像、背景、附件、证书）走的都是 `express.raw`，
> 请求体是**原始字节**，不是 JSON 字段。
>
> ⚠️ **附件有两层限制**：`express.raw` 那层是 20MB（更大会直接被解析器挡掉，
>    连业务逻辑都进不去），业务层另有 `ATTACHMENT_MAX_FILE_MB`（默认 8MB），
>    两者取更严格的那个生效。
>    另外附件还有**总量上限** `ATTACHMENT_MAX_TOTAL_MB`（默认 500MB），
>    超出返回 `507`（和 413 区分开），见 `src/attachments.js`。

### 图片类型判定

上传的图片一律按**文件头魔数**重新定扩展名，不看客户端声明的 `Content-Type`
或文件名。只认 `png / jpg / gif / webp / svg`。

- 头像和背景**额外拒绝 `svg`**（它们会被内联渲染，SVG 是脚本载体）
- 附件若扩展名落在黑名单（`html / svg / js / xml …`）会被强制改成 `.bin`

---

## 1. 基础

### `GET /health` 公开

```json
{"ok": true, "online": 3, "https": true, "ts": 1789982992010}
```

| 字段 | 说明 |
|---|---|
| ok | 服务是否正常 |
| online | 当前 WebSocket 连接数 |
| https | HTTPS 是否已启用 |
| ts | 当前时间戳 |

### `GET /config` 公开

前端启动前拉取的运行时配置。

```json
{"certsUiEnabled": true, "httpsPort": 20443, "aggWindowMs": 300000, "aggMaxLifetimeMs": 1800000, "lang": "zh", "langLocked": false}
```

| 字段 | 说明 |
|---|---|
| certsUiEnabled | 是否显示网页端的「HTTPS 证书」面板（环境变量 `CERTS_UI_ENABLED=false` 可关） |
| httpsPort | 当前 HTTPS 端口 |
| aggWindowMs | 消息聚合的滚动窗口（`AGG_WINDOW_MS`），距**上次折叠**超过它就换新的一条 |
| aggMaxLifetimeMs | 单条聚合消息的最长寿命（`AGG_MAX_LIFETIME_MS`），从**建消息时间**算起；`0` = 不限制 |
| lang | 服务端**日志**当前说的语言：`zh` / `en` |
| langLocked | `true` = 环境变量 `LOG_LANG` 把它钉死了，网页端改不动 |

### `GET /config/lang` 登录

```json
{ "lang": "zh", "locked": false }
```

当前生效的日志语言，以及它是否被 `LOG_LANG` 锁死。

### `PUT /config/lang` 超级管理员

改整机的**日志**语言。**立刻生效**，不用重启。

```json
// 请求
{ "lang": "en" }
```

- 只接受 `en` / `zh`，其它值一律按 `zh` 处理
- 普通用户 / 管理员调用 → `403`（注册是完全开放的，否则谁注册个号都能改你的日志）
- 环境变量 `LOG_LANG` 设过时，接口仍然返回 `200`，但生效值不变（`locked: true`）
- 切换时会往日志里打一行 `🌐 日志语言已切换为 英文`，并记一条 `config.set_lang` 审计

```json
// 响应（locked=true 时 lang 可能与请求的不同）
{ "lang": "en", "locked": false }
```

> 💡 网页端侧栏的语言按钮会顺手调这个接口，所以**界面切英文、容器日志也跟着变英文**。
> 引导页是唯一「还没有超管、却能定整机语言」的时刻 —— `POST /setup` 会带上 `lang`。

### `GET /version` 登录

```json
{"version": "2.0.0", "commit": "local", "buildDate": "2026-09-21T09:29:52.019Z"}
```

`buildDate` 是**接口被调用的时刻**，不是编译时刻。

---

## 2. 用户 & 设备

### `GET /setup/status` 公开

全新安装的**首次引导**用的两个接口。触发条件是 `migrate.js` 在新建 `admin` 时写下的
`meta.setup_completed = '0'`；存量部署在迁移里会被补成 `'1'`，所以老实例升级后不会被弹引导页。

```json
// 响应
{ "needsSetup": true }
```

只回这一个布尔值，不泄露实例内部的任何信息。

### `POST /setup` 公开（限速 20 次 / 小时 / IP）

给全新安装设置管理员账号。**终身只能成功一次**，之后一律 `403`。

```json
// 请求
{
  "username": "admin",
  "password": "换成你自己的密码",
  "displayName": "管理员",
  "lang": "zh"
}
```

约束：

- `username` 2–32 位，仅允许 `a-z A-Z 0-9 _ - .`；与其它用户重名 → `409`
- `password` **6–128 位**（与普通注册一致，管理员不再额外加严）
- `lang` 可选，`en` / `zh`；只认这两个字面值，其它一律忽略。它决定**服务端日志**说什么语言
  （写进 `meta.lang`），也是唯一「还没有超管、却能定整机语言」的时刻。除此之外还会把
  migrate 预置的「默认频道」一并改成相应语言（前端 i18n 不会碰频道名 —— 那是用户数据）
- `email` 可选，用于「忘记密码」；格式不对 → `400`，被别人占用 → `409`
- 已经完成过初始化 → `403`

成功时会：

1. 接管 `migrate.js` 预置的那个 `admin` 用户 —— **是改它的用户名/密码，不是新建一个管理员**，
   所以不会出现两个管理员，它已持有的默认频道订阅也保住了
2. 把 `meta.setup_completed` 置为 `'1'`，接口就此关闭
3. 若 `lang` 是 `en` / `zh`，写进 `meta.lang` —— 之后的容器日志按它输出；
   语言真的变了会**用新语言**打一行 `🌐 日志语言已切换为 英文`（不用重启就能确认）
4. **把预置的「默认频道」也改成相应语言**（`默认频道` ⇄ `Default channel`）。
   🔴 只动「名字还是预置原文」的那一条 —— 用户改过名的绝不会被语言切换覆盖
5. 生成并返回主密钥 —— 引导页可以直接进应用，不用再登录一次

> ⚠️ 主密钥是**到这一步才生成**的（2026-10-05 改），之前它根本不存在，也从不进容器日志。
> 返回的就是那枚主密钥本身（`cz.` + 30 位），随后会以「默认 Token」的名字登记成设备，
> 所以超管手上只有一枚凭据，不会冒出「两枚都有效」的困惑。

> 另外：`POST /auth/login` 登录成功时也会把这个标记置成 `'1'`。
> 用真实凭据进来过 = 这个实例已经有人在管了，不该再弹引导。
>
> ⚠️ 引导完成**不会**作废旧 `AUTH_TOKEN` —— Gotify 客户端还在用它。
> 要吊销请到「账户 → 安全与登录 → 登录设备」里删对应那一行。

### `POST /auth/register` 公开

请求：

```json
{
  "username": "alice",
  "password": "alice123",
  "displayName": "Alice",
  "email": "alice@example.com"
}
```

响应：

```json
{
  "user": {
    "id": 2,
    "username": "alice",
    "displayName": "Alice",
    "avatar": null,
    "isAdmin": false,
    "createdAt": 1789968398982
  },
  "token": "cz.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

> 设备 Token 统一是 `cz.` + 30 位 base62（共 33 字符）。别把它和 10 位的
> **应用** Token 搞混 —— 后者是嵌在 webhook URL 里的（见「5. 应用」）。

约束：

- `username` 2–32 位，仅允许 `a-z A-Z 0-9 _ - .`
- `password` ≥ 6 位
- `email` **选填**：填了必须合法，且不能和其它账号重复（重复 → `409`）；
  它是「忘记密码」定位账号的依据，没填邮箱的账号用不了忘记密码
- 用户名已存在 → `409`
- 注册出来的是**普通用户**。⚠️ 早期文档里写的「系统里还没有管理员时，第一个注册的用户
  自动成为管理员」在当前版本是**不成立的**：`migrate.js` 启动时就已经预置了 `admin` 用户，
  `users` 表永远不会为空。真正拿到管理员的方式是全新安装时的**首次引导页**（见下），
  或用 `AUTH_TOKEN` 登录后自行管理。
- 自动创建一个名为 `Web` 的设备 Token

> ⚠️ **注册不会自动订阅任何公开频道。** 新账号的抽屉是空的，
> 需要到「发现频道」里显式订阅。唯一的例外是：建频道的人自动订阅自己建的频道。

### `POST /auth/login` 公开

```json
// 请求
{
  "username": "alice",
  "password": "alice123",
  "deviceName": "手机"
}

// 响应：同 register
```

- **所有用户**（含管理员 / 超管）：登录都发**本人**的设备 Token，
  拿到的 token **一定对应登录的那个账号**
- **一个用户 = 一枚登录 Token**：取该用户 id 最小的那枚（排除全局主密钥）复用，
  只更新 `last_seen`；没有才新发。于是反复登录（含无痕模式 / 清过 localStorage）、
  以及换设备登录，拿到的都是**同一枚**。想多一枚就手动「添加设备」`POST /device`

> ⚠️ 2026-10-01 前「管理员登录直接返回全局 `AUTH_TOKEN`（主密钥）」。
> 但主密钥在 `devices` 表里是「默认 Token」行、绑定的是**第一个**管理员，
> 于是第二个管理员登录后拿到主密钥 → 身份变成第一个人、还白拿了超管权限
> （表现为「bob 提升为管理员后登录，实际却是 yezi」）。已改为一律发本人 token。

用户名不存在或密码错误都返回 `401 {"error": "用户名或密码错误"}`（两种情况返回同一句，避免泄露用户名是否存在）
（刻意不区分两种失败，避免用户名枚举）。

### `POST /auth/forgot-password` 公开（限速 10 次 / 小时 / IP）

```json
// 请求
{"email": "alice@example.com"}

// 响应（不管邮箱有没有注册，都回同一句，不泄露信息）
{"ok": true, "message": "如果该邮箱已注册，重置链接已写入服务日志，请管理员查看 docker compose logs"}
```

没接 SMTP，所以重置链接是**打印到容器日志**里（`docker compose logs chatz`）：

```text
📧 密码重置请求
   用户: alice <alice@example.com>
   链接: http://<host>/reset-password?token=xxxx...
   有效期: 30 分钟（一次性，用一次即失效）
```

- 令牌只存 sha256 哈希，不存原文；30 分钟过期；用过一次即失效
- 任何方式改过密码，都会把该用户还没用的重置链接全部作废

### `GET /auth/reset-password/validate` 公开

```json
// 请求：?token=xxx
// 响应
{"valid": true, "reason": null}          // 有效
{"valid": false, "reason": "expired"}    // 已过期
{"valid": false, "reason": "used"}       // 已被使用过
{"valid": false, "reason": "invalid"}    // 无效
```

### `POST /auth/reset-password` 公开（限速 20 次 / 10 分钟 / IP）

```json
// 请求
{"token": "xxx", "password": "newpassword123"}

// 响应
{"ok": true}
```

约束：`password` 6–128 位；令牌无效 / 已用 / 过期 → `400`。

### `GET /auth/me` 登录

```json
{
  "id": 2,
  "username": "alice",
  "displayName": "Alice",
  "avatar": "/user-avatars/user-2-1789.jpg",
  "isAdmin": false,
  "createdAt": 1789968398982
}
```

### `POST /auth/logout` 登录

删除**当前设备**的 Token（靠 Token 反查 device id）。

```json
{"ok": true}
```

用 `AUTH_TOKEN` 调用时没有 device id，接口返回 `ok` 但不会真的删掉任何东西。

> **管理员例外**：管理员用密码登录复用的就是全局 `AUTH_TOKEN`，它对应
> `devices` 表里那行「默认 Token」。登出时这行**不会被删除**，响应会多一个
> `{"ok": true, "keptDefaultToken": true}`。
> 原因：删掉它没有意义 —— `AUTH_TOKEN` 走的是「devices 查不到就比全局 token」的
> 兜底分支，行删了照样有效；而且下次密码登录又会把它补回来。
> 想真正作废这枚主密钥，只能换掉 `.env` / `meta` 里的 `AUTH_TOKEN`。

### `GET /device` 登录

返回当前用户的**全部**设备 Token。

🔴 **唯一例外是主密钥那一行**：它不下发明文，只给指纹。

```json
[
  {
    "id": 1,
    "name": "默认 Token",
    "token": null,
    "tokenPreview": "kR9mX2pQ",
    "tokenHidden": true,
    "isCurrent": true,
    "isMaster": true,
    "lastSeen": 1789968398982,
    "createdAt": 1789968398982
  },
  {
    "id": 7,
    "name": "我的手机",
    "token": "cz.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "tokenPreview": null,
    "tokenHidden": false,
    "isCurrent": false,
    "isMaster": false,
    "lastSeen": 1789968398982,
    "createdAt": 1789968398982
  }
]
```

| 字段 | 说明 |
|---|---|
| `token` | 主密钥行为 `null`；其余行是完整值 |
| `tokenPreview` | 主密钥行的 8 位指纹（算法同启动日志：跳过 `cz.` 前缀取 8 位），只用来和别的记录对上 |
| `tokenHidden` | 为 `true` 时前端应把「复制」按钮改成「验密码后复制」 |

> 为什么要单独藏起主密钥：它是**全局超管凭据**，而这一行会出现在任何一个拿到
> 超管密码的人眼前。抄走之后你改密码也没用 —— 改密码不作废主密钥，
> 他能一直用到你换主密钥为止。所以「已登录」不足以授权看它。
> 别的设备 Token 不受影响：那本来就是登录时下发给本人、存在 localStorage 里的东西。

### `POST /device/:id/reveal` 登录

取主密钥明文，**必须二次验密码**。

```json
// 请求
{"password": "当前登录账号的密码"}

// 响应 200
{"token": "cz.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}
```

| 情况 | 响应 |
|---|---|
| 密码正确且该行是主密钥 | `200` + 完整 token，同时写一条 `device.reveal` 审计 |
| 密码错误 | `403 密码不正确`（审计里记 `success: false`）。🔴 **不能用 401** —— 前端把 401 一律当成登录失效、会清 token 弹回登录页，而这里用户明明还登录着 |
| 没带 `password` | `400 请输入当前密码` |
| 该行不是主密钥 | `400 这一行不需要二次验证` |
| 该行不属于当前用户 | `404 设备不存在` |

限流 10 次 / 小时（`device_reveal`）。密码只在内存里比对一次，不进日志、不进审计的 `meta`。

> 自己写客户端时建议照这个原则处理：**不要把完整 Token 渲染到界面上**，
> 面板经常在投屏 / 截图 / 远程协助的环境里被打开。
> 网页端设备面板刻意只在列表里渲染前 16 位（主密钥行只渲染指纹），完整值走「复制」进剪贴板。

### `POST /device` 登录

```json
// 请求
{"name": "平板"}

// 响应
{"id": 5, "name": "平板", "token": "abc...", "createdAt": 1789...}
```

不传 `name` 时默认为「新设备」。

### `DELETE /device/:id` 登录

- 删的是当前设备 → `400 不能删除正在使用的设备`
- 删的是主密钥行（`token === AUTH_TOKEN`）→ `400 这是主密钥，无法删除（要更换请换掉 AUTH_TOKEN 本身）`
- id 不存在 → `404 设备不存在`

```json
{"ok": true}
```

### `POST /device/rotate` 登录（限速 20 次 / 小时 / IP）

更换**当前正在用的**这枚 Token —— 因为 `DELETE /device/:id` 明确拒绝删当前设备，
「一个用户 = 一枚登录 Token」之后必须单独有这条路，否则用户换不掉在用的凭据。

- 旧值**立即失效**，响应直接返回新的，当前会话换完继续用（不用重新登录）
- 别的设备若也用着这枚 token，会被一起踢下线重新登录
- 用主密钥登录（`deviceId` 为 null）时 → `400 主密钥不能在这里更换`

```json
{"ok": true, "token": "新的完整 token"}
```

### `POST /user/avatar` 登录

请求体是原始图片字节（≤ 5 MB），`png / jpg / gif / webp`，`svg` 会被拒。

```bash
curl -X POST http://<host>:20010/user/avatar \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @avatar.png
```

```json
{"ok": true, "avatar": "/user-avatars/user-2-1789.jpg"}
```

上传新头像会自动删除旧头像文件，并向该用户的所有连接广播 `userUpdated`
（客户端和网页都靠它即时同步，无需手动刷新）。

### `DELETE /user/avatar` 登录

```json
{"ok": true}
```

同样会广播 `userUpdated`。

### `PATCH /user/profile` 登录

```json
// 请求
{"displayName": "爱丽丝"}

// 响应
{"ok": true, "user": { "id": 2, "username": "alice", "displayName": "爱丽丝", ... }}
```

昵称 trim 后长度需在 1–32 之间，否则 `400`。

### `PATCH /user/email` 登录

```json
// 请求
{"email": "alice@example.com"}     // 或 "" 清空邮箱

// 响应
{"ok": true, "user": { "id": 2, "username": "alice", "email": "alice@example.com", ... }}
```

- 一个邮箱最多对应一个账号（全局唯一），重复 → `409`
- 邮箱选填：传 `""` 清空；没邮箱的账号用不了「忘记密码」
- 格式非法 → `400`

### `PATCH /user/username` 登录

改自己的**登录用户名**（不是昵称；昵称走 `PATCH /user/profile`）。

```json
// 请求
{"username": "yezi"}

// 响应
{"ok": true, "user": { "id": 1, "username": "yezi", "displayName": "yezi", ... }}
```

- 规则与注册完全一致：trim 后 2–32 位，仅 `a-z A-Z 0-9 _ - .`，否则 `400`
- **全局唯一**：与别人重名 → `409 用户名已被占用`（`AND id != ?` 排除自己，
  所以改回原名 / 只改大小写以外的相同值不会误报）
- 新旧名相同（含 trim 后相同）→ 直接 `200`，不碰数据库
- 并发下万一绕过预检查，`users.username` 的 `UNIQUE` 约束会兜底，
  捕获后仍回 `409` 而不是 500
- 限速：每 IP 每 10 分钟 10 次

> **改用户名不影响任何功能**：权限来自 `users.is_admin` 标志位，所有鉴权按
> `user_id` 走；设备 Token 绑的也是 `user_id`，`auth.js` 查询时 `JOIN users`
> 实时取 `username`，所以改完名字后已登录的设备全部照常有效。
> `migrate.js` 也改成按 `is_admin = 1` 找管理员，不再依赖名字叫 `admin`。

---

### `PATCH /user/password` 登录

改自己的密码（已登录即已通过身份验证，**不需要**旧密码）：

```json
// 请求
{"new_password": "新密码123", "revokeDevices": false}

// 响应
{"ok": true, "revokedDevices": 0}
```

管理员重置他人（同样不需要旧密码）：

```json
// 请求
{"userId": 2, "new_password": "新密码123"}

// 响应
{"ok": true, "revokedDevices": 3}
```

规则是刻意不对称的：

| 场景 | 要不要 `old_password` | 设备处理 |
|---|---|---|
| 改自己的 | 不需要（登录态即身份） | 默认**保留**已登录设备；传 `revokeDevices: true` 才清掉其它设备 |
| 管理员改他人 | 不需要 | 默认**吊销该用户全部设备**（密码能被别人重置说明账号已不安全） |

任何情况下**当前发起请求的那台设备都不会被清掉**，不会把自己踢下线。

约束：`new_password` **6–128** 字符（与注册 / 引导 / 重置三个入口一致）；不能和当前密码相同（否则 `400`）；
**非超级管理员**改他人返回 `403`（普通管理员改不了别人密码）。限速每 IP 每 10 分钟 10 次。

> ⚠️ 改自己的密码不再校验旧密码，意味着**拿到一枚设备 Token 就能改密码**——
> 所以设备列表里的每枚 Token 都等同于登录态，要保管好、及时删掉不用的设备。
>
> ⚠️ 用全局 `AUTH_TOKEN`（而非设备 token）登录时 `deviceId` 为空，
> 这时没法识别"当前会话"，只能清掉全部 —— 网页端走的是设备 token，不受影响。

### `GET /user/list` 超级管理员

全部用户及其角色。

```json
[
  {
    "id": 1,
    "username": "admin",
    "displayName": "管理员",
    "avatar": null,
    "email": null,
    "isAdmin": true,
    "role": 2,
    "isSuper": true,
    "createdAt": 1789964364760
  }
]
```

### `PATCH /user/:id/role` 超级管理员

提升 / 降级某个用户。

```json
// 请求
{"role": 1}

// 响应：更新后的用户对象（同上）
```

`role` 只能是 `0`（普通用户）/ `1`（管理员）/ `2`（超级管理员），否则 `400`。

两道保护：

1. **不能改自己的角色** → `400`。否则一次手滑把自己降下去就再也升不回来。
2. **至少要保留一个超级管理员** → 把最后一个超管降级时返回 `400`。

角色改完会推 `userUpdated` 给该用户，并刷新他**已在线** WebSocket 连接的身份
（见下方「角色变更与在线连接」）。

#### 三种角色的权限边界

| 能力 | 普通用户 | 管理员 (1) | 超级管理员 (2) |
|---|---|---|---|
| 自己订阅的频道 | ✅ | ✅ | ✅ |
| 应用、路由规则（自己的） | ✅ | ✅ | ✅ |
| HTTPS 证书 | ❌ | ❌ | ✅ |
| 审计日志 | ❌ | ❌ | ✅ |
| 改 / 删别人的频道 | ❌ | ❌ | ✅ |
| 订阅别人的私有频道 | ❌ | ❌ | ✅ |
| 改他人密码 | ❌ | ❌ | ✅ |
| **读未订阅的私有频道** | ❌ | ❌ | ✅ |
| 提升 / 降级他人 | ❌ | ❌ | ✅ |

> ⚠️ **旧接口 `isAdmin` 的语义变了**：它现在等价于 `role >= 1`。
> 如果你有脚本在判断 `isAdmin` 来断言「能看全部频道」，那已经不成立了 ——
> 请改判 `isSuper`（或 `role === 2`）。
>
> ⚠️ **角色变更与在线连接**：`ws.isAdmin` / `ws.isSuper` / `ws.subscribedChannels`
> 都是连接建立时算一次的快照。改角色后服务端会调 `refreshUserIdentity(id)` 刷新
> 该用户的所有在线连接，所以降级/升级**立即生效**，不需要对方重连。

---

## 3. 频道

### `GET /channel` 登录

只返回**自己订阅的频道** —— **超管也不例外**（2026-10-01 收窄）。

> 以前超管能看到全站频道（含别人的私有频道），代价是他的抽屉里塞满别人的频道、
> 还跟着一堆别人的频道更新事件。现在超管的「全知」移到
> [管理页 `GET /admin/channels`](#15-超管管理页全站只读)，日常界面只看自己的。

```json
[
  {
    "id": 1,
    "name": "默认频道",
    "description": "v1 数据自动归属",
    "image": null,
    "isPublic": true,
    "creatorId": 1,
    "createdAt": 1789964364760,
    "unreadCount": 4,
    "subscribed": true,
    "muted": false,
    "passwordProtected": false
  },
  {
    "id": 2,
    "name": "工作",
    "description": "工作通知",
    "image": "/channel-icons/2-1789.jpg",
    "isPublic": true,
    "creatorId": 1,
    "createdAt": 1789965173353,
    "unreadCount": 0,
    "subscribed": true,
    "muted": false
  }
]
```

`unreadCount` 统计的是该频道里**未读且未收藏**的消息。

### `GET /channel/discover` 登录

用于「发现频道」页面。**只返回 `is_public = 1` 的频道**。

Query 参数：

- `q`（可选）：按名字或 ID 搜索。纯数字 → 匹配「名字包含」或「ID 精确相等」；
  非数字 → 只匹配「名字包含」。**大小写不敏感**（模糊子串匹配）。

排序：**当前用户创建的频道排最前**，其余按 id 升序。

```json
[
  {
    "id": 2,
    "name": "工作",
    "description": "工作通知",
    "image": null,
    "isPublic": true,
    "creatorId": 1,
    "createdAt": 1789...,
    "passwordProtected": false,
    "subscribed": false,
    "muted": false,
    "unreadCount": 0
  }
]
```

### `GET /channel/:id` 登录

单个频道详情。私有频道需要**已订阅** —— 超管也不例外。

> ⚠️ 2026-10-01 起**取消了「超管全知」**：
> 以前超管能读到全部频道的消息（含别人的私有频道），现在日常接口一律按订阅走，
> 超管也不例外。全站数据改到 [管理页 `GET /admin/channels`](#15-超管管理页全站只读) 看。
>
> 受影响的接口（现在都按订阅 / 按归属，不再对超管放行）：
> `GET /channel`、`GET /channel/:id`、`GET /message`、`GET /message/search`、
> `GET /message/deleted`、`POST /message/read-all`。
> 频道元信息广播 `channelCreated/Updated/Deleted` 也早一步改判了「订阅者 ∪ 创建者」。
>
> `is_public = false` 对普通用户**和管理员（role 1）**仍然生效。
> 详见 [README 的「三种角色」小节](../README.md)。
> （中文标题的锚点在不同渲染器下算法不一致，这里不写死锚点。）

### `POST /channel` 登录

请求：

```json
{
  "name": "工作",
  "description": "工作通知",
  "image": null,
  "is_public": true,
  "password": "可选：订阅密码，4-64 位，不传/空 = 无密码"
}
```

响应：同 `GET /channel` 里的单项（`subscribed: true`，含 `passwordProtected`）。

说明：

- 频道名**允许重名**（像 QQ 群：id 唯一、群名随便），靠 `id` 区分
- `password` 非空时，该频道成为「受保护频道」：任何人订阅都要输密码（创建者/超管免密）
- **只有创建者本人自动订阅**，其他人要去「发现频道」显式订阅
- 广播 `channelCreated`（收件人 = 订阅者 ∪ 创建者）
- 广播里的频道对象**不带** `subscribed` / `muted` —— 而「你订没订」是每个人的私有状态。
  客户端收到后应重新拉一次 `GET /channel`

### `PATCH /channel/:id` 创建者/超级管理员

支持修改：`name`、`description`、`image`、`is_public`、`password`。广播 `channelUpdated`。

- `password` 传非空 → 设置新密码；传空串 `""` → 清除密码；不传 → 不动
- 改名**不查重**（允许重名）

### `DELETE /channel/:id` 创建者/超级管理员

```json
{"deletedMessages": 5}
```

行为：

1. 软删该频道下所有消息
2. 删除所有订阅关系
3. 该频道的应用自动归到默认频道（id = 1）
4. 删除频道本身
5. 广播 `messageDeleted`（逐条）+ `channelDeleted`

限制：**id = 1 的默认频道不能删**，返回 `400 cannot delete default channel`。

### `POST /channel/:id/icon` 创建者/超级管理员

请求体是原始图片字节（≤ 5 MB）。上传新图标会自动删除旧图标文件，并广播 `channelUpdated`。

```bash
curl -X POST http://<host>:20010/channel/2/icon \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @icon.png
```

### `POST /channel/:id/subscribe` 登录

```json
// 无密码 / 免密时不带 body；有密码时：
{"password": "频道密码"}

// 响应
{"ok": true, "subscribed": true}
```

订阅私有频道需要你是它的创建者或超级管理员，否则 `403 private channel, cannot subscribe`。
频道设了订阅密码时，创建者/超管免密，其他人必须传 `password` 且正确，否则：

- 密码错 → `403 密码错误`
- 同 IP 对同频道 5 分钟内错满 5 次 → `429`（带 `Retry-After` 秒数）

向该用户的所有设备广播 `subscriptionChanged`（`action: "subscribed"`）。

### `DELETE /channel/:id/subscribe` 登录

```json
{"ok": true, "subscribed": false}
```

### `PATCH /channel/:id/subscribe` 登录

改静音状态。

```json
// 请求
{"muted": true}

// 响应
{"ok": true, "muted": true}
```

- `muted` 必须是布尔值，否则 `400 muted must be boolean`
- 未订阅该频道 → `404 not subscribed`

静音会影响该用户的**所有设备**，所以也会广播 `subscriptionChanged`（`action: "muted"`）。

---

## 4. 消息

### `GET /message` 登录

查询参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| limit | 50 | 单页条数，上限 500 |
| since | 0 | 只返回 `id > since` 的消息 |
| channel | — | 只查该频道（未订阅的频道 → 403） |
| unread | — | `1` 只看未读 |
| archived | — | `1` 只看收藏；`all` 包含收藏 |

响应：

```json
{
  "paging": {"size": 2, "limit": 50, "next": null, "since": 0},
  "messages": [
    {
      "id": 15,
      "appid": 1,
      "message": "CPU 95%",
      "title": "CPU 告警",
      "priority": 8,
      "date": "2026-09-21T09:29:52.019Z",
      "extras": null,
      "channel_id": 1,
      "tags": ["urgent"],
      "isRead": false,
      "aggCount": 5,
      "aggLastAt": 1789982996143,
      "aggChildren": [
        {"message": "CPU 95% 第 1 次", "title": "CPU告警", "date": "...", "priority": 8, "extras": null}
      ]
    }
  ]
}
```

> ⚠️ 排序是 **`id` 升序**（老的在前），翻页靠 `since = 最后一条的 id`，
> 不是 `next`。默认**排除已收藏的**消息，要一起看就传 `archived=all`。

### `GET /message/deleted` 登录

**删除墓碑**。增量同步用 `since`（id 水位线）只能表达「新增」，表达不了「删除」——
服务端删掉 id=50，本地已经推进到 100，`WHERE id > 100` 永远看不见它，客户端上就留下
一条永远清不掉的幽灵消息。这个接口按 `deleted_at` 时间戳返回「哪些 id 被删了」。

| 参数 | 默认 | 说明 |
|---|---|---|
| since | 0 | 水位线：只返回 `deleted_at > since` 的墓碑（**毫秒时间戳**，不是 id） |
| sinceId | 0 | 次级游标：`deleted_at == since` 时只取 `id > sinceId` 的行 |
| limit | 500 | 单页条数，上限 1000 |

响应：

```json
{
  "deleted": [
    {"id": 50, "channelId": 1, "deletedAt": 1789982996143},
    {"id": 51, "channelId": 1, "deletedAt": 1789982996143}
  ],
  "since": 0,
  "sinceId": 0,
  "next": {"since": 1789982996143, "sinceId": 51},
  "paging": {"size": 2, "limit": 500}
}
```

> ⚠️ **必须用双游标**。删频道 / 删应用是**一条 UPDATE 打同一个 `Date.now()`**，
> 整批墓碑时间戳完全相等，单靠 `since` 无法表达「同一时刻里读到第几条」。
> 实测 1200 条同刻墓碑在单游标下只拿到 503 条，**静默漏 700 条**。
>
> 用法：**把响应里的 `next` 原样回传**（`since=next.since&sinceId=next.sinceId`），
> 不要自己从最后一条里推算。`next` 为 `null` 表示已拉到底。
> 客户端要把**两个游标都落盘**，中途失败才不会漏掉同刻剩余行。
>
> 权限同 `GET /message`：**一律按订阅，超管也不例外** —— 普通用户只看**已订阅频道**的删除
> （否则别的频道的删除 id 会泄漏）。没有任何订阅时直接返回空数组。
>
> ⚠️ 这个接口依赖已删的行**还在**（软删除，只写 `deleted_at`）。
> 将来若做「物理清理已删行」，必须保证所有客户端都追上水位线。

### `POST /message` 登录

请求：

```json
{
  "title": "CPU 告警",
  "message": "CPU 95%",
  "priority": 8,
  "channel_id": 1,
  "appid": 1,
  "tags": ["urgent"],
  "extras": {"image": "https://example.com/img.jpg"},
  "silent": false
}
```

处理流程：

```text
1. 字段清理（长度截断、优先级夹到 0-10）
2. 找应用：不传 appid 时取**该用户自己的**第一个应用（自己有 0 个才回落全局第一个）
   ⚠️ 归属校验：登录用户**只能用自己的应用**署名（超管不限）——
      否则随便传个 appid 就能冒用别人的应用身份发消息（appid 很好猜：1、2、3…）
   → 找频道：不传取应用的默认频道
   ⚠️ 投递权限：普通用户必须是该频道的**订阅者**；超管随意
3. 过路由引擎 applyRoutes —— **只用当前用户自己的规则**（见第 8 节「规则按用户隔离」）
   - 可能改优先级、加标签、静默、转发、丢弃
4. 写入快照：`extras.sender`（发送者）+ `extras.app`（应用，含名字/图标，**不含 token**）
5. 尝试消息聚合
   - 同频道 + 同应用 + 同标题 + 5 分钟窗口，且原消息未被收藏
   - ⚠️ 还要求**原消息的年龄 < `AGG_MAX_LIFETIME_MS`**（默认 30 分钟，`0` = 不限制）——
     窗口量的是「上次折叠时间」，只看它的话一条老消息会被无限折叠（滚动续命）：
     位置永远不上浮、还会把最早的子条目挤出 `aggChildren`
   - 命中则更新已有消息的 aggCount 和 aggChildren
   - **首次折叠**时会把原消息（第 1 条）自己补进 `aggChildren` 的第 1 位，并清掉主卡上的「图」：
     · `extras` 里只摘图相关键 —— `image` / `client::display.url` / `client::notification.bigImageUrl`
       （`extras.sender` / `extras.app` 一律保留，主卡还要显示发送者）
     · 正文里的 markdown 图片 `![alt](url)` 也一并清掉（**两个通道的图来源不同**：客户端读 `extras.image`，
       而 WebUI 会把正文渲染出的第一张图提升成整张卡片的背景）
     ⇒ 聚合主卡只显示标题 + `×N`，**不再顶着「第 1 条」的封面误导人**；图和原文都完整保留在第 1 个子项里
6. 落库
7. 广播给频道订阅者
```

响应：

```json
// 新建消息
{"id": 15, "appid": 1, "message": "CPU 95%", "title": "CPU 告警", ...}

// 被路由规则丢弃
{"dropped": true}

// 被聚合进已有消息（返回的是被更新的那条老消息）
{"id": 14, "aggCount": 3, "aggChildren": [...], ...}
```

**创建消息时的字段上限：**

| 字段 | 限制 |
|---|---|
| `title` | 截断到 500 字符 |
| `message` | 截断到 50000 字符 |
| `extras` | JSON 序列化后 > 10000 字符 → 整个丢弃，置为 `null` |
| `tags` | 最多 20 个，每个截断到 50 字符 |
| `priority` | 夹到 0–10，默认 5 |

### `DELETE /message/:id` 频道订阅者/管理员

软删（写 `deleted_at`），广播 `messageDeleted`。

```json
{}
```

同时会清理该消息**独占**的附件（还有别的消息引用就不删）。

### `GET /message/search` 登录

全文搜索（`LIKE %q%` 模糊匹配）。

| 参数 | 默认 | 说明 |
|---|---|---|
| q | — | 搜索关键词。不传或为空 → 返回空列表（不是 400） |
| limit | 50 | 上限 200 |
| channel | — | 只搜该频道 |

响应：

```json
{
  "query": "告警",
  "count": 3,
  "messages": [ { "id": 15, "title": "CPU告警", ... } ]
}
```

特点：

- 中文单字、双字、英文都能搜，大小写不敏感
- 同时匹配 `title` 和 `message`
- 按 **`id` 倒序**（最新优先）—— 和 `GET /message` 相反
- 普通用户只能搜订阅的频道

```bash
curl "http://<host>:20010/message/search?q=告警" \
  -H "Authorization: Bearer <token>"
```

### `POST /message/:id/read` 登录

```json
{"ok": true, "readAt": 1789...}
```

向**自己的所有设备**广播 `messageRead`。

### `POST /message/:id/unread` 登录

```json
{"ok": true}
```

### `POST /message/read-all` 登录

```json
// 请求（可选指定频道）
{"channel_id": 1}
// 或 {} 表示全部

// 响应
{"count": 8}
```

跳过已收藏的消息。广播 `messagesReadAll`。

### `POST /message/:id/archive` 登录

收藏（服务端字段名仍是 `archived_at`，API 路径也仍是 `archive`；只是 UI 文案改成了「收藏」）。

```json
{"ok": true, "archivedAt": 1789...}
```

广播 `messageArchived`。

### `POST /message/:id/unarchive` 登录

```json
{"ok": true}
```

### `GET /message/unread-counts` 登录

```json
{
  "total": 5,
  "byChannel": {"1": 3, "2": 2}
}
```

排除已收藏的消息。管理员统计所有频道，普通用户只统计订阅的频道。

---

## 5. 应用

应用是消息的来源身份。每个应用有一个独立的 token，用于 Webhook 鉴权。

> 📌 **应用按用户隔离**（2026-10-01 起）：**所有登录用户**都能管理自己的应用，
> 每人只看得到自己创建的（`user_id` = 自己）。**管理员也看不到别人的应用** ——
> 要看全站用超管专用接口 [`GET /admin/applications`](#15-超管管理页全站只读)。
> 建/改应用时 `channel_id` 必须是自己订阅的或自己创建的频道（超管不限）。

### `GET /application` 登录

```json
[
  {
    "id": 1,
    "name": "默认应用",
    "description": "自建 Gotify 兼容服务",
    "image": null,
    "internal": false,
    "token": "aB3xK9mQ2p",
    "defaultPriority": 0,
    "channelId": 1,
    "template": null
  }
]
```

| 字段 | 说明 |
|---|---|
| token | Webhook URL 里用的那段。**10 位大小写字母+数字**（如 `aB3xK9mQ2p`），全局唯一。旧的 48 位 hex 会在启动迁移时自动换成新格式 |
| channelId | 应用默认发到哪个频道 |
| template | 消息模板（JSON 字符串），见 [TEMPLATE.md](TEMPLATE.md) |
| internal | 恒为 `false`（为兼容 Gotify 客户端保留） |
| defaultPriority | 恒为 `0`（同上，未实现） |

> 🔒 **这个接口会返回明文 token，所以历史上要求管理员权限。**
> 2026-09-30 之前它只要求登录、不看角色 —— 注册是开放的，等于任何人注册个账号
> 就能拿到全部应用的 Webhook 凭据。之后收紧到 `requireAdmin`；
> 2026-10-01 起改成**按 `user_id` 过滤**，每人只能拿到自己创建的，
> 泄露面回到「只有归属者」，于是权限回到「仅登录」。
>
> ⚠️ 曾经这里写的是 `token: row.token || AUTH_TOKEN`，即 token 为空时回落到
> **全局主密钥**。主密钥 = 超级管理员身份（能提升任意人、读所有私有频道），
> 一旦某行 token 为空就是把整站交出去。现在改成 `|| null` ——
> 宁可 Webhook URL 显示不出来，也不能吐主密钥。

### `POST /application` 登录

```json
// 请求
{
  "name": "GitHub",
  "description": "GitHub 通知",
  "channel_id": 1,
  "template": null
}

// 响应：同 GET 列表，含自动生成的 token
```

不传 `channel_id` 时，优先落到**该用户自己订阅的第一个频道**；一个都没订阅才回落到
id 最小的频道（默认频道 id = 1）。

> `channel_id` 必须是自己**订阅的或自己创建的**频道，否则 `403` —— 否则随便填个 id
> 就能把 webhook 消息发进别人的私有频道。超管不受此限制。

### `PATCH /application/:id` 登录

支持修改：`name`、`description`、`image`、`channel_id`、`template`。

### `DELETE /application/:id` 登录

```json
{"deletedMessages": 5}
```

连带软删该应用发的所有消息，逐条广播 `messageDeleted`，并删除应用图标文件。

### `POST /application/:id/icon` 登录

请求体是原始图片字节（≤ 5 MB）。

---

## 6. 附件

附件是"先把文件存下来、拿一个 URL"，消息怎么引用由调用方决定：
图片通常放进 `extras.image`，其他文件放进正文链接或 `extras.attachment`。

### `POST /attachment?name=xxx.png` 登录

请求体是**原始字节**（≤ 20 MB），文件名通过 query 传。

```bash
curl -X POST "http://<host>:20010/attachment?name=shot.png" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @shot.png
```

```json
{
  "url": "/attachments/9f3c1e...a7.png",
  "name": "shot.png",
  "size": 48213,
  "isImage": true,
  "contentType": "image/png"
}
```

| 字段 | 说明 |
|---|---|
| url | 静态目录直链，免鉴权，客户端可直接 `<img src>` |
| name | 原始文件名（只做字符白名单清洗 + 截断到 120 字符，仅用于展示） |
| isImage | 是否按魔数判定为图片（不含 svg） |
| contentType | 图片时为 `image/png|jpeg|gif|webp`，否则 `null` |

> 落盘文件名是**16 字节随机 hex**，与 `name` 无关，URL 不可猜。
> 危险扩展名（`html / svg / js / xml …`）会被强制改成 `.bin`，
> 静态服务对非图片一律发 `Content-Disposition: attachment`。

### 附件回收

- 删消息时：该消息**独占**的附件跟着删（还有别的未删消息引用同一个 URL 就不删）
- 服务启动时：全量扫一遍目录，谁都没引用的孤儿附件一并清理

清空全部消息、裁剪历史、删频道这些路径不会逐条通知附件，靠启动扫描兜底。

---

## 7. Webhook

### `POST /hook/:token` 公开

`:token` 是**应用对象里的 `token` 字段**，不是 `AUTH_TOKEN`。

支持四种输入方式：

**方式 1：纯文本 body（推荐）**

```bash
curl -d "服务器挂了" http://<host>:20010/hook/<app-token>
```

不需要 `Content-Type`，不需要 JSON。中文、空格、换行、emoji、Markdown 都能直接发。

**方式 2：JSON body**

```bash
curl -X POST http://<host>:20010/hook/<app-token> \
  -H "Content-Type: application/json" \
  -d '{"title":"GitHub","message":"新提交","priority":5}'
```

| 字段 | 类型 | 说明 |
|---|---|---|
| message | string | 消息正文（必填） |
| title | string | 标题 |
| priority | int | 0–10 |
| channel_id | int | 目标频道 |
| tags | string[] | 标签 |
| extras | object | 任意 JSON |
| silent | bool | 静默 |

**方式 3：表单 `multipart/form-data`（`curl -F`）**

```bash
curl -F "title=下载完成" -F "message=Ubuntu 24.04.iso" -F "priority=5" \
  http://<host>:20010/hook/<app-token>
```

qBittorrent 这类程序习惯用 `-F` 推送。种子名里常带空格、引号、百分号、方括号，
用 JSON 手拼字符串很容易转义出错，而 `-F` 天然安全。

> ⚠️ 表单模式下**模板不会生效**（模板只在 JSON 模式渲染，`_isJSON` 为 true 才走）。
> 表单字段会按 JSON 那套语义做类型转换：`priority` / `channel_id` 转整数，
> `tags` 按逗号切分，`silent` 认 `true` 和 `1`。文件内容直接忽略。

**方式 4：空 body + query 参数**

```bash
curl "http://<host>:20010/hook/<app-token>?message=hello&priority=5"
```

浏览器地址栏直接输入也能发。

### Query 参数

同时适用于纯文本、表单和 JSON 模式（**JSON 模式下 body 优先**）：

| 参数 | 类型 | 说明 |
|---|---|---|
| message | string | 消息正文（body 为空时使用） |
| title | string | 标题 |
| priority | int | 0–10 |
| channel_id | int | 目标频道 |
| tags | string | 逗号分隔，如 `urgent,prod` |
| silent | bool | `true` 或 `1` 触发静默 |

### 响应与处理流程

HTTP **立即**返回，后续处理在 `setImmediate` 里异步进行：

```json
{"received": true, "appid": 1}
```

```text
1. 按 token 找应用（找不到 → 404 unknown token）
2. 解析 body（JSON / 表单 / 纯文本）+ 合并 query 参数
3. 如果应用有 template 且 body 是 JSON → 用模板引擎渲染
4. 否则 → 直接取 message / title / priority / tags / extras
   - 标题缺省用应用名，优先级缺省为 5
5. 走 createMessage() → 路由 → 聚合 → 落库 → 广播
   - 路由**只用该应用归属用户自己的规则**（2026-10-01 起规则按用户隔离）
   - 落库时写入 `extras.app`（应用快照，含名字/图标、不含 token）
```

如果最终正文为空（trim 后），这条请求会被静默丢弃，不入库。

### 完整示例

```bash
TOKEN=aB3xK9mQ2p

# 最简
curl -d "test" http://<host>:20010/hook/$TOKEN

# 带标题和优先级
curl -d "CPU 95%" "http://<host>:20010/hook/$TOKEN?priority=9&title=紧急"

# 指定频道
curl -d "部署完成" "http://<host>:20010/hook/$TOKEN?channel_id=2"

# 带标签
curl -d "上线了" "http://<host>:20010/hook/$TOKEN?tags=deploy,prod"

# 静默
curl -d "心跳" "http://<host>:20010/hook/$TOKEN?silent=true"

# Markdown
curl -d "**紧急** 磁盘满了" http://<host>:20010/hook/$TOKEN

# 多行
curl -d "第一行
第二行" http://<host>:20010/hook/$TOKEN

# 表单（qBittorrent 风格）
curl -F "title=下载完成" -F "message=带空格 的 名字.mkv" http://<host>:20010/hook/$TOKEN

# JSON（兼容旧用法）
curl -H "Content-Type: application/json" \
  -d '{"message":"JSON 模式","priority":7}' \
  http://<host>:20010/hook/$TOKEN
```

### `POST /hook/preview` 公开

用示例数据预览模板渲染结果，不入库。限速 30 次 / 分钟。

```json
// 请求
{
  "template": {"title": "{{name}}", "message": "Hi {{user.name}}"},
  "data": {"name": "Test", "user": {"name": "Alice"}}
}

// 响应
{"ok": true, "rendered": {"title": "Test", "message": "Hi Alice"}}
```

模板语法见 [TEMPLATE.md](TEMPLATE.md)。

---

## 8. 路由规则

规则引擎在消息落库前运行。按 `priority DESC` 依次匹配执行。

> 📌 **规则按用户隔离**（2026-10-01 起）：**所有登录用户**都能建自己的规则，
> 且**只作用于自己的消息** ——
>   - 登录用户发消息 → 只跑他自己的规则
>   - Webhook → 只跑该应用归属用户的规则
>
> 每人只看得到自己创建的（`user_id` = 自己），**管理员也看不到别人的规则**；
> 要看全站用 [`GET /admin/routes`](#15-超管管理页全站只读)。
>
> ⚠️ `broadcast_to` 的目标频道会被过滤成「公开 / 自己订阅 / 自己创建」（超管不限）——
>    防止任何注册用户把消息投进别人的私有频道。

### `GET /route` 登录

```json
[
  {
    "id": 1,
    "name": "紧急升级",
    "enabled": true,
    "priority": 90,
    "conditions": {"priority_gte": 8},
    "actions": [{"type": "add_tag", "value": "urgent"}],
    "createdAt": 1789969060495
  }
]
```

### `POST /route` 登录

```json
// 请求
{
  "name": "紧急升级",
  "priority": 90,
  "enabled": true,
  "conditions": {"priority_gte": 8},
  "actions": [
    {"type": "set_priority", "value": 10},
    {"type": "add_tag", "value": "urgent"}
  ]
}
```

`priority` 默认 **50**，会被夹到 0–100。`conditions` 和 `actions` 必填。

### `PATCH /route/:id` 登录

修改任意字段（`priority` 同样夹到 0–100）。

### `DELETE /route/:id` 登录

```json
{"ok": true}
```

### `POST /route/test` 登录

不改数据，只测试规则是否命中。

```json
// 请求
{
  "conditions": {"priority_gte": 8},
  "actions": [{"type": "add_tag", "value": "urgent"}],
  "message": {"message": "hello", "priority": 9},
  "appName": "GitHub",
  "channelName": "监控"
}

// 响应
{
  "matched": true,
  "dropped": false,
  "silent": false,
  "result": {"message": "hello", "title": "", "priority": 9, "tags": ["urgent"]},
  "extraChannels": []
}
```

| 字段 | 说明 |
|---|---|
| matched | 是否命中条件 |
| dropped | 是否被丢弃 |
| silent | 是否被静默 |
| result | 处理后的消息 |
| extraChannels | 转发目标频道列表 |

> `appName` / `channelName` 只填**名字**，测试上下文里没有 id，
> 所以 `channel_id`、`app_id` 这两个条件在测试接口里永远不匹配。
> 要测它们请用真实发消息 + 看结果。

### `GET /route/templates` 登录

返回 7 个预置模板（含 id、name、description、conditions、actions、priority）。

支持的条件、动作详细说明见 [ROUTES.md](ROUTES.md)。

---

## 9. HTTPS 证书

全部接口均需**超级管理员**（`certs.js` 里对整个 `/certs` 挂了 `requireSuper`）。请求体是 PEM 原文（`express.raw`）。

### `GET /certs/status` 超级管理员

```json
{
  "httpsEnabled": true,
  "hasCrt": true,
  "hasKey": true,
  "certInfo": {
    "valid": true,
    "certCount": 2,
    "subject": "CN=chatz.example.com",
    "issuer": "CN=R3, O=Let's Encrypt, C=US",
    "validFrom": "Sep  1 00:00:00 2026 GMT",
    "validTo": "Nov 30 23:59:59 2026 GMT",
    "expired": false,
    "notYetValid": false,
    "selfSigned": false,
    "hasChain": true
  },
  "keyInfo": {"valid": true, "type": "rsa", "bits": 2048},
  "keyMatch": true,
  "error": null
}
```

`keyMatch: false` 时 `error` 里会写「证书与私钥不匹配」。

### `POST /certs/fullchain` 超级管理员

```bash
curl -X POST http://<host>:20010/certs/fullchain \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/x-pem-file" \
  --data-binary @fullchain.pem
```

```json
{
  "ok": true,
  "certInfo": {"subject": "...", "issuer": "...", "validTo": "...", "certCount": 2, "hasChain": true},
  "httpsStarted": true,
  "message": "证书已上传，HTTPS 已启用"
}
```

校验项：

- 必须含 `BEGIN CERTIFICATE` 块，能解析
- **已过期 / 尚未生效** → `400`
- 如果私钥已存在，会先验证**配对**，不匹配 → `400`

只上传了其中一个文件时不会启动 HTTPS，返回 `httpsStarted: false` 和「等待上传私钥 / 证书」。

### `POST /certs/privkey` 超级管理员

同样做私钥格式校验与配对校验。

### `DELETE /certs` 超级管理员

```json
{
  "ok": true,
  "message": "证书已删除",
  "httpsStopped": true,
  "note": "HTTPS 服务已关闭"
}
```

`httpsStopped: false` 时表示当时没有 HTTPS 服务在跑。已有连接不受影响，
**重启容器才会完全关闭**。

---

## 10. 背景

每个用户可以上传自己的界面背景图。

### `GET /background` 登录

```json
{
  "enabled": true,
  "url": "/background-files/user-2/bg-1789.jpg",
  "uploadedAt": 1789...
}
```

未设置：

```json
{"enabled": false}
```

### `POST /background` 登录

请求体是原始图片字节（≤ 8 MB），`png / jpg / webp`，**`svg` 会被拒**。
上传新图自动删除旧图。

```bash
curl -X POST http://<host>:20010/background \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/jpeg" \
  --data-binary @bg.jpg
```

```json
{"ok": true, "url": "/background-files/user-2/bg-1789.jpg"}
```

### `DELETE /background` 登录

```json
{"ok": true}
```

每个用户独立，互不影响。**模糊度、暗度、主题色都只存在浏览器 localStorage，不存服务端。**

---

## 11. 审计日志

### `GET /audit` 超级管理员

| 参数 | 默认 | 说明 |
|---|---|---|
| action | — | 按动作过滤，如 `login`、`register`、`app.delete` |
| userId | — | 按用户过滤 |
| since | — | 只返回 `ts > since` 的记录 |
| limit | 100 | 上限 500 |

```json
[
  {
    "id": 42,
    "ts": 1789982992010,
    "userId": 1,
    "ip": "203.0.113.7",
    "action": "app.create",
    "target": "3",
    "meta": {"name": "GitHub"},
    "success": true
  }
]
```

按 `ts DESC` 排序（最新在前）。

已记录的 action：

| action | 触发 | meta 里有什么 |
|---|---|---|
| `register` | 注册成功 / 失败 | `isAdmin`、`reason`（失败原因） |
| `login` | 登录成功 / 失败 | `reason`（`用户不存在` / `密码错误`） |
| `logout` | 登出（target = 设备 id） | — |
| `auth.bad_token` | 拿到无效 token 调接口 | `method`、`path`、`tokenPrefix`（只留前 8 位） |
| `auth.forbidden` | 已登录的普通用户撞管理员接口 | `method`、`path` |
| `auth.forbidden_super` | 已登录用户撞超管接口（证书 / 审计 / 管理页） | `method`、`path`、`role` |
| `hook.bad_token` | 用不存在的 token 调 webhook | `tokenPrefix`（只留前 8 位） |
| `device.create` / `device.delete` | 签发 / 吊销设备 token | `name` |
| `device.reveal` | 二次验密码后取主密钥明文 | `success` |
| `user.avatar.upload` / `user.avatar.delete` | 头像 | target = 文件名 |
| `user.background.upload` / `user.background.delete` | 聊天背景 | target = 文件名 |
| `user.profile.update` | 改昵称 | `displayName` |
| `user.email_change` | 改 / 清空邮箱 | `email` |
| `user.username_change` | 改登录用户名 | `before`、`after`、`reason`（失败：重名） |
| `user.password_change` | 改密码 / 管理员重置他人密码 | `self`、`revokedDevices`、`reason`（失败原因） |
| `setup.complete` | 首次引导：给全新安装设管理员账号 | `username` |
| `config.set_lang` | 超管改整机日志语言（`PUT /config/lang`） | `before`、`after`、`locked` |
| `app.create` / `app.update` / `app.delete` | 应用管理 | `name`、`changed`（改了哪些字段）、`deletedMessages` |
| `app.icon.upload` | 应用图标 | — |
| `channel.create` / `channel.update` / `channel.delete` | 频道管理（含 `is_public` 翻转） | `name`、`isPublic`、`changed`、`deletedMessages` |
| `channel.subscribe` / `channel.unsubscribe` | 订阅 / 退订（= 频道消息可见权） | `name`、`private` |
| `channel.icon.upload` | 频道图标 | — |
| `route.create` / `route.update` / `route.delete` | 路由规则（最高权限配置） | `name`、`priority`、`actionTypes` |
| `certs.upload.crt` / `certs.upload.key` / `certs.delete` | TLS 证书/私钥 | `subject`、`validTo`、`type`、`bits`、`httpsStarted` |
| `message.create` | 通过登录态发消息（不含 webhook 那条路） | `appid`、`channelId`、`title`、`dropped`、`aggregated` |
| `message.delete` | 删除消息 | `channelId`、`title`、`attachmentsRemoved` |
| `attachment.create` | 附件上传 | `name`、`size`、`ext` |

节流与脱敏规则：

- `auth.bad_token` / `auth.forbidden` / `auth.forbidden_super` / `hook.bad_token` 是**攻击者可刷**的失败事件，
  按 IP（或用户 + 路径）**5 分钟只记一条**，否则一分钟就能灌进几十万行把真记录淹掉。
- token 一律只记前 8 位，证书私钥**只记类型和位数、绝不记 PEM 内容** ——
  审计日志是给管理员在网页端翻的，不该成为第二个密钥仓库。
- `ip` 最长 64 字符、`target` 200、`meta` 里每个值 200、最多 20 个字段。

保留策略：默认保留 `AUDIT_RETENTION_DAYS=90` 天且最多 `AUDIT_MAX_ROWS=50000` 条，
启动时和之后每 6 小时各裁一次。

> IP 默认取 **TCP 对端地址**，`X-Forwarded-For` 只在设了 `TRUST_PROXY` 时才采信
> （详见 README 的环境变量表）。端口直接对外时**不要开** `TRUST_PROXY`，
> 开了就等于让攻击者自己填限速用的 IP。

---

## 12. WebSocket

### 连接

```text
ws://<host>:20010/stream?token=<token>
wss://<host>:20443/stream?token=<token>
```

也可以带 `Authorization: Bearer <token>` 头。

连接约束：

- **路径必须是 `/stream`**，其他路径在 upgrade 阶段直接断掉
- 全局连接上限 **1000**，超过 → HTTP `503`
- 单用户连接上限 **10**，超过 → HTTP `429`
- Token 无效 → HTTP `401`

### 服务端推送

新消息（无 `event` 字段）：

```json
{
  "id": 15,
  "appid": 1,
  "message": "CPU 95%",
  "title": "CPU 告警",
  "priority": 8,
  "date": "2026-09-21T09:29:52.019Z",
  "extras": null,
  "channel_id": 1,
  "tags": ["urgent"],
  "aggCount": 1,
  "aggLastAt": 1789...
}
```

事件消息（有 `event` 字段）：

| event | 数据 | 触发 |
|---|---|---|
| `messageDeleted` | `{id}` | 消息被删 |
| `messageAggregated` | `{message}` | 消息被聚合进已有卡片 |
| `messageRead` | `{messageId, userId, readAt}` | 标已读 |
| `messageUnread` | `{messageId, userId}` | 标未读 |
| `messagesReadAll` | `{channelId, readAt, count}` | 批量已读 |
| `messageArchived` | `{messageId, archivedAt}` | 收藏 |
| `messageUnarchived` | `{messageId}` | 取消收藏 |
| `channelCreated` | `{channel}` | 新频道（不带 subscribed/muted） |
| `channelUpdated` | `{channel}` | 频道修改 |
| `channelDeleted` | `{channelId}` | 频道删除 |
| `subscriptionChanged` | `{channelId, action, muted?}` | 你订阅 / 取消 / 改静音 |
| `userUpdated` | `{}` | **你自己**的账号信息被改了（头像 / 昵称 / 用户名 / 邮箱 / 密码） |

`subscriptionChanged` 的 `action` 取值：`subscribed` / `unsubscribed` / `muted`。

> 频道元信息事件（`channelCreated` / `channelUpdated` / `channelDeleted`）的收件人是
> **「订阅者 ∪ 创建者」**—— 超管**不再**全收（2026-10-01 起，为省电）。
> 超管收不到未订阅频道的删除事件，本地会残留 `subscribed=0` 的幽灵记录（无害），
> 靠客户端「打开抽屉 / 前台时的 refreshChannelList 全量对账」兜底清理。

#### `userUpdated`

只推给**被改动的那个用户**自己的所有连接（`broadcastToUser`），别人收不到。

事件体是空的 —— 它只是个「你该重拉了」的信号。收到后请重新 `GET /auth/me`
拉一份最新账号信息覆盖本地。

为什么不直接把新内容塞进事件里：那样服务端每次加字段，客户端都得跟着改，
漏一个就静默不同步；推信号 + 重拉则天然不会漏。

触发点：`POST/DELETE /user/avatar`、`PATCH /user/profile`、`PATCH /user/email`、
`PATCH /user/username`、`PATCH /user/password`（管理员重置他人时会推给被改的那个用户）。

典型场景：手机客户端换了头像，网页端不需要手动刷新就能看到。

### 客户端发送

| 内容 | 用途 |
|---|---|
| `""` | 心跳（服务端忽略） |
| `"{}"` | 心跳（服务端忽略） |

### 分频道接收

| 身份 | 收到 |
|---|---|
| 任何用户 | **只收订阅频道的消息** |

⚠️ 2026-10-01 起这里也**没有管理员 / 超管特权**了：消息推送走 `broadcastToChannel`，
只按 `ws.subscribedChannels` 筛人，超管也不例外。超管的「全站数据」走
[第 15 节 `GET /admin/*`](#15-超管管理页全站只读)，不从这条实时流里拿。

路由规则的 `broadcast_to` 会把一条消息投给多个频道，服务端用
`broadcastToChannels` 做了**每客户端只投一次**的去重，不会重复收到同一条。

### 心跳

服务端每 30 秒主动 `ping` 一次，客户端需要响应 `pong`。
浏览器 WebSocket API 自动处理，原生客户端要自己回。

连续两次 ping 没回（约 60 秒）连接会被 `terminate`。

---

## 13. 静态资源

| 路径 | 说明 |
|---|---|
| `/` | Web UI（`public/`） |
| `/reset-password?token=<重置令牌>` | 同一个 Web UI —— 前端读到 `?token=` 后切到「重置密码」视图。**免鉴权**（重置令牌本身就是凭据） |
| `/icons/<file>` | 应用图标 |
| `/channel-icons/<file>` | 频道图标 |
| `/user-avatars/<file>` | 用户头像 |
| `/attachments/<file>` | 消息附件（图片 `inline`，其余 `attachment`） |
| `/background-files/user-<id>/<file>` | 用户背景 |

全部免鉴权，缓存头 `Cache-Control: public, max-age=300`。
`/attachments` 额外带 `X-Content-Type-Options: nosniff`（下面那张表里的头全响应都会带）。

> `/reset-password` 只是把 `index.html` 送出去，**它本身不校验令牌**。
> 真正的校验在 `GET /auth/reset-password/validate` 和 `POST /auth/reset-password`，
> 所以拿一个随便编的 `?token=` 也能打开页面，但提交时会报错。

---

## 14. 安全响应头

所有响应（含静态资源）都会带上：

| 头 | 值 | 作用 |
|---|---|---|
| `Content-Security-Policy` | 见下 | 限制脚本 / 图片 / 连接的来源，XSS 的最后一道兜底 |
| `X-Content-Type-Options` | `nosniff` | 阻止浏览器猜 MIME（把 `text/plain` 当 HTML 执行） |
| `X-Frame-Options` | `DENY` | 禁止被 `<iframe>` 嵌套，防点击劫持 |
| `Referrer-Policy` | `no-referrer` | 不外发 Referer —— URL 里的 `?token=` 不会泄漏给第三方 |
| `Permissions-Policy` | `geolocation=(), microphone=(), camera=(), payment=()` | 关掉用不到的设备能力 |
| `Strict-Transport-Security` | 仅 HTTPS 且 `HSTS_MAX_AGE > 0` 时下发 | 强制后续请求走 HTTPS |

`X-Powered-By` 已移除（不再暴露 Express）。

CSP 的当前值（`<Host>` 会替换成请求的 Host 头）：

```text
default-src 'self';
script-src 'self' https://cdn.jsdelivr.net;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https: http:;
connect-src 'self' ws://<Host> wss://<Host>;
font-src 'self' data:;
media-src 'self' data: blob:;
object-src 'none';
frame-src 'none';
frame-ancestors 'none';
base-uri 'self';
form-action 'self'
```

几条取舍，改之前先读：

- **`script-src` 刻意没有 `'unsafe-inline'`**。加它就等于 CSP 对 XSS 基本失效。
  代价是 `index.html` 里不能写内联 `<script>` —— 首屏过渡和背景预置已外置到 `/boot.js`。
- **`style-src` 必须留 `'unsafe-inline'`**：页面大量使用 `style="..."` 内联属性，
  去掉会整页掉样式。CSS 注入的危害远小于 JS，可接受。
- **`connect-src` 按请求 Host 放行 `ws://` / `wss://`**：页面连的是
  `${proto}//${location.host}/stream`，scheme 是 ws，而 CSP 的 `'self'` 只认
  http/https 同 scheme —— 光写 `'self'` 会把实时推送挡掉。
- **`img-src` 放开 `https:` 和 `http:`**：消息封面图和 markdown 图片可能来自任意外链。
- **`script-src` 放行 `cdn.jsdelivr.net`**：网页端渲染 markdown 用的
  `marked` / `dompurify` 从 CDN 加载（版本已锁死 `@3.0.6` / `@12.0.2`）。
  这两库加载失败时会退回「原文转义后纯文本显示」，不会变成 XSS。
  想彻底去掉这个外部依赖，可以把两个文件下载到 `public/` 改成相对路径引用。

HSTS 默认**关闭**（`HSTS_MAX_AGE=0`）。它一旦下发浏览器就会记住，到期前无法撤销；
自建服务常换证书 / 换域名 / 临时退回 HTTP 调试，证书出问题时浏览器会**硬拒绝**连接
而且普通用户不知道怎么清，所以做成显式开启：

```bash
HSTS_MAX_AGE=15552000          # 180 天，常见取值
HSTS_INCLUDE_SUBDOMAINS=true   # 可选，确认所有子域都能 HTTPS 再开
```

> 通过反代上 HTTPS 时，`req.secure` 由 `X-Forwarded-Proto` 决定，
> 所以必须同时设 `TRUST_PROXY`，否则 HSTS 永远不会下发。

---

## 15. 超管管理页（全站只读）

频道、应用、路由规则在 2026-10-01 起都改成了**按用户隔离** —— 日常接口
（`GET /channel`、`GET /application`、`GET /route`）只返回登录者自己的，
**管理员也看不到别人的**。超级管理员要看全站谁建了什么，走这一组接口。

> ⚠️ 全部要求**超级管理员**（role 2），且**只读**。
> 管理页目前只要求「看得到」，所以没开增删改 —— 真要动别人的资源另开接口，
> 那样每一步都能单独审计，比一个万能 PATCH 安全。

### `GET /admin/channels` 超级管理员

```json
[
  {
    "id": 2,
    "name": "家庭",
    "description": null,
    "image": null,
    "isPublic": true,
    "creatorId": 3,
    "creatorName": "bob",
    "createdAt": 1789...,
    "passwordProtected": false
  }
]
```

### `GET /admin/applications` 超级管理员

带 `ownerId` / `ownerName`。⚠️ `token` 是**明文** —— 这是管理页，超管本来就该能查看全站凭据，
但也正因如此这条必须 `requireSuper` 且只读。

```json
[{"id": 5, "name": "平板", "token": "abc...", "channelId": 1, "ownerId": 3, "ownerName": "bob", "createdAt": 1789...}]
```

### `GET /admin/routes` 超级管理员

带 `ownerId` / `ownerName`，`conditions` / `actions` 已解析成对象。

```json
[{"id": 1, "name": "紧急升级", "enabled": true, "priority": 90, "conditions": {...}, "actions": [...], "ownerId": 1, "ownerName": "yezi", "createdAt": 1789...}]
```

---

## 消息字段

| 字段 | 说明 |
|---|---|
| id | 消息 ID（递增整数，可用于 `since`） |
| appid | 应用 ID |
| channel_id | 频道 ID |
| date | ISO8601 UTC 时间 |
| tags | 标签数组 |
| isRead | 当前用户是否已读 |
| readAt | 已读时间戳 |
| archivedAt | 收藏时间戳 |
| aggCount | 聚合了几条（≥ 1） |
| aggLastAt | 最后一次聚合时间 |
| aggChildren | 被聚合的子消息数组（**含原消息本身**；最多保留最近 100 条。`AGG_MAX_LIFETIME_MS` 用于防止无限续命把早期条目挤出这里） |

### `extras` 里的约定字段

| 字段 | 说明 |
|---|---|
| `extras.image` | 封面图 URL。优先级：`image` → `client::display.url` → `client::notification.bigImageUrl` |
| `extras.sender` | **发送者快照**，见下 |
| `extras.app` | **应用快照**，见下 |

> **图片到底放正文还是放 `extras`？两个都得放。**
> 两个通道取图的位置不一样：客户端（Android）读 `extras.image`，而 **WebUI 读正文渲染出来的第一张图**
> （`public/app.js` 会把它摘下来提升成整张卡片的背景）。只放一边的话另一边就不显示。
>
> 反过来，正文里的 `![](...)` 在**通知正文 / 引用摘要 / 聚合子项**里会被剥掉（图片由 `extras.image`
> 单独呈现，避免同一张图显示两次），所以别指望它能当正文内容用。

### 发送者快照 `extras.sender`

消息表里没有 `user_id` 列，所以发送者信息作为快照写进 `extras`：

```json
{
  "id": 2,
  "username": "alice",
  "displayName": "Alice",
  "isAdmin": false
}
```

- 只有走 `POST /message`（带登录身份）才有；**Webhook 那条路没有登录用户，不带这个字段**
- 在路由引擎**之后**写入，且**无条件覆盖** —— 否则任何持有 token 的客户端都能伪造 sender 冒充别人
- 已知代价：用户之后改昵称，旧消息仍显示当时的名字

### 应用快照 `extras.app`

应用在 2026-10-01 起**按用户隔离**（`GET /application` 只返回自己的），客户端就查不到
「别人应用」的名字/图标了 —— 而订阅了别人频道的人是**看得到那些消息**的。
所以和 `sender` 一样，把应用信息作为快照写进 `extras`：

```json
{
  "id": 5,
  "name": "Jellyfin",
  "image": "/icons/5-1789.png"
}
```

- **所有消息都有**（Webhook 和 `POST /message` 都会写）
- ⚠️ 只含 `id` / `name` / `image`，**不含 token**（webhook 凭据，绝不外泄）
- `image` 是**相对路径**，客户端自己拼服务器基址
- 客户端应**优先用它**，不要依赖 `GET /application`（那份列表现在只有自己的应用）
- 同样在路由引擎**之后**写入、**无条件覆盖**；已知代价：应用改名后旧消息仍显示当时的名字

---

## 完整示例

### curl 全流程

```bash
HOST=http://localhost:20010

# 1. 注册
curl -X POST $HOST/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"alice123","displayName":"Alice"}'

# 得到：{"user":{...},"token":"cz.kR9mX2pQ7tL..."}
TOKEN="cz.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# 2. 查频道
curl $HOST/channel -H "Authorization: Bearer $TOKEN"

# 3. 建频道
curl -X POST $HOST/channel \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"工作","description":"工作通知","is_public":true}'

# 4. 发消息
curl -X POST $HOST/message \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"测试","message":"hello","priority":5,"channel_id":2}'

# 5. 拉列表
curl "$HOST/message?limit=50&since=0" -H "Authorization: Bearer $TOKEN"

# 6. 搜索
curl "$HOST/message/search?q=hello" -H "Authorization: Bearer $TOKEN"

# 7. 标已读
curl -X POST $HOST/message/15/read -H "Authorization: Bearer $TOKEN"

# 8. 收藏
curl -X POST $HOST/message/15/archive -H "Authorization: Bearer $TOKEN"

# 9. 未读数
curl $HOST/message/unread-counts -H "Authorization: Bearer $TOKEN"

# 10. 应用列表
curl $HOST/application -H "Authorization: Bearer $TOKEN"
```

### Webhook 一行发送

```bash
APP_TOKEN=aB3xK9mQ2p

curl -d "服务器挂了" http://localhost:20010/hook/$APP_TOKEN
curl -d "CPU 95%" "http://localhost:20010/hook/$APP_TOKEN?priority=9&title=紧急"
curl -d "**紧急** 磁盘满" "http://localhost:20010/hook/$APP_TOKEN?tags=urgent"
```

### Node.js WebSocket

```js
const WebSocket = require('ws');

const token = 'cz.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const ws = new WebSocket('ws://localhost:20010/stream?token=' + token);

ws.on('open', () => console.log('✅ connected'));

ws.on('message', (raw) => {
  const data = JSON.parse(raw.toString());

  if (data.id && data.message != null && !data.event) {
    console.log('📬 新消息:', data.title, '-', data.message);
    return;
  }

  switch (data.event) {
    case 'messageDeleted':
      console.log('🗑️ 删除:', data.id);
      break;
    case 'messageAggregated':
      console.log('📎 聚合:', data.message.id, 'x' + data.message.aggCount);
      break;
    case 'messageRead':
      console.log('✓ 已读:', data.messageId);
      break;
  }
});
```

### Android / Kotlin

```kotlin
val client = OkHttpClient.Builder()
    .pingInterval(30, TimeUnit.SECONDS)
    .build()

val request = Request.Builder()
    .url("wss://<host>:20443/stream?token=$token")
    .build()

val ws = client.newWebSocket(request, object : WebSocketListener() {
    override fun onMessage(ws: WebSocket, text: String) {
        val obj = JSONObject(text)
        when (obj.optString("event")) {
            "messageDeleted" -> {
                val id = obj.getLong("id")
                // 删除本地消息
            }
            "" -> {
                if (obj.has("message")) {
                    // 新消息
                }
            }
        }
    }

    override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
        // 断线重连
    }
})
```

### 第三方 Webhook

```http
POST http://<host>:20010/hook/<app-token>
Content-Type: application/json
```

不需要鉴权头，token 就是 URL 里的那段。

---

## 版本

当前版本：2.0.0。`GET /version` 返回版本信息。
