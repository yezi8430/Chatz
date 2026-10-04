# 路由规则

> 📌 **2026-10-01 起，规则按用户隔离**：
>   - **所有登录用户**都能建自己的规则（不再限于管理员），每人只看得到自己创建的，
>     管理员也看不到别人的（超管可在管理页看全站）。
>   - 规则**只作用于自己的消息**：登录用户发消息 → 跑他自己的规则；
>     Webhook → 跑**该应用归属用户**的规则。别人的规则碰不到你的消息，反之亦然。
>   - `broadcast_to` 的目标频道会被过滤成「公开 / 自己订阅 / 自己创建」（超管不限）——
>     规则现在人人可建，不设防就能把消息投进别人的私有频道。

路由引擎在**消息落库前**运行，让每条消息都能按规则被"处理"一次：

```text
发消息 ──▶ 路由引擎 ──▶ 聚合 ──▶ 落库 ──▶ 广播
              │
              ├─ 匹配条件
              └─ 执行动作
                 （改优先级、加标签、转发、丢弃...）
```

## 规则结构

```json
{
  "name": "紧急升级",
  "priority": 90,
  "enabled": true,
  "conditions": {
    "priority_gte": 8
  },
  "actions": [
    {"type": "set_priority", "value": 10},
    {"type": "add_tag", "value": "urgent"}
  ]
}
```

| 字段 | 说明 |
|---|---|
| name | 规则名称 |
| priority | 排序值 0–100，越大越先执行（默认 50） |
| enabled | 是否启用。只跑 `enabled = 1` 的规则 |
| conditions | 条件对象，**所有条件都满足**才触发 |
| actions | 动作数组，按顺序执行 |

## 执行顺序

规则按 `priority DESC` 排序，同优先级按 `id ASC`，依次匹配：

```text
规则 P95: 丢弃噪音        ← 最先跑
规则 P90: 升级严重告警
规则 P80: 转发到运维群
规则 P50: 加时间前缀
规则 P10: 加默认标签       ← 最后跑
```

关键点：**前面的规则改了消息，后面的规则会看到修改后的结果。**

```json
[
  {"name": "A", "priority": 90, "conditions": {"priority_gte": 8}, "actions": [{"type": "set_priority", "value": 10}]},
  {"name": "B", "priority": 80, "conditions": {"priority_eq": 10}, "actions": [{"type": "add_tag", "value": "critical"}]}
]
```

消息优先级是 9 → 规则 A 把它改成 10 → 规则 B 看到的是 10，命中并加 `critical` 标签。

---

## 条件

共 **11 种**。所有条件都满足（AND 逻辑）才触发，**条件之间没有 OR 语法**。

### `priority_gte` — 优先级 ≥

```json
{"conditions": {"priority_gte": 8}}
```

### `priority_lte` — 优先级 ≤

```json
{"conditions": {"priority_lte": 3}}
```

### `priority_eq` — 优先级 =

```json
{"conditions": {"priority_eq": 10}}
```

### `body_matches` — 内容匹配正则

```json
{"conditions": {"body_matches": "error|fail|exception"}}
```

匹配消息正文，**大小写不敏感**（固定带 `i` 标志）。

示例：

```text
heartbeat|ping        — 心跳消息
^\[CRITICAL\]         — 以 [CRITICAL] 开头
disk (full|space)     — 磁盘相关
\d{3,}                — 至少三位数字
```

### `title_matches` — 标题匹配正则

```json
{"conditions": {"title_matches": "^\\[生产\\]"}}
```

同 `body_matches`，但匹配标题。

### `channel` — 频道名 =

```json
{"conditions": {"channel": "监控"}}
```

按频道名称精确匹配。

### `channel_id` — 频道 ID =

```json
{"conditions": {"channel_id": 2}}
```

按频道 ID 精确匹配。比 `channel` 更稳定（名称可能改）。

### `source_app` — 来源应用名 =

```json
{"conditions": {"source_app": "GitHub"}}
```

按应用的 `name` 字段匹配。

### `app_id` — 应用 ID =

```json
{"conditions": {"app_id": 1}}
```

### `time_between` — 时间段

```json
{"conditions": {"time_between": ["23:00", "07:00"]}}
```

当前**服务器时间**在这个区间才匹配。支持跨天（起始分钟 > 结束分钟时按跨天处理）。

示例：

```text
["09:00", "18:00"]  — 工作时间
["23:00", "07:00"]  — 夜间（跨天）
["00:00", "23:59"]  — 全天
```

> ⚠️ 判断用的是服务器本地时区，不是客户端时区。

### `tag_includes` — 包含标签

```json
{"conditions": {"tag_includes": ["urgent"]}}
```

消息 `tags` 数组必须包含**全部**指定标签才匹配。

