const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { detectImageExt } = require('./sanitize');
const { rateLimit } = require('./rateLimit');
const audit = require('./audit');

/**
 * 附件上传
 *
 * 只负责"把文件存下来 + 给一个 URL"，不含任何业务语义：
 * 消息怎么引用它由客户端决定（图片走 extras.image，其他文件走 extras.attachment）。
 *
 * ⚠️ 扩展名的取法（两处安全考量）：
 *   1. 图片以**魔数**为准 —— 客户端声明的类型/文件名都不可信
 *   2. 浏览器能内联执行的类型（html/svg/js/xml…）一律改存成 .bin
 *      附件目录和 WebUI 是**同源**的，一个被内联打开的 .html 就等于存储型 XSS
 *
 * 落盘文件名随机（16 字节 hex），URL 不可猜；目录本身是公开静态目录，
 * 和 /icons、/user-avatars 一致（客户端加载图片不会带鉴权头）。
 */

/** 危险扩展名：连魔数认出来是图片（svg）也不保留原扩展名 */
const BLOCKED_EXTS = new Set([
  'html', 'htm', 'xhtml', 'shtml', 'svg', 'xml', 'js', 'mjs', 'cjs', 'hta', 'swf',
]);

// ── 容量上限 ──
//
// ⚠️ 为什么需要：这个接口接受**任意类型**文件，之前除了单请求 20MB 之外
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

function sanitizeName(raw) {
  const base = path.basename(String(raw || ''))
    .replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  return base.slice(0, 120) || 'file';
}

function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

function createAttachmentsRouter({ attachmentsDir }) {
  fs.mkdirSync(attachmentsDir, { recursive: true });

  const router = express.Router();

  // POST /attachment?name=xxx.png  —— body 是裸二进制
  router.post('/attachment',
    rateLimit({
      windowMs: 60000,
      // 30 → 10：附件是这里唯一能写任意大文件的入口，频率和容量一起收才有用
      max: 10,
      name: 'attachment',
      keyFn: (req) => 'att:' + (req.user ? req.user.id : 'anon'),
      message: '上传过于频繁',
    }),
    (req, res) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return res.status(400).json({ error: '请求内容为空' });
      }

      if (body.length > MAX_FILE_BYTES) {
        return res.status(413).json({
          error: `文件超过 ${MAX_FILE_BYTES / 1048576}MB 上限`,
        });
      }
      if (dirSize(attachmentsDir) + body.length > MAX_TOTAL_BYTES) {
        // 507 Insufficient Storage：服务端没地方存了，和 413（单个太大）区分开
        return res.status(507).json({
          error: `附件空间已满（上限 ${MAX_TOTAL_BYTES / 1048576}MB），请先清理旧附件`,
        });
      }

      const name = sanitizeName(req.query.name);
      const imageExt = detectImageExt(body);

      let ext = imageExt || extOf(name) || 'bin';
      if (BLOCKED_EXTS.has(ext)) ext = 'bin';

      const filename = crypto.randomBytes(16).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(attachmentsDir, filename), body);
      // 立刻累加进缓存：否则 5 秒内的连续上传都读到"还没算上本次"的旧值，
      // 一次能绕过总量检查好几个文件
      if (cachedSize != null) cachedSize += body.length;

      const isImage = !!imageExt && imageExt !== 'svg';

      audit.fromReq(req, {
        action: 'attachment.create',
        target: filename,
        meta: { name, size: body.length, ext },
      });

      res.json({
        url: '/attachments/' + filename,
        name,
        size: body.length,
        isImage,
        contentType: isImage ? 'image/' + (imageExt === 'jpg' ? 'jpeg' : imageExt) : null,
      });
    }
  );

  return router;
}

// ============================================================
// 清理
// ============================================================

/**
 * 从一条消息里揪出它引用的附件文件名
 *
 * 正文（markdown 链接 / 裸 URL）和 extras 里都可能有，两边都扫。
 */
function attachmentNamesIn(row) {
  const text = (row.message || '') + ' ' + (row.extras || '');
  const names = new Set();
  const re = /\/attachments\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) names.add(m[1]);
  return names;
}

/** 还有别的（未删除的）消息在引用这个附件吗 */
function isStillReferenced(db, name) {
  const hit = db.prepare(`
    SELECT 1 FROM messages
    WHERE deleted_at IS NULL AND (message LIKE ? OR extras LIKE ?)
    LIMIT 1
  `).get('%/attachments/' + name + '%', '%/attachments/' + name + '%');
  return !!hit;
}

/**
 * 删掉某条消息独占的附件
 *
 * ⚠️ 先查引用再删：同一个附件 URL 可以被再发一次（用户手动转发那段链接），
 *    直接跟着消息删会把别人还在用的文件断掉。
 *    文件名是随机 hex + 扩展名、不含 LIKE 通配符，可以安全地拼进查询模式。
 *
 * @returns 实际删掉的文件数
 */
function cleanupMessageAttachments({ db, attachmentsDir, row }) {
  if (!row) return 0;
  let removed = 0;
  for (const name of attachmentNamesIn(row)) {
    if (isStillReferenced(db, name)) continue;
    try {
      fs.unlinkSync(path.join(attachmentsDir, name));
      removed++;
    } catch {}
  }
  return removed;
}

/**
 * 全量清理孤儿附件（启动时跑一次）
 *
 * 覆盖"删消息"之外的所有路径：清空全部消息、裁剪历史、删频道…… 那些地方不会逐条
 * 通知附件，所以用"扫一遍目录、谁都没引用就删"兜底。
 * 只把**正文/extras 里出现过 /attachments/ 的行**取出来，避免全表扫描撑爆内存。
 *
 * @returns 实际删掉的文件数
 */
function sweepOrphanAttachments({ db, attachmentsDir }) {
  let files;
  try {
    files = fs.readdirSync(attachmentsDir);
  } catch {
    return 0;
  }
  if (files.length === 0) return 0;

  const referenced = new Set();
  const rows = db.prepare(`
    SELECT message, extras FROM messages
    WHERE deleted_at IS NULL
      AND (message LIKE '%/attachments/%' OR extras LIKE '%/attachments/%')
  `).all();
  for (const row of rows) {
    for (const name of attachmentNamesIn(row)) referenced.add(name);
  }

  let removed = 0;
  for (const file of files) {
    if (referenced.has(file)) continue;
    try {
      fs.unlinkSync(path.join(attachmentsDir, file));
      removed++;
    } catch {}
  }
  return removed;
}

module.exports = {
  createAttachmentsRouter,
  cleanupMessageAttachments,
  sweepOrphanAttachments,
};