# Routing rules

> **中文**: [ROUTES.md](ROUTES.md)

> 📌 **Since 2026-10-01, rules are isolated per user**:
>   - **Every signed-in user** can create their own rules (no longer admins only). Each person
>     only sees the rules they created; admins cannot see other people's (the super admin can
>     view everything site-wide from the admin page).
>   - A rule **only applies to its owner's messages**: a signed-in user posting a message runs
>     their own rules; a webhook runs the rules of **the user who owns that app**.
>     Other people's rules never touch your messages, and vice versa.
>   - `broadcast_to` targets are filtered to "public / subscribed by me / created by me"
>     (no restriction for the super admin) — now that anyone can create rules, leaving this
>     unguarded would let a rule push messages into someone else's private channel.

The routing engine runs **before the message is stored**, so every message gets "processed" once:

```text
send ──▶ routing engine ──▶ aggregation ──▶ store ──▶ broadcast
              │
              ├─ match conditions
              └─ run actions
                 (change priority, add tags, forward, drop...)
```

## Rule shape

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

| Field | Meaning |
|---|---|
| name | rule name |
| priority | sort value 0–100, higher runs first (default 50) |
| enabled | whether it is active. Only rules with `enabled = 1` run |
| conditions | condition object; **all** conditions must match |
| actions | action array, executed in order |

## Execution order

Rules are sorted by `priority DESC`, ties broken by `id ASC`:

```text
P95: drop noise              ← runs first
P90: escalate severe alerts
P80: forward to the ops group
P50: add a time prefix
P10: add a default tag       ← runs last
```

Key point: **if an earlier rule changes the message, later rules see the changed version.**

```json
[
  {"name": "A", "priority": 90, "conditions": {"priority_gte": 8}, "actions": [{"type": "set_priority", "value": 10}]},
  {"name": "B", "priority": 80, "conditions": {"priority_eq": 10}, "actions": [{"type": "add_tag", "value": "critical"}]}
]
```

Message priority is 9 → rule A raises it to 10 → rule B sees 10, matches, and adds `critical`.

---

## Conditions

**11** in total. All conditions must hold (AND); **there is no OR syntax** between conditions.

### `priority_gte` — priority ≥

```json
{"conditions": {"priority_gte": 8}}
```

### `priority_lte` — priority ≤

```json
{"conditions": {"priority_lte": 3}}
```

### `priority_eq` — priority =

```json
{"conditions": {"priority_eq": 10}}
```

### `body_matches` — body matches regex

```json
{"conditions": {"body_matches": "error|fail|exception"}}
```

Matches the message body, **case-insensitive** (the `i` flag is always applied).

Examples:

```text
heartbeat|ping        — heartbeat messages
^\[CRITICAL\]         — starts with [CRITICAL]
disk (full|space)     — disk related
\d{3,}                — at least three digits
```

### `title_matches` — title matches regex

```json
{"conditions": {"title_matches": "^\\[生产\\]"}}
```

Same as `body_matches` but against the title.

### `channel` — channel name =

```json
{"conditions": {"channel": "监控"}}
```

Exact match on the channel name.

### `channel_id` — channel ID =

```json
{"conditions": {"channel_id": 2}}
```

Exact match on the channel ID. More stable than `channel` (names can change).

### `source_app` — source app name =

```json
{"conditions": {"source_app": "GitHub"}}
```

Matches the app's `name` field.

### `app_id` — app ID =

```json
{"conditions": {"app_id": 1}}
```

### `time_between` — time window

```json
{"conditions": {"time_between": ["23:00", "07:00"]}}
```

Matches when the current **server time** falls inside the window. Crossing midnight is supported
(when the start minute is greater than the end minute it is treated as overnight).

Examples:

```text
["09:00", "18:00"]  — working hours
["23:00", "07:00"]  — night (crosses midnight)
["00:00", "23:59"]  — all day
```

> ⚠️ Evaluation uses the **server's local timezone**, not the client's.

### `tag_includes` — contains tags

```json
{"conditions": {"tag_includes": ["urgent"]}}
```

