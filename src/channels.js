const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const ws = require('./ws');
const audit = require('./audit');
const { rateLimit, consume } = require('./rateLimit');
const { hashPassword, verifyPassword } = require('./migrate');
const { cleanupAttachmentsOfRows } = require('./attachments');

const router = express.Router();

const DATA_DIR = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : './data';
const CHANNEL_ICONS_DIR = path.join(DATA_DIR, 'channel-icons');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
fs.mkdirSync(CHANNEL_ICONS_DIR, { recursive: true });

function rowToChannel(row, opts = {}) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    image: row.image || null,
    isPublic: !!row.is_public,
    creatorId: row.creator_id,
    createdAt: row.created_at,
    // 只暴露「有没有密码」，绝不把 password_hash 原样吐出去
    passwordProtected: !!(row.password_hash),
    unreadCount: opts.unreadCount != null ? opts.unreadCount : undefined,
    subscribed: opts.subscribed != null ? opts.subscribed : undefined,
    muted: opts.muted != null ? !!opts.muted : undefined,
  };
}

// GET /channel
router.get('/channel', (req, res) => {
  const userId = req.user.id;
  // 只返回**自己订阅的**频道 —— 超管也不例外（2026-10-01 收窄）。
  //
  // 以前超管能看到全站频道（含别人的私有频道），代价是他的抽屉里塞满别人的频道、
  // 还跟着一堆别人的频道更新事件（费电、吵）。现在超管日常也只看自己的，
  // 要看全站数据去管理页 `GET /admin/channels`。
  //
  // 超管的「全知」保留在管理页，不在日常界面。
  const rows = db.prepare(`
    SELECT c.*, s.muted, 1 AS subscribed
    FROM channels c
    JOIN subscriptions s ON s.channel_id = c.id AND s.user_id = ?
    ORDER BY c.id ASC
  `).all(userId);

  const unreadStmt = db.prepare(`
    SELECT COUNT(*) AS c
    FROM messages m
    LEFT JOIN message_reads r ON r.message_id = m.id AND r.user_id = ?
    WHERE m.channel_id = ?
      AND m.deleted_at IS NULL
      AND m.archived_at IS NULL
      AND r.read_at IS NULL
  `);

  const result = rows.map(r => {
    const subscribed = !!r.subscribed;
    // ⚠️ 未订阅的频道**不给未读数**（2026-09-30 改）。
    //
    // 超管能看到全部频道（排障需要），于是以前连别人的频道都会算出未读数：
    // "bob私有 2 条未读" —— 看着像"串了"，而且会让人误以为自己该去处理。
    // 已读状态本来就是 per-user 的（`message_reads` 按 user_id 存），
    // 没订阅就不该有未读角标 —— 和消息推送的口径保持一致（都按订阅）。
    //
    // 想看那个频道里的消息，点进去照样看得到（拉取侧仍然全知）。
    const unread = subscribed ? unreadStmt.get(userId, r.id).c : 0;
    return rowToChannel(r, {
      unreadCount: unread,
      subscribed,
      muted: r.muted,
    });
  });

  res.json(result);
});

