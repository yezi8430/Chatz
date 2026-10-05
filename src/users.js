const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const { hashPassword, verifyPassword } = require('./migrate');
const { resolveToken, extractToken, getAuthToken, requireSuper } = require('./auth');
const { generateDeviceToken } = require('./tokenGen');
const { rateLimit, rateLimitLogin } = require('./rateLimit');
const audit = require('./audit');
const ws = require('./ws');
const router = express.Router();

/**
 * 把「账号信息变了」推给该用户的所有在线连接
 *
 * 为什么需要：客户端改头像/昵称/用户名/邮箱后，网页那一端**不会自己知道** ——
 * 它只在 start() 里拉过一次 /auth/me，之后没有任何东西会重新拉。
 * 结果就是「客户端换完头像，网页得手动刷新才更新」。
 *
 * 只推「你该重拉了」这个信号，不推具体内容：
 * 接收端 re-fetch /auth/me 即可，省得两端各维护一份字段清单（漏一个就静默不同步）。
 * 用 broadcastToUser 而不是 broadcast —— 账号信息属于个人，不能广播给别人。
 */
function notifyUserUpdated(userId) {
  try {
    ws.broadcastToUser(userId, { event: 'userUpdated' });
  } catch (e) {
    // 推送失败不能影响接口本身的成功返回（账号确实已经改好了）
    console.error('[user] userUpdated 推送失败:', e.message);
  }
}

function rowToUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatar: row.avatar || null,
    email: row.email || null,
    isAdmin: !!row.is_admin,
    // role 可能为 NULL（迁移前建的老行），兜一下：
    //   老管理员（is_admin=1）按超级管理员算，其余按普通用户
    role: row.role != null ? row.role : (row.is_admin ? 2 : 0),
    isSuper: (row.role != null ? row.role : (row.is_admin ? 2 : 0)) >= 2,
    createdAt: row.created_at,
  };
}

/**
 * 库指纹：三个「正常使用中只增不减」的计数拼成的串
 *
 * 用途见 GET /auth/me 里的注释 —— 它是「换了库」判定的兜底依据，
 * 单靠 db_epoch 不足以覆盖「恢复了本纪元内的旧备份」这种情况。
 *
 * 为什么选这三个：
 *   - messages 的 AUTOINCREMENT 序列（sqlite_sequence）：删消息是软删，
 *     序列不回退；换回旧库序列必然更小
 *   - messages 总行数：软删的行仍在，所以它是单调的
 *   - message_reads 总行数：同上
 * 任何一项异常（表不存在等）都吞掉，返回 null —— 指纹只是**辅助**，
 * 拿不到就不参与判定，绝不能让 /auth/me 因此 500。
 */
function dbFingerprint() {
  try {
    const seq = db.prepare(
      "SELECT seq FROM sqlite_sequence WHERE name = 'messages'"
    ).get();
    const msgCount = db.prepare('SELECT COUNT(*) AS c FROM messages').get();
    const readCount = db.prepare('SELECT COUNT(*) AS c FROM message_reads').get();
    return `${seq ? seq.seq : 0}:${msgCount ? msgCount.c : 0}:${readCount ? readCount.c : 0}`;
  } catch (e) {
    return null;
  }
}

// 邮箱：选填，但填了必须合法、且不能和其它账号重复。
// 忘记密码靠它定位账号，所以没填邮箱的账号用不了「忘记密码」。
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return s || null;
}

// 重置链接的时效与一次性令牌
const RESET_TOKEN_TTL = 30 * 60 * 1000; // 30 分钟
const hashResetToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// 任何方式改过密码后，把这个用户还没用的重置链接全部作废
function invalidateResetTokens(userId) {
  db.prepare(
    'UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL'
  ).run(Date.now(), userId);
}

// 校验一枚重置令牌：不存在 / 已用 / 已过期 分别返回原因
function checkResetToken(token) {
  if (!token) return { ok: false, reason: 'invalid' };
  const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ?').get(hashResetToken(token));
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.used_at) return { ok: false, reason: 'used' };
  if (row.expires_at <= Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, row };
}

/**
 * 签发一枚设备 Token，带全局查重
 *
 * ⚠️ 为什么必须查重：tokenGen.js 里刻意不碰 db（会形成
 * `db → migrate → tokenGen → db` 循环依赖），所以查重只能放在调用点。
 *
 * 虽然 30 位 base62 的碰撞概率低到可以忽略（62^30 ≈ 6.2e53），
 * 但 devices.token 上有 UNIQUE 索引 —— 真撞上一次 INSERT 会直接抛异常，
 * 整个注册/登录请求 500。花一次 SELECT 把这个可能性彻底消掉，不亏。
 *
 * 这里用 devices 全表查重（而不是只查当前用户）：token 是全局唯一的，
 * 跨用户也不能重。
 *
 * @returns {string} `cz.` 开头的 33 字符设备 Token
 */
