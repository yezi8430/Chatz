# Template syntax

> **中文**: [TEMPLATE.md](TEMPLATE.md)

Chatz webhooks support **templates** that render the raw JSON from a third party into a readable
notification. Templates use a Mustache-like syntax — nothing new to learn.

## Quick start

Set the `template` field on an app (a JSON string). When a webhook arrives:

1. Parse the raw JSON into `data`
2. Render `template` with `data`
3. Use the rendered result as the message's `title`, `message`, `priority`, `extras`, `tags`

In the web UI: sidebar "Apps" → edit app → Template. Or via the API `PATCH /application/:id`.

## Template shape

The template itself is a JSON object telling Chatz how to build the message fields:

```json
{
  "title": "标题模板",
  "message": "正文模板",
  "priority": 5,
  "extras": {},
  "tags": []
}
```

| Field | Type | Meaning |
|---|---|---|
| title | string | message title |
| message | string | message body, Markdown supported |
| priority | number or string | 0–10; a string is rendered first, then converted |
| extras | any | passed through to clients verbatim (e.g. an image) |
| tags | array | tags |

Only `message` is required; everything else can be omitted (defaults apply).

> If the rendered `message` comes out empty, Chatz **falls back** to the raw `message` field from
> the body. So a template that only sets `title` is safe.

---

## Variables

Substitute with `{{name}}`.

```json
{"message": "Hello {{name}}"}
```

Given this `data`:

```json
{"name": "Alice"}
```

The rendered result is:

```json
{"message": "Hello Alice"}
```

### Nested paths

Use dots to reach nested fields:

```json
{"message": "仓库 {{repository.full_name}} 有更新"}
```

Against:

```json
{"repository": {"full_name": "user/repo"}}
```

If any step along the path is `null` / `undefined`, it renders as an empty string.

### Default values

Append a default with `|`; it is used when the field is empty or missing:

```json
{"message": "作者：{{author.name | \"匿名\"}}"}
```

Rendered result (when `author.name` does not exist):

```json
{"message": "作者：匿名"}
```

Constraints:

- The default must be wrapped in **single or double quotes** (unquoted it is parsed as a path)
- It triggers on `undefined` / `null` / **empty string**. `0` and `false` do **not** trigger it
- Do not put `|` inside a variable name — it would be read as the separator

---

## Conditionals

Use `{{#if condition}}...{{/if}}`.

### Simple truthiness

```json
{"message": "{{#if user}}用户在线{{/if}}"}
```

Counts as true when the value exists and is not `false`, `"0"` or `""`.

### Equals / not equals

```json
{"message": "{{#if status == \"down\"}}服务挂了{{/if}}"}
{"message": "{{#if status != \"up\"}}服务异常{{/if}}"}
```

Both sides are stringified before comparison, so `{{#if heartbeat.status == "0"}}` matches the
number `0`.

### if-else

```json
{"message": "{{#if status == \"down\"}}❌ 服务挂了{{else}}✅ 正常{{/if}}"}
```

### Nested conditionals

```json
{
  "message": "{{#if monitor.url}}{{#if monitor.status == \"down\"}}地址 {{monitor.url}} 挂了{{/if}}{{/if}}"
}
```

The safety limit for nesting depth is 50; beyond that expansion stops (it will not hang).

---

## Loops

Use `{{#each array}}...{{/each}}`.

```json
{"message": "{{#each items}}· {{this}}\n{{/each}}"}
```

Data:

```json
{"items": ["a", "b", "c"]}
```

Renders:

```text
· a
· b
· c
```

### With an index

Use `{{@index}}` for the index (starting at 0):

```json
{"message": "{{#each items}}{{@index}}. {{this}}\n{{/each}}"}
```

### Looping over an array of objects

```json
{
  "message": "{{#each commits}}· {{hash}} - {{message}}\n{{/each}}"
}
```

Data:

```json
{
  "commits": [
    {"hash": "abc123", "message": "fix bug"},
    {"hash": "def456", "message": "add feature"}
  ]
}
```

Renders:

```text
· abc123 - fix bug
· def456 - add feature
```

Inside the loop body just use the **field name directly** — no need for `{{this.hash}}`.

---

## Priority

`priority` can be a number, or a string that becomes a number after rendering.