// GET /channel/discover（必须在 /channel/:id 之前）
router.get('/channel/discover', (req, res) => {
  const userId = req.user.id;
  const q = (req.query.q || '').toString().trim();

  // 搜索：按名字子串（instr + LOWER 做大小写不敏感，避开 LIKE 通配符）或 ID 精确匹配。
  // conditions 只拼硬编码片段，用户输入一律走 ? 绑定，无注入面。
  const conditions = ['c.is_public = 1'];
  const params = [userId, userId];   // muted / subscribed 两个子查询的 userId
  if (q) {
    const qNum = parseInt(q, 10);
    if (!Number.isNaN(qNum)) {
      conditions.push('(instr(LOWER(c.name), LOWER(?)) > 0 OR c.id = ?)');
      params.push(q, qNum);
    } else {
      conditions.push('instr(LOWER(c.name), LOWER(?)) > 0');
      params.push(q);
    }
  }
  params.push(userId);   // 排序：自己创建的排前面

  const rows = db.prepare(`
    SELECT c.*,
           (SELECT muted FROM subscriptions WHERE user_id = ? AND channel_id = c.id) AS muted,
           CASE WHEN EXISTS (
             SELECT 1 FROM subscriptions WHERE user_id = ? AND channel_id = c.id
           ) THEN 1 ELSE 0 END AS subscribed
    FROM channels c
    WHERE ${conditions.join(' AND ')}
    ORDER BY (c.creator_id = ?) DESC, c.id ASC
  `).all(...params);

  const unreadStmt = db.prepare(`
    SELECT COUNT(*) AS c
    FROM messages m
    LEFT JOIN message_reads r ON r.message_id = m.id AND r.user_id = ?
    WHERE m.channel_id = ?
      AND m.deleted_at IS NULL
      AND m.archived_at IS NULL
      AND r.read_at IS NULL
  `);

  res.json(rows.map(r => {
    const subscribed = !!r.subscribed;
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      image: r.image || null,
      isPublic: true,
      creatorId: r.creator_id,
      createdAt: r.created_at,
      passwordProtected: !!(r.password_hash),
      subscribed,
      muted: !!r.muted,
      // ⚠️ 未订阅就给 0，和 `GET /channel` 同一口径（2026-09-30 改）。
      //    原来是"每个频道都算"，于是发现页里会看到一堆"未订阅但有 17 条未读"
      //    的频道 —— 那数字是**你自己**没读过，不是别人的，看着像串了。
      //    想看频道里有什么，订阅了自然会显示。
      unreadCount: subscribed ? unreadStmt.get(userId, r.id).c : 0,
    };
  }));
});

// GET /channel/:id
router.get('/channel/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });

  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  if (!ch) return res.status(404).json({ error: '频道不存在' });

  // 私有频道：只能看自己订阅的 —— **超管也不例外**（2026-10-01 收窄）。
  // 超管的「全知」移到管理页 `GET /admin/channels`，日常界面不再能点开别人的私有频道。
  if (!ch.is_public) {
    const sub = db.prepare(
      'SELECT 1 FROM subscriptions WHERE user_id = ? AND channel_id = ?'
    ).get(req.user.id, id);
    if (!sub) return res.status(403).json({ error: '没有权限' });
  }

  const sub = db.prepare(
    'SELECT muted FROM subscriptions WHERE user_id = ? AND channel_id = ?'
  ).get(req.user.id, id);

  const unread = db.prepare(`
    SELECT COUNT(*) AS c
    FROM messages m
    LEFT JOIN message_reads r ON r.message_id = m.id AND r.user_id = ?
    WHERE m.channel_id = ?
      AND m.deleted_at IS NULL
      AND m.archived_at IS NULL
      AND r.read_at IS NULL
  `).get(req.user.id, id).c;

  res.json(rowToChannel(ch, {
    unreadCount: unread,
    subscribed: !!sub,
    muted: sub?.muted,
  }));
});