function newDeviceToken() {
  for (let i = 0; i < 10; i++) {
    const candidate = generateDeviceToken();
    const dup = db.prepare('SELECT 1 FROM devices WHERE token = ?').get(candidate);
    if (!dup) return candidate;
  }
  // 理论上到不了这里（概率 ≈ 1e-53 连撞 10 次）。真到了说明随机源出了问题，
  // 与其静默返回一个可能重复的值让 INSERT 抛错，不如明确失败。
  throw new Error('设备 Token 生成失败：连续 10 次碰撞');
}

function optionalAuth(req, res, next) {
  const token = extractToken(req);
  const identity = resolveToken(token);
  if (identity) {
    req.user = {
      id: identity.userId,
      username: identity.username,
      isAdmin: identity.isAdmin,
      isSuper: !!identity.isSuper,
      role: identity.role != null ? identity.role : (identity.isAdmin ? 1 : 0),
    };
    req.deviceId = identity.deviceId;
    req.isLegacyAuth = identity.isLegacyAuth;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录或登录已过期' });
  next();
}

router.use(optionalAuth);

// ============================================================
// 注册（公开，限速：每 IP 每小时 3 次）
// ============================================================
router.post('/auth/register',
  rateLimit({ windowMs: 3600000, max: 3, name: 'register', message: '注册过于频繁，请稍后再试' }),
  (req, res) => {
    const { username, password, displayName } = req.body || {};
    const email = normalizeEmail(req.body && req.body.email);
    const ip = audit.getIp(req);

    // 先做类型检查再看长度：body 是任意 JSON，username/password 可能是数字、
    // 对象或数组。直接 .length 在数字上是 undefined（比较为 false，静默放行），
    // 在对象上取不到，在后面当 SQL 参数用就会变成 "[object Object]" 落库。
    // 所以统一先卡 typeof，再谈长度和格式。
    if (!username || !password) {
      audit.log({ ip, action: 'register', target: username || null, success: false, meta: { reason: '缺少字段' } });
      return res.status(400).json({ error: '请填写用户名和密码' });
    }
    if (typeof username !== 'string' || username.length < 2 || username.length > 32) {
      return res.status(400).json({ error: '用户名长度需要 2-32 个字符' });
    }
    if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
      return res.status(400).json({ error: '密码长度需要 6-128 位' });
    }
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(username)) {
      return res.status(400).json({ error: '用户名只能包含字母、数字和 _ - .' });
    }
    if (email && !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      audit.log({ ip, action: 'register', target: username, success: false, meta: { reason: '用户名已存在' } });
      return res.status(409).json({ error: '用户名已存在' });
    }
    if (email && db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
      return res.status(409).json({ error: '邮箱已被占用' });
    }

    // 只有库里**一个用户都没有**时，才把注册者设成超级管理员。
    // 实际几乎不会触发 —— migrate 启动时已经建好 admin 了（这条基本是死代码），
    // 保留是为了「手动清空 users 表后重新初始化」这种极端场景仍能自举。
    const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const isAdmin = userCount === 0 ? 1 : 0;
    const role = userCount === 0 ? 2 : 0;

    const now = Date.now();
    const hash = hashPassword(password);
    const info = db.prepare(
      'INSERT INTO users (username, password_hash, display_name, email, is_admin, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(username, hash, displayName || username, email, isAdmin, role, now);

    const userId = info.lastInsertRowid;

    // 刻意不自动订阅任何公开频道：订阅统一由用户显式操作
    // （「发现频道」里点订阅），避免新账号一注册抽屉里就塞满别人建的频道。
    // 唯一的例外是 migrate.js 给首个管理员订阅默认频道，那是老数据归属需要。

    const token = newDeviceToken();
    db.prepare(
      'INSERT INTO devices (user_id, name, token, created_at) VALUES (?, ?, ?, ?)'
    ).run(userId, 'Web', token, now);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

    audit.log({ userId, ip, action: 'register', target: username, success: true, meta: { isAdmin: !!isAdmin } });

    res.json({ user: rowToUser(user), token });
  }
);

// ============================================================
// 首次引导（全新安装的 Web 初始化）
// ============================================================
// 全新安装时 admin 的密码就是那串随机 AUTH_TOKEN，用户只能去 docker logs 里捞 ——
// 这是整个安装流程里最劝退的一步。这里给一条不用碰命令行的路：
//   打开网页 → 自己设管理员账号 → 直接进应用
//
// 触发条件是 migrate.js 新建 admin 时写下的 meta.setup_completed = '0'；
// 存量部署在迁移里会被补成 '1'，所以老实例升级后不会被莫名弹到引导页。

function readSetupFlag() {
  return db.prepare("SELECT value FROM meta WHERE key = 'setup_completed'").get();
}

function markSetupCompleted() {
  // 每次登录都会走到这儿，先查再写，避免无意义的重复写入
  const flag = readSetupFlag();
  if (flag && flag.value === '1') return;
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('setup_completed', '1')").run();
}

// 必须公开：引导页出现在登录之前，那一刻手里没有任何凭据。
// 只回一个"要不要显示引导页"的布尔值，不泄露实例内部的任何信息。
router.get('/setup/status', (req, res) => {
  const flag = readSetupFlag();
  res.json({ needsSetup: !flag || flag.value !== '1' });
});

