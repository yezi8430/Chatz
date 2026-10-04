const express = require('express');
const db = require('./db');
const { evalCondition, applyAction } = require('./routing');
const { rateLimit } = require('./rateLimit');
const audit = require('./audit');

const router = express.Router();

/**
 * 规则归属校验：路由规则**按用户隔离** —— 谁创建的谁能看/改/删，
 * 别人（含管理员）一律 404（不暴露它存不存在，避免被用来探测）。
 * 超管要看/管全部走 `/admin/routes`。
 */
function routeBelongsToUser(row, req) {
  return !!row && row.user_id === req.user.id;
}

function rowToRoute(row) {
  return {
    id: row.id,
    name: row.name,
    enabled: !!row.enabled,
    priority: row.priority,
    conditions: JSON.parse(row.conditions),
    actions: JSON.parse(row.actions),
    createdAt: row.created_at,
  };
}

// 不再 requireAdmin：普通用户也能管自己的规则（`/route` 在 index.js 里已挂过 auth，
// 所以这里只要求登录）。列表按 user_id 过滤 —— 每人只看得到自己创建的。
router.get('/route', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM routes WHERE user_id = ? ORDER BY priority DESC, id ASC'
  ).all(req.user.id);
  res.json(rows.map(rowToRoute));
});

// ⚠️ 限流：规则现在**人人可建**（以前是管理员专用），注册又是开放的 —— 不限就能被刷
router.post('/route',
  rateLimit({ windowMs: 3600000, max: 30, name: 'route_create', message: '新建规则过于频繁，请稍后再试' }),
  (req, res) => {
  const { name, enabled, priority, conditions, actions } = req.body || {};
  if (!name) return res.status(400).json({ error: '请填写规则名称' });
  if (!conditions || !actions) return res.status(400).json({ error: 'conditions 和 actions 不能为空' });

  let p = priority != null ? parseInt(priority, 10) : 50;
  if (isNaN(p)) p = 50;
  p = Math.max(0, Math.min(100, p));

  const info = db.prepare(`
    INSERT INTO routes (name, enabled, priority, conditions, actions, created_at, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    enabled === false ? 0 : 1,
    p,
    JSON.stringify(conditions),
    JSON.stringify(actions),
    Date.now(),
    req.user.id
  );

  const row = db.prepare('SELECT * FROM routes WHERE id = ?').get(info.lastInsertRowid);

  // 路由规则是本系统权限最高的配置：它能改写消息的优先级 / 内容 / 目标频道，
  // 还能调外部 webhook。现在普通用户也能建规则（但只作用于**自己**的消息，见 routing.js），
  // 谁改过规则必须可追溯，所以这里把 actions 的类型记进 meta
  audit.fromReq(req, {
    action: 'route.create',
    target: String(row.id),
    meta: {
      name: row.name,
      enabled: !!row.enabled,
      priority: row.priority,
      actionTypes: (Array.isArray(actions) ? actions : []).map(a => a && a.type).filter(Boolean),
    },
  });

  res.json(rowToRoute(row));
});

router.patch('/route/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });
  const row = db.prepare('SELECT * FROM routes WHERE id = ?').get(id);
  if (!routeBelongsToUser(row, req)) {
    audit.fromReq(req, { action: 'route.forbidden_owner', target: String(id), success: false });
    return res.status(404).json({ error: '规则不存在' });
  }

  const { name, enabled, priority, conditions, actions } = req.body || {};
  const updates = [];
  const params = [];
  if (name != null) { updates.push('name = ?'); params.push(name); }
  if (enabled != null) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (priority != null) {
    let p = parseInt(priority, 10);
    if (isNaN(p)) p = 50;
    p = Math.max(0, Math.min(100, p));
    updates.push('priority = ?');
    params.push(p);
  }
  if (conditions != null) { updates.push('conditions = ?'); params.push(JSON.stringify(conditions)); }
  if (actions != null) { updates.push('actions = ?'); params.push(JSON.stringify(actions)); }
  if (updates.length === 0) return res.json(rowToRoute(row));

  params.push(id);
  db.prepare(`UPDATE routes SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const updated = db.prepare('SELECT * FROM routes WHERE id = ?').get(id);

  audit.fromReq(req, {
    action: 'route.update',
    target: String(id),
    meta: {
      name: updated.name,
      enabled: !!updated.enabled,
      changed: ['name', 'enabled', 'priority', 'conditions', 'actions']
        .filter(k => (req.body || {})[k] != null),
      actionTypes: Array.isArray(actions)
        ? actions.map(a => a && a.type).filter(Boolean)
        : undefined,
    },
  });

  res.json(rowToRoute(updated));
});

router.delete('/route/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });

  // 先查再删：日志里要留下"删掉的是哪条规则"，只记一个 id 事后没法还原
  const row = db.prepare('SELECT * FROM routes WHERE id = ?').get(id);
  if (!routeBelongsToUser(row, req)) {
    audit.fromReq(req, { action: 'route.forbidden_owner', target: String(id), success: false });
    return res.status(404).json({ error: '规则不存在' });
  }
  db.prepare('DELETE FROM routes WHERE id = ?').run(id);

  audit.fromReq(req, {
    action: 'route.delete',
    target: String(id),
    meta: row ? { name: row.name } : { missing: true },
  });

  res.json({ ok: true });
});

