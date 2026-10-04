const db = require('./db');
const { isWebhookTargetAllowed } = require('./ssrfGuard');

// ============================================================
// 安全正则
// ============================================================
const MAX_PATTERN_LEN = 200;
const MAX_INPUT_LEN = 10000;

function safeRegex(pattern, flags = 'i') {
  if (typeof pattern !== 'string') return null;
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LEN) return null;
  // 检测嵌套量词（如 (a+)+、(a*)*）
  if (/\(\s*(?:[^()\\]|\\.)*[*+{]\s*(?:[^()\\]|\\.)*\)\s*[*+{]/.test(pattern)) {
    return null;
  }
  // 检测连续的贪婪通配
  if (/(\.\*){3,}/.test(pattern)) return null;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

function safeMatch(pattern, input, flags = 'i') {
  const re = safeRegex(pattern, flags);
  if (!re) return false;
  const text = (input || '').slice(0, MAX_INPUT_LEN);
  try {
    return re.test(text);
  } catch {
    return false;
  }
}

// ============================================================
// 条件求值
// ============================================================
function evalCondition(cond, ctx) {
  if (cond.channel && ctx.channel?.name !== cond.channel) return false;
  if (cond.channel_id != null && ctx.channel?.id !== cond.channel_id) return false;
  if (cond.source_app && ctx.app?.name !== cond.source_app) return false;
  if (cond.app_id != null && ctx.app?.id !== cond.app_id) return false;

  if (cond.priority_gte != null && ctx.message.priority < cond.priority_gte) return false;
  if (cond.priority_lte != null && ctx.message.priority > cond.priority_lte) return false;
  if (cond.priority_eq != null && ctx.message.priority !== cond.priority_eq) return false;

  if (cond.body_matches) {
    if (!safeMatch(cond.body_matches, ctx.message.message)) return false;
  }
  if (cond.title_matches) {
    if (!safeMatch(cond.title_matches, ctx.message.title)) return false;
  }

  if (cond.time_between) {
    const [from, to] = cond.time_between;
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const [fh, fm] = from.split(':').map(Number);
    const [th, tm] = to.split(':').map(Number);
    const startMin = fh * 60 + fm;
    const endMin = th * 60 + tm;
    const inRange = startMin <= endMin
      ? cur >= startMin && cur <= endMin
      : cur >= startMin || cur <= endMin;
    if (!inRange) return false;
  }

  if (cond.tag_includes) {
    const tags = ctx.message.tags || [];
    if (!cond.tag_includes.every(t => tags.includes(t))) return false;
  }

  return true;
}

// ============================================================
// 动作执行
// ============================================================
function applyAction(action, ctx) {
  switch (action.type) {
    case 'set_priority':
      ctx.message.priority = Math.max(0, Math.min(10, parseInt(action.value, 10) || 0));
      break;
    case 'add_tag': {
      const tags = new Set(ctx.message.tags || []);
      if (tags.size < 50) tags.add(String(action.value).slice(0, 50));
      ctx.message.tags = [...tags];
      break;
    }
    case 'remove_tag':
      ctx.message.tags = (ctx.message.tags || []).filter(t => t !== action.value);
      break;
    case 'set_silent':
      ctx.silent = action.value !== false;
      break;
    case 'broadcast_to': {
      ctx.extraChannels = ctx.extraChannels || [];
      const ids = Array.isArray(action.value) ? action.value : [action.value];
      ctx.extraChannels.push(...ids.map(Number).filter(n => n > 0));
      break;
    }
    case 'drop':
      ctx.drop = true;
      break;
    case 'add_prefix':
      ctx.message.message = String(action.value || '').slice(0, 200) + (ctx.message.message || '');
      break;
    case 'call_webhook': {
      const url = String(action.value || '');
      if (!/^https?:\/\//i.test(url)) break;
      setImmediate(async () => {
        try {
          // ⚠️ 必须先过 SSRF 守卫：这个 URL 是规则里填的，而能改规则的是管理员
          // （两级权限下管理员可以分给别人）。不设防的话任何一个管理员都能让
          // 服务器去请求内网地址 / 169.254.169.254，而且 body 里带的是完整消息。
          // 守卫逻辑与逃生开关（ALLOW_PRIVATE_WEBHOOK=1）见 src/ssrfGuard.js
          const check = await isWebhookTargetAllowed(url);
          if (!check.ok) {
            console.warn(`[route] call_webhook 已拒绝: ${url} —— ${check.reason}`);
            return;
          }

          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ctx.message),
            signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
          }).catch(() => {});
        } catch {}
      });
      break;
    }
  }
}

// ============================================================
// 主流程
// ============================================================

/**
 * 过滤 `broadcast_to` 的目标频道 —— 只留下归属者有权投递的。
 *
 * ⚠️ broadcast_to 以前**完全不校验**目标频道：动作里随便填个 id 就能投过去。
 *    而路由规则现在普通用户也能建（注册是开放的），不设防的话任何人都能
 *    往别人的私有频道灌消息 —— 那频道他本来连看都看不到。
 *    口径与 messageCreate.js 的主频道校验保持一致：
 *      公开频道 / 归属者订阅的 / 归属者创建的 / 归属者是超管（不限）。
 */
function filterAllowedBroadcastChannels(ids, ctx) {
  const ownerId = ctx.ownerId;
  const out = [];
  for (const cid of ids) {
    const ch = db.prepare('SELECT id, is_public, creator_id FROM channels WHERE id = ?').get(cid);
    if (!ch) continue;
    if (ctx.ownerIsSuper || ch.is_public || ch.creator_id === ownerId) { out.push(cid); continue; }
    if (ownerId == null) continue;
    const sub = db.prepare(
      'SELECT 1 FROM subscriptions WHERE user_id = ? AND channel_id = ?'
    ).get(ownerId, cid);
    if (sub) out.push(cid);
  }
  return out;
}

function applyRoutes(ctx) {
  // 规则**按用户隔离**：只加载消息归属者自己的规则。
  //   - 登录用户发消息 → 该用户的规则
  //   - Webhook       → 应用归属用户的规则
  // 存量规则已回填给 admin，所以老实例上管理员建的规则仍对 admin 的消息生效。
  const ownerId = ctx.ownerId;
  const routes = ownerId != null
    ? db.prepare(
        'SELECT * FROM routes WHERE enabled = 1 AND user_id = ? ORDER BY priority DESC, id ASC'
      ).all(ownerId)
    : [];

  for (const route of routes) {
    let cond, actions;
    try {
      cond = JSON.parse(route.conditions);
      actions = JSON.parse(route.actions);
    } catch { continue; }

    if (!evalCondition(cond, ctx)) continue;

    for (const a of actions) {
      applyAction(a, ctx);
      if (ctx.drop) return null;
    }
  }

  // 规则跑完再统一过滤转发目标（applyAction 是纯函数，不适合在里面查库）
  if (ctx.extraChannels && ctx.extraChannels.length > 0) {
    ctx.extraChannels = filterAllowedBroadcastChannels(ctx.extraChannels, ctx);
  }
  return ctx;
}

module.exports = { evalCondition, applyAction, applyRoutes, safeRegex, safeMatch };
