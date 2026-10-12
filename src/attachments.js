const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { detectImageExt } = require('./sanitize');
const { rateLimit } = require('./rateLimit');
const audit = require('./audit');
const i18n = require('./serverI18n');
// 引用查询 / 宽限期：孤儿清理和磁盘配额回收共用一套口径，见 attachmentRefs.js
const { attachmentNamesIn, referencedAttachmentNames, ORPHAN_GRACE_MS } = require('./attachmentRefs');
const { getQuotaBytes, enforceQuota } = require('./attachmentQuota');

/**
 * 「刚传上来、还没被任何消息引用」的宽限期
 *
 * 附件是**先落盘、后发消息**两步：上传接口把文件存下来返回一个 URL，
 * 客户端拿着 URL 去发消息，消息里才出现对它的引用。
 * 在这两步之间这个文件在库里是"谁都没引用"的状态 —— 跟真孤儿长得一模一样。
 * 于是「上传完马上重启」就会被 sweep 当孤儿删掉，客户端握着一个 404 的 URL。
 *
 * 所以全量 sweep 对**近期创建**的文件网开一面，等下一次再清理。
 * 代价只是真孤儿多躺一会儿（最多到下次 sweep），比删掉正在用的文件划算得多。
 *
 * ⚠️ 这个宽限**只加在全量 sweep 上**，不加在 cleanupMessageAttachments（删消息那条路）：
 *    那边是显式删除，消息已经软删、引用关系当场就能查清，没有"还没来得及引用"这回事。
 *
 * 常量本体在 attachmentRefs.js（配额回收也要用同一个值）。
 */

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

// ── 容量上限与目录统计 ──
// 实现在 attachmentLimits.js（零依赖，缓存封面图那边复用同一套口径，
// 而离线 verify 脚本要能不带 db 依赖地 require 它）
const { MAX_FILE_BYTES, MAX_TOTAL_BYTES, dirSize, bumpCachedSize, resetCachedSize } =
  require('./attachmentLimits');

function sanitizeName(raw) {
  const base = path.basename(String(raw || ''))
    .replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  return base.slice(0, 120) || 'file';
}

function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

function createAttachmentsRouter({ attachmentsDir, db = null }) {
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

      // 超上限时**先试着回收**（删孤儿 + 最旧的缓存封面），回收完还超才拒绝。
      // 没有这一步的话，目录顶到天花板就只能人工去删旧消息。
      if (dirSize(attachmentsDir) + body.length > MAX_TOTAL_BYTES) {
        if (db) {
          const swept = enforceQuota({
            db,
            dir: attachmentsDir,
            quotaBytes: getQuotaBytes(db),
          });
          if (swept.removed > 0) {
            // 删过文件：作废目录大小缓存，重新算一次
            resetCachedSize();
          }
        }
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
      // （以前这里直接写私有变量 cachedSize，会抛 ReferenceError，见 bumpCachedSize 的说明）
      bumpCachedSize(body.length);

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
 * 实现挪到了 attachmentRefs.js（孤儿清理和磁盘配额回收共用），这里只保留
 * 本模块用到的几个函数。
 */

/** 还有别的（未删除的）消息在引用这个附件吗 */
function isStillReferenced(db, name) {
  const like = '%/attachments/' + name + '%';
  const hit = db.prepare(`
    SELECT 1 FROM messages
    WHERE deleted_at IS NULL
      AND (message LIKE ? OR extras LIKE ? OR agg_children LIKE ?)
    LIMIT 1
  `).get(like, like, like);
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
    } catch (e) {
      // 🔴 不能一律静默：文件"本来就不存在"（已经删过一次 / 压根没落盘）不是故障，
      //    但权限问题、文件被占用、路径异常都是**真的没删掉** —— 默默吞掉的话
      //    这个文件会永远留在盘上，而且没人知道磁盘在泄漏。
      if (e && e.code !== 'ENOENT') {
        i18n.warn('attachment.unlinkFailed', { name, msg: e.message });
      }
    }
  }
  return removed;
}

