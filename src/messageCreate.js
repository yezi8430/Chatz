const db = require('./db');
const ws = require('./ws');
const { applyRoutes } = require('./routing');

const AGG_WINDOW_MS = parseInt(process.env.AGG_WINDOW_MS || '300000', 10);

// 聚合消息的**最长寿命**（毫秒），从「建消息时间」算起，默认 30 分钟；<= 0 表示不限制。
//
// ⚠️ 为什么需要它：AGG_WINDOW_MS 量的是 `agg_last_at`（**上一次**折叠时间），而它每次折叠都被刷成
//    `now` ⇒ 那其实是个**滚动窗口**：只要新条目间隔 < AGG_WINDOW_MS，同一条消息就能无限续命。
//    而折叠分支既不改 id、也不改 date/title（只动 agg_*，外加**首次折叠**时清一次主卡的图），
//    列表又是 `ORDER BY m.id DESC`
//    ⇒ 这条消息**永远停在原位不上浮**，并且会把最早的子项挤出 `agg_children` 的 slice(-100)
//    ⇒ 表现：用户「早就翻过去了，却还在被静默追加，且最早的条目已经丢了」。
//    这里补一个**从第一条算起**的硬上限，超时就另开一条新消息（新 id ⇒ 正常浮到列表顶部）。
const AGG_MAX_LIFETIME_MS = parseInt(process.env.AGG_MAX_LIFETIME_MS || '1800000', 10);

// 长度限制
const MAX_TITLE_LEN = 500;
const MAX_MESSAGE_LEN = 50000;
const MAX_EXTRAS_LEN = 10000;
const MAX_TAG_LEN = 50;
const MAX_TAGS = 20;

function rowToMsg(row) {
  const msg = {
    id: row.id,
    appid: row.appid,
    message: row.message,
    title: row.title,
    priority: row.priority,
    date: row.date,
    extras: row.extras ? JSON.parse(row.extras) : null,
    channel_id: row.channel_id,
  };
  if (row.tags) { try { msg.tags = JSON.parse(row.tags); } catch {} }
  if (row.agg_count != null) msg.aggCount = row.agg_count;
  if (row.agg_last_at) msg.aggLastAt = row.agg_last_at;
  if (row.agg_children) {
    try { msg.aggChildren = JSON.parse(row.agg_children); } catch { msg.aggChildren = []; }
  }
  return msg;
}

// 摘掉 extras 里所有「会被渲染成封面」的键，其余（sender / app / 自定义字段）一律保留。
// 封面优先级与网页 public/app.js:renderAggChildren、Android MessageText.imageUrlFromExtras 一致：
//   extras.image  →  extras['client::display'].url  →  extras['client::notification'].bigImageUrl
function stripCoverKeys(extras) {
  if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return extras;
  const out = { ...extras };
  delete out.image;
  for (const [key, field] of [['client::display', 'url'], ['client::notification', 'bigImageUrl']]) {
    const obj = out[key];
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const copy = { ...obj };
      delete copy[field];
      if (Object.keys(copy).length > 0) out[key] = copy; else delete out[key];
    }
  }
  return out;
}

// 去掉正文里的 markdown 图片（`![alt](url)`）。只用于**聚合主卡** ——
// 原正文已经一字不改地存进 agg_children 的第 1 个元素，所以这里清掉不会丢内容。
//
// 为什么光清 extras.image 不够：两个通道的「图」来源不同 ——
//   · 客户端（Android）读 `extras.image`
//   · WebUI 读**正文**：public/app.js:888-903 会把正文渲染出的第一张 <img> 摘下来，
//     挂成整张卡片的背景图（`--msg-image`）。所以正文里的图不清，网页主卡照样顶着封面。
function stripMarkdownImages(text) {
  if (!text) return text;
  return String(text)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')  // ![alt](url) / ![alt](url "title")
    .replace(/[ \t]+\n/g, '\n')            // 清掉行尾多出来的空白
    .replace(/\n{3,}/g, '\n\n')            // 塌缩被打图留下的空行
    .trim();
}

function findAggregateTarget(channelId, appid, title) {
  if (!title || !title.trim()) return null;
  const now = Date.now();
  const since = now - AGG_WINDOW_MS;
  // since = 滚动窗口下限：agg_last_at（**上次**折叠时间）得够新，才算「还在同一批」。
  // lifetimeFloor = 硬上限下限：**建消息时间**得够新，防上面那个滚动窗口被无限续命
  //   （为什么必须补这一条，见 AGG_MAX_LIFETIME_MS 的注释）。
  //   AGG_MAX_LIFETIME_MS <= 0 时不限制，传 -1 让条件恒真（created_at 是毫秒时间戳，恒 > -1）；
  //   created_at 为 NULL 的行也放行 —— 基础表定义是 NOT NULL，这只是兜底，不因缺值突然不聚合。
  const lifetimeFloor = AGG_MAX_LIFETIME_MS > 0 ? now - AGG_MAX_LIFETIME_MS : -1;
  return db.prepare(`
    SELECT * FROM messages
    WHERE channel_id = ?
      AND appid = ?
      AND title = ?
      AND deleted_at IS NULL
      AND archived_at IS NULL
      AND agg_last_at > ?
      AND (created_at IS NULL OR created_at > ?)
    ORDER BY agg_last_at DESC
    LIMIT 1
  `).get(channelId, appid, title, since, lifetimeFloor);
}

function broadcastAggregated(target, ctx) {
  const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(target.id);
  const msgObj = rowToMsg(updated);
  const channels = new Set([updated.channel_id]);
  for (const cid of ctx.extraChannels) channels.add(cid);
  // 用 broadcastToChannels：一条消息对同一客户端只投递一次
  // （broadcast_to 可能把消息投到多个频道，管理员/多频道订阅者会被命中多次）
  //
  // ★ silent 必须**随广播下发**：它不在 messages 表里（只是"这一次投递要不要响铃"），
  //   而路由规则的 set_silent 和内置的 night-silent 模板都靠它生效。
  //   以前 silent 只在 HTTP 响应里回给发送方，接收端根本拿不到 ⇒ 静默规则等于白配。
  ws.broadcastToChannels([...channels], { event: 'messageAggregated', message: { ...msgObj, silent: ctx.silent } });
  return msgObj;
}

/**
 * 发送者快照
 *
 * 消息表里**没有** user_id 列（历史设计如此），所以把发送者信息作为**快照**写进
 * extras —— extras 是 Gotify 专门留给客户端自定义数据的扩展点，会原样透传并存下来，
 * 客户端的本地库也已经持久化它，因此不需要任何表结构迁移。
 *
 * 代价（已知并接受）：用户之后改昵称，旧消息仍显示当时的名字。
 */
function resolveSender(userId) {
  if (!userId) return null;
  const u = db.prepare(
    'SELECT id, username, display_name, is_admin, role FROM users WHERE id = ?'
  ).get(userId);
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    // display_name 允许为空（注册时回落成 username），这里统一兜一下，
    // 免得客户端还要各自判空
    displayName: u.display_name || u.username,
    isAdmin: !!u.is_admin,
    // role 可能为 NULL（迁移前建的老行），按 is_admin 兜成 2
    isSuper: (u.role != null ? u.role : (u.is_admin ? 2 : 0)) >= 2,
  };
}

/**
 * 把发送者写进 extras
 *
 * ⚠️ **覆盖写入**：extras 是可以由调用方（HTTP body）传进来的，不做覆盖的话
 *    任何持有 token 的客户端都能伪造"sender"冒充别人。所以这里无条件盖掉。
 *    也刻意放在 applyRoutes **之后**：路由规则不给碰，杜绝被改掉的可能。
 */