The message `tags` array must contain **all** the listed tags.

Note: tags are usually added by earlier rules, so this kind of rule needs a **lower** `priority`
than the rule that adds the tag.

### Combining conditions

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

All three must hold: priority ≥ 8 **and** currently within working hours **and** the message was
posted to the monitoring channel.

---

## Actions

**8** in total, executed in array order.

### `set_priority` — change priority

```json
{"type": "set_priority", "value": 10}
```

`value` is `parseInt`-ed and clamped to **0–10**.

Example: raise every severe alert to 10; lower ordinary night-time messages to 3.

### `add_tag` — add a tag

```json
{"type": "add_tag", "value": "urgent"}
```

- At most **50** tags; beyond that nothing is added
- A single tag is truncated to **50 characters**
- Adding an existing tag is a no-op (de-duplicated via a `Set`)

Shown as `#urgent` in clients.

### `remove_tag` — remove a tag

```json
{"type": "remove_tag", "value": "noisy"}
```

Usually used to undo a tag added by an earlier rule.

### `set_silent` — silence

```json
{"type": "set_silent", "value": true}
```

A silenced message is still stored, but clients do not pop a notification or play a sound — it
just joins the list quietly.

> The check is `value !== false`, so **omitting `value` also means silent**.

Use cases: silence non-urgent messages at night; keep floods of duplicates in the database
without being disturbed.

### `broadcast_to` — forward to channels

```json
{"type": "broadcast_to", "value": [2, 3]}
```

The message is also delivered to the listed channels; the original channel is kept.

```json
// severe alerts also go to the "on-call" channel
{"type": "broadcast_to", "value": [5]}

// forward to several channels
{"type": "broadcast_to", "value": [2, 3, 7]}
```

Details:

- The message body is unchanged; only the broadcast set grows
- Subscribers of the target channels receive it
- The message's `channel_id` **stays the original**
- IDs go through `Number()` and values ≤ 0 are filtered out
- The server de-duplicates per client in `broadcastToChannels`, so nobody receives the same
  message twice
- ⚠️ **Targets are filtered by ownership (since 2026-10-01)**: only channels that are
  "public / subscribed by me / created by me" pass (no restriction for the super admin).
  Now that anyone can create rules, without this guard anyone could type a channel id and
  pour messages into someone else's private channel. Filtered ids are dropped silently,
  with no error.

### `add_prefix` — prefix the body

```json
{"type": "add_prefix", "value": "[自动] "}
```

Inserts text at the start of the message body; the prefix is truncated to **200 characters**.

Examples: `"[客服] "`, `"⚠️ "`.

> Plain text only — **template variables are not supported** (`"{{source}}"` is output verbatim).

### `call_webhook` — call an external URL

```json
{"type": "call_webhook", "value": "https://example.com/alert"}
```

The message is POSTed as-is (JSON body) to the target URL; **no response is awaited**.

Use cases: send severe alerts to your own alerting system; forward to another Chatz instance;
trigger external automation (e.g. a WeCom bot).

Notes:

- The URL must start with `http://` or `https://`, otherwise the whole action is skipped
- Timeout is **5 seconds**; failures are ignored silently and do not affect the main flow
- **No retry**

### `drop` — discard

```json
{"type": "drop"}
```

The message is discarded: not stored, not broadcast, not notified. **Once it triggers, later
rules do not run** (the engine returns `null` immediately).

Use cases: block noise (heartbeats, probes); block duplicates from a specific source.

---

## Built-in templates

Apply them in one click from the web UI: "Routing rules" → "Create from template".
Also available via `GET /route/templates`.

| Template | Condition | Action | Priority | Purpose |
|---|---|---|---|---|
| Uptime Kuma escalation | `priority_gte: 8` | `set_priority: 10` + `add_tag: urgent` | 90 | make severe alerts stand out |
| Night silence | `time_between: [23:00, 07:00]` + `priority_lte: 7` | `set_silent: true` | 70 | do not disturb at night |
| Drop noise | `body_matches: heartbeat\|ping\|test-ignore` | `drop` | 95 | block probe messages |
| Forward severe alerts | `priority_gte: 8` | `broadcast_to: [2]` | 80 | send to the ops channel |
| GitHub → channel | `source_app: GitHub` | `broadcast_to: [2]` | 80 | split the stream |
| Time prefix | none | `add_prefix: "[自动] "` | 10 | mark the source |
| Severe alerts → webhook | `priority_gte: 8` | `call_webhook` | 85 | forward to another system |