注意：标签一般是前面的规则加的，所以这类规则的 `priority` 要设得比"加标签"的规则**低**。

### 条件组合示例

```json
{
  "name": "上班时间的严重告警",
  "priority": 90,
  "conditions": {
    "priority_gte": 8,
    "time_between": ["09:00", "18:00"],
    "channel": "监控"
  },
  "actions": [
    {"type": "add_tag", "value": "oncall"}
  ]
}
```

三个条件都满足才触发：优先级 ≥ 8 **且** 当前在工作时间 **且** 消息发到监控频道。

---

## 动作

共 **8 种**，按数组顺序执行。

### `set_priority` — 改优先级

```json
{"type": "set_priority", "value": 10}
```

`value` 会被 `parseInt` 并夹到 **0–10**。

示例：严重告警一律提到 10；半夜的普通消息降到 3。

### `add_tag` — 加标签

```json
{"type": "add_tag", "value": "urgent"}
```

- 标签最多 **50 个**，超了就不加
- 单个标签截断到 **50 字符**
- 已存在则无操作（`Set` 去重）

客户端显示为 `#urgent`。

### `remove_tag` — 移除标签

```json
{"type": "remove_tag", "value": "noisy"}
```

一般用于撤销前面规则加的标签。

### `set_silent` — 静默

```json
{"type": "set_silent", "value": true}
```

静默的消息仍然落库，但客户端收到后不弹通知、不响铃，只静默加入列表。

> 判据是 `value !== false`，所以**不写 `value` 也等于静默**。

用途：半夜静默非紧急消息；大量重复消息只入库不打扰。

### `broadcast_to` — 转发到频道

```json
{"type": "broadcast_to", "value": [2, 3]}
```

消息同时发到指定频道，原频道也保留。

```json
// 严重告警同时发到「值班群」
{"type": "broadcast_to", "value": [5]}

// 转发到多个频道
{"type": "broadcast_to", "value": [2, 3, 7]}
```

说明：

- 消息本体不变，只是广播范围扩大
- 目标频道的订阅者会收到
- 消息的 `channel_id` **仍是原频道**
- ID 会过 `Number()` 并过滤掉 ≤ 0 的值
- 服务端用 `broadcastToChannels` 做了每客户端去重，不会被同一条消息命中多次
- ⚠️ **目标频道会做归属过滤**（2026-10-01 起）：只放行「公开 / 自己订阅 / 自己创建」
  的频道（超管不限）。规则现在人人可建，不设防的话随便填个频道 id
  就能把消息灌进别人的私有频道；被过滤掉的 id 静默丢弃，不报错。

### `add_prefix` — 内容加前缀

```json
{"type": "add_prefix", "value": "[自动] "}
```

在消息正文开头插入文本，前缀截断到 **200 字符**。

示例：`"[客服] "`、`"⚠️ "`。

> 只支持纯文本，**不支持模板变量**（`"{{source}}"` 会原样输出）。

### `call_webhook` — 回调外部 URL

```json
{"type": "call_webhook", "value": "https://example.com/alert"}
```

消息原样 POST 到目标 URL（JSON body），**不等待响应**。

用途：严重告警同时推送到自建告警系统；转发到另一个 Chatz 实例；触发外部自动化（如企业微信机器人）。

注意：

- URL 必须以 `http://` 或 `https://` 开头，否则整个动作跳过
- 超时 **5 秒**，失败静默忽略，不影响主流程
- **没有重试机制**

### `drop` — 丢弃

```json
{"type": "drop"}
```

消息被丢弃，不入库、不广播、不通知。**一旦触发，后续规则不再执行**（引擎直接返回 `null`）。

用途：屏蔽噪音（心跳、探测）；屏蔽特定来源的重复消息。

---

## 预置模板

在网页「路由规则」→「从模板创建」里可以一键应用。`GET /route/templates` 也能拿到。

| 模板 | 条件 | 动作 | 优先级 | 用途 |
|---|---|---|---|---|
| Uptime Kuma 告警升级 | `priority_gte: 8` | `set_priority: 10` + `add_tag: urgent` | 90 | 严重告警更醒目 |
| 半夜静默 | `time_between: [23:00, 07:00]` + `priority_lte: 7` | `set_silent: true` | 70 | 夜间不打扰 |
| 噪音消息丢弃 | `body_matches: heartbeat\|ping\|test-ignore` | `drop` | 95 | 屏蔽探测消息 |
| 严重告警转发 | `priority_gte: 8` | `broadcast_to: [2]` | 80 | 转运维频道 |
| GitHub 消息转频道 | `source_app: GitHub` | `broadcast_to: [2]` | 80 | 分流 |
| 内容加时间前缀 | 无 | `add_prefix: "[自动] "` | 10 | 标记来源 |
| 严重告警调用外部 Webhook | `priority_gte: 8` | `call_webhook` | 85 | 转发到其他系统 |