router.post('/setup',
  rateLimit({ windowMs: 3600000, max: 20, name: 'setup', message: '操作过于频繁，请稍后再试' }),
  (req, res) => {
    const flag = readSetupFlag();
    if (flag && flag.value === '1') {
      return res.status(403).json({ error: '初始化已完成，不能重复设置' });
    }

    const admin = db.prepare('SELECT * FROM users WHERE is_admin = 1 ORDER BY id ASC LIMIT 1').get();
    if (!admin) return res.status(500).json({ error: '找不到管理员账号' });

    const { username, password, displayName } = req.body || {};
    const email = normalizeEmail(req.body && req.body.email);

    if (typeof username !== 'string' || !/^[a-zA-Z0-9_\-\.]{2,32}$/.test(username)) {
      return res.status(400).json({ error: '用户名长度需要 2-32 个字符，只能用字母、数字、_ - .' });
    }
    // 密码策略与普通注册保持一致（6 位起）——
    // 管理员账号的价值在权限，不在密码复杂度；6 位是用户自己定的下限，
    // 两个入口不一致只会让人困惑（同一个人在两个页面看到两套规则）。
    if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
      return res.status(400).json({ error: '密码长度需要 6-128 位' });
    }
    if (email && !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }

    const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, admin.id);
    if (clash) return res.status(409).json({ error: '用户名已被占用' });
    if (email && db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, admin.id)) {
      return res.status(409).json({ error: '邮箱已被占用' });
    }

    // 接管 migrate 预置的那个 admin，而不是新建一个 —— 避免实例里冒出两个管理员，
    // 也保住它已经持有的默认频道订阅关系
    db.prepare('UPDATE users SET username = ?, display_name = ?, password_hash = ?, email = ? WHERE id = ?')
      .run(username, displayName || username, hashPassword(password), email, admin.id);

    markSetupCompleted();

    // 签发一枚设备 token，让引导页可以直接进应用，不用再登录一次
    const token = newDeviceToken();
    const now = Date.now();
    db.prepare(
      'INSERT INTO devices (user_id, name, token, created_at) VALUES (?, ?, ?, ?)'
    ).run(admin.id, 'Web', token, now);

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(admin.id);

    audit.fromReq(req, { action: 'setup.complete', target: String(admin.id), meta: { username } });

    res.json({ user: rowToUser(updated), token });
  }
);

// ============================================================
// 忘记密码 / 重置（公开）
// ============================================================
// 流程：用户在登录页点「忘记密码」→ 填邮箱 → POST /auth/forgot-password
// → 服务端生成一枚带时效、一次性令牌 → 把重置链接打印到容器日志
// （没接 SMTP 时的做法；管理员去 docker compose logs 里看）→
// 用户打开链接 → 前端读 ?token= → POST /auth/reset-password 设新密码。
//
// 令牌只存 sha256 哈希、不存原文；30 分钟过期；用过一次即失效；
// 任何方式改过密码都会把该用户还没用的重置链接全部作废。
const RESET_LINK_PATH = '/reset-password';

router.post('/auth/forgot-password',
  rateLimit({ windowMs: 3600000, max: 10, name: 'forgot-pw', message: '操作过于频繁，请稍后再试' }),
  (req, res) => {
    const email = normalizeEmail(req.body && req.body.email);
    const ip = audit.getIp(req);

    // 不管邮箱是否存在，都回同一句 —— 不泄露「哪些邮箱注册过」
    const reply = { ok: true, message: '如果该邮箱已注册，重置链接已写入服务日志，请管理员查看 docker compose logs' };

    if (!email || !EMAIL_RE.test(email)) {
      return res.status(200).json(reply);
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      audit.log({ ip, action: 'auth.forgot_password', target: email, success: false, meta: { reason: '邮箱未注册' } });
      return res.status(200).json(reply);
    }

    const token = crypto.randomBytes(32).toString('hex');
    db.prepare(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)'
    ).run(user.id, hashResetToken(token), Date.now() + RESET_TOKEN_TTL, Date.now());

    // 没有接 SMTP —— 把重置链接打印到日志。管理员用 `docker compose logs chatz` 看。
    // 链接的 host/scheme 取自当前请求（走反代时是公网域名 + https，直连时是内网 IP）。
    const host = req.get('host') || 'localhost';
    const scheme = (req.protocol === 'https') ? 'https' : 'http';
    const link = `${scheme}://${host}${RESET_LINK_PATH}?token=${token}`;

    console.log('');
    console.log('📧 密码重置请求');
    console.log(`   用户: ${user.username} <${email}>`);
    console.log(`   链接: ${link}`);
    console.log(`   有效期: ${RESET_TOKEN_TTL / 60000} 分钟（一次性，用一次即失效）`);
    console.log('');

    audit.log({ userId: user.id, ip, action: 'auth.forgot_password', target: email, success: true });

    res.status(200).json(reply);
  }
);

