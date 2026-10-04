const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const ws = require('./ws');
const { resolveToken, extractToken, requireAdmin, requireSuper } = require('./auth');
const channelsRouter = require('./channels');
const messagesRouter = require('./messages');
const usersRouter = require('./users');
const routesApi = require('./routes-api');
const adminApi = require('./admin-api');
const { createMessage, AGG_WINDOW_MS, AGG_MAX_LIFETIME_MS } = require('./messageCreate');
const { router: hooksRouter } = require('./hooks');
const { createCertsRouter } = require('./certs');
const { createBackgroundRouter } = require('./background');
const {
  createAttachmentsRouter,
  cleanupMessageAttachments,
  sweepOrphanAttachments,
} = require('./attachments');
const { rateLimit } = require('./rateLimit');
const { detectImageExt } = require('./sanitize');
const audit = require('./audit');
const { trustProxyConfig, AUTO_TRUST_LIST } = require('./clientIp');
const { createSecurityHeaders } = require('./securityHeaders');
const { generateAppToken } = require('./tokenGen');

const app = express();
const server = http.createServer(app);

// 别在响应头里宣布用的是 Express（securityHeaders.js 里还会再兜一次 removeHeader，
// 这里是源头：Express 默认在 expressInit 中间件里就把它设上了）
app.disable('x-powered-by');

// ============================================================
// 反向代理信任（TRUST_PROXY）
// ============================================================
// 默认不信任 X-Forwarded-For —— 它是客户端自带的头，能伪造，
// 无条件采信会让限速被绕过（见 clientIp.js 里的说明）。
// 只有前面确实有反代、且反代会覆盖（而非追加）XFF 时才开启。
let TRUST_PROXY = trustProxyConfig();
if (TRUST_PROXY != null) {
  // 兜底：万一手动填了 clientIp.js 没拦住的畸形值，proxyaddr.compile() 会抛
  // TypeError，那会在启动阶段就把服务搞挂，不如降级成"不信任"继续跑
  try {
    app.set('trust proxy', TRUST_PROXY);
  } catch (e) {
    console.error(`[trust proxy] "${TRUST_PROXY}" 不是合法的信任配置，按不信任处理: ${e.message}`);
    app.set('trust proxy', false);
    TRUST_PROXY = null; // 启动日志也按 off 展示，别误导
  }
}

const AUTH_TOKEN = global.__AUTH_TOKEN__ || process.env.AUTH_TOKEN || 'dev-token';
const PORT = process.env.PORT || 20010;
const HTTPS_PORT = process.env.HTTPS_PORT || 20443;