```json
{"priority": 5}
```

```json
{"priority": "{{#if status == \"down\"}}10{{else}}5{{/if}}"}
```

In the second case the rendered result is `"10"` or `"5"`; Chatz runs `parseInt` on it.
If parsing fails it falls back to **5**, clamped to 0–10.

---

## Tags

```json
{"tags": ["alert", "{{source}}"]}
```

**String elements** of the array are rendered in full — meaning `{{#if}}` and `{{#each}}` work
inside a tag element too, not just plain substitution.

> The array **structure itself** cannot be expanded by `{{#each}}` into multiple tags (a template
> cannot say "loop over alerts and produce N tags"). For a dynamic number of tags, assemble the
> array upstream.

---

## extras

Passed through to clients; any shape.

```json
{
  "message": "看这张图",
  "extras": {
    "image": "{{screenshot_url}}"
  }
}
```

Clients read `extras.image` to display the picture. The cover-image lookup order is
`image` → `client::display.url` → `client::notification.bigImageUrl`, which follows the Gotify
convention so the same `extras` payload works on both ends.

---

## When templates do not apply

Templates are **rendered in JSON mode only**. That is decided by: the request carries
`Content-Type: application/json`, or the first non-whitespace character of the body is `{`.

| How you send | Does the template apply? |
|---|---|
| `Content-Type: application/json` + JSON body | ✅ yes |
| plain-text body (`curl -d "文本"`) | ❌ no |
| form post `curl -F` | ❌ no |
| empty body + query parameters | ❌ no |

> Form mode used to treat the whole `multipart` payload as the message body. Chatz now parses the
> fields out (text mode only), but still does **not** run templates.

Practical advice:

- If the sender (plugin / script) **has already composed** the title and body, **do not configure
  a template** on the app — leaving it empty is cleanest
- Templates are for accepting fixed third-party payloads (GitHub, Uptime Kuma, Grafana…)

---

## Real-world examples

### Uptime Kuma

Uptime Kuma's webhook payload looks roughly like:

```json
{
  "heartbeat": {
    "status": 0,
    "msg": "Connection refused",
    "time": "2026-09-21 12:00:00"
  },
  "monitor": {
    "name": "服务器 A",
    "url": "https://example.com",
    "hostname": "example.com"
  },
  "msg": "服务器 A 无法访问"
}
```

Template:

```json
{
  "title": "{{monitor.name}} {{#if heartbeat.status == \"0\"}}🔴 宕机{{else}}✅ 恢复{{/if}}",
  "message": "**{{monitor.name}}**\n\n{{heartbeat.msg}}\n\n地址：{{monitor.url}}\n时间：{{heartbeat.time}}",
  "priority": "{{#if heartbeat.status == \"0\"}}10{{else}}3{{/if}}",
  "tags": ["uptime"]
}
```

### GitHub Push

GitHub's push event:

```json
{
  "ref": "refs/heads/main",
  "pusher": {"name": "alice"},
  "repository": {
    "full_name": "user/repo",
    "html_url": "https://github.com/user/repo"
  },
  "commits": [
    {"id": "abc123", "message": "fix bug", "author": {"name": "Alice"}},
    {"id": "def456", "message": "add feature", "author": {"name": "Bob"}}
  ]
}
```

Template:

```json
{
  "title": "{{repository.full_name}} 新推送",
  "message": "**{{pusher.name}}** 推送了 {{#each commits}}`{{id}}` {{message}} {{/each}}",
  "priority": 5,
  "tags": ["github", "push"]
}
```

### GitHub Pull Request

```json
{
  "action": "opened",
  "pull_request": {
    "title": "Add new feature",
    "number": 42,
    "html_url": "https://github.com/user/repo/pull/42",
    "user": {"login": "alice"},
    "body": "This PR adds..."
  },
  "repository": {"full_name": "user/repo"}
}
```

Template:

```json
{
  "title": "PR #{{pull_request.number}} {{action}}",
  "message": "**{{pull_request.title}}**\n\n由 @{{pull_request.user.login}} 提交\n\n{{pull_request.body}}\n\n[查看 PR]({{pull_request.html_url}})",
  "priority": 5,
  "tags": ["github", "pr"],
  "extras": {
    "image": "{{pull_request.user.avatar_url}}"
  }
}
```

