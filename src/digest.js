// 每日摘要（digest）
//
// 每个用户在设定时间收到一条「过去 24 小时消息汇总」，用来补看不想被实时
// 打扰、但又不想漏掉的消息。
//
// ── 为什么摘要消息要落在「每人一个私有频道」里 ──
// 消息可见性是按**频道订阅**算的：默认频道（id=1）人人订阅，摘要发那儿，
// A 的未读列表就暴露给所有订阅者了。所以每人一个私有频道，只有本人能读，
// 顺带把未读数 / WS 广播 / 通知 / 网页与客户端显示全链路都复用起来。
//
//   频道和容器 id 都存在 user_digest_channels 表里（**服务端自有**，
//   不放 users.settings —— 那是用户可写的 JSON，放进去等于让客户端
//   能把摘要指到别人的私有频道）。
//
// ── 懒创建 / 开显关隐 ──
//   开启摘要时才建频道和应用；关闭开关只是不再生成 + 客户端不显示入口，
//   频道和历史都留着（重开就能回看）。
//
// ── 时间与补发 ──
//   time 按**用户自己选的时区**（digest.tz，默认 Asia/Shanghai）解释。
//   时刻和「今天」都按那个时区算：服务器跑在 UTC 上，用户设 08:00 就是他
//   手表上的 08:00；日期键也必须跟着走，否则「他那边已过 8 点、服务器这边
//   还是前一天」会导致当天漏发。
//   每分钟扫一遍，规则只有一条：**已过今天的设定时间且今天还没发过 → 发**。
//   这样「定时器错过那一分钟」「服务端重启」「宕机一整天」全都自动补上，
//   不需要单独的补发逻辑。代价是重启后已过时间点会立刻补一份 —— 这是有意的
//   （用户能立刻确认功能生效），文档里写清楚。
//
// ── 空摘要不发 ──
//   24 小时内一条可摘要的消息都没有（比如没订阅任何频道）→ 什么都不发，
//   别每天推一条「今天没有消息」的噪音。
const db = require('./db');
const crypto = require('crypto');
const { createMessage } = require('./messageCreate');
const { refreshUserChannels } = require('./ws');
const i18n = require('./serverI18n');
// 纯逻辑（默认值 / 设置合并 / 渲染）在零依赖的 digestCore.js 里，
// 离线 verify 脚本要能 require 它，见那个文件的说明。
const { DEFAULT_DIGEST, digestSettingsOf, zoneNow } = require('./digestCore');

const CHANNEL_NAME = '每日摘要';
const CHANNEL_DESC = '每天的消息汇总，由系统自动生成（关闭摘要后这里的历史仍会保留）';
const APP_NAME = '每日摘要';
const APP_DESC = '每日摘要的署名应用，由系统自动创建';

/** 汇总窗口：过去 24 小时（到设定时刻为止） */
const WINDOW_MS = 24 * 3600 * 1000;

/** 定时粒度。1 分钟足够（time 只到分钟），也别更快 —— 每分钟全表扫一遍用户就够吵了 */
const TICK_MS = 60 * 1000;

// ============================================================
// 懒创建：容器频道 + 署名应用
// ============================================================

function digestChannelId(userId) {
  const row = db.prepare('SELECT channel_id FROM user_digest_channels WHERE user_id = ?').get(userId);
  return row ? row.channel_id : null;
}

/**
 * 拿到（没有就建）该用户的摘要容器频道
 *
 * 频道 + 订阅 + 映射必须在**同一个事务**里：三步中间挂了会留下一个
 * 没人订阅的孤儿频道 —— 用户在 /admin 里看得见，自己反而进不去也删不掉。
 */