---

## 常用规则示例

### 只保留严重告警

```json
{
  "name": "丢弃低优先级",
  "priority": 5,
  "conditions": {"priority_lte": 3},
  "actions": [{"type": "drop"}]
}
```

### 值班人员双通道通知

```json
{
  "name": "严重告警双通道",
  "priority": 90,
  "conditions": {
    "priority_gte": 9,
    "time_between": ["09:00", "22:00"]
  },
  "actions": [
    {"type": "add_tag", "value": "oncall"},
    {"type": "broadcast_to", "value": [3]}
  ]
}
```

### 灰度发布期间静默测试消息

```json
{
  "name": "静默测试频道",
  "priority": 80,
  "conditions": {"channel_id": 5},
  "actions": [{"type": "set_silent", "value": true}]
}
```

### 特定来源的消息加时间戳

```json
{
  "name": "服务器消息加时间戳",
  "priority": 50,
  "conditions": {"source_app": "服务器监控"},
  "actions": [{"type": "add_prefix", "value": "[自动] "}]
}
```

### 关键字黑名单

```json
{
  "name": "屏蔽营销消息",
  "priority": 95,
  "conditions": {"body_matches": "促销|优惠券|推广"},
  "actions": [{"type": "drop"}]
}
```

---

## 测试规则

网页上每条规则都有「测试」按钮。或者用 API：

```bash
curl -X POST http://<host>:20010/route/test \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "conditions": {"priority_gte": 8},
    "actions": [{"type": "add_tag", "value": "urgent"}],
    "message": {"message": "hello", "priority": 9}
  }'
```

响应：

```json
{
  "matched": true,
  "dropped": false,
  "silent": false,
  "result": {
    "message": "hello",
    "title": "",
    "priority": 9,
    "tags": ["urgent"]
  },
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

请求里还可以带 `appName` 和 `channelName`，用来测 `source_app` 和 `channel` 这两个条件。

> ⚠️ 测试接口只构造 `{name}` 上下文，**没有 id**，
> 所以 `channel_id` 和 `app_id` 在这里永远匹配不上。要测它们请用真实发消息。
>
> 测试接口不会真正创建消息，只返回假设结果。

---

## 排序技巧

规则优先级 0–100，越大越先执行。留空隙方便以后插入：

```text
95 - 屏蔽类（最高，先过滤）
90 - 严重告警处理
85 - 外部回调
80 - 转发
70 - 静默
50 - 内容改写
10 - 兜底
```

想插入新规则时可以用 92、88、85 这种中间值，不用重排。

---

## 性能与安全限制

规则数量不影响性能（一次遍历所有规则），但要注意：

- 避免复杂的正则（贪婪匹配、嵌套括号）
- 同一规则同时匹配大量消息时，用 `drop` 优先处理掉

正则在编译前会过安全检查，**不合规的表达式直接判定为"不匹配"**（不会报错）：

| 限制 | 值 | 说明 |
|---|---|---|
| 正则长度 | ≤ 200 字符 | 超长直接拒绝 |
| 嵌套量词 | 禁止 | 如 `(a+)+`、`(a*)*`，防 catastrophic backtracking |
| 连续贪婪通配 | 禁止 3 个以上 | `(\.\*){3,}` 直接拒绝 |
| 匹配输入长度 | 截断到 10000 字符 | 只对正文前 10000 字符做匹配 |
| 标签数量上限 | 50 个 | `add_tag` 超过就不加 |
| 单个标签长度 | 50 字符 | 超出截断 |
| 前缀长度 | 200 字符 | `add_prefix` 超出截断 |
| 优先级范围 | 0–10 | `set_priority` 强制夹到这个区间 |
| 回调超时 | 5 秒 | `call_webhook` 超时即放弃，不重试 |

---

## 与模板的关系

| 阶段 | 用什么 |
|---|---|
| Webhook 到达 | 模板（[TEMPLATE.md](TEMPLATE.md)）：把原始 JSON 渲染成消息 |
| 消息落库前 | 路由规则（本文档）：按条件处理消息 |

顺序：

```text
Webhook 原始数据 ──[模板渲染]──▶ 消息对象 ──[路由规则]──▶ 落库
```

> 模板只在 **JSON 模式**下生效。用 `curl -F` 发表单、或发纯文本时，
> 消息已经是"成品"，路由规则照常跑，但模板不会参与。

---

## 相关

- [API 参考](API.md) — `/route` 系列接口的完整说明
- [模板语法](TEMPLATE.md) — Webhook 数据渲染
