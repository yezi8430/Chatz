# 模板语法

Chatz 的 Webhook 支持用**模板**把第三方发来的原始 JSON 渲染成可读通知。模板用类似 Mustache 的语法，不需要学新东西。

## 快速开始

在「应用」上设置 `template` 字段（一个 JSON 字符串）。Webhook 到达时：

1. 解析原始 JSON 为 `data`
2. 用 `data` 渲染 `template`
3. 用渲染结果作为消息的 `title`、`message`、`priority`、`extras`、`tags`

网页端：侧栏「应用」→ 编辑应用 → 模板。也可以走 API `PATCH /application/:id`。

## 模板结构

模板本身就是一个 JSON 对象，告诉 Chatz 怎么生成消息的字段：

```json
{
  "title": "标题模板",
  "message": "正文模板",
  "priority": 5,
  "extras": {},
  "tags": []
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| title | 字符串 | 消息标题 |
| message | 字符串 | 消息正文，支持 Markdown |
| priority | 数字或字符串 | 0–10，字符串会先渲染再转数字 |
| extras | 任意 | 直接透传给客户端（如图片） |
| tags | 数组 | 标签 |

只有 `message` 是必须的，其他都可以省略（走默认值）。

> 如果模板渲染后 `message` 是空的，会**回退**去用 body 里原始的 `message` 字段。
> 所以模板只写 `title` 也是安全的。

---

## 变量

用 `{{变量名}}` 替换。

```json
{"message": "Hello {{name}}"}
```

如果 data 是：

```json
{"name": "Alice"}
```

渲染结果：

```json
{"message": "Hello Alice"}
```

### 嵌套路径

用点号访问嵌套字段：

```json
{"message": "仓库 {{repository.full_name}} 有更新"}
```

对应：

```json
{"repository": {"full_name": "user/repo"}}
```

路径上任何一环是 `null` / `undefined` 就渲染成空字符串。

### 默认值

用 `|` 加默认值，字段为空或不存在时用默认值：

```json
{"message": "作者：{{author.name | \"匿名\"}}"}
```

渲染结果（当 `author.name` 不存在）：

```json
{"message": "作者：匿名"}
```

约束：

- 默认值必须用**单引号或双引号**包起来（不带引号会被当成路径名）
- 触发条件是值为 `undefined` / `null` / **空字符串**。`0` 和 `false` **不触发**
- 变量名里不要出现 `|`，否则会被当成默认值分隔符

---

## 条件

用 `{{#if 条件}}...{{/if}}`。

### 简单真假判断

```json
{"message": "{{#if user}}用户在线{{/if}}"}
```

判为"真"的条件：值存在，且不等于 `false`、`"0"`、`""`。

### 等于 / 不等于

```json
{"message": "{{#if status == \"down\"}}服务挂了{{/if}}"}
{"message": "{{#if status != \"up\"}}服务异常{{/if}}"}
```

比较时两侧都转成字符串，所以 `{{#if heartbeat.status == "0"}}` 能匹配数值 `0`。

### if-else

```json
{"message": "{{#if status == \"down\"}}❌ 服务挂了{{else}}✅ 正常{{/if}}"}
```

### 嵌套条件

```json
{
  "message": "{{#if monitor.url}}{{#if monitor.status == \"down\"}}地址 {{monitor.url}} 挂了{{/if}}{{/if}}"
}
```

嵌套层数的安全上限是 50 层，超了就停止继续展开（不会卡死）。

---

## 循环

用 `{{#each 数组}}...{{/each}}`。

```json
{"message": "{{#each items}}· {{this}}\n{{/each}}"}
```

数据：

```json
{"items": ["a", "b", "c"]}
```

渲染：

```text
· a
· b
· c
```

### 带下标

用 `{{@index}}` 访问索引（从 0 开始）：

```json
{"message": "{{#each items}}{{@index}}. {{this}}\n{{/each}}"}
```

### 遍历对象数组

```json
{
  "message": "{{#each commits}}· {{hash}} - {{message}}\n{{/each}}"
}
```

数据：

```json
{
  "commits": [
    {"hash": "abc123", "message": "fix bug"},
    {"hash": "def456", "message": "add feature"}
  ]
}
```

渲染：

```text
· abc123 - fix bug
· def456 - add feature
```

循环体里**直接用字段名**即可，不需要写 `{{this.hash}}`。

---

## 优先级

`priority` 可以是数字，也可以是渲染后变成数字的字符串。

```json
{"priority": 5}
```

```json
{"priority": "{{#if status == \"down\"}}10{{else}}5{{/if}}"}
```

第二种情况下，渲染结果是 `"10"` 或 `"5"`，Chatz 会自动 `parseInt`；
解析不出来时回落到 **5**，并强制夹到 0–10。

---

## 标签

```json
{"tags": ["alert", "{{source}}"]}
```

数组里的**字符串元素**会被完整渲染 —— 也就是说 `{{#if}}` 和 `{{#each}}`
在标签元素里同样可用，不只是简单替换。

> 数组**结构本身**不能被 `{{#each}}` 展开成多个标签（模板里没法写
> "遍历 alerts 生成 N 个 tag"）。要做动态数量的标签，只能在上游拼好数组。

---

## extras

透传给客户端，格式任意。

```json
{
  "message": "看这张图",
  "extras": {
    "image": "{{screenshot_url}}"
  }
}
```

客户端读取 `extras.image` 显示图片。封面图的取值优先级是
`image` → `client::display.url` → `client::notification.bigImageUrl`，
与 Gotify 约定兼容，同一份 extras 可以两端共用。

---

## 什么时候模板不生效

模板**只在 JSON 模式下渲染**。判定条件是：请求带 `Content-Type: application/json`，
或者请求体第一个非空字符是 `{`。

| 发送方式 | 模板是否生效 |
|---|---|
| `Content-Type: application/json` + JSON body | ✅ 生效 |
| 纯文本 body（`curl -d "文本"`） | ❌ 不生效 |
| 表单 `curl -F` | ❌ 不生效 |
| 空 body + query 参数 | ❌ 不生效 |

> 表单模式曾经会把整段 `multipart` 报文当成消息正文，
> 现在 Chatz 会解析出字段（只在文本模式下），但**不会**走模板。

实践建议：

- 如果发送方（插件 / 脚本）**自己已经拼好**标题和正文，**不要给应用配模板**，留空最干净
- 需要模板的场景是接第三方固定 payload（GitHub、Uptime Kuma、Grafana…）

---

## 实战示例

### Uptime Kuma

Uptime Kuma 的 Webhook payload 大致是：

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

模板：

```json
{
  "title": "{{monitor.name}} {{#if heartbeat.status == \"0\"}}🔴 宕机{{else}}✅ 恢复{{/if}}",
  "message": "**{{monitor.name}}**\n\n{{heartbeat.msg}}\n\n地址：{{monitor.url}}\n时间：{{heartbeat.time}}",
  "priority": "{{#if heartbeat.status == \"0\"}}10{{else}}3{{/if}}",
  "tags": ["uptime"]
}
```

### GitHub Push

GitHub 的 push 事件：

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

模板：

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

模板：

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

Grafana 的 alert payload：

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

模板：

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

模板：

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

模板：

```json
{
  "title": "Sentry: {{project}}",
  "message": "**{{event.title}}**\n\n位置：{{event.culprit}}\n\n[查看详情]({{event.url}})",
  "priority": 8,
  "tags": ["sentry", "error"]
}
```

### qBittorrent（表单模式，不用模板）

qBittorrent 的「完成时运行外部程序」填：

```bash
curl -s -F "title=qBittorrent" -F "message=%N 下载完成，大小 %Z，保存位置 %L" -F "priority=3" http://<host>:20010/hook/<app-token>
```

用 `-F` 时**不要给应用配模板**（表单模式不渲染）。种子名里的空格、引号、
百分号、方括号由 curl 自己编码，比手拼 JSON 字符串可靠得多。

---

## 通用转发

如果第三方发来的 payload 你不确定结构，先不设模板，Chatz 会把整个 JSON 作为正文发出来。看到原始数据后再写模板。

### 测试方法

```bash
curl -X POST http://<host>:20010/hook/preview \
  -H "Content-Type: application/json" \
  -d '{
    "template": {"title": "{{name}}", "message": "Hi {{user.name}}"},
    "data": {"name": "Test", "user": {"name": "Alice"}}
  }'
```

返回：

```json
{"ok": true, "rendered": {"title": "Test", "message": "Hi Alice"}}
```

`/hook/preview` 不入库，限速 30 次 / 分钟。

---

## 语法速查

| 语法 | 说明 |
|---|---|
| `{{name}}` | 变量 |
| `{{user.name}}` | 嵌套路径 |
| `{{name \| "默认值"}}` | 默认值（空 / 不存在时生效） |
| `{{#if x}}...{{/if}}` | 条件（真值判断） |
| `{{#if x == "y"}}...{{/if}}` | 等值判断 |
| `{{#if x != "y"}}...{{/if}}` | 不等判断 |
| `{{#if x}}...{{else}}...{{/if}}` | if-else |
| `{{#each arr}}...{{/each}}` | 循环 |
| `{{this}}` | 循环当前项 |
| `{{@index}}` | 循环索引（从 0 开始） |

---

## 限制

- 不支持逻辑运算（`&&`、`||`、`!`）
- 不支持算术运算
- 不支持函数调用、过滤器链
- `{{#each}}` 不能把数组展开成数组的**多个元素**（只能在字符串里拼）
- `{{var \| default}}` 的默认值必须是**带引号的字符串字面量**
- `==` 比较的右侧不能包含引号
- 嵌套展开（`{{#if}}` / `{{#each}}`）各有 50 次上限

如果模板太复杂，可以在上游（发送方）用脚本预处理好再发。

---

## 相关

- [路由规则](ROUTES.md) — 消息落库前的条件 + 动作
- [API 参考](API.md) — `/hook/:token` 的完整说明
