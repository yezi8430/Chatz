const db = require('./db');
const { clientIp } = require('./clientIp');
const i18n = require('./serverI18n');

const insertStmt = db.prepare(`
  INSERT INTO audit_log (ts, user_id, ip, action, target, meta, success)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// 所有写进日志的值都要截断：用户名、频道名、文件名这些长度是用户可控的，
// 不设上限的话一条日志就能往库里塞一大坨（而且 /audit 会原样吐给前端）。
function capStr(v, max = 200) {
  if (v == null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

function capMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(meta)) {
    if (n++ >= 20) break;
    if (v == null) continue;
    out[k] = typeof v === 'object' ? capStr(JSON.stringify(v), 500) : capStr(v, 200);
  }
  return out;
}

function log({ userId = null, ip = null, action, target = null, meta = null, success = true }) {
  try {
    insertStmt.run(
      Date.now(),
      userId != null ? userId : null,
      capStr(ip, 64),
      String(action).slice(0, 64),
      target != null ? capStr(target, 200) : null,
      meta ? JSON.stringify(capMeta(meta)) : null,
      success ? 1 : 0
    );
  } catch (e) {
    console.error('[audit] write failed:', e.message);
  }
}

// 已登录接口的调用点统一用这个：
// 手写 { userId: req.user.id, ip: audit.getIp(req) } 迟早会漏掉一处，
// 而漏掉的那条日志恰好就成了「查不出是谁干的」那条。
function fromReq(req, { action, target = null, meta = null, success = true, userId } = {}) {
  return log({
    userId: userId !== undefined ? userId : (req && req.user ? req.user.id : null),
    ip: getIp(req),
    action,
    target,
    meta,
    success,
  });
}

// 和限速共用同一套 IP 判定（见 clientIp.js），避免两份逻辑漂移。
// 这里兜底用 null：审计日志的 ip 列是可空的，写 'unknown' 反而污染查询。
function getIp(req) {
  return clientIp(req, null);
}

// 查询审计日志
function query({ action, userId, limit = 100, since } = {}) {
  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const params = [];
  if (action) { sql += ' AND action = ?'; params.push(action); }
  if (userId != null) { sql += ' AND user_id = ?'; params.push(userId); }
  if (since != null) { sql += ' AND ts > ?'; params.push(since); }
  sql += ' ORDER BY ts DESC LIMIT ?';
  params.push(Math.min(limit, 500));

  return db.prepare(sql).all(...params).map(r => ({
    id: r.id,
    ts: r.ts,
    userId: r.user_id,
    ip: r.ip,
    action: r.action,
    target: r.target,
    meta: r.meta ? JSON.parse(r.meta) : null,
    success: !!r.success,
  }));
}

// ============================================================
// 节流写入
// ============================================================
// 有些事件是「攻击者可控的高频失败」：拿错 token 狂刷 webhook、撞库登录……
// 直接逐条记录的话，攻击者一分钟内就能灌进几十万行，把真正的操作记录淹掉。
// 所以这类事件按 key 在窗口期内只记一条 —— 排查要的是「有人在试」，不是「试了多少次」。
const throttleKeys = new Map();

function logThrottled(key, windowMs, entry) {
  const now = Date.now();
  const until = throttleKeys.get(key);
  if (until && until > now) return false;
  throttleKeys.set(key, now + windowMs);
  log(entry);
  return true;
}

// 清掉过期 key，否则 Map 本身会被不同的 key 撑大
setInterval(() => {
  const now = Date.now();
  for (const [k, until] of throttleKeys) {
    if (until <= now) throttleKeys.delete(k);
  }
}, 600000).unref();

// ============================================================
// 保留策略
// ============================================================
// 覆盖面补全之后日志量会明显变大：登录失败、设备、频道、路由、证书……
// 不裁的话 app.db 会一直涨，/audit 查询也会越来越慢。
// 两个维度同时生效：超过 N 天的删；超过 M 条的按时间从旧往新删。
// 设成 0 即关闭该维度（AUDIT_RETENTION_DAYS=0 表示永不按时间清理）。
function envInt(name, fallback, min = 0) {
  const n = Number.parseInt(process.env[name] ?? String(fallback), 10);
  return Number.isInteger(n) && n >= min ? n : fallback;
}
const RETENTION_DAYS = envInt('AUDIT_RETENTION_DAYS', 90);
const MAX_ROWS = envInt('AUDIT_MAX_ROWS', 50000);

function prune() {
  let removed = 0;
  try {
    if (RETENTION_DAYS > 0) {
      const cutoff = Date.now() - RETENTION_DAYS * 86400000;
      removed += db.prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoff).changes;
    }
    if (MAX_ROWS > 0) {
      const { c } = db.prepare('SELECT COUNT(*) AS c FROM audit_log').get();
      if (c > MAX_ROWS) {
        // 第 MAX_ROWS 新的那条为分界，它和更旧的都删掉。
        // ts 相同的会多删一两条，无所谓 —— 这是裁剪不是账本。
        const row = db.prepare(
          'SELECT ts FROM audit_log ORDER BY ts DESC LIMIT 1 OFFSET ?'
        ).get(MAX_ROWS);
        if (row) {
          removed += db.prepare('DELETE FROM audit_log WHERE ts <= ?').run(row.ts).changes;
        }
      }
    }
  } catch (e) {
    console.error('[audit] prune failed:', e.message);
  }
  if (removed > 0) i18n.log('audit.trimmed', { n: removed });
  return removed;
}

module.exports = {
  log, fromReq, logThrottled, getIp, query, prune,
  RETENTION_DAYS, MAX_ROWS,
};