function ensureDigestChannel(userId) {
  const existing = digestChannelId(userId);
  if (existing) return existing;

  const now = Date.now();
  const channelId = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO channels (name, description, is_public, creator_id, created_at)
      VALUES (?, ?, 0, ?, ?)
    `).run(CHANNEL_NAME, CHANNEL_DESC, userId, now);
    const cid = info.lastInsertRowid;
    db.prepare(`
      INSERT OR IGNORE INTO subscriptions (user_id, channel_id, created_at)
      VALUES (?, ?, ?)
    `).run(userId, cid, now);
    db.prepare('INSERT OR REPLACE INTO user_digest_channels (user_id, channel_id) VALUES (?, ?)')
      .run(userId, cid);
    return cid;
  })();

  // 广播和刷新订阅关系留在事务外：那是进程外副作用，回滚不了（同 channels.js 的做法）
  refreshUserChannels(userId);
  i18n.log('digest.channelCreated', { userId, channelId });
  return channelId;
}

/**
 * 拿到（没有就建）该用户的署名应用
 *
 * 为什么不用「他自己的第一个应用」：那个人可能一个应用都没有，
 * createMessage 会回落到全局第一个应用 —— 那往往是别人的，
 * 接着应用归属校验就会以「不能使用其他用户的应用发消息」拒掉。
 * 专用应用还顺带让卡片上显示「每日摘要」而不是某个无关应用名。
 */
function ensureDigestApp(userId, channelId) {
  const mine = db.prepare(
    "SELECT id FROM applications WHERE user_id = ? AND name = ? ORDER BY id ASC LIMIT 1"
  ).get(userId, APP_NAME);
  if (mine) return mine.id;

  const now = Date.now();
  const token = crypto.randomBytes(5).toString('hex');   // 10 位，和 tokenGen 一个长度
  const info = db.prepare(`
    INSERT INTO applications (name, description, token, channel_id, user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(APP_NAME, APP_DESC, token, channelId, userId, now);
  i18n.log('digest.appCreated', { userId, appId: info.lastInsertRowid });
  return info.lastInsertRowid;
}

// ============================================================
// 摘要内容
// ============================================================

/**
 * 汇总过去 24 小时的消息
 *
 * @returns {{ total, items, text } | null}  一条可摘要的都没有时返回 null
 */
function buildDigest(userId, cfg) {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();

  // 候选集：这个人订阅的频道、未删除未归档、过去 24 小时。
  //   · 已读的**也算** —— 摘要是「过去一天都发生了什么」的回看清单，
  //     按未读过滤的话白天看过的消息晚上就找不到了（以前有个 onlyUnread 开关，已去掉）
  //   · includeMuted=false 时排除静音的频道
  //   · 所有「摘要容器频道」一律排除 —— 否则昨天的摘要会进今天的摘要，
  //     子子孙孙无穷匮也（用 NOT IN 而不是 != 自己的 id：万一以后换容器）
  const rows = db.prepare(`
    SELECT m.id, m.title, m.message, m.priority, m.date, m.agg_count, m.channel_id,
           m.extras, c.name AS channel_name, s.muted AS muted
    FROM messages m
    JOIN subscriptions s ON s.channel_id = m.channel_id AND s.user_id = @userId
    JOIN channels c ON c.id = m.channel_id
    WHERE m.deleted_at IS NULL
      AND m.archived_at IS NULL
      AND m.date >= @since
      AND m.channel_id NOT IN (SELECT channel_id FROM user_digest_channels)
      AND (@includeMuted = 1 OR s.muted = 0)
    ORDER BY m.date DESC
  `).all({
    userId,
    since,
    includeMuted: cfg.includeMuted ? 1 : 0,
  });

  // 自己发的排除（extras.sender.id 在 JSON 里，SQL 不好过滤，这里按行判）
  const filtered = cfg.excludeOwn
    ? rows.filter(r => {
        try {
          const ex = r.extras ? JSON.parse(r.extras) : null;
          const sid = ex && ex.sender ? ex.sender.id : null;
          return sid !== userId;
        } catch { return true; }   // extras 坏了：保守起见算进来
      })
    : rows;

  if (filtered.length === 0) return null;

  // 按频道分组（保持时间倒序：组内从新到旧）
  const byChannel = new Map();
  for (const r of filtered) {
    if (!byChannel.has(r.channel_id)) {
      byChannel.set(r.channel_id, { channelId: r.channel_id, name: r.channel_name, items: [] });
    }
    byChannel.get(r.channel_id).items.push(r);
  }
  const groups = [...byChannel.values()];

  // 渲染（分组计数、截断、「还有 N 条」）在 digestCore.renderDigest 里，纯函数
  const rendered = renderDigest(groups, filtered.length, cfg.maxItems);
  return { total: filtered.length, items: rendered.items, text: rendered.text };
}

// ============================================================
// 发送
// ============================================================

/** 今天给这个用户发过没有（幂等的唯一依据，必须落库） */
function wasSent(userId, day) {
  return !!db.prepare('SELECT 1 FROM user_digest_sent WHERE user_id = ? AND day = ?').get(userId, day);
}

function markSent(userId, day) {
  db.prepare('INSERT OR REPLACE INTO user_digest_sent (user_id, day, sent_at) VALUES (?, ?, ?)')
    .run(userId, day, Date.now());
}

/**
 * 给一个用户发一份摘要
 *
 * @param force 跳过「今天发过」的幂等检查（POST /user/digest/run 手动触发用）
 * @param day   日期键，由 tick 按用户时区算好传进来（不传就自己算一次）
 * @returns {{ sent: boolean, reason?: string, messageId?: number, total?: number }}
 */
function sendDigest(user, cfg, { force = false, day = null } = {}) {
  const d = day || zoneNow(cfg.tz).day;
  if (!force && wasSent(user.id, d)) return { sent: false, reason: 'already-sent' };

  const channelId = ensureDigestChannel(user.id);
  const built = buildDigest(user.id, cfg);
  if (!built) return { sent: false, reason: 'empty' };

  const appId = ensureDigestApp(user.id, channelId);
  const r = createMessage({
    appid: appId,
    channel_id: channelId,
    title: `今日摘要 · ${built.total} 条`,
    message: built.text,
    priority: cfg.priority,
    extras: { digest: true, items: built.items, total: built.total },
    tags: ['digest'],
    userId: user.id,
    noAgg: true,      // 补发和定时可能落在同一个 5 分钟窗口，折叠掉就只剩一条
    skipRules: true,  // 用户自己的规则（如「priority<8 静默」）会把摘要吃掉
  });

  if (r && r.error) {
    i18n.warn('digest.sendFailed', { userId: user.id, msg: r.error });
    return { sent: false, reason: r.error };
  }

  // createMessage 返回的是 { message: 行对象, silent, aggregated }，id 在 message 里
  markSent(user.id, d);
  i18n.log('digest.sent', { userId: user.id, total: built.total, priority: cfg.priority });
  return { sent: true, messageId: r && r.message && r.message.id, total: built.total };
}

// ============================================================
// 定时
// ============================================================

/**
 * 扫一遍所有用户，该发的发
 *
 * 规则只有一条：**已过今天的设定时间，且今天还没发过 → 发**。
 *  missed minute / 服务端重启 / 宕机一整天，全都由这一条兜住（见文件头）。
 */
function tick() {
  // 家庭 NAS 用户量级是个位到几十，全表拉一遍在 JS 里过滤完全够；
  // 真到了要索引那天，再把 time 拆成列建索引不迟。
  const users = db.prepare('SELECT id, username, settings FROM users').all();
  for (const u of users) {
    const cfg = digestSettingsOf(u);
    if (!cfg.enabled) continue;

    const m = /^(\d{2}):(\d{2})$/.exec(String(cfg.time));
    if (!m) continue;
    const target = parseInt(m[1], 10) * 100 + parseInt(m[2], 10);

    // ⚠️ 时刻和「今天」都按**这个人自己的时区**算：服务器跑在 UTC 上，
    //    用户设的 08:00 就是他手表上的 08:00；日期键也跟着它走，
    //    否则「他那边已经过 8 点、服务器这边还是前一天」会当天漏发。
    const now = zoneNow(cfg.tz);
    if (now.hhmm < target) continue;                 // 还没到今天的点

    try {
      sendDigest(u, cfg, { day: now.day });
    } catch (e) {
      // 一个用户挂了不能把整轮扫下去，更不能让定时器自己死掉
      i18n.warn('digest.tickFailed', { userId: u.id, msg: e.message });
    }
  }
}

/** 启动定时器（index.js 调用） */
function startDigestScheduler() {
  // 启动立刻扫一遍：补上停机期间错过的（见文件头的补发说明）
  tick();
  const timer = setInterval(tick, TICK_MS);
  timer.unref();   // 别让这个定时器成为进程不退出的理由
  return timer;
}

module.exports = {
  DEFAULT_DIGEST,
  CHANNEL_NAME,
  digestSettingsOf,
  digestChannelId,
  ensureDigestChannel,
  buildDigest,
  sendDigest,
  tick,
  startDigestScheduler,
  dayKey,
};