---

## Common rule examples

### Keep only severe alerts

```json
{
  "name": "丢弃低优先级",
  "priority": 5,
  "conditions": {"priority_lte": 3},
  "actions": [{"type": "drop"}]
}
```

### Dual-channel on-call notification

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

### Silence test messages during a canary rollout

```json
{
  "name": "静默测试频道",
  "priority": 80,
  "conditions": {"channel_id": 5},
  "actions": [{"type": "set_silent", "value": true}]
}
```

### Timestamp messages from a specific source

```json
{
  "name": "服务器消息加时间戳",
  "priority": 50,
  "conditions": {"source_app": "服务器监控"},
  "actions": [{"type": "add_prefix", "value": "[自动] "}]
}
```

### Keyword blacklist

```json
{
  "name": "屏蔽营销消息",
  "priority": 95,
  "conditions": {"body_matches": "促销|优惠券|推广"},
  "actions": [{"type": "drop"}]
}
```

---

## Testing rules

Every rule has a "Test" button in the web UI. Or use the API:

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

Response:

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

| Field | Meaning |
|---|---|
| matched | whether the conditions matched |
| dropped | whether it was dropped |
| silent | whether it was silenced |
| result | the processed message |
| extraChannels | list of channels it was forwarded to |

The request may also carry `appName` and `channelName` to exercise the `source_app` and `channel`
conditions.

> ⚠️ The test endpoint only builds a `{name}` context — **no ids** — so `channel_id` and `app_id`
> can never match there. To test those, send a real message.
>
> The test endpoint does not create a message; it only returns a hypothetical result.

---

## Ordering tips

Rule priority is 0–100, higher runs first. Leave gaps so you can insert later:

```text
95 - filtering (highest, filter first)
90 - severe alert handling
85 - external callbacks
80 - forwarding
70 - silencing
50 - content rewriting
10 - catch-all
```

To insert a new rule use an in-between value like 92, 88 or 85 instead of renumbering.

---

## Performance and safety limits

The number of rules does not affect performance (all rules are walked once), but watch out for:

- Expensive regexes (greedy matching, nested groups)
- A rule that matches a flood of messages — use `drop` early

Regexes pass a safety check before compilation; **a non-compliant pattern simply evaluates to
"no match"** (no error is thrown):

| Limit | Value | Notes |
|---|---|---|
| Regex length | ≤ 200 chars | longer is rejected outright |
| Nested quantifiers | forbidden | e.g. `(a+)+`, `(a*)*` — guards against catastrophic backtracking |
| Consecutive greedy wildcards | more than 3 forbidden | `(\.\*){3,}` is rejected |
| Match input length | truncated to 10000 chars | only the first 10000 chars of the body are matched |
| Max tags | 50 | `add_tag` stops adding beyond that |
| Single tag length | 50 chars | truncated |
| Prefix length | 200 chars | `add_prefix` truncates |
| Priority range | 0–10 | `set_priority` clamps into this range |
| Callback timeout | 5 s | `call_webhook` gives up, no retry |

---

## How this relates to templates

| Stage | Uses |
|---|---|
| Webhook arrival | templates ([TEMPLATE.md](TEMPLATE.md)): render the raw JSON into a message |
| Before storing | routing rules (this document): process the message by condition |

Order:

```text
raw webhook data ──[template render]──▶ message object ──[routing rules]──▶ stored
```

> Templates only apply in **JSON mode**. With `curl -F` form posts or plain text the message is
> already "finished": routing rules still run, but templates do not participate.

---

## See also

- [API reference](API.md) — full description of the `/route` endpoints
- [Template syntax](TEMPLATE.md) — rendering webhook data