const DATA_DIR = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : './data';
const ICONS_DIR = path.join(DATA_DIR, 'icons');
const CHANNEL_ICONS_DIR = path.join(DATA_DIR, 'channel-icons');
const CERT_DIR = path.join(DATA_DIR, 'certs');
const BACKGROUND_DIR = path.join(DATA_DIR, 'background');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
for (const d of [ICONS_DIR, CHANNEL_ICONS_DIR, CERT_DIR, BACKGROUND_DIR, ATTACHMENTS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const CRT_PATH = path.join(CERT_DIR, 'fullchain.pem');
const KEY_PATH = path.join(CERT_DIR, 'privkey.pem');
let httpsServer = null;

function hasCerts() {
  return fs.existsSync(CRT_PATH) && fs.existsSync(KEY_PATH);
}

// 启动或热重载 HTTPS
// 返回 { ok, started, error } —— 调用方据此判断真实结果
async function ensureHttps() {
  // 已有 server → 尝试热重载
  if (httpsServer) {
    try {
      httpsServer.setSecureContext({
        cert: fs.readFileSync(CRT_PATH),
        key: fs.readFileSync(KEY_PATH),
      });
      console.log('✅ 证书已热更新');
      return { ok: true, started: false };
    } catch (e) {
      console.error('❌ 证书热更新失败:', e.message);
      return { ok: false, error: e.message };
    }
  }

  // 首次启动
  if (!hasCerts()) {
    return { ok: false, error: '证书或私钥缺失' };
  }

  let srv;
  try {
    srv = https.createServer({
      cert: fs.readFileSync(CRT_PATH),
      key: fs.readFileSync(KEY_PATH),
    }, app);
    ws.attach(srv);
  } catch (e) {
    console.error('❌ HTTPS 创建失败:', e.message);
    return { ok: false, error: e.message };
  }

  return new Promise((resolve) => {
    let settled = false;

    const onError = (e) => {
      if (settled) return;
      settled = true;
      httpsServer = null;
      try { srv.close(); } catch {}
      console.error('❌ HTTPS 监听失败:', e.message);
      resolve({ ok: false, error: e.message });
    };

    srv.once('error', onError);

    srv.listen(HTTPS_PORT, () => {
      if (settled) return;
      settled = true;
      srv.removeListener('error', onError);

      // listen 成功后，改挂运行时错误处理
      srv.on('error', (e) => {
        console.error('❌ HTTPS 运行时错误:', e.message);
      });

      httpsServer = srv;
      console.log(`🔒 HTTPS 已启动，监听端口 ${HTTPS_PORT}`);
      resolve({ ok: true, started: true });
    });
  });
}

// 关闭 HTTPS 服务
function stopHttps() {
  if (!httpsServer) return { stopped: false };
  try {
    const srv = httpsServer;
    httpsServer = null;
    srv.close(() => {
      console.log('🛑 HTTPS 服务已关闭');
    });
    return { stopped: true };
  } catch (e) {
    console.error('关闭 HTTPS 失败:', e.message);
    return { stopped: false, error: e.message };
  }
}

// 安全响应头：放在所有路由和静态资源之前，保证每个响应都带上
app.use(createSecurityHeaders());

// ============================================================
// 静态文件
// ============================================================
app.use('/icons', express.static(ICONS_DIR));
app.use('/channel-icons', express.static(CHANNEL_ICONS_DIR));
app.use('/background-files', express.static(BACKGROUND_DIR, {
  maxAge: '5m',
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=300'),
}));
// 附件：和 /icons、/user-avatars 一样是公开静态目录（文件名随机，URL 不可猜）。
//
// 为什么要按类型区分 Content-Disposition：
//   - 图片必须是 inline —— WebUI 用 <img> 引用它（浏览器对子资源本来就不理会这个头，
//     但显式写成 inline 更保险，别让图片变成"下载"）
//   - 其余一律 attachment：附件目录和 WebUI **同源**，万一有个 html 系扩展名
//     （html/xhtm/mhtml…，扩展名黑名单永远堵不全）被内联打开，就是一个存储型 XSS
// 图片的扩展名是服务端按魔数定的（只可能是 png/jpg/gif/webp），所以这里按扩展名判断是可靠的。
app.use('/attachments', express.static(ATTACHMENTS_DIR, {
  maxAge: '5m',
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const isImage = /\.(png|jpe?g|gif|webp)$/i.test(filePath);
    res.setHeader('Content-Disposition', isImage ? 'inline' : 'attachment');
  },
}));
app.use('/user-avatars', express.static(path.join(DATA_DIR, 'user-avatars'), {
  maxAge: '5m',
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=300'),
}));
app.use(express.static(path.join(__dirname, '..', 'public')));

// 忘记密码的重置链接形如 /reset-password?token=…：没有对应的静态文件，
// 落到这里返回 SPA 首页，前端从 query 里读 token 显示重置页。
app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ============================================================
// Body 解析
// ============================================================
app.use('/hook', express.raw({ type: '*/*', limit: '1mb' }));
app.use('/certs', express.raw({ type: '*/*', limit: '1mb' }));
app.use('/application/:id/icon', express.raw({ type: 'image/*', limit: '5mb' }));
app.use('/channel/:id/icon', express.raw({ type: 'image/*', limit: '5mb' }));
app.use('/background', express.raw({ type: 'image/*', limit: '8mb' }));
// 附件是任意类型，raw 解析器必须挂在 express.json **之前**：
// 否则用 application/json 上传的 .json 文件会被 json 解析器先吃掉（limit 1mb）
app.use('/attachment', express.raw({ type: '*/*', limit: '20mb' }));
app.use('/user/avatar', express.raw({ type: 'image/*', limit: '5mb' }));
app.use(express.json({ limit: '1mb' }));

// 全局限速（兜底）
app.use(rateLimit({ windowMs: 60000, max: 600, name: 'global', message: '请求过于频繁' }));

// ============================================================
// 鉴权
// ============================================================
function auth(req, res, next) {
  const token = extractToken(req);
  const identity = resolveToken(token);
  if (!identity) {
    // 无效 / 过期 token。和 webhook 那条一样属于可刷的高频失败事件，
    // 按 IP 节流成 5 分钟一条，避免把审计表灌满（见 audit.logThrottled）
    audit.logThrottled('bad-token:' + audit.getIp(req), 300000, {
      ip: audit.getIp(req),
      action: 'auth.bad_token',
      success: false,
      meta: { method: req.method, path: req.path, tokenPrefix: token ? String(token).slice(0, 8) : null },
    });
    return res.status(401).json({ error: '未登录或登录已过期', errorCode: 401 });
  }
  req.user = {
    id: identity.userId,
    username: identity.username,
    isAdmin: identity.isAdmin,
    isSuper: !!identity.isSuper,
    role: identity.role != null ? identity.role : (identity.isAdmin ? 1 : 0),
  };
  req.deviceId = identity.deviceId;
  req.isLegacyAuth = identity.isLegacyAuth;
  next();
}

function isoDate(ms) { return new Date(ms).toISOString(); }

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

function rowToApp(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    image: row.image || null,
    internal: false,
    // ⚠️ 绝不能 fallback 成 AUTH_TOKEN —— 那是全局主密钥，等于超管身份
    //    （能提升任意人为超管、读所有私有频道、改路由规则）。
    //    以前这里写的是 `row.token || AUTH_TOKEN`，一旦某行 token 为空就会
    //    把主密钥直接吐给调用方。token 为空就返回 null，宁可前端显示不了 URL。
    token: row.token || null,
    defaultPriority: 0,
    channelId: row.channel_id || null,
    template: row.template || null,
  };
}

