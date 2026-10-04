const db = require('./db');
const audit = require('./audit');

// 动态读取：优先 global（由 migrate 解析），其次 env，最后兜底
function getAuthToken() {
  return global.__AUTH_TOKEN__ || process.env.AUTH_TOKEN || 'dev-token';
}

function resolveToken(token) {
  if (!token) return null;

  const device = db.prepare(`
    SELECT d.id AS device_id, d.user_id, u.username, u.is_admin, u.role
    FROM devices d
    JOIN users u ON u.id = d.user_id
    WHERE d.token = ?
  `).get(token);

  if (device) {
    // role 可能为 NULL（迁移前建的老行），兜成 0；is_admin 语义保持 role >= 1
    const role = device.role != null ? device.role : (device.is_admin ? 2 : 0);
    return {
      userId: device.user_id,
      username: device.username,
      isAdmin: role >= 1 || !!device.is_admin,
      isSuper: role >= 2,
      role,
      deviceId: device.device_id,
      isLegacyAuth: false,
    };
  }

  if (token === getAuthToken()) {
    // 主密钥 = 超级管理员。用 role >= 2 找，找不到就退回 is_admin。
    const admin = db.prepare(
      'SELECT * FROM users WHERE role >= 2 ORDER BY id ASC LIMIT 1'
    ).get() || db.prepare('SELECT * FROM users WHERE is_admin = 1 LIMIT 1').get();
    return {
      userId: admin ? admin.id : 1,
      username: admin ? admin.username : 'admin',
      isAdmin: true,
      isSuper: true,
      role: 2,
      deviceId: null,
      isLegacyAuth: true,
    };
  }

  return null;
}

function extractToken(req) {
  const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const gotifyKey = req.headers['x-gotify-key'] || '';
  const queryToken = req.query?.token || '';
  return bearer || gotifyKey || queryToken;
}

/**
 * 该用户订阅了哪些频道
 *
 * ⚠️ 2026-09-30 改过语义：**超级管理员也不再返回 null**。
 *
 * 以前超管返回 null（= 全收），后果是超管的连接会收到**所有**频道的消息推送，
 * 而 `refreshUserChannels` 又跳过超管连接 ⇒ 超管点「退订」完全无效，
 * 没有任何手段让一个频道安静下来。
 *
 * 现在所有人一律按订阅集合推送消息。超管的特权保留在**拉取**侧：
 * `GET /message`、`GET /channel` 仍能查到任意频道（排障需要）。
 *
 * ⚠️ 但 `broadcastChannelMeta`（频道元信息）**仍然给超管全收** ——
 *    否则超管收不到频道的 created/updated/deleted，本地会残留幽灵频道
 *    （他 `GET /channel` 能看到全部频道，删除事件漏了就永远清不掉）。
 *
 * @param {number} userId
 * @returns {Set<number>} 订阅的频道 id 集合（不会返回 null）
 */
function getUserChannels(userId) {
  const rows = db.prepare(
    'SELECT channel_id FROM subscriptions WHERE user_id = ?'
  ).all(userId);
  return new Set(rows.map(r => r.channel_id));
}

/**
 * 订阅了某个频道的全部 user_id（管理员不在里面，他们另有全收通道）
 *
 * 与 `getUserChannels` 的区别：那个是「某用户订了哪些频道」（连接时快照一次），
 * 这个是「某频道被哪些人订了」（**每次实时查库**）。
 *
 * ⚠️ 频道元信息广播必须走这个实时版本，不能用连接快照 ——
 *    用户中途订阅的频道不在快照里，用快照会漏人。
 *
 * @param {number} channelId
 * @returns {Set<number>}
 */
function getChannelSubscriberIds(channelId) {
  const rows = db.prepare(
    'SELECT user_id FROM subscriptions WHERE channel_id = ?'
  ).all(channelId);
  return new Set(rows.map(r => r.user_id));
}

/**
 * 按用户 id 重新读取身份（role / isAdmin / isSuper）
 *
 * 用途：管理员被提升或降级后，刷新他**已在线**的 WS 连接。
 * `ws.isAdmin` / `ws.isSuper` / `ws.subscribedChannels` 都是连接时算一次的快照，
 * 不刷的话刚改完角色的连接行为还是旧的（降级了照样全收、升级了照样收不到）。
 *
 * @param {number} userId
 * @returns {{userId, username, isAdmin, isSuper, role}|null}
 */
function getUserIdentity(userId) {
  const u = db.prepare(
    'SELECT id, username, is_admin, role FROM users WHERE id = ?'
  ).get(userId);
  if (!u) return null;
  const role = u.role != null ? u.role : (u.is_admin ? 2 : 0);
  return {
    userId: u.id,
    username: u.username,
    isAdmin: role >= 1 || !!u.is_admin,
    isSuper: role >= 2,
    role,
  };
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    // 已登录的普通用户在撞管理员接口 —— 要么是被改过的客户端，要么是在试探越权。
    // 按「用户 + 路径」节流：正常误触只会记一条，反复试探也留得下痕迹
    audit.logThrottled(`forbidden:${req.user ? req.user.id : 'anon'}:${req.baseUrl}${req.path}`, 300000, {
      userId: req.user ? req.user.id : null,
      ip: audit.getIp(req),
      action: 'auth.forbidden',
      success: false,
      meta: { method: req.method, path: `${req.baseUrl}${req.path}` },
    });
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

/**
 * 要求**超级管理员**（role 2）
 *
 * 与 `requireAdmin` 的区别：管理员（role 1）只能管应用和路由规则，
 * 碰不到证书、审计日志、别人的频道，也看不到私有频道内容。
 *
 * ⚠️ 用新的节流 key（`forbidden-super`），别和管理员的共用 ——
 *    否则同一个用户在两个级别上的试探会互相淹没计数。
 */
function requireSuper(req, res, next) {
  if (!req.user || !req.user.isSuper) {
    audit.logThrottled(`forbidden-super:${req.user ? req.user.id : 'anon'}:${req.baseUrl}${req.path}`, 300000, {
      userId: req.user ? req.user.id : null,
      ip: audit.getIp(req),
      action: 'auth.forbidden_super',
      success: false,
      meta: { method: req.method, path: `${req.baseUrl}${req.path}`, role: req.user ? req.user.role : null },
    });
    return res.status(403).json({ error: '需要超级管理员权限' });
  }
  next();
}

module.exports = {
  resolveToken,
  extractToken,
  getUserChannels,
  getChannelSubscriberIds,
  getUserIdentity,
  requireAdmin,
  requireSuper,
  getAuthToken,
};