// 前端打开重置页时先问一下这枚令牌还能不能用，好决定显示表单还是「已失效」
router.get('/auth/reset-password/validate', (req, res) => {
  const token = req.query && req.query.token ? String(req.query.token) : '';
  const chk = checkResetToken(token);
  res.json({ valid: chk.ok, reason: chk.ok ? null : chk.reason });
});

router.post('/auth/reset-password',
  rateLimit({ windowMs: 600000, max: 20, name: 'reset-pw', message: '操作过于频繁，请稍后再试' }),
  (req, res) => {
    const { token, password } = req.body || {};
    const chk = checkResetToken(token);
    if (!chk.ok) {
      const reason = {
        invalid: '链接无效或已被使用',
        used: '链接已被使用过，不能再用',
        expired: '链接已过期，请重新申请',
      }[chk.reason] || '链接无效';
      return res.status(400).json({ error: reason });
    }

    if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
      return res.status(400).json({ error: '密码长度需要 6-128 位' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(chk.row.user_id);
    if (!user) return res.status(400).json({ error: '链接无效' });

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
    invalidateResetTokens(user.id);

    audit.log({ userId: user.id, action: 'auth.reset_password', target: String(user.id), success: true });

    res.json({ ok: true });
  }
);

// ============================================================
// 登录（公开，限速：每 IP 每 10 分钟 5 次）
// ============================================================
router.post('/auth/login',
  ...rateLimitLogin(),
  (req, res) => {
    const { username, password, deviceName } = req.body || {};
    const ip = audit.getIp(req);

    // 和 /auth/register 同样的道理：body 是任意 JSON。
    // 这里比注册更关键 —— 不加类型检查的话，传数字/对象会走到下面的
    // crypto.scryptSync(password, ...) 直接抛 TypeError，接口回 500 而不是 401，
    // 顺带把「用户名不存在」和「密码错误」的区别也暴露了。
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return res.status(400).json({ error: '请填写用户名和密码' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      audit.log({ ip, action: 'login', target: username, success: false, meta: { reason: '用户不存在' } });
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    if (!verifyPassword(password, user.password_hash)) {
      audit.log({ userId: user.id, ip, action: 'login', target: username, success: false, meta: { reason: '密码错误' } });
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const now = Date.now();
    // 一个用户 = 一枚登录 token（永久复用），只有手动「添加设备」才会多出来。
    //
    // ⚠️ 以前每次登录都 INSERT 一枚新的，网页端 deviceName 恒为 'Web'，
    //    于是无痕模式 / 清过 localStorage 的浏览器每登录一次就多一枚「Web」设备。
    //
    // ⚠️ 更早以前给管理员直接复用全局 AUTH_TOKEN（主密钥）：主密钥在 devices 表里
    //    是「默认 Token」行、绑定的是**第一个管理员**，第二个管理员登录后拿到它
    //    → 身份变成第一个人（还白拿超管权限）。就是「bob 提管理员后登录变 yezi」。
    //
    // 现在：取该用户**第一枚** token（按 id 最小），有就复用、只更新 last_seen，
    // 没有才新发。刻意**排除主密钥**：它属于「默认 Token」行，身份语义是不同的东西。
    const masterToken = getAuthToken();
    const existing = db.prepare(
      'SELECT token FROM devices WHERE user_id = ? AND token != ? ORDER BY id ASC LIMIT 1'
    ).get(user.id, masterToken);

    const devName = deviceName || 'Web';
    const token = existing ? existing.token : newDeviceToken();
    if (existing) {
      db.prepare('UPDATE devices SET last_seen = ? WHERE token = ?').run(now, existing.token);
    } else {
      db.prepare(
        'INSERT INTO devices (user_id, name, token, last_seen, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(user.id, devName, token, now, now);
    }

    audit.log({ userId: user.id, ip, action: 'login', target: username, success: true });

    // 能用真实凭据登录进来，就说明这个实例已经有人在管了 —— 别再弹首次引导
    markSetupCompleted();

    res.json({ user: rowToUser(user), token });
  }
);

// ============================================================
// 当前用户
// ============================================================
router.get('/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({
    ...rowToUser(user),
    // ── 库身份（给客户端识别「换了库」用） ──
    //
    // 客户端把「删除对账水位线」按 serverId 存在本地；一旦服务端 ./data
    // 被换成更旧的备份，水位线就会永久悬在墓碑之上，删除对账彻底失效。
    // 客户端拿这两个字段做一次相等比较即可判断要不要归零水位线：
    //
    //   dbEpoch —— 库纪元串（migrate 生成，换库重装必然不同）
    //   dbMark  —— 库指纹（见下），用于兜底：万一恢复出来的备份里
    //              db_epoch 恰好和当前一致（比如备份是在本次纪元生成之后做的，
    //              但恢复回去后数据又回退了），单靠纪元串判不出来。
    //
    // 指纹取「不受软删除影响」的单调量：
    //   - messages 的自增序列（sqlite_sequence）：删除**不会**让它回退
    //   - messages 总行数（含已软删的）
    //   - message_reads 总行数
    // 指纹取「不受软删除影响」的单调量（实现见 dbFingerprint）：
    //   - messages 的自增序列（sqlite_sequence）：删除**不会**让它回退
    //   - messages 总行数（含已软删的）
    //   - message_reads 总行数
    // 恢复旧库会让序列或行数变小 ⇒ 指纹变化 ⇒ 客户端归零水位线。
    // 反过来，正常使用中这三个数只会单调增，**不会**误判成换库。
    dbEpoch: global.__DB_EPOCH__ || null,
    dbMark: dbFingerprint(),
  });
});

// ============================================================
// 登出
// ============================================================
// 语义：登出 = 删掉「当前会话用的那枚凭据」。
//
// 但对管理员有个特例：管理员登录复用的就是全局 AUTH_TOKEN
// （devices 表里那行叫「默认 Token」），而 AUTH_TOKEN 又是
// 主密钥 —— 删掉它本身没有任何意义：
//
//   1) AUTH_TOKEN 走的是 auth.js 的兜底分支，devices 里那行没了照样能用；
//   2) 一旦它不在 devices 表里，设备列表就看不到「当前」标记，
//      下次用密码登录又会把它补回来 —— 删了等于没删，纯噪音；
//   3) 而且它本来就不是「一台设备」的凭据，删它并不能让任何设备下线。
//
// 所以：管理员登出只结束前端会话，不动「默认 Token」行。
// 真要作废这枚主密钥，唯一办法是换掉 .env / meta 里的 AUTH_TOKEN。
router.post('/auth/logout', requireAuth, (req, res) => {
  if (!req.deviceId) {
    // 走兜底路径（legacy Bearer），本来就没有设备行可删
    return res.json({ ok: true });
  }

  const row = db.prepare('SELECT id, token FROM devices WHERE id = ? AND user_id = ?')
    .get(req.deviceId, req.user.id);

  if (row && row.token === getAuthToken()) {
    // 当前行就是主密钥（默认 Token）：只记录，不删除
    audit.fromReq(req, {
      action: 'logout',
      target: String(req.deviceId),
      meta: { keptDefaultToken: true },
    });
    return res.json({ ok: true, keptDefaultToken: true });
  }

  // ⚠️ 登出**不再删除**这行设备凭据。
  //
  // 语义：一个用户 = 一枚登录 token（登录时按 user_id 复用，见上面的登录分支），
  // 登出只结束前端会话，凭据本身留着，下次登录还是同一枚。
  //
  // 以前登出会 DELETE 掉这行，于是「登录 → 登出 → 再登录」每次都查不到 existing、
  // 只能新发一枚，设备列表里越攒越多「Web」—— 用户明确不要这个行为。
  //
  // 真要作废某枚凭据，有三条路（都比"登出即销毁"更明确）：
  //   · 设备列表里点删除
  //   · 点 ⟳（POST /device/rotate）更换，旧值立即失效
  //   · 改密码（会踢掉该用户的设备）
  db.prepare('UPDATE devices SET last_seen = ? WHERE id = ? AND user_id = ?')
    .run(Date.now(), req.deviceId, req.user.id);
  audit.fromReq(req, {
    action: 'logout',
    target: String(req.deviceId),
    meta: { keptToken: true },
  });
  res.json({ ok: true, keptToken: true });
});

// ============================================================
// 设备列表
// ============================================================
router.get('/device', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT id, name, token, last_seen, created_at FROM devices WHERE user_id = ? ORDER BY id ASC'
  ).all(req.user.id);

  const masterToken = getAuthToken();

  res.json(rows.map(r => ({
    id: r.id,
    name: r.name,
    token: r.token,
    isCurrent: r.id === req.deviceId,
    // 主密钥行（管理员登录复用的那枚全局 token）：
    // 前端据此把它显示成「主密钥」而不是「可注销的设备」——
    // 因为它删不掉（服务端会拦），也不该删。
    isMaster: r.token === masterToken,
    lastSeen: r.last_seen,
    createdAt: r.created_at,
  })));
});

// ⚠️ 每调一次就签发一枚新的长期 token，之前完全没限流 ⇒ 能刷出一堆长期凭据
router.post('/device',
  requireAuth,
  rateLimit({ windowMs: 3600000, max: 20, name: 'device_create', message: '新建设备过于频繁，请稍后再试' }),
  (req, res) => {
  const { name } = req.body || {};
  const now = Date.now();
  const token = newDeviceToken();

  const info = db.prepare(
    'INSERT INTO devices (user_id, name, token, created_at) VALUES (?, ?, ?, ?)'
  ).run(req.user.id, name || '新设备', token, now);

  // 新建设备 = 签发一枚新的长期 token，等于"放行一台新设备"
  audit.fromReq(req, {
    action: 'device.create',
    target: String(info.lastInsertRowid),
    meta: { name: name || '新设备' },
  });

  res.json({ id: info.lastInsertRowid, name: name || '新设备', token, createdAt: now });
});

router.delete('/device/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });
  if (id === req.deviceId) {
    return res.status(400).json({ error: '不能删除正在使用的设备' });
  }

  // 主密钥行也删不得：删了 AUTH_TOKEN 照样有效（走兜底），而且下次登录又补回来。
  // 前端已经把这一行的按钮置灰，这里再拦一道，防止直接调接口把它点掉。
  const target = db.prepare(
    'SELECT id, token FROM devices WHERE id = ? AND user_id = ?'
  ).get(id, req.user.id);
  if (!target) return res.status(404).json({ error: '设备不存在' });
  if (target.token === getAuthToken()) {
    return res.status(400).json({ error: '这是主密钥，无法删除（要更换请在 .env 里修改 AUTH_TOKEN）' });
  }

  const result = db.prepare(
    'DELETE FROM devices WHERE id = ? AND user_id = ?'
  ).run(id, req.user.id);

  if (result.changes === 0) return res.status(404).json({ error: '设备不存在' });

  // 删设备 = 吊销一枚长期 token
  audit.fromReq(req, { action: 'device.delete', target: String(id) });
  res.json({ ok: true });
});