// ============================================================
// 基础
// ============================================================
app.get('/health', (req, res) => {
  res.json({ ok: true, online: ws.onlineCount(), https: !!httpsServer, ts: Date.now() });
});

// 前端配置
app.get('/config', (req, res) => {
  res.json({
    certsUiEnabled: process.env.CERTS_UI_ENABLED !== 'false',
    httpsPort: HTTPS_PORT,
    // 消息聚合的**有效**配置（非敏感）—— 让客户端和 verify-full.sh 能直接断言真实生效值，
    // 不用去解析启动日志（日志会被轮转，--tail 也不一定捞得到启动那一行）。
    //   aggWindowMs      滚动窗口：距**上次折叠**超过它就换新的一条
    //   aggMaxLifetimeMs 单条聚合消息的最长寿命，从**建消息时间**算起；0 = 不限制
    aggWindowMs: AGG_WINDOW_MS,
    aggMaxLifetimeMs: AGG_MAX_LIFETIME_MS,
  });
});

app.get('/version', auth, (req, res) => {
  res.json({ version: '2.0.0', commit: 'local', buildDate: new Date().toISOString() });
});

// ============================================================
// 挂载子路由
// ============================================================
app.use(hooksRouter);
app.use(usersRouter);
app.use(auth);

app.use(channelsRouter);
app.use(messagesRouter);
app.use(routesApi);
app.use(adminApi);   // 超管管理页：/admin/* （全量只读，带归属用户）
app.use(createCertsRouter({
  certsDir: CERT_DIR,
  onCertsUpdated: ensureHttps,
  onCertsRemoved: stopHttps,
}));
app.use(createBackgroundRouter({ backgroundDir: BACKGROUND_DIR }));
app.use(createAttachmentsRouter({ attachmentsDir: ATTACHMENTS_DIR }));

// ============================================================
// 应用
// ============================================================
// 应用**按用户隔离**：普通用户也能管自己的应用，但只看得到自己创建的。
//
// 不再用 requireAdmin —— 之前那样做是因为列表返回**明文 token**，而注册是开放的，
// 等于任何人注册个账号就能拿到全部应用的 webhook 凭据。现在改成按 user_id 过滤，
// 每人只能拿到自己的，token 泄露面回到「只有归属者」。（超管看全部走 /admin/applications）
//
// ⚠️ 归属校验 helper：别人的应用一律回 404 —— 不暴露它存不存在，避免被用来探测。
function appBelongsToUser(row, req) {
  return !!row && row.user_id === req.user.id;
}

app.get('/application', (req, res) => {
  const rows = db.prepare('SELECT * FROM applications WHERE user_id = ? ORDER BY id ASC').all(req.user.id);
  res.json(rows.map(rowToApp));
});