/**
 * 清理**一批消息**共用的附件（删频道 / 删应用这种整批软删的场景）
 *
 * 单条删除走 `cleanupMessageAttachments`；整批删除（DELETE /channel/:id、
 * DELETE /application/:id）一次会软删几千条消息，逐条调那个会有几千次查询，
 * 所以这里先把这批消息里的附件名**去重**，再逐个判断引用 ——
 * 开销只跟**附件个数**有关，跟消息条数无关。
 *
 * @param rows 只需要带 `message` 和 `extras` 两个字段
 * @returns 实际删掉的文件数
 */
function cleanupAttachmentsOfRows({ db, attachmentsDir, rows }) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  // 去重：同一个附件常被这批消息里的好几条引用
  const names = new Set();
  for (const row of rows) {
    for (const n of attachmentNamesIn(row)) names.add(n);
  }
  if (names.size === 0) return 0;

  let removed = 0;
  for (const name of names) {
    if (isStillReferenced(db, name)) continue;
    try {
      fs.unlinkSync(path.join(attachmentsDir, name));
      removed++;
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        i18n.warn('attachment.unlinkFailed', { name, msg: e.message });
      }
    }
  }
  return removed;
}

/**
 * 全量清理孤儿附件（启动时跑一次）
 *
 * 兜底用的。会默默产生孤儿的路径有两层：
 *   · 已覆盖：删单条消息（cleanupMessageAttachments）、删频道 / 删应用
 *     （cleanupAttachmentsOfRows —— 这两个入口现在都显式清了）
 *   · 未覆盖：上传了但还没发出消息就没了（客户端弃用）、以及将来要加的
 *     "清空全部消息 / 历史裁剪"。这些只能靠"扫一遍目录、谁都没引用就删"。
 *
 * 只把**正文/extras 里出现过 /attachments/ 的行**取出来，避免全表扫描撑爆内存。
 *
 * ⚠️ 现在只在启动时跑一次 —— 也就是说上面"未覆盖"那批要等重启才回收。
 *    加宽限期（ORPHAN_GRACE_MS）之后这一点更明显：真孤儿会被一直推到下次重启。
 *    等真做了"清空全部消息 / 历史裁剪"，就该把它改成定时 + 分页跑
 *    （照 index.js 里 audit.prune() 那个 setInterval + unref 的写法）。
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

  // 引用集合：和磁盘配额回收共用同一个函数（口径必须一致，见 attachmentRefs.js）
  const referenced = referencedAttachmentNames(db);

  const now = Date.now();
  let removed = 0;
  let fresh = 0;

  for (const file of files) {
    if (referenced.has(file)) continue;

    // 「刚传上来还没被引用」的宽限，见 ORPHAN_GRACE_MS 的说明
    let st;
    try {
      st = fs.statSync(path.join(attachmentsDir, file));
    } catch { continue; }   // stat 都失败（文件没了/没权限）：跳过，别当孤儿删
    if (now - st.mtimeMs < ORPHAN_GRACE_MS) { fresh++; continue; }

    try {
      fs.unlinkSync(path.join(attachmentsDir, file));
      removed++;
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        i18n.warn('attachment.unlinkFailed', { name: file, msg: e.message });
      }
    }
  }

  if (fresh > 0) {
    // 说清楚为什么少删了：不然看到「清理了 0 个」会以为功能坏了
    i18n.log('attachment.sweepSkippedFresh', { n: fresh });
  }
  return removed;
}

module.exports = {
  createAttachmentsRouter,
  cleanupMessageAttachments,
  cleanupAttachmentsOfRows,
  sweepOrphanAttachments,
  // imageCache 复用同一套容量口径（缓存封面图和用户上传的附件共享一个目录/上限）
  dirSize,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
};