// 附件目录的容量口径 —— 上传（attachments.js）和缓存封面图（imageCache.js）共用一套。
//
// 为什么单独成文件：这两个常量 + dirSize 原本长在 attachments.js 里，而那个文件
// 依赖 audit → db（better-sqlite3）。离线 verify 脚本（本机没有 node_modules）
// 要能 require 缓存模块来测抓取逻辑，所以把这块**零依赖**的实现挪出来。
const fs = require('fs');
const path = require('path');

// ── 容量上限 ──
//
// ⚠️ 为什么需要：附件接口接受**任意类型**文件，之前除了单请求 20MB 之外
//    没有任何总量约束，而孤儿清理只在启动时跑一次。
//    于是「登录用户 × 限流 30 次/分钟 × 20MB」= 600MB/分钟的写入，
//    文件还会一直留着 —— 对 NAS 是个实打实的磁盘风险。
//
// 两个值都可用环境变量调，默认取保守值：
//   单文件 8MB（和背景图的 8MB 对齐，图片类接口口径一致）
//   总量   500MB（超了就拒绝，不再无上限地长）
const MAX_FILE_BYTES =
  (parseInt(process.env.ATTACHMENT_MAX_FILE_MB, 10) || 8) * 1024 * 1024;
const MAX_TOTAL_BYTES =
  (parseInt(process.env.ATTACHMENT_MAX_TOTAL_MB, 10) || 500) * 1024 * 1024;

/**
 * 附件目录当前总大小
 *
 * ⚠️ 带 5 秒缓存：每次上传都 readdirSync + 逐个 statSync，文件多了（几千个）
 *    会明显拖慢请求。容量检查不需要精确到字节，几秒内复用同一个值没问题。
 */
let cachedSize = null;
let cachedAt = 0;
function dirSize(dir) {
  const now = Date.now();
  if (cachedSize != null && now - cachedAt < 5000) return cachedSize;

  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try {
        total += fs.statSync(path.join(dir, f)).size;
      } catch {}
    }
  } catch {}
  cachedSize = total;
  cachedAt = now;
  return total;
}

/**
 * 刚写进一个新文件时，把缓存值一起加上去
 *
 * 为什么需要：不修正的话，5 秒内的连续上传都读到「还没算上本次」的旧值，
 * 一次能绕过总量检查好几个文件。
 *
 * ⚠️ 这个函数就是给 attachments.js 上传路径用的 —— 那边以前直接写了
 *    `if (cachedSize != null) cachedSize += body.length`，而 cachedSize 是
 *    **本模块的私有变量**，在 attachments.js 里是个未声明标识符 ⇒ 每次上传
 *    都在写盘之后抛 ReferenceError（接口 500，文件还留在盘上变成孤儿）。
 *    现在改成显式导出，调用方再也摸不到这个私有变量。
 */
function bumpCachedSize(delta) {
  if (cachedSize != null) cachedSize += delta;
}

/** 删过文件后作废缓存（下次 dirSize 重新扫一遍） */
function resetCachedSize() {
  cachedSize = null;
  cachedAt = 0;
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  dirSize,
  bumpCachedSize,
  resetCachedSize,
};