// ⚠️ 限流：应用现在**人人可建**（以前是管理员专用），而注册又是开放的 ——
//    不限的话一个账号就能刷出成千上万行、每行还各带一枚长期 token。
//    口径参考 POST /device（20/h）。
app.post('/application',
  rateLimit({ windowMs: 3600000, max: 30, name: 'app_create', message: '新建应用过于频繁，请稍后再试' }),
  (req, res) => {
  const { name, description, image, channel_id, template } = req.body || {};
  if (!name) return res.status(400).json({ error: '请填写名称' });

  let finalChannelId = channel_id;
  if (!finalChannelId) {
    // 优先落到该用户订阅的第一个频道，没订阅才回落到 id 最小的频道
    const sub = db.prepare(
      'SELECT channel_id FROM subscriptions WHERE user_id = ? ORDER BY channel_id ASC LIMIT 1'
    ).get(req.user.id);
    if (sub) {
      finalChannelId = sub.channel_id;
    } else {
      const first = db.prepare('SELECT id FROM channels ORDER BY id ASC LIMIT 1').get();
      finalChannelId = first ? first.id : null;
    }
  }

  // 应用只能绑到自己有权限的频道（订阅的 / 自己创建的）：
  // 否则随便填个 channel_id 就能把 webhook 消息发进别人的私有频道。
  if (finalChannelId) {
    const ch = db.prepare('SELECT id, creator_id FROM channels WHERE id = ?').get(finalChannelId);
    if (!ch) return res.status(400).json({ error: '频道不存在' });
    if (!req.user.isSuper) {
      const sub = db.prepare(
        'SELECT 1 FROM subscriptions WHERE user_id = ? AND channel_id = ?'
      ).get(req.user.id, finalChannelId);
      if (!sub && ch.creator_id !== req.user.id) {
        return res.status(403).json({ error: '没有权限使用该频道' });
      }
    }
  }

  // 生成应用 Token（10 位大小写+数字，见 tokenGen.js）。
  //
  // 唯一性重试：10 位虽然撞车概率极低（按生日问题，千级应用约 1e-5），
  // 但 applications.token 上有 UNIQUE 索引，真撞了 INSERT 会直接抛
  // SQLITE_CONSTRAINT。这里重试几次，比让建应用接口 500 好。
  // 概率上说重试一次就够，循环上限纯粹是防御性写法。
  let token = null;
  let info = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateAppToken();
    const dup = db.prepare('SELECT 1 FROM applications WHERE token = ?').get(candidate);
    if (dup) continue;
    try {
      info = db.prepare(
        'INSERT INTO applications (name, description, image, channel_id, template, token, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(name, description || null, image || null, finalChannelId, template || null, candidate, Date.now(), req.user.id);
      token = candidate;
      break;
    } catch (e) {
      // 只吞 UNIQUE 冲突，其它错误（磁盘满、表不存在…）照常抛
      if (!/UNIQUE|constraint/i.test(e.message)) throw e;
    }
  }
  if (!token) {
    return res.status(500).json({ error: '生成应用 Token 失败，请重试' });
  }

  audit.fromReq(req, {
    action: 'app.create',
    target: String(info.lastInsertRowid),
    meta: { name, channelId: finalChannelId, hasTemplate: !!template },
  });

  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(info.lastInsertRowid);
  res.json(rowToApp(row));
});

app.patch('/application/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!appBelongsToUser(row, req)) {
    audit.fromReq(req, { action: 'app.forbidden_owner', target: String(id), success: false });
    return res.status(404).json({ error: '资源不存在' });
  }

  const { name, description, image, channel_id, template } = req.body || {};

  // 改绑频道同样要校验归属（同 POST）：不能把应用指向别人的私有频道
  if (channel_id !== undefined && channel_id) {
    const ch = db.prepare('SELECT id, creator_id FROM channels WHERE id = ?').get(channel_id);
    if (!ch) return res.status(400).json({ error: '频道不存在' });
    if (!req.user.isSuper) {
      const sub = db.prepare(
        'SELECT 1 FROM subscriptions WHERE user_id = ? AND channel_id = ?'
      ).get(req.user.id, channel_id);
      if (!sub && ch.creator_id !== req.user.id) {
        return res.status(403).json({ error: '没有权限使用该频道' });
      }
    }
  }

  const updates = [];
  const params = [];
  if (name != null) { updates.push('name = ?'); params.push(name); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (image !== undefined) { updates.push('image = ?'); params.push(image); }
  if (channel_id !== undefined) { updates.push('channel_id = ?'); params.push(channel_id); }
  if (template !== undefined) { updates.push('template = ?'); params.push(template); }
  if (updates.length === 0) return res.json(rowToApp(row));

  params.push(id);
  db.prepare(`UPDATE applications SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const updated = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  audit.fromReq(req, {
    action: 'app.update',
    target: String(id),
    meta: { changed: ['name', 'description', 'image', 'channel_id', 'template'].filter(k => (req.body || {})[k] !== undefined) },
  });
  res.json(rowToApp(updated));
});

app.post('/application/:id/icon', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });
  const appRow = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!appBelongsToUser(appRow, req)) {
    audit.fromReq(req, { action: 'app.forbidden_owner', target: String(id), success: false });
    return res.status(404).json({ error: '应用不存在' });
  }
  if (!req.body || req.body.length === 0) return res.status(400).json({ error: '请求内容为空' });

  // 魔数校验
  const ext = detectImageExt(req.body);
  if (!ext) return res.status(400).json({ error: '图片格式不支持' });

  if (appRow.image && appRow.image.startsWith('/icons/')) {
    try { fs.unlinkSync(path.join(ICONS_DIR, path.basename(appRow.image))); } catch {}
  }

  const filename = `${id}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(ICONS_DIR, filename), req.body);
  db.prepare('UPDATE applications SET image = ? WHERE id = ?').run(`/icons/${filename}`, id);

  const updated = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);

  audit.fromReq(req, { action: 'app.icon.upload', target: String(id) });

  res.json(rowToApp(updated));
});