function attachSender(ctx, userId) {
  const sender = resolveSender(userId);
  if (!sender) return;
  const e = ctx.message.extras;
  if (e && typeof e === 'object' && !Array.isArray(e)) {
    e.sender = sender;
  } else {
    // extras 缺失、是数组、或者是个字符串（客户端传了怪东西）→ 直接换掉
    ctx.message.extras = { sender };
  }
}

/**
 * 把**应用快照**写进 extras
 *
 * 应用改成按用户隔离后，`GET /application` 只返回自己的 —— 于是客户端拿不到
 * 「别人应用」的名字/图标，而**订阅了别人频道的人是看得到那些消息的**，
 * 卡片上就会显示不出是谁发的（只剩默认图标）。
 *
 * 所以这里把应用名/图标快照进 extras，和 `extras.sender` 一个道理：
 *   · 客户端展示不再依赖应用列表（那玩意儿现在按用户隔离了）
 *   · 不需要任何表结构迁移（extras 本来就是存任意 JSON 的扩展点）
 *   · 代价同 sender：应用后来改名，旧消息仍显示当时的名字
 *
 * ⚠️ 只写 id / name / image，**绝不写 token** —— 那是 webhook 凭据，绝不能外泄。
 * ⚠️ **覆盖写入**，理由同 attachSender：extras 可由调用方传进来，不覆盖就能伪造。
 *    同样放在 applyRoutes **之后**，不给路由规则改。
 */
function attachApp(ctx, app) {
  if (!app) return;
  const snapshot = {
    id: app.id,
    name: app.name || '',
    // 相对路径（/icons/xxx.png），客户端自己拼 baseUrl —— 服务端不知道对外地址
    image: app.image || null,
  };
  const e = ctx.message.extras;
  if (e && typeof e === 'object' && !Array.isArray(e)) {
    e.app = snapshot;
  } else {
    ctx.message.extras = { app: snapshot };
  }
}

