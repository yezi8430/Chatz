// 附件目录的**磁盘配额与自动回收**
//
// 和 attachmentLimits.js 的分工：
//   · 那边是「写之前先拒绝」—— 硬上限，超了返回 507，写不进去
//   · 这边是「超了自动回收」—— 保留策略，把最不可惜的东西删掉，把用量压回配额以下
//
// 为什么两个都要：只有硬上限的话，目录一旦顶到天花板就只能人工去删旧消息，
// 而「缓存封面」本该是可再生的消耗品（删了老通知的封面变裂图，消息本身还在）。
// 自动回收让目录长期停在配额附近，硬上限退化成最后一道防线。
//
// 回收顺序（从最不可惜到最不可动）：
//   1. **谁都没引用的文件**（孤儿：传了没发、删消息时漏网的）—— 纯赚，先删
//   2. **还被引用的缓存封面**（cached- 前缀），按修改时间**最旧优先** ——
//      牺牲的是老通知的封面（裂图），消息正文和其它附件不受影响
//   3. 仍然超配 → 只告警。**引用中的用户附件一律不删**（那是用户的数据）
//
// 宽限期：不到 10 分钟的文件不删（可能是刚上传还没被消息引用），
//   见 attachmentRefs.js 里 ORPHAN_GRACE_MS 的说明。
//
// 配置：meta 表 `attachments.quota_mb`（超管在设置页改），
//   环境变量 ATTACHMENTS_QUOTA_MB 设了就**硬覆盖**数据库（和 LOG_LANG 一个路子）。
//   0 = 不限。
const fs = require('fs');
const path = require('path');
const i18n = require('./serverI18n');
const { referencedAttachmentNames, ORPHAN_GRACE_MS } = require('./attachmentRefs');

const MB = 1024 * 1024;

// 默认配额。和 attachmentLimits 的 MAX_TOTAL_BYTES 默认值（500MB）对齐：
// 「保持目录不超过原来那道硬上限，靠回收而不是靠拒绝」
const DEFAULT_QUOTA_MB = 500;

// 防止手滑填个离谱的值（0 = 不限是允许的，见 isValidQuotaMb）
const MAX_QUOTA_MB = 1024 * 100; // 100 GB

const META_KEY = 'attachments.quota_mb';

/** 缓存封面的文件名前缀（imageCache.js 的 cachedFileBase） */
const CACHE_PREFIX = 'cached-';

/** 环境变量是否设了（设了就锁死数据库里的值，行为与 LOG_LANG 一致） */
function quotaMbFromEnv() {
  const raw = process.env.ATTACHMENTS_QUOTA_MB;
  if (raw === undefined || raw === '') return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** 当前生效的配额（字节）。0 = 不限 */
function getQuotaBytes(db) {
  const envMb = quotaMbFromEnv();
  if (envMb !== null) return envMb * MB;

  let raw = null;
  try {
    raw = db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY);
  } catch { /* meta 表还没建好 / 库异常：按默认值走，别让配额检查把服务搞挂 */ }
  const mb = raw ? parseInt(raw.value, 10) : NaN;
  if (Number.isFinite(mb) && mb >= 0) return mb * MB;
  return DEFAULT_QUOTA_MB * MB;
}

/** 环境变量锁死了吗（界面上要提示「改了不生效」） */
function isQuotaLocked() {
  return quotaMbFromEnv() !== null;
}

/** 校验用户输入的配额（MB）。0 = 不限；返回 null 表示不合法 */
function normalizeQuotaMb(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0 || n > MAX_QUOTA_MB) return null;
  return n;
}

function saveQuotaMb(db, mb) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(META_KEY, String(mb));
  return mb;
}

/** 目录当前用量（实时扫描，不走 attachmentLimits 的 5 秒缓存） */
function usage(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { files: 0, bytes: 0 };
  }
  let files = 0;
  let bytes = 0;
  let cachedFiles = 0;
  let cachedBytes = 0;
  for (const name of names) {
    let st;
    try {
      st = fs.statSync(path.join(dir, name));
    } catch { continue; }
    if (!st.isFile()) continue;
    files++;
    bytes += st.size;
    if (name.startsWith(CACHE_PREFIX)) {
      cachedFiles++;
      cachedBytes += st.size;
    }
  }
  return { files, bytes, cachedFiles, cachedBytes };
}