// POST /channel
router.post('/channel',
  // ⚠️ 建频道此前完全没限流，全局兜底是 600/min ⇒ 一分钟能塞 600 个频道进来。
  //    虽然要登录（注册另有 3/h 限制），内部用户或被攻破的账号仍能刷爆。
  rateLimit({ windowMs: 3600000, max: 20, name: 'channel_create', message: '创建频道过于频繁，请稍后再试' }),
  (req, res) => {
  const { name, description, image, is_public, password } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '请填写频道名称' });
  }

  // 订阅密码（可选）：不传 / 空 = 无密码
  let passwordHash = null;
  if (password !== undefined && password !== null && password !== '') {
    if (typeof password !== 'string') return res.status(400).json({ error: '密码必须是字符串' });
    if (password.length < 4 || password.length > 64) {
      return res.status(400).json({ error: '频道密码需 4-64 位' });
    }
    passwordHash = hashPassword(password);
  }

  // 频道名允许重名（像 QQ 群：id 唯一、群名随便），不查重

  const now = Date.now();

  // ⚠️ 「建频道」和「给创建者订阅」必须在**同一个事务**里：
  //    两步中间挂了会留下一个没人订阅的孤儿频道 —— 超管在 /admin 里看得见，
  //    创建者自己反而看不见（他没有订阅关系），于是谁都进不去也删不掉。
  //    订阅用 INSERT OR IGNORE，同一人重复订阅不会撞 UNIQUE。
  const newChannelId = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO channels (name, description, image, is_public, creator_id, created_at, password_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      name.trim(),
      description || null,
      image || null,
      is_public ? 1 : 0,
      req.user.id,
      now,
      passwordHash
    );

    // 只自动订阅创建者本人：自己建的频道自己看得见。
    // 其他人不会被订阅，要收消息得去「发现频道」显式订阅。
    db.prepare(`
      INSERT OR IGNORE INTO subscriptions (user_id, channel_id, created_at)
      VALUES (?, ?, ?)
    `).run(req.user.id, info.lastInsertRowid, now);

    return info.lastInsertRowid;
  })();

  // 🔴 广播和刷新订阅关系一律留在事务**外面**：那是进程外的副作用，回滚不了。
  //    只有事务真的提交成功了才该发生 —— 否则会推一个并不存在的频道出去。
  //    订阅关系一变就得刷，否则创建者已在线的设备收不到这个频道的消息
  ws.refreshUserChannels(req.user.id);

  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(newChannelId);

  // 广播里不带 subscribed/muted：收件人不止一个，
  // 而"你订没订/静音没静音"是每个用户各自的状态，塞进广播里必然是错的。
  // 客户端收到后会去 /channel 拉一次权威状态（见 handleChannelUpsertEvent）。
  //
  // 用 broadcastChannelMeta 而不是 broadcast：新频道可能是私有的（is_public=0），
  // 不该把它的名字推给看不到的人。收件人 = 管理员 + 订阅者（含创建者，见上面的自动订阅）。
  ws.broadcastChannelMeta(ch.id, {
    event: 'channelCreated',
    channel: rowToChannel(ch, { unreadCount: 0 }),
  }, undefined, ch.creator_id);

  // 频道会出现在所有人的「发现频道」里，属于公共可见的创建动作，必须留痕
  audit.fromReq(req, {
    action: 'channel.create',
    target: String(ch.id),
    meta: { name: ch.name, isPublic: !!ch.is_public },
  });

  res.json(rowToChannel(ch, { subscribed: true, muted: false, unreadCount: 0 }));
});

// POST /channel/:id/icon
router.post('/channel/:id/icon', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });

  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  if (!ch) return res.status(404).json({ error: '频道不存在' });
  // 换图标：超级管理员或频道创建者。普通管理员（role 1）管不到频道
  if (!req.user.isSuper && ch.creator_id !== req.user.id) {
    return res.status(403).json({ error: '没有权限' });
  }
  if (!req.body || req.body.length === 0) {
    return res.status(400).json({ error: '请求内容为空' });
  }

  const { detectImageExt } = require('./sanitize');
  const ext = detectImageExt(req.body);
  if (!ext) return res.status(400).json({ error: '图片格式不支持' });

  if (ch.image && ch.image.startsWith('/channel-icons/')) {
    try { fs.unlinkSync(path.join(CHANNEL_ICONS_DIR, path.basename(ch.image))); } catch {}
  }

  const filename = `${id}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(CHANNEL_ICONS_DIR, filename), req.body);

  const imagePath = `/channel-icons/${filename}`;
  db.prepare('UPDATE channels SET image = ? WHERE id = ?').run(imagePath, id);

  const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);

  ws.broadcastChannelMeta(id, {
    event: 'channelUpdated',
    channel: rowToChannel(updated),
  }, undefined, updated.creator_id);

  audit.fromReq(req, { action: 'channel.icon.upload', target: String(id) });

  res.json(rowToChannel(updated));
});

// PATCH /channel/:id
router.patch('/channel/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });

  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  if (!ch) return res.status(404).json({ error: '频道不存在' });

  // 改频道（名称/描述/公开性）：超级管理员或创建者。普通管理员管不到频道
  if (!req.user.isSuper && ch.creator_id !== req.user.id) {
    return res.status(403).json({ error: '没有权限' });
  }

  const { name, description, image, is_public, password } = req.body || {};
  const updates = [];
  const params = [];

  if (name != null) {
    const trimmed = String(name).trim();
    if (!trimmed) return res.status(400).json({ error: '名称不能为空' });
    updates.push('name = ?'); params.push(trimmed);
  }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (image !== undefined) { updates.push('image = ?'); params.push(image); }
  if (is_public !== undefined) { updates.push('is_public = ?'); params.push(is_public ? 1 : 0); }

  // 订阅密码：空串/ null = 清除；非空 = 设置（哈希存）
  if (password !== undefined) {
    if (password === '' || password === null) {
      updates.push('password_hash = ?'); params.push(null);
    } else {
      if (typeof password !== 'string') return res.status(400).json({ error: '密码必须是字符串' });
      if (password.length < 4 || password.length > 64) {
        return res.status(400).json({ error: '频道密码需 4-64 位' });
      }
      updates.push('password_hash = ?'); params.push(hashPassword(password));
    }
  }

  if (updates.length === 0) return res.json(rowToChannel(ch));

  params.push(id);
  db.prepare(`UPDATE channels SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);

  ws.broadcastChannelMeta(id, {
    event: 'channelUpdated',
    channel: rowToChannel(updated),
  }, undefined, updated.creator_id);

  // is_public 从 1 改成 0 会让别人瞬间看不到这个频道、0 改成 1 则是公开出去，
  // 这种可见性翻转必须记下来，所以这里把改动过的字段名一并写进 meta
  audit.fromReq(req, {
    action: 'channel.update',
    target: String(id),
    meta: {
      name: updated.name,
      changed: ['name', 'description', 'image', 'is_public', 'password']
        .filter(k => (req.body || {})[k] !== undefined),
      isPublic: !!updated.is_public,
    },
  });

  res.json(rowToChannel(updated));
});