function createMessage({ appid, channel_id, message, title, priority, extras, tags, silent, userId }) {
  // ============ 输入清理 ============
  let safeTitle = title != null ? String(title).slice(0, MAX_TITLE_LEN) : null;
  let safeMessage = message != null ? String(message).slice(0, MAX_MESSAGE_LEN) : '';
  let safeTags = Array.isArray(tags)
    ? tags.slice(0, MAX_TAGS).map(t => String(t).slice(0, MAX_TAG_LEN)).filter(Boolean)
    : [];
  let safeExtras = extras;
  if (extras) {
    try {
      const s = JSON.stringify(extras);
      if (s.length > MAX_EXTRAS_LEN) safeExtras = null;
    } catch {
      safeExtras = null;
    }
  }
  let safePriority = priority != null ? parseInt(priority, 10) : 5;
  if (isNaN(safePriority)) safePriority = 5;
  safePriority = Math.max(0, Math.min(10, safePriority));

  let finalAppId = appid;
  if (!finalAppId) {
    // 应用**按用户隔离**：登录用户发消息时「默认应用」取**他自己**的第一个应用；
    // 他自己一个都没有，才回落到全局第一个（通常是内置的「默认应用」，作系统兜底）。
    // webhook（无 userId）保持原样 —— 调用方本来就带着某个应用的 token。
    const mine = userId != null
      ? db.prepare('SELECT id FROM applications WHERE user_id = ? ORDER BY id ASC LIMIT 1').get(userId)
      : null;
    const first = mine || db.prepare('SELECT id FROM applications ORDER BY id ASC LIMIT 1').get();
    if (!first) return null;
    finalAppId = first.id;
  }

  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(finalAppId);
  if (!app) return null;

  // 归属校验：应用按用户隔离，**登录用户只能用自己的应用署名**（超管不限）。
  // 不校验的话，随便传个 appid 就能冒用别人的应用身份发消息 —— appid 很好猜（1、2、3…）。
  if (userId != null && app.user_id != null && app.user_id !== userId) {
    const s = resolveSender(userId);
    if (!s || !s.isSuper) {
      return { error: '不能使用其他用户的应用发消息' };
    }
  }

  let finalChannelId = channel_id || app.channel_id;
  if (!finalChannelId) {
    const def = db.prepare('SELECT id FROM channels ORDER BY id ASC LIMIT 1').get();
    finalChannelId = def ? def.id : null;
  }

  const channel = finalChannelId
    ? db.prepare('SELECT * FROM channels WHERE id = ?').get(finalChannelId)
    : null;

  // ── 频道存在性 + 投递权限 ──
  //
  // ⚠️ 以前这里查不到频道也照样往下走：消息会落进一个不存在的频道，谁也收不到，
  //    接口还返回 200（带一个看起来正常的消息对象）—— 是最难排查的一种失败。
  //    现在一律拒绝。
  if (!channel) return { error: '频道不存在' };

  // 谁有权往这个频道发：
  //
  // · 登录用户（userId 有值）：**超级管理员**随意；其余人（含普通管理员）
  //   必须是该频道的**订阅者**。
  //   之前完全没校验，而注册是开放的 ⇒ 随便注册个账号就能往任意频道（含私有频道）
  //   注入消息，订阅者手机上直接弹。
  //   （普通管理员看不到未订阅的私有频道，自然也不该能往里发。）
  //
  // · Webhook（userId 为空）：只能是应用自己的默认频道，或任意**公开**频道。
  //   应用 Token 是要外发给第三方服务的（Uptime Kuma / GitHub / Grafana），
  //   不挡的话拿到一枚 token 就能往别人的私有频道灌消息 —— 而 token 持有者
  //   本来连那个频道都看不到。公开频道不挡：它本来就是谁都能订阅的。
  if (userId) {
    const sender = resolveSender(userId);
    if (sender && !sender.isSuper) {
      const sub = db.prepare(
        'SELECT 1 FROM subscriptions WHERE user_id = ? AND channel_id = ?'
      ).get(userId, finalChannelId);
      if (!sub) return { error: '没有在该频道发消息的权限（未订阅）' };
    }
  } else if (finalChannelId !== app.channel_id && !channel.is_public) {
    return { error: '该频道不接受 Webhook 投递' };
  }

  // 消息归属者 —— 决定两件事：用**谁的规则**、broadcast_to 能投到哪些频道。
  //   - 登录用户发消息 → 本人
  //   - Webhook       → 应用归属用户（应用按用户隔离，见 migrate 的 applications.user_id）
  const ownerId = userId != null ? userId : (app.user_id != null ? app.user_id : null);
  const ownerIsSuper = ownerId != null
    ? ((db.prepare('SELECT role FROM users WHERE id = ?').get(ownerId) || {}).role || 0) >= 2
    : false;

  const ctx = {
    message: {
      appid: finalAppId,
      channel_id: finalChannelId,
      message: safeMessage,
      title: safeTitle,
      priority: safePriority,
      tags: [...safeTags],
      extras: safeExtras,
    },
    app,
    channel,
    silent: !!silent,
    extraChannels: [],
    ownerId,
    ownerIsSuper,
  };

  const routed = applyRoutes(ctx);
  if (routed === null) return { dropped: true };

  // 发送者快照写进 extras（在路由之后，且覆盖写入 —— 见 attachSender 的说明）
  attachSender(ctx, userId);
  // 应用快照同理：应用现在按用户隔离，客户端已经查不到「别人应用」的名字/图标了
  attachApp(ctx, app);

  const now = Date.now();
  const date = new Date(now).toISOString();

  // 尝试聚合
  const aggTarget = findAggregateTarget(ctx.message.channel_id, ctx.message.appid, ctx.message.title);
  if (aggTarget) {
    let children = [];
    try { children = JSON.parse(aggTarget.agg_children || '[]'); } catch {}

    // 主卡片的 message/extras 装的是**第 1 条**的内容（折叠只更新 agg_* 三列，见文件头说明），
    // 而第 1 条**不在** agg_children 里 —— children 是从第 2 条开始攒的。
    // 两个 *.Raw 默认原样写回；只有首次折叠才应该动它们。
    let mainExtrasRaw = aggTarget.extras;
    let mainMessageRaw = aggTarget.message;
    if (children.length === 0) {
      // ★ 首次折叠：把第 1 条**原样**补进 children 的第 1 位。
      //   因为紧接着要把主卡上的图清掉，不补的话第 1 条的封面就**再也看不到**了。
      //   顺带把编号补连续：展开后是 1..N（原来是 2..N，第 1 条只以主卡形式存在）。
      let mainExtras = null;
      try { mainExtras = aggTarget.extras ? JSON.parse(aggTarget.extras) : null; } catch { mainExtras = null; }
      children.push({
        message: aggTarget.message,
        title: aggTarget.title,
        date: aggTarget.date,
        priority: aggTarget.priority,
        extras: mainExtras,
      });

      // ★ 聚合主卡不放图（只显示标题 + ×N，要看图去展开的子项里看）。
      //   动机：标题固定的应用（如插件默认的 `[Jellyfin] 新增媒体`）会把几天里
      //   互不相关的条目全折进一条，主卡却永远挂着**第 1 条**的封面 ⇒ 严重误导。
      //   ⚠️ 两个通道都要清（原因见 stripMarkdownImages 的注释）；只清 extras.image 的话网页端没效果。
      //   ⚠️ 只摘「图」相关的键，**必须保留 extras.sender / extras.app** —— 主卡还要显示发送者/应用。
      const stripped = stripCoverKeys(mainExtras);
      mainExtrasRaw = stripped ? JSON.stringify(stripped) : null;
      mainMessageRaw = stripMarkdownImages(aggTarget.message);
    }

    children.push({
      message: ctx.message.message,
      title: ctx.message.title,
      date,
      priority: ctx.message.priority,
      extras: ctx.message.extras || null,
    });
    if (children.length > 100) children = children.slice(-100);

    db.prepare(`
      UPDATE messages
      SET agg_count = agg_count + 1, agg_last_at = ?, agg_children = ?, extras = ?, message = ?
      WHERE id = ?
    `).run(now, JSON.stringify(children), mainExtrasRaw, mainMessageRaw, aggTarget.id);

    const msgObj = broadcastAggregated(aggTarget, ctx);
    return { message: msgObj, silent: ctx.silent, aggregated: true };
  }

  const extrasJson = ctx.message.extras ? JSON.stringify(ctx.message.extras) : null;
  const tagsJson = ctx.message.tags.length > 0 ? JSON.stringify(ctx.message.tags) : null;

  const info = db.prepare(`
    INSERT INTO messages
      (appid, channel_id, message, title, priority, date, extras, tags, created_at, agg_count, agg_last_at, agg_children)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, '[]')
  `).run(
    ctx.message.appid, ctx.message.channel_id, ctx.message.message,
    ctx.message.title, ctx.message.priority,
    date, extrasJson, tagsJson, now, now
  );

  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
  const msgObj = rowToMsg(row);

  const channels = new Set([ctx.message.channel_id]);
  for (const cid of ctx.extraChannels) channels.add(cid);
  // 用 broadcastToChannels：一条消息对同一客户端只投递一次
  // （broadcast_to 可能把消息投到多个频道，管理员/多频道订阅者会被命中多次）
  //
  // ★ silent 见 broadcastAggregated 的说明：不带下去，路由的静默规则就不生效
  ws.broadcastToChannels([...channels], { ...msgObj, silent: ctx.silent });

  return { message: msgObj, silent: ctx.silent };
}

module.exports = { createMessage, AGG_WINDOW_MS, AGG_MAX_LIFETIME_MS };