// 更换**当前正在用的**这枚 token（旧值立即失效）
//
// 定成「一个用户 = 一枚登录 token」之后，光靠 DELETE /device/:id 换不掉在用的那枚 ——
// 那条路径明确拒绝删当前设备（`id === req.deviceId`）。所以单独给一个 rotate：
//   旧 token 立刻作废 → 返回新 token，当前会话换完继续用，不用重新登录。
//
// ⚠️ 副作用：别的设备若也用着这枚 token（本来就是共享的），会一起被踢下线，
//    重新登录即可拿到新的那枚。
router.post('/device/rotate',
  requireAuth,
  rateLimit({ windowMs: 3600000, max: 20, name: 'device_rotate', message: '更换过于频繁，请稍后再试' }),
  (req, res) => {
  // 用主密钥（/ legacy Token）登录时 deviceId 为 null，那枚不在这里换
  if (!req.deviceId) {
    return res.status(400).json({ error: '主密钥不能在这里更换（要换请改 .env 的 AUTH_TOKEN）' });
  }

  const row = db.prepare('SELECT id, token FROM devices WHERE id = ?').get(req.deviceId);
  if (!row) return res.status(404).json({ error: '设备不存在' });
  if (row.token === getAuthToken()) {
    return res.status(400).json({ error: '主密钥不能在这里更换（要换请改 .env 的 AUTH_TOKEN）' });
  }

  const token = newDeviceToken();
  db.prepare('UPDATE devices SET token = ?, last_seen = ? WHERE id = ?')
    .run(token, Date.now(), req.deviceId);

  // 换 token = 吊销旧凭据 + 签发新凭据，属于敏感操作
  audit.fromReq(req, { action: 'device.rotate', target: String(req.deviceId) });
  res.json({ ok: true, token });
});