// DELETE /channel/:id
router.delete('/channel/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });
  if (id === 1) return res.status(400).json({ error: '默认频道不能删除' });

  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  if (!ch) return res.status(404).json({ error: '频道不存在' });

  // 删频道：超级管理员或创建者。普通管理员（role 1）管不到频道
  if (!req.user.isSuper && ch.creator_id !== req.user.id) {
    return res.status(403).json({ error: '没有权限' });
  }

  const msgRows = db.prepare(
    'SELECT id FROM messages WHERE channel_id = ? AND deleted_at IS NULL'
  ).all(id);

  if (ch.image && ch.image.startsWith('/channel-icons/')) {
    try { fs.unlinkSync(path.join(CHANNEL_ICONS_DIR, path.basename(ch.image))); } catch {}
  }

  // ⚠️ 收件人必须在事务**之前**取：tx() 里会 `DELETE FROM subscriptions`，
  //    事后再查订阅表就是空的 —— 订阅者收不到删除事件，本地会残留幽灵频道。
  const subscribers = ws.getChannelSubscriberIds(id);

  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE messages SET deleted_at = ? WHERE channel_id = ? AND deleted_at IS NULL'
    ).run(now, id);
    db.prepare('DELETE FROM subscriptions WHERE channel_id = ?').run(id);
    db.prepare('UPDATE applications SET channel_id = 1 WHERE channel_id = ?').run(id);
    db.prepare('DELETE FROM channels WHERE id = ?').run(id);
  });
  tx();

  // 频道里所有消息被整批软删了，它们独占的附件跟着删。
  //
  // ⚠️ 查询放在 tx() **之后**、且不筛 deleted_at：事务已经把这些消息标成已删，
  //    再带 `deleted_at IS NULL` 就什么都查不到了。频道行删了但消息的 channel_id 还在，
  //    所以 `WHERE channel_id = ?` 照样捞得到。
  // ⚠️ 只捞**真的引用了附件**的那些行 —— 大频道几万条消息，把正文全捞出来
  //    会把内存和事件循环一起吃掉（同步驱动，跑的时候整个进程是停的）。
  const removedAttachments = cleanupAttachmentsOfRows({
    db,
    attachmentsDir: ATTACHMENTS_DIR,
    rows: db.prepare(`
      SELECT message, extras FROM messages
      WHERE channel_id = ?
        AND (message LIKE '%/attachments/%' OR extras LIKE '%/attachments/%')
    `).all(id),
  });

  for (const m of msgRows) {
    ws.broadcastToChannel(id, { id: m.id, event: 'messageDeleted' });
  }
  ws.broadcastChannelMeta(id, { event: 'channelDeleted', channelId: id }, subscribers, ch.creator_id);
  // 这里不用 refreshUserChannels：频道都没了，不会再有它的消息，
  // 各连接里残留的那个 channel_id 只是个死值，不影响任何推送判断。

  // 删频道是连锁删除：频道内所有消息一起软删、订阅关系清空、
  // 绑在上面的应用回落到默认频道。这是全站影响最大的破坏性操作之一
  audit.fromReq(req, {
    action: 'channel.delete',
    target: String(id),
    meta: { name: ch.name, deletedMessages: msgRows.length, removedAttachments },
  });

  res.json({ deletedMessages: msgRows.length, removedAttachments });
});

