// 附件引用关系的**公共查询**
//
// 为什么单独成文件：有两处要用到「哪些附件还被未删除消息引用着」——
//   · attachments.js 的孤儿清理（sweepOrphanAttachments）
//   · attachmentQuota.js 的磁盘配额回收（超限时只能删没人引用的）
// 两边口径必须一致（漏一种引用就会误删还在用的文件），而配额模块要能在
// 离线 verify 脚本里 require（不带 express / db 依赖），所以把这块挪出来。
//
// ⚠️ agg_children 也要扫：折叠消息的子项各自带着自己的 extras / 正文，
//    缓存下来的封面图就藏在那一列里。漏掉它的话「删掉引用这条消息」时，
//    别的消息里还在用的文件会被误删。

/** 「刚传上来、还没被任何消息引用」的宽限期（分钟级常量，两个模块共用） */
const ORPHAN_GRACE_MS = 10 * 60 * 1000;

/** 附件 URL 里的文件名：随机 hex / cached-<sha1>，不含 LIKE 通配符 */
const ATTACHMENT_RE = /\/attachments\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;

/**
 * 从一条消息行里揪出它引用的附件文件名
 *
 * 正文（markdown 链接 / 裸 URL）和 extras 里都可能有，两边都扫。
 */
function attachmentNamesIn(row) {
  const text = (row.message || '') + ' ' + (row.extras || '') + ' ' + (row.agg_children || '');
  const names = new Set();
  let m;
  ATTACHMENT_RE.lastIndex = 0;
  while ((m = ATTACHMENT_RE.exec(text)) !== null) names.add(m[1]);
  return names;
}

/**
 * 全库「还被引用着」的附件文件名集合
 *
 * 只把**正文/extras 里出现过 /attachments/ 的行**取出来，避免全表扫描撑爆内存。
 */
function referencedAttachmentNames(db) {
  const referenced = new Set();
  const rows = db.prepare(`
    SELECT message, extras, agg_children FROM messages
    WHERE deleted_at IS NULL
      AND (message LIKE '%/attachments/%'
           OR extras LIKE '%/attachments/%'
           OR agg_children LIKE '%/attachments/%')
  `).all();
  for (const row of rows) {
    for (const name of attachmentNamesIn(row)) referenced.add(name);
  }
  return referenced;
}

module.exports = {
  ORPHAN_GRACE_MS,
  attachmentNamesIn,
  referencedAttachmentNames,
};