// ⚠️ 必须限流：这个接口会**真的执行** actions，包括 call_webhook（对外发请求）。
//    不限的话管理员能一分钟刷 600 次，等于送一个内网端口扫描器。
router.post('/route/test',
  rateLimit({ windowMs: 60000, max: 20, name: 'route_test', message: '测试过于频繁，请稍后再试' }),
  (req, res) => {
  const { conditions, actions, message, appName, channelName } = req.body || {};
  if (!conditions) return res.status(400).json({ error: '缺少 conditions' });

  const ctx = {
    message: {
      message: message?.message || '',
      title: message?.title || '',
      priority: message?.priority != null ? message.priority : 5,
      tags: message?.tags || [],
    },
    app: { name: appName || '' },
    channel: { name: channelName || '' },
    extraChannels: [],
  };

  let matched;
  try { matched = evalCondition(conditions, ctx); }
  catch (e) { return res.status(400).json({ error: '模板渲染失败: ' + e.message }); }

  if (matched && actions) {
    for (const a of actions) applyAction(a, ctx);
  }

  res.json({
    matched,
    dropped: !!ctx.drop,
    silent: !!ctx.silent,
    result: ctx.message,
    extraChannels: ctx.extraChannels,
  });
});

// ---------- 规则模板 ----------
// priority: 越大越先执行，最大 100
const RULE_TEMPLATES = [
  {
    id: 'uptime-urgent',
    name: 'Uptime Kuma 告警升级',
    description: '优先级 ≥ 8 时提升到 10，并加 urgent 标签',
    conditions: { priority_gte: 8 },
    actions: [
      { type: 'set_priority', value: 10 },
      { type: 'add_tag', value: 'urgent' },
    ],
    priority: 90,
  },
  {
    id: 'night-silent',
    name: '半夜静默',
    description: '23:00-07:00 之间，优先级 ≤ 7 的消息静默',
    conditions: { time_between: ['23:00', '07:00'], priority_lte: 7 },
    actions: [{ type: 'set_silent', value: true }],
    priority: 70,
  },
  {
    id: 'noise-drop',
    name: '噪音消息丢弃',
    description: '内容含 heartbeat / ping / test-ignore 的消息直接丢弃',
    conditions: { body_matches: 'heartbeat|ping|test-ignore' },
    actions: [{ type: 'drop' }],
    priority: 95,
  },
  {
    id: 'urgent-forward',
    name: '严重告警转发',
    description: '优先级 ≥ 8 时同时发到工作频道（id=2）',
    conditions: { priority_gte: 8 },
    actions: [{ type: 'broadcast_to', value: [2] }],
    priority: 80,
  },
  {
    id: 'github-channel',
    name: 'GitHub 消息转频道',
    description: '来源应用名 = GitHub 的消息转到频道 2',
    conditions: { source_app: 'GitHub' },
    actions: [{ type: 'broadcast_to', value: [2] }],
    priority: 80,
  },
  {
    id: 'time-prefix',
    name: '内容加时间前缀',
    description: '给所有消息内容前面加 [自动]',
    conditions: {},
    actions: [{ type: 'add_prefix', value: '[自动] ' }],
    priority: 10,
  },
  {
    id: 'urgent-webhook',
    name: '严重告警调用外部 Webhook',
    description: '优先级 ≥ 8 时 POST 到指定 URL（自己改 URL）',
    conditions: { priority_gte: 8 },
    actions: [
      { type: 'call_webhook', value: 'https://example.com/alert' },
    ],
    priority: 85,
  },
];

router.get('/route/templates', (req, res) => {
  res.json(RULE_TEMPLATES);
});

module.exports = router;
