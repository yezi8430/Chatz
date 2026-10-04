const express = require('express');
const db = require('./db');
const ws = require('./ws');

const router = express.Router();

function rowToMessage(row) {
  const msg = {
    id: row.id,
    appid: row.appid,
    message: row.message,
    title: row.title,
    priority: row.priority,
    date: row.date,
    extras: row.extras ? JSON.parse(row.extras) : null,
  };
  if (row.channel_id != null) msg.channel_id = row.channel_id;
  if (row.tags) { try { msg.tags = JSON.parse(row.tags); } catch { msg.tags = []; } }
  if (row.archived_at) msg.archivedAt = row.archived_at;
  if (row.is_read != null) msg.isRead = !!row.is_read;
  if (row.read_at) msg.readAt = row.read_at;
  if (row.agg_count != null) msg.aggCount = row.agg_count;
  if (row.agg_last_at) msg.aggLastAt = row.agg_last_at;
  if (row.agg_children) {
    try { msg.aggChildren = JSON.parse(row.agg_children); } catch { msg.aggChildren = []; }
  }
  return msg;
}

/**
 * 检查消息存在 + 用户有权限**操作**该消息所属频道
 *
 * 被四个接口共用：`read` / `unread` / `archive` / `unarchive`。
 *
 * ⚠️ 一律要求**订阅**该频道，**超管也不例外**（2026-09-30 改）。
 *
 * 以前超管能绕过订阅检查，于是他打开别人的频道时可以标已读、归档 ——
 * 看着像"我动了别人的消息"，让人以为状态串了。
 *
 * ⚠️ 其中最要命的是 archive / unarchive：那两个改的是 **messages 表本身**
 *    （`UPDATE messages SET archived_at`），**不是 per-user 的**。
 *    超管在未订阅的频道上一点归档，频道所有者那边这条消息就真的消失了。
 *    （read / unread 倒是 per-user 的 —— `message_reads` 按 user_id 存 ——
 *     那种点了对别人零影响。）
 *
 * 现在的口径和消息推送、未读数一致：**按订阅**。
 * 超管能**看**（`GET /message`、`GET /channel` 全知，排障用），
 * 但**不能操作**未订阅频道里的消息。
 */
function getMessageWithPermission(messageId, user) {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!msg) return { error: '消息不存在', code: 404 };

  const sub = db.prepare(
    'SELECT 1 FROM subscriptions WHERE user_id = ? AND channel_id = ?'
  ).get(user.id, msg.channel_id);
  if (!sub) {
    return {
      error: '这是别人的频道，只能查看不能操作（想标记请先订阅）',
      code: 403,
    };
  }

  return { msg };
}

// ============================================================
// GET /message/search — 搜索（LIKE 模糊匹配）
// ============================================================
router.get('/message/search', (req, res) => {
  const userId = req.user.id;
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ query: '', count: 0, messages: [] });

  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
  const channelFilter = req.query.channel != null ? parseInt(req.query.channel, 10) : null;

  // 按订阅过滤 —— **超管也不例外**（2026-10-01 收窄）：
  // 超管日常也只搜得到自己订阅的频道里的消息，全站数据去管理页看。
  const allowedChannels = db.prepare(
    'SELECT channel_id FROM subscriptions WHERE user_id = ?'
  ).all(userId).map(r => r.channel_id);
  if (allowedChannels.length === 0) {
    return res.json({ query: q, count: 0, messages: [] });
  }

  let channelIds;
  if (channelFilter != null) {
    if (!allowedChannels.includes(channelFilter)) {
      return res.status(403).json({ error: '没有权限' });
    }
    channelIds = [channelFilter];
  } else {
    channelIds = allowedChannels;
  }

  const like = '%' + q + '%';

  let sql = `
    SELECT m.*,
           CASE WHEN r.read_at IS NOT NULL THEN 1 ELSE 0 END AS is_read,
           r.read_at
    FROM messages m
    LEFT JOIN message_reads r ON r.message_id = m.id AND r.user_id = ?
    WHERE m.deleted_at IS NULL
      AND (m.title LIKE ? OR m.message LIKE ?)
  `;
  const params = [userId, like, like];

  if (channelIds) {
    const ph = channelIds.map(() => '?').join(',');
    sql += ` AND m.channel_id IN (${ph})`;
    params.push(...channelIds);
  }

  sql += ` ORDER BY m.id DESC LIMIT ?`;
  params.push(limit);

  try {
    const rows = db.prepare(sql).all(...params);
    res.json({
      query: q,
      count: rows.length,
      messages: rows.map(rowToMessage),
    });
  } catch (e) {
    console.error('[search] error:', e.message);
    res.status(500).json({ error: '搜索失败' });
  }
});

// ============================================================
// POST /message/:id/read — 标记已读
// ============================================================
router.post('/message/:id/read', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });

  const check = getMessageWithPermission(id, req.user);
  if (check.error) return res.status(check.code).json({ error: check.error });

  const now = Date.now();
  db.prepare(`
    INSERT OR REPLACE INTO message_reads (message_id, user_id, read_at)
    VALUES (?, ?, ?)
  `).run(id, req.user.id, now);

  ws.broadcastToUser(req.user.id, {
    event: 'messageRead',
    messageId: id,
    userId: req.user.id,
    readAt: now,
  });

  res.json({ ok: true, readAt: now });
});