app.delete('/application/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });
  const appRow = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!appBelongsToUser(appRow, req)) {
    audit.fromReq(req, { action: 'app.forbidden_owner', target: String(id), success: false });
    return res.status(404).json({ error: '应用不存在' });
  }
  const msgRows = db.prepare(
    'SELECT id, channel_id FROM messages WHERE appid = ? AND deleted_at IS NULL'
  ).all(id);

  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare('UPDATE messages SET deleted_at = ? WHERE appid = ? AND deleted_at IS NULL').run(now, id);
    db.prepare('DELETE FROM applications WHERE id = ?').run(id);
  });
  tx();

  if (appRow && appRow.image && appRow.image.startsWith('/icons/')) {
    try { fs.unlinkSync(path.join(ICONS_DIR, path.basename(appRow.image))); } catch {}
  }

  for (const m of msgRows) {
    ws.broadcastToChannel(m.channel_id, { id: m.id, event: 'messageDeleted' });
  }

  audit.fromReq(req, {
    action: 'app.delete',
    target: String(id),
    meta: { name: appRow ? appRow.name : null, deletedMessages: msgRows.length },
  });
  res.status(200).json({ deletedMessages: msgRows.length });
});

// ============================================================
// 消息列表
// ============================================================
app.get('/message', (req, res) => {
  const userId = req.user.id;
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
  const since = parseInt(req.query.since || '0', 10) || 0;
  const channelFilter = req.query.channel != null ? parseInt(req.query.channel, 10) : null;
  const unreadOnly = req.query.unread === '1';
  const archivedOnly = req.query.archived === '1';
  const includeArchived = req.query.archived === 'all';

  // 按订阅过滤 —— **超管也不例外**（2026-10-01 收窄）：
  // 以前超管能跨频道读到所有人的消息（全知），代价是他的消息列表里混着别人的消息。
  // 现在超管日常也只看自己订阅的频道，要看全站数据去管理页。
  const allowedChannels = db.prepare(
    'SELECT channel_id FROM subscriptions WHERE user_id = ?'
  ).all(userId).map(r => r.channel_id);
  if (allowedChannels.length === 0) {
    return res.json({ paging: { size: 0, limit, since, next: null }, messages: [] });
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

  let sql = `
    SELECT m.*,
           CASE WHEN r.read_at IS NOT NULL THEN 1 ELSE 0 END AS is_read,
           r.read_at
    FROM messages m
    LEFT JOIN message_reads r ON r.message_id = m.id AND r.user_id = ?
    WHERE m.id > ? AND m.deleted_at IS NULL
  `;
  const params = [userId, since];

  if (channelIds) {
    const ph = channelIds.map(() => '?').join(',');
    sql += ` AND m.channel_id IN (${ph})`;
    params.push(...channelIds);
  }
  if (unreadOnly) sql += ` AND r.read_at IS NULL`;
  if (archivedOnly) sql += ` AND m.archived_at IS NOT NULL`;
  else if (!includeArchived) sql += ` AND m.archived_at IS NULL`;
  sql += ` ORDER BY m.id ASC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  res.json({
    paging: { size: rows.length, limit, next: null, since },
    messages: rows.map(rowToMessage),
  });
});

// ============================================================
// 已删除消息的增量对账（墓碑列表）
// ============================================================
//
// 为什么需要这个接口：
//   GET /message 的 `since` 是 **id 水位线**（`WHERE m.id > ?`），它只能表达
//   「新增」—— 删除永远拉不到。客户端本地 id 已经推进到 100 时，服务端删掉
//   id=50 的消息，增量同步完全看不见它，那条消息就成了客户端上的"幽灵"。
//
//   只有两条路能发现删除：① WS 的 messageDeleted 事件（离线时错过就永久错过）；
//   ② 全量同步（要翻完整个历史，成本高）。这个接口给出第三条、也是精确的一条：
//   按**删除时间**增量拉墓碑，客户端在每次消息增量同步后顺带调一次即可。
//
// 水位线用 deleted_at（毫秒时间戳），不能用 id：
//   删除的 id 是无序的（可能删 50、也可能删 3），拿 id 做水位线会漏。
//
// 权限与 GET /message 一致：
//   管理员看全部；普通用户只看自己已订阅频道的删除。
//   否则别的频道的删除 id 会泄漏给未订阅用户。
app.get('/message/deleted', (req, res) => {
  const since = parseInt(req.query.since || '0', 10) || 0;
  // 次级游标：同一 deleted_at 内的进度。
  // 删频道 / 删应用是**一条 UPDATE 打同一个 Date.now()**，整批墓碑时间戳完全相等。
  // 只靠 since 无法表达「同一时刻里已经读到第几条」—— 而且因为排序是
  // `deleted_at ASC, id ASC`，这个值天然等于「本页最后一条的 id」，可以直接复用：
  // 客户端把 since 换成最大 deleted_at、把 sinceId 换成「最后一条的 id」即可续读。
  // 语义：当 deleted_at == since 时，只取 id > sinceId 的行（严格大于，不重不漏）。
  const sinceId = parseInt(req.query.sinceId || '0', 10) || 0;
  const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 1000);

  // 按订阅过滤 —— **超管也不例外**（与 GET /message 同一口径）：
  // 墓碑对账只关心「我订阅的频道里哪些消息没了」，别人的频道不该混进来。
  const allowedChannels = db.prepare(
    'SELECT channel_id FROM subscriptions WHERE user_id = ?'
  ).all(req.user.id).map(r => r.channel_id);
  if (allowedChannels.length === 0) {
    return res.json({ deleted: [], since, sinceId, paging: { size: 0, limit } });
  }

  let sql = `
    SELECT id, channel_id, deleted_at
    FROM messages
    WHERE deleted_at IS NOT NULL
      AND (deleted_at > ?
           OR (deleted_at = ? AND id > ?))
  `;
  const params = [since, since, sinceId];

  if (allowedChannels) {
    const ph = allowedChannels.map(() => '?').join(',');
    sql += ` AND channel_id IN (${ph})`;
    params.push(...allowedChannels);
  }
  // 排序规则（两个条件缺一不可）：
  //   1. deleted_at ASC —— 客户端要用「最后一条」的 deleted_at 推进水位线，
  //      必须保证「先返回的先被应用完」，否则中途中断会漏掉中间那一段。
  //   2. id ASC 次级键 —— 同刻墓碑的相对顺序必须稳定可复现，否则分页会
  //      重复/漏行（客户端靠「最后一条的 id」续读，顺序不稳就接不上）。
  sql += ' ORDER BY deleted_at ASC, id ASC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  res.json({
    deleted: rows.map(r => ({
      id: r.id,
      channelId: r.channel_id ?? null,
      deletedAt: r.deleted_at,
    })),
    // 回显请求的游标，方便客户端排查
    since,
    sinceId,
    // 下一页游标：客户端应原样回传 `since=next.since & sinceId=next.sinceId`。
    // 不再让客户端自己从「最后一条」里算 —— 客户端多一步推导就多一处出错机会，
    // 而且这样服务端改了排序规则客户端也不会错（游标由产出方定义）。
    // rows 为空时 next 为 null，表示已经拉到底。
    next: last ? { since: last.deleted_at, sinceId: last.id } : null,
    paging: { size: rows.length, limit },
  });
});

app.post('/message', (req, res) => {
  const { title, message, priority, extras, appid, channel_id, tags, silent } = req.body || {};
  if (!message) return res.status(400).json({ error: '消息内容不能为空' });

  const result = createMessage({
    appid, channel_id, message, title, priority, extras, tags, silent,
    // 走全局 auth，所以这里一定有身份；由服务端据此写入发送者快照
    // （webhook 那条路没有登录用户，不传，消息就不带发送者）
    userId: req.user ? req.user.id : null,
  });

  // createMessage 现在会因为「频道不存在 / 没权限」返回 { error }，
  // 把具体原因透出去 —— 否则用户只看到一句"消息创建失败"，根本不知道是自己
  // 没订阅还是频道 id 填错了
  if (!result || result.error) {
    return res.status(400).json({ error: (result && result.error) || '消息创建失败' });
  }

  // 走全局 auth 发的消息（区别于 webhook）要记下是谁发的 ——
  // 它会广播给整个频道，事后要能查到"这条是谁手动推的"。
  // 被路由规则 drop 掉的也记，否则"消息发了但没人收到"会完全查不到原因。
  const m = result.message;
  audit.fromReq(req, {
    action: 'message.create',
    target: m ? String(m.id) : null,
    meta: {
      appid: m ? m.appid : appid,
      channelId: m ? (m.channel_id ?? null) : (channel_id ?? null),
      title: m ? m.title : title,
      dropped: !!result.dropped,
      aggregated: !!result.aggregated,
      silent: !!result.silent,
    },
  });

  if (result.dropped) return res.json({ dropped: true });
  res.json(result.message);
});

app.delete('/message/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '资源不存在' });

  // 删消息：**一律必须订阅该频道，超管也不例外**（2026-09-30 改）。
  //
  // 删除是**全局破坏性**操作（软删 messages 表，不分用户），
  // 比归档更严重：超管在未订阅的频道上一删，频道所有者那边消息就没了。
  // 现在统一成"看得到但操作不了" —— 真要删，先订阅那个频道（超管能订阅任意频道）。
  const sub = db.prepare(
    'SELECT 1 FROM subscriptions WHERE user_id = ? AND channel_id = ?'
  ).get(req.user.id, row.channel_id);
  if (!sub) {
    return res.status(403).json({
      error: '这是别人的频道，只能查看不能删除（想删请先订阅）',
    });
  }

  if (!row.deleted_at) {
    db.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?').run(Date.now(), id);
    ws.broadcastToChannel(row.channel_id, { id, event: 'messageDeleted' });

    // 这条消息独占的附件跟着删（还有别的消息引用它就不删）。
    // 清空全部消息 / 裁剪历史那几条路径不走这里，由启动时的 sweepOrphanAttachments 兜底
    const removed = cleanupMessageAttachments({
      db,
      attachmentsDir: ATTACHMENTS_DIR,
      row,
    });
    if (removed > 0) console.log(`🧹 随消息删除清理附件 ${removed} 个`);

    // 删消息对同频道所有人可见（会广播 messageDeleted），属于共享状态的破坏性操作。
    // 注意这里普通用户也能删自己订阅频道的消息，所以记 userId 有意义
    audit.fromReq(req, {
      action: 'message.delete',
      target: String(id),
      meta: { channelId: row.channel_id, title: row.title, attachmentsRemoved: removed },
    });
  }
  res.status(200).json({});
});

// ============================================================
// 审计日志查询（管理员）
// ============================================================
// 审计日志归超级管理员：里面记着所有人的操作痕迹，
// 普通管理员（role 1）只管应用和路由规则，不该看到全站操作记录
app.get('/audit', requireSuper, (req, res) => {
  const { action, userId, since } = req.query;
  const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
  res.json(audit.query({
    action: action || undefined,
    userId: userId != null ? parseInt(userId, 10) : undefined,
    since: since != null ? parseInt(since, 10) : undefined,
    limit,
  }));
});

// ============================================================
// 404 和错误处理
// ============================================================
app.use((req, res) => {
  res.status(404).json({ error: '资源不存在' });
});

app.use((err, req, res, next) => {
  console.error('[error]', err.stack || err.message);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  const message = status >= 500 ? 'internal server error' : (err.message || 'error');
  res.status(status).json({ error: message });
});

// ============================================================
// 启动
// ============================================================
ws.attach(server);

// 启动时间戳：既用来给日志分段，也能在排查"这次到底是哪一轮"时对时间
const BOOTED_AT = new Date().toISOString().replace('T', ' ').slice(0, 19);
const bootSep = () => console.log(`──────── 启动 ${BOOTED_AT} ────────`);

server.listen(PORT, () => {
  // 分隔线：容器日志是 append 的，连续 restart 时上一轮的退出日志
  // 会和这一轮的启动日志粘在一起（看起来像"启动/关闭交错"）。
  // 加一条带时间戳的分隔 + 收尾的结束线，一眼就能看出每轮的边界。
  bootSep();

  console.log(`✅ Chatz 已启动，监听端口 ${PORT}`);
  console.log(`   数据目录: ${global.__DB_PATH__ || '(未知)'}`);
  console.log(`   网页版: http://<主机>:${PORT}/`);
  console.log(`   推送接口: http://<主机>:${PORT}/hook/<应用Token>`);
  // 直接复用 messageCreate 里的常量，别再抄一份默认值（抄就会drift）
  const aggLife = AGG_MAX_LIFETIME_MS > 0 ? `${AGG_MAX_LIFETIME_MS}ms` : '不限制';
  console.log(`   消息聚合窗口: ${AGG_WINDOW_MS}ms（单条最长寿命 ${aggLife}）`);

  if (TRUST_PROXY == null) {
    console.log('   🛡️  TRUST_PROXY=off  →  限速 / 审计只认 TCP 对端地址（忽略 X-Forwarded-For）');
    console.log('      （前面挂了反代的话要改：否则所有人被记成反代的内网 IP，一人触发限速全站 429）');
  } else if (TRUST_PROXY === true) {
    console.log('   ⚠️  TRUST_PROXY=true  →  限速 / 审计取 X-Forwarded-For 第一段');
    console.log('      ⚠️  反代用 $proxy_add_x_forwarded_for（追加）时，客户端伪造的值就在第一段');
    console.log('         建议改用 TRUST_PROXY=1 或 TRUST_PROXY=<反代内网IP>');
  } else if (typeof TRUST_PROXY === 'number') {
    console.log(`   ⚠️  TRUST_PROXY=${TRUST_PROXY}  →  按 ${TRUST_PROXY} 跳反代计算客户端 IP`);
    console.log('      ⚠️  跳数模式不校验对端：本端口若也能被公网直连，绕过反代 + 伪造 XFF 可取任意 IP');
    console.log('         要么防火墙只放行 80/443，要么改成 TRUST_PROXY=<反代内网IP>');
  } else {
    // TRUST_PROXY=auto 展开成一串网段名，日志里还原成 auto 更好认
    const shown = TRUST_PROXY === AUTO_TRUST_LIST ? 'auto' : TRUST_PROXY;
    console.log(`   🛡️  TRUST_PROXY=${shown}  →  只信任来自本机 / 内网的代理`);
  }

  // 孤儿附件清理：覆盖"删消息"之外的所有路径（清空全部消息 / 裁剪历史 / 删频道）
  // —— 那些地方不会逐条通知附件，启动时扫一遍兜底
  const swept = sweepOrphanAttachments({ db, attachmentsDir: ATTACHMENTS_DIR });
  if (swept > 0) console.log(`🧹 启动清理孤儿附件 ${swept} 个`);

  // 审计日志裁剪：保留 ${audit.RETENTION_DAYS} 天 / 最多 ${audit.MAX_ROWS} 条
  audit.prune();
  const auditPruneTimer = setInterval(() => audit.prune(), 6 * 3600 * 1000);
  auditPruneTimer.unref();

  // ============================================================
  // AUTH_TOKEN 提示
  // ============================================================
  // 只在**首次自动生成**时打印明文，之后每次启动都不再复述完整 Token。
  //
  // 原因有两个：
  //   1. 每次启动都往容器日志里写完整密钥，等于让密钥长期留在
  //      docker logs / 日志驱动 / `docker compose logs` 里 —— 日志会被采集、
  //      转发、备份，密钥的暴露面比它需要的大得多。
  //   2. 没有信息增量：Token 来自环境变量时，用户在 .env 里本来就写着；
  //      来自数据库时，之后也不会变。真正需要"看一眼并抄下来"的只有
  //      首次生成那一次。
  const src = global.__AUTH_TOKEN_SOURCE__ || 'env';
  // 指纹用于日志里「和别的记录对上」，只取前 8 位。
  // cz. 格式的前 3 位固定是 `cz.`，白占 3 位信息量太少 —— 跳过前缀取 8 位，
  // 这样新旧两种格式都能露出 8 个真实随机字符。
  const rawAuth = String(AUTH_TOKEN);
  const fingerprint = (rawAuth.startsWith('cz.') ? rawAuth.slice(3) : rawAuth).slice(0, 8);

  console.log('');
  if (src === 'generated') {
    // 唯一需要完整打印的场景：这是用户能拿到它的唯一机会
    console.log('🔑 AUTH_TOKEN [本次启动自动生成]');
    console.log(`   ${AUTH_TOKEN}`);
    console.log('   ⚠️  请立即妥善保存，之后不会再打印完整值');
    console.log('   ⚠️  如需更换，请设置环境变量 AUTH_TOKEN=xxx 后重启');
    if (global.__FRESH_ADMIN__) {
      console.log('');
      console.log('   ⚠️  这次连的是全新数据目录（里面没有历史数据），所以 Token 和账号都是新的：');
      console.log(`       数据目录 = ${global.__DB_PATH__ || '(未知)'}`);
      console.log('       → 打开网页版按引导设置管理员账号即可，不需要抄这串 Token');
      console.log('       → 如果这不是你想要的，说明部署目录 / 挂载的数据卷和上次不一样');
    }
    console.log('');
    console.log('   💡 想让 Token 以后不随数据目录变：在 .env 里写死 AUTH_TOKEN=<固定值>');
  } else if (src === 'db') {
    console.log(`🔑 AUTH_TOKEN 就绪 [数据库（首次生成时已打印）] · 指纹 ${fingerprint}…`);
    console.log('   如需查看完整值，见网页版「安全与登录」或数据库 meta 表');
  } else {
    console.log(`🔑 AUTH_TOKEN 就绪 [环境变量] · 指纹 ${fingerprint}…`);
    console.log('   完整值见 .env 里的 AUTH_TOKEN');
  }
  console.log('──────── 就绪 ────────');
});

if (hasCerts()) {
  ensureHttps().catch(e => {
    console.error('启动时启用 HTTPS 失败:', e.message);
  });
}

// 优雅退出
//
// ⚠️ 必须防重入：`docker compose restart` 会先发 SIGTERM，超时没退干净再发 SIGKILL。
//    重复进入这里会二次 db.close()（better-sqlite3 对已关闭的库操作会抛错），
//    结果是错误日志把真正的退出信息盖掉。
let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) {
    console.log(`   （已在关闭中，忽略重复的 ${signal}）`);
    return;
  }
  shuttingDown = true;

  console.log('');
  console.log(`──────── 收到 ${signal}，正在关闭 ────────`);
  try { server.close(); } catch {}
  try { if (httpsServer) httpsServer.close(); } catch {}
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    console.log('✅ 数据库已关闭');
  } catch (e) {
    console.error('❌ 数据库关闭失败:', e.message);
  }

  // 给 stdout 一点冲刷时间再退。
  // process.exit() 会立刻终止进程，容器环境下日志走的是管道，
  // 极端情况下最后几行可能来不及写出去。
  setTimeout(() => process.exit(0), 50).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