// ============================================================
// 用户头像
// ============================================================
const fs = require('fs');
const path = require('path');
const { detectImageExt } = require('./sanitize');

const DATA_DIR = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : './data';
const AVATARS_DIR = path.join(DATA_DIR, 'user-avatars');
fs.mkdirSync(AVATARS_DIR, { recursive: true });

router.post('/user/avatar',
  requireAuth,
  (req, res) => {
    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: '请求内容为空' });
    }
    const ext = detectImageExt(req.body);
    if (!ext || ext === 'svg') {
      return res.status(400).json({ error: '图片格式不支持（仅 png/jpg/gif/webp）' });
    }

    // 删旧头像
    const cur = db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.user.id);
    if (cur && cur.avatar && cur.avatar.startsWith('/user-avatars/')) {
      try { fs.unlinkSync(path.join(AVATARS_DIR, path.basename(cur.avatar))); } catch {}
    }

    const filename = `user-${req.user.id}-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(AVATARS_DIR, filename), req.body);
    const avatarUrl = '/user-avatars/' + filename;
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.user.id);

    audit.fromReq(req, { action: 'user.avatar.upload', target: filename });
    notifyUserUpdated(req.user.id);
    res.json({ ok: true, avatar: avatarUrl });
  }
);

router.delete('/user/avatar', requireAuth, (req, res) => {
  const cur = db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.user.id);
  if (cur && cur.avatar && cur.avatar.startsWith('/user-avatars/')) {
    try { fs.unlinkSync(path.join(AVATARS_DIR, path.basename(cur.avatar))); } catch {}
  }
  db.prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(req.user.id);
  audit.fromReq(req, { action: 'user.avatar.delete', target: cur ? cur.avatar : null });
  notifyUserUpdated(req.user.id);
  res.json({ ok: true });
});

// ============================================================
// 修改昵称
// ============================================================
router.patch('/user/profile', requireAuth, (req, res) => {
  const { displayName } = req.body || {};

  if (displayName === undefined) {
    return res.status(400).json({ error: '缺少 displayName' });
  }

  const name = String(displayName).trim();
  if (name.length === 0) {
    return res.status(400).json({ error: '昵称不能为空' });
  }
  if (name.length > 32) {
    return res.status(400).json({ error: '昵称最长 32 字符' });
  }

  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, req.user.id);

  audit.fromReq(req, { action: 'user.profile.update', meta: { displayName: name } });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  notifyUserUpdated(req.user.id);
  res.json({ ok: true, user: rowToUser(user) });
});

// ============================================================
// 修改邮箱
// ============================================================
// 一个邮箱最多对应一个账号（全局唯一）；可以为空 —— 没邮箱就用不了「忘记密码」。
router.patch('/user/email', requireAuth, (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);

  if (email && !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }
  if (email) {
    const clash = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.user.id);
    if (clash) return res.status(409).json({ error: '邮箱已被占用' });
  }

  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.user.id);
  audit.fromReq(req, { action: 'user.email_change', meta: { email } });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  notifyUserUpdated(req.user.id);
  res.json({ ok: true, user: rowToUser(user) });
});

// ============================================================
// 修改用户名
// ============================================================
// 用户名全局唯一（migrate 里的 `username TEXT NOT NULL UNIQUE` 是最后一道兜底）。
// 校验规则与注册保持完全一致，避免出现「注册不允许、改名却允许」这种不一致：
//   2-32 位，仅允许 a-z A-Z 0-9 _ - .
//
// 改名不会影响权限：权限来自 users.is_admin 标志位，所有鉴权都按 id/标志位走，
// 代码里没有任何地方拿 user.username === 'admin' 做判断（migrate.js 也改成按
// is_admin 找管理员了）。所以 admin 改成 yezi 之后，一切照旧。
//
// 改名也不会影响登录态：设备 Token 绑的是 user_id，第 23 行的查询是
// `JOIN users` 取当前 username，所以改完名字后旧 Token 依然有效、显示的是新名字。
router.patch('/user/username',
  requireAuth,
  rateLimit({ windowMs: 600000, max: 10, name: 'username', message: '操作过于频繁，请稍后再试' }),
  (req, res) => {
    const raw = req.body && req.body.username;

    // 先卡类型：body 是任意 JSON，直接 .length 在数字上是 undefined（静默放行）
    if (typeof raw !== 'string') {
      return res.status(400).json({ error: '用户名必须是字符串' });
    }

    const username = raw.trim();

    if (username.length < 2 || username.length > 32) {
      return res.status(400).json({ error: '用户名长度需要 2-32 个字符' });
    }
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(username)) {
      return res.status(400).json({ error: '用户名只能包含字母、数字和 _ - .' });
    }

    // 没改（含大小写完全相同）直接当成功返回，不用碰数据库 ——
    // 否则下面那条唯一性检查会命中自己，回一个莫名其妙的 409。
    const current = db.prepare('SELECT username FROM users WHERE id = ?').get(req.user.id);
    if (current && current.username === username) {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      return res.json({ ok: true, user: rowToUser(user) });
    }

    // ⚠️ 检索重名：必须排除自己（`AND id != ?`），否则改回原名会被自己挡住
    const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?')
      .get(username, req.user.id);
    if (clash) {
      audit.fromReq(req, {
        action: 'user.username_change',
        success: false,
        meta: { reason: '用户名已被占用', username },
      });
      return res.status(409).json({ error: '用户名已被占用' });
    }

    // 兜底：万一并发请求绕过了上面的检查，UNIQUE 约束会在这里抛错。
    // 捕获后同样回 409，而不是让 500 漏出去。
    try {
      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, req.user.id);
    } catch (err) {
      if (String(err.message || '').includes('UNIQUE')) {
        return res.status(409).json({ error: '用户名已被占用' });
      }
      throw err;
    }

    audit.fromReq(req, {
      action: 'user.username_change',
      target: String(req.user.id),
      meta: { before: current && current.username, after: username },
    });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    notifyUserUpdated(req.user.id);
    res.json({ ok: true, user: rowToUser(user) });
  }
);

// ============================================================
// 修改密码（限速：每 IP 每 10 分钟 10 次）
// ============================================================
// 一条接口覆盖两种场景，规则刻意不对称：
//
//   改自己的密码 → 已登录即已通过身份验证，**不再要求确认旧密码**；
//     默认**保留**已登录设备（手机端不会因为改密码被踢下线，
//     这是大多数人预期的行为；真怀疑泄露了就传 revokeDevices=true）
//
//   管理员重置他人 → 默认**吊销对方全部设备**
//     （密码能被别人重置，说明账号已经不安全了，留着旧 token 没意义）
//
// 注意：改自己的密码不再校验旧密码，等于「拿到一枚设备 Token 就能改密码」——
// 所以设备 Token 的保管比密码更重要（设备列表里看到的每一枚 Token 都等同登录态）。
router.patch('/user/password',
  requireAuth,
  rateLimit({ windowMs: 600000, max: 10, name: 'password', message: '操作过于频繁，请稍后再试' }),
  (req, res) => {
    const { new_password, userId, revokeDevices } = req.body || {};

    const targetId = userId === undefined || userId === null || userId === ''
      ? req.user.id
      : parseInt(userId, 10);

    if (!targetId) return res.status(400).json({ error: '无效的 userId' });

    const isSelf = targetId === req.user.id;
    // 改别人的密码 = 动别人的账号，只有超级管理员能做
    if (!isSelf && !req.user.isSuper) {
      audit.fromReq(req, { action: 'user.password_change', target: String(targetId), success: false, meta: { reason: '非超级管理员' } });
      return res.status(403).json({ error: '需要超级管理员权限' });
    }

    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!target) return res.status(404).json({ error: '用户不存在' });

    if (typeof new_password !== 'string' || new_password.length < 6 || new_password.length > 128) {
      return res.status(400).json({ error: '密码长度需要 6-128 位' });
    }

    // 已登录 = 已通过身份验证，所以不再要求确认旧密码。
    // 唯一要挡的：新密码和当前一样 —— 等于没改，还会让人误以为改成功了。
    if (target.password_hash && verifyPassword(new_password, target.password_hash)) {
      return res.status(400).json({ error: '新密码不能和当前密码相同' });
    }

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(new_password), targetId);
    // 改过密码，把这个用户还没用的重置链接一并作废
    invalidateResetTokens(targetId);

    // 保留当前会话（改自己的密码且能识别到设备时），其余按规则清掉。
    //
    // ⚠️ 主密钥行（token === AUTH_TOKEN）永远不删：
    //   - 它不是「一台设备」的凭据，删掉不会让任何设备下线；
    //   - AUTH_TOKEN 走 auth.js 的兜底分支，行删了照样有效 —— 删了纯属噪音；
    //   - 而且下次密码登录又会被补回来。
    // 所以无论哪条分支，都额外排除掉这一行。
    const keepCurrent = isSelf && req.deviceId;
    const shouldRevoke = !isSelf || revokeDevices === true;

    let revokedCount = 0;
    if (shouldRevoke) {
      const keepIds = [getAuthToken()];
      if (keepCurrent) keepIds.push(req.deviceId);
      // 用 NOT IN 一次排除「主密钥」和「当前设备」两枚 token
      const placeholders = keepIds.map(() => '?').join(', ');
      revokedCount = db.prepare(
        `DELETE FROM devices WHERE user_id = ? AND token NOT IN (${placeholders})`
      ).run(targetId, ...keepIds).changes;
    }

    audit.fromReq(req, {
      action: 'user.password_change',
      target: String(targetId),
      meta: { self: isSelf, revokedDevices: revokedCount },
    });

    // 密码属于"账号信息"但不体现在界面上，推送的实际意义是让被改者知道
    // 「你的登录态可能已经变了」（管理员重置他人时 device 全被吊销）。
    // 客户端的 userUpdated 处理器不会去改密码框，所以推了也无害。
    notifyUserUpdated(targetId);

    res.json({ ok: true, revokedDevices: revokedCount });
  }
);

// ============================================================
// 用户角色管理（仅超级管理员）
// ============================================================
//
// 角色：0 普通用户 / 1 管理员 / 2 超级管理员
//   管理员：只能管应用和路由规则，**看不到**未订阅的私有频道
//   超级管理员：全知 + 管证书/审计/频道 + 提升他人
//
// ⚠️ `is_admin` 列同步维护成 `role >= 1`，见 migrate.js 的说明。

// GET /user/list — 用户列表
router.get('/user/list', requireSuper, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM users ORDER BY id ASC'
  ).all();
  res.json(rows.map(rowToUser));
});

// PATCH /user/:id/role — 提升 / 降级
router.patch('/user/:id/role', requireSuper, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: '无效的 ID' });

  const role = parseInt((req.body || {}).role, 10);
  if (role !== 0 && role !== 1 && role !== 2) {
    return res.status(400).json({ error: 'role 只能是 0（普通用户）/ 1（管理员）/ 2（超级管理员）' });
  }

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: '用户不存在' });

  // 保护 1：不能改自己的角色 —— 否则一次手滑就把自己降下去，再也升不回来
  if (id === req.user.id) {
    return res.status(400).json({ error: '不能修改自己的角色（换个超级管理员账号操作）' });
  }

  // 保护 2：系统里至少要留一个超级管理员
  const oldRole = target.role != null ? target.role : (target.is_admin ? 2 : 0);
  if (oldRole >= 2 && role < 2) {
    const superCount = db.prepare('SELECT COUNT(*) AS c FROM users WHERE role >= 2 OR is_admin = 1').get().c;
    if (superCount <= 1) {
      return res.status(400).json({ error: '至少要保留一个超级管理员' });
    }
  }

  db.prepare('UPDATE users SET role = ?, is_admin = ? WHERE id = ?')
    .run(role, role >= 1 ? 1 : 0, id);

  // 角色一变，他已在线的连接必须刷新：isSuper 和 subscribedChannels 都是
  // 连接时算一次的快照，不刷的话降级了照样全收、升级了照样收不到
  ws.refreshUserIdentity(id);

  // 让他自己的其它设备也知道（重新拉 /auth/me）
  notifyUserUpdated(id);

  audit.fromReq(req, {
    action: 'user.role_change',
    target: String(id),
    meta: { username: target.username, from: oldRole, to: role },
  });

  res.json(rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
});

module.exports = router;