/** 给人看的体积（日志 / 界面） */
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

/**
 * 扫描目录：带大小和修改时间的文件清单
 * @returns {{ files: Array<{name,size,mtimeMs}>, total: number }}
 */
function scanDir(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { files: [], total: 0 };
  }
  const files = [];
  let total = 0;
  for (const name of names) {
    let st;
    try {
      st = fs.statSync(path.join(dir, name));
    } catch { continue; }
    if (!st.isFile()) continue;
    files.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    total += st.size;
  }
  return { files, total };
}

/**
 * 超限就回收，把用量压回配额以下
 *
 * @param db            可传 null（离线测试用）：传了才能判断「谁还在引用」
 * @param referenced    直接给引用集合（测试用；给了就不查库）
 * @returns 回收结果（删除数 / 释放字节 / 回收后用量 / 是否仍超限）
 */
function enforceQuota({ db, dir, quotaBytes, referenced = null }) {
  const before = scanDir(dir);
  const result = {
    unlimited: !quotaBytes || quotaBytes <= 0,
    removed: 0,
    freed: 0,
    before: before.total,
    after: before.total,
    stillOver: false,
    skippedFresh: 0,
  };
  if (result.unlimited) return result;
  if (before.total <= quotaBytes) return result;

  const ref = referenced || (db ? referencedAttachmentNames(db) : new Set());
  const now = Date.now();
  let current = before.total;

  const unlink = (f) => {
    try {
      fs.unlinkSync(path.join(dir, f.name));
      result.removed++;
      result.freed += f.size;
      current -= f.size;
      return true;
    } catch (e) {
      // 和孤儿清理同一口径：ENOENT 不是故障，静默；其它错误必须留痕
      if (e && e.code !== 'ENOENT') {
        i18n.warn('attachment.unlinkFailed', { name: f.name, msg: e.message });
      }
      return false;
    }
  };

  // ── 第一轮：孤儿（谁都没引用）── 纯赚，先删
  for (const f of before.files) {
    if (current <= quotaBytes) break;
    if (ref.has(f.name)) continue;
    // 宽限期：可能是刚上传、还没被消息引用的文件
    if (now - f.mtimeMs < ORPHAN_GRACE_MS) {
      result.skippedFresh++;
      continue;
    }
    unlink(f);
  }

  // ── 第二轮：还被引用的缓存封面，最旧优先 ──
  // 牺牲的是老通知的封面（裂图），消息正文、其它附件都不动
  if (current > quotaBytes) {
    const covers = before.files
      .filter(f => f.name.startsWith(CACHE_PREFIX) && ref.has(f.name))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of covers) {
      if (current <= quotaBytes) break;
      unlink(f);
    }
  }

  result.after = current;
  result.stillOver = current > quotaBytes;

  // ── 日志 ──
  if (result.removed > 0) {
    i18n.log('attachment.quotaSwept', {
      n: result.removed,
      freed: formatBytes(result.freed),
      after: formatBytes(current),
      quota: formatBytes(quotaBytes),
    });
  } else if (result.skippedFresh > 0) {
    // 一个都没删成、又恰好有宽限期内的文件：说清楚为什么
    i18n.log('attachment.quotaSkippedFresh', { n: result.skippedFresh });
  }
  if (result.stillOver) {
    i18n.warn('attachment.quotaStillOver', {
      used: formatBytes(current),
      quota: formatBytes(quotaBytes),
    });
  }
  return result;
}

module.exports = {
  MB,
  DEFAULT_QUOTA_MB,
  MAX_QUOTA_MB,
  META_KEY,
  getQuotaBytes,
  isQuotaLocked,
  normalizeQuotaMb,
  saveQuotaMb,
  usage,
  formatBytes,
  scanDir,
  enforceQuota,
};