### Grafana Alert

Grafana's alert payload:

```json
{
  "status": "firing",
  "alerts": [
    {
      "labels": {"alertname": "HighCPU", "instance": "server1"},
      "annotations": {"summary": "CPU 使用率超过 90%"},
      "startsAt": "2026-09-21T12:00:00Z"
    }
  ]
}
```

Template:

```json
{
  "title": "{{#if status == \"firing\"}}🚨 Grafana 告警{{else}}✅ 告警恢复{{/if}}",
  "message": "{{#each alerts}}**{{labels.alertname}}**\n{{annotations.summary}}\n实例：{{labels.instance}}\n开始：{{startsAt}}\n{{/each}}",
  "priority": "{{#if status == \"firing\"}}9{{else}}3{{/if}}",
  "tags": ["grafana"]
}
```

### Docker Hub

```json
{
  "repository": {
    "repo_name": "user/app",
    "description": "My app"
  },
  "push_data": {
    "tag": "latest",
    "pushed_at": 1789982992
  }
}
```

Template:

```json
{
  "title": "Docker Hub: {{repository.repo_name}}",
  "message": "镜像 **{{repository.repo_name}}:{{push_data.tag}}** 已更新",
  "priority": 3,
  "tags": ["docker"]
}
```

### Sentry

```json
{
  "project": "my-app",
  "event": {
    "title": "TypeError: Cannot read property 'x' of undefined",
    "culprit": "app.js in handleClick",
    "url": "https://sentry.io/..."
  }
}
```

Template:

```json
{
  "title": "Sentry: {{project}}",
  "message": "**{{event.title}}**\n\n位置：{{event.culprit}}\n\n[查看详情]({{event.url}})",
  "priority": 8,
  "tags": ["sentry", "error"]
}
```

### qBittorrent (form mode, no template)

Put this into qBittorrent's "Run external program on torrent completion":

```bash
curl -s -F "title=qBittorrent" -F "message=%N 下载完成，大小 %Z，保存位置 %L" -F "priority=3" http://<host>:20010/hook/<app-token>
```

When using `-F`, **do not configure a template on the app** (form mode does not render).
Spaces, quotes, percent signs and brackets in torrent names are encoded by curl itself, which is
far more reliable than hand-assembling a JSON string.

---

## Generic forwarding

If you are unsure about the shape of a third-party payload, leave the template unset — Chatz will
post the whole JSON as the body. Look at the raw data, then write the template.

### How to test

```bash
curl -X POST http://<host>:20010/hook/preview \
  -H "Content-Type: application/json" \
  -d '{
    "template": {"title": "{{name}}", "message": "Hi {{user.name}}"},
    "data": {"name": "Test", "user": {"name": "Alice"}}
  }'
```

Returns:

```json
{"ok": true, "rendered": {"title": "Test", "message": "Hi Alice"}}
```

`/hook/preview` stores nothing; rate limit is 30 per minute.

---

## Syntax cheat sheet

| Syntax | Meaning |
|---|---|
| `{{name}}` | variable |
| `{{user.name}}` | nested path |
| `{{name \| "默认值"}}` | default value (when empty / missing) |
| `{{#if x}}...{{/if}}` | conditional (truthiness) |
| `{{#if x == "y"}}...{{/if}}` | equality |
| `{{#if x != "y"}}...{{/if}}` | inequality |
| `{{#if x}}...{{else}}...{{/if}}` | if-else |
| `{{#each arr}}...{{/each}}` | loop |
| `{{this}}` | current loop item |
| `{{@index}}` | loop index (from 0) |

---

## Limitations

- No logical operators (`&&`, `||`, `!`)
- No arithmetic
- No function calls, no filter chains
- `{{#each}}` cannot expand an array into **multiple elements of an array** (only concatenate
  inside a string)
- The default in `{{var \| default}}` must be a **quoted string literal**
- The right-hand side of `==` cannot contain quotes
- Nested expansion (`{{#if}}` / `{{#each}}`) is capped at 50 each

If a template gets too complex, pre-process the payload upstream with a script.

---

## See also

- [Routing rules](ROUTES.md) — conditions + actions applied before storing
- [API reference](API.md) — full description of `/hook/:token`