// ============================================================
// POST /message/:id/unread — 标记未读
// ============================================================
router.post('/message/:id/unread', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });

  const check = getMessageWithPermission(id, req.user);
  if (check.error) return res.status(check.code).json({ error: check.error });

  db.prepare(
    'DELETE FROM message_reads WHERE message_id = ? AND user_id = ?'
  ).run(id, req.user.id);

  ws.broadcastToUser(req.user.id, {
    event: 'messageUnread',
    messageId: id,
    userId: req.user.id,
  });

  res.json({ ok: true });
});

// ============================================================
// POST /message/read-all — 批量已读
// ============================================================
router.post('/message/read-all', (req, res) => {
  const { channel_id } = req.body || {};
  const now = Date.now();

  let channelIds;
  if (channel_id != null) {
    const cid = parseInt(channel_id, 10);
    // 显式指定频道时必须订阅过 —— **超管也不例外**（2026-10-01 收窄）：
    // 以前超管能标任意频道（理由是"他看得见"），但超管日常已经看不到未订阅频道了，
    // 这个例外就没有依据。已读状态是 per-user 的，没订阅就不该替别人标。
    const sub = db.prepare(
      'SELECT 1 FROM subscriptions WHERE user_id = ? AND channel_id = ?'
    ).get(req.user.id, cid);
    if (!sub) return res.status(403).json({ error: '没有权限' });
    channelIds = [cid];
  } else {
    // 不传 channel_id：只清自己**已订阅**频道的已读状态，超管也不例外。
    //
    // 以前超管走 `channelIds = null`（全站），和现在的未读数口径不一致：
    // 未订阅的频道不显示未读，却会被"全部已读"悄悄标记一遍。
    // 已读状态是 per-user 的，没订阅就既不统计、也不批量标记。
    channelIds = db.prepare(
      'SELECT channel_id FROM subscriptions WHERE user_id = ?'
    ).all(req.user.id).map(r => r.channel_id);
    if (channelIds.length === 0) return res.json({ count: 0 });
  }

  let sql = `
    SELECT id FROM messages
    WHERE deleted_at IS NULL
      AND archived_at IS NULL
  `;
  const params = [];
  if (channelIds) {
    const ph = channelIds.map(() => '?').join(',');
    sql += ` AND channel_id IN (${ph})`;
    params.push(...channelIds);
  }

  const msgs = db.prepare(sql).all(...params);

  if (msgs.length === 0) return res.json({ count: 0 });

  const tx = db.transaction(() => {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO message_reads (message_id, user_id, read_at)
      VALUES (?, ?, ?)
    `);
    for (const m of msgs) stmt.run(m.id, req.user.id, now);
  });
  tx();

  ws.broadcastToUser(req.user.id, {
    event: 'messagesReadAll',
    channelId: channel_id != null ? parseInt(channel_id, 10) : null,
    readAt: now,
    count: msgs.length,
  });

  res.json({ count: msgs.length });
});

// ============================================================
// POST /message/:id/archive — 归档
// ============================================================
router.post('/message/:id/archive', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });

  const check = getMessageWithPermission(id, req.user);
  if (check.error) return res.status(check.code).json({ error: check.error });

  const now = Date.now();
  db.prepare('UPDATE messages SET archived_at = ? WHERE id = ?').run(now, id);

  ws.broadcastToChannel(check.msg.channel_id, {
    event: 'messageArchived',
    messageId: id,
    archivedAt: now,
  });

  res.json({ ok: true, archivedAt: now });
});

// ============================================================
// POST /message/:id/unarchive — 取消归档
// ============================================================
router.post('/message/:id/unarchive', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });

  const check = getMessageWithPermission(id, req.user);
  if (check.error) return res.status(check.code).json({ error: check.error });

  db.prepare('UPDATE messages SET archived_at = NULL WHERE id = ?').run(id);

  ws.broadcastToChannel(check.msg.channel_id, {
    event: 'messageUnarchived',
    messageId: id,
  });

  res.json({ ok: true });
});

// ============================================================
// GET /message/unread-counts — 每个频道的未读数
// ============================================================
router.get('/message/unread-counts', (req, res) => {
  const userId = req.user.id;

  // 未读数：**一律只统计已订阅的频道，超管也不例外**（2026-09-30 改）。
  //
  // 以前超管走"全部频道"分支 ⇒ 别人的私有频道也会报未读数，
  // 看着像未读状态串了。已读状态本来就是 per-user 的
  // （`message_reads` 按 (message_id, user_id) 存），
  // 没订阅就不该出现在未读统计里 —— 和 `GET /channel`、`消息推送` 口径统一。
  const channelRows = db.prepare(
    'SELECT channel_id AS id FROM subscriptions WHERE user_id = ?'
  ).all(userId);

  const stmt = db.prepare(`
    SELECT COUNT(*) AS c
    FROM messages m
    LEFT JOIN message_reads r ON r.message_id = m.id AND r.user_id = ?
    WHERE m.channel_id = ?
      AND m.deleted_at IS NULL
      AND m.archived_at IS NULL
      AND r.read_at IS NULL
  `);

  const result = {};
  let total = 0;
  for (const ch of channelRows) {
    const count = stmt.get(userId, ch.id).c;
    result[ch.id] = count;
    total += count;
  }

  res.json({ total, byChannel: result });
});

module.exports = router;