// POST /channel/:id/subscribe
router.post('/channel/:id/subscribe', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });

  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  if (!ch) return res.status(404).json({ error: '频道不存在' });

  // 订阅私有频道：超级管理员或创建者。普通管理员也不能钻进别人的私有频道
  if (!ch.is_public && !req.user.isSuper && ch.creator_id !== req.user.id) {
    return res.status(403).json({ error: '私有频道无法订阅' });
  }

  // 订阅门槛：频道设了密码时，创建者/超管免密，其他人必须输对密码
  if (ch.password_hash && req.user.id !== ch.creator_id && !req.user.isSuper) {
    const { password } = req.body || {};
    if (typeof password !== 'string' || !verifyPassword(password, ch.password_hash)) {
      // 只有密码**错误**才计数（防爆破）：同一 IP 对同一频道 5 分钟内错 5 次 → 429
      const retryAfter = consume(`channel-pwd:${audit.getIp(req)}:${id}`, 300000, 5);
      audit.fromReq(req, {
        action: 'channel.subscribe',
        target: String(id),
        success: false,
        meta: { name: ch.name, reason: retryAfter > 0 ? '密码错误次数过多' : '密码错误' },
      });
      if (retryAfter > 0) {
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({ error: '密码尝试次数过多，请稍后再试', retryAfter });
      }
      return res.status(403).json({ error: '密码错误' });
    }
  }

  db.prepare(`
    INSERT OR IGNORE INTO subscriptions (user_id, channel_id, created_at)
    VALUES (?, ?, ?)
  `).run(req.user.id, id, Date.now());

  // ⚠️ 必须刷新：ws.subscribedChannels 是连接建立时的**快照**，
  //    不刷的话这个频道的消息推不到已经在线的设备 —— 要等 WS 断线重连才恢复。
  ws.refreshUserChannels(req.user.id);

  ws.broadcastToUser(req.user.id, {
    event: 'subscriptionChanged',
    channelId: id,
    action: 'subscribed',
  });

  // 订阅 = 获取这个频道消息的权限，属于"权限变更"，不是普通偏好设置。
  // 管理员 / 创建者还能订阅私有频道，所以这里要记下是不是越权订阅
  audit.fromReq(req, {
    action: 'channel.subscribe',
    target: String(id),
    meta: { name: ch.name, private: !ch.is_public },
  });

  res.json({ ok: true, subscribed: true });
});

// DELETE /channel/:id/subscribe
router.delete('/channel/:id/subscribe', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });

  db.prepare(
    'DELETE FROM subscriptions WHERE user_id = ? AND channel_id = ?'
  ).run(req.user.id, id);

  // 同订阅：不刷的话已退订的频道还会继续往在线设备推消息
  ws.refreshUserChannels(req.user.id);

  ws.broadcastToUser(req.user.id, {
    event: 'subscriptionChanged',
    channelId: id,
    action: 'unsubscribed',
  });

  audit.fromReq(req, { action: 'channel.unsubscribe', target: String(id) });

  res.json({ ok: true, subscribed: false });
});

// PATCH /channel/:id/subscribe
router.patch('/channel/:id/subscribe', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });

  const { muted } = req.body || {};
  if (typeof muted !== 'boolean') {
    return res.status(400).json({ error: 'muted 只能是 true 或 false' });
  }

  // 只改 muted，不动订阅关系本身 ⇒ 不用 refreshUserChannels
  // （subscribedChannels 里存的是 channel_id 集合，与静音无关）
  const result = db.prepare(
    'UPDATE subscriptions SET muted = ? WHERE user_id = ? AND channel_id = ?'
  ).run(muted ? 1 : 0, req.user.id, id);

  if (result.changes === 0) {
    return res.status(404).json({ error: '尚未订阅该频道' });
  }

  // 静音是「每个用户自己」的订阅状态，但一个用户可能有多台设备，
  // 不广播的话其它设备要等下次同步才知道，会出现"A 静音了、B 还在弹通知"
  ws.broadcastToUser(req.user.id, {
    event: 'subscriptionChanged',
    channelId: id,
    action: 'muted',
    muted,
  });

  res.json({ ok: true, muted });
});

router.iconsDir = CHANNEL_ICONS_DIR;

module.exports = router;
