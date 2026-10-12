const express = require('express');
const db = require('./db');
const { requireSuper } = require('./auth');
const audit = require('./audit');

const router = express.Router();

/**
 * 超级管理员「管理页」专用接口
 *
 * 日常接口（`/channel`、`/application`、`/route`）都是**按用户隔离**的 —— 每个人
 * 只看得到自己创建的。超管要看全站数据就走这里。
 *
 * 与日常接口的分工：
 *   - 日常：自己的、能操作的（含明文 token 也只给归属者）
 *   - 这里：全量、**只读**（带 ownerName / creatorName 便于分辨是谁的）
 *
 * ⚠️ 只做 GET：管理页目前只要求「看得到」。真要动别人的资源另开接口，
 *    那样每一步都能单独审计，比一个万能 PATCH 安全。
 */

router.get('/admin/channels', requireSuper, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, u.username AS creator_name
    FROM channels c
    LEFT JOIN users u ON u.id = c.creator_id
    ORDER BY c.id ASC
  `).all();

  res.json(rows.map(r => ({
    id: r.id,
    name: r.name,
    description: r.description,
    image: r.image || null,
    isPublic: !!r.is_public,
    creatorId: r.creator_id,
    creatorName: r.creator_name || null,
    createdAt: r.created_at,
    passwordProtected: !!r.password_hash,
  })));
});

router.get('/admin/applications', requireSuper, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, u.username AS owner_name
    FROM applications a
    LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.id ASC
  `).all();

  // ⚠️ token 是明文：这是管理页，超管本来就该能查看全站凭据；
  //    但也正因如此，这条接口必须 requireSuper，且只读。
  res.json(rows.map(r => ({
    id: r.id,
    name: r.name,
    description: r.description,
    image: r.image || null,
    token: r.token || null,
    channelId: r.channel_id,
    template: r.template || null,
    ownerId: r.user_id,
    ownerName: r.owner_name || null,
    createdAt: r.created_at,
  })));
});

router.get('/admin/routes', requireSuper, (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, u.username AS owner_name
    FROM routes r
    LEFT JOIN users u ON u.id = r.user_id
    ORDER BY r.priority DESC, r.id ASC
  `).all();

  res.json(rows.map(r => {
    let conditions = null;
    let actions = null;
    try { conditions = JSON.parse(r.conditions); } catch {}
    try { actions = JSON.parse(r.actions); } catch {}
    return {
      id: r.id,
      name: r.name,
      enabled: !!r.enabled,
      priority: r.priority,
      conditions,
      actions,
      createdAt: r.created_at,
      ownerId: r.user_id,
      ownerName: r.owner_name || null,
    };
  }));
});

// ============================================================
// 附件磁盘配额（/admin/attachments）
// ============================================================
// 与上面几个「只读管理页」不同，这里是可写的 —— 但每一步都挂 requireSuper + audit，
// 且一次只做一件事（看用量 / 改配额 / 手动清理），不搞万能 PATCH。
const {
  getQuotaBytes,
  isQuotaLocked,
  normalizeQuotaMb,
  saveQuotaMb,
  usage,
  enforceQuota,
  DEFAULT_QUOTA_MB,
  MAX_QUOTA_MB,
  formatBytes,
} = require('./attachmentQuota');
const { ATTACHMENTS_DIR } = require('./paths');

/** 附件目录用量 + 当前配额（设置页「存储」分类用） */
router.get('/admin/attachments', requireSuper, (req, res) => {
  const u = usage(ATTACHMENTS_DIR);
  const quotaBytes = getQuotaBytes(db);
  res.json({
    files: u.files,
    bytes: u.bytes,
    bytesText: formatBytes(u.bytes),
    cachedFiles: u.cachedFiles,
    cachedBytes: u.cachedBytes,
    cachedBytesText: formatBytes(u.cachedBytes),
    quotaBytes,
    quotaMb: Math.round(quotaBytes / (1024 * 1024)),
    quotaBytesText: formatBytes(quotaBytes),
    unlimited: quotaBytes <= 0,
    quotaLocked: isQuotaLocked(),
    defaultQuotaMb: DEFAULT_QUOTA_MB,
    maxQuotaMb: MAX_QUOTA_MB,
  });
});

/** 改配额（MB）。0 = 不限。环境变量设了会返回 locked，改了不生效 */
router.put('/admin/attachments/quota', requireSuper, (req, res) => {
  if (isQuotaLocked()) {
    return res.status(409).json({
      error: '配额由环境变量 ATTACHMENTS_QUOTA_MB 锁定，请改环境变量',
      locked: true,
    });
  }
  const mb = normalizeQuotaMb(req.body && req.body.quotaMb);
  if (mb === null) {
    return res.status(400).json({
      error: `配额必须是 0（不限）到 ${MAX_QUOTA_MB} 之间的整数 MB`,
    });
  }
  const before = getQuotaBytes(db);
  saveQuotaMb(db, mb);

  audit.fromReq(req, {
    action: 'attachments.set_quota',
    target: String(mb),
    meta: { beforeMb: Math.round(before / (1024 * 1024)), afterMb: mb },
  });

  res.json({ quotaMb: mb, quotaBytes: mb * 1024 * 1024, unlimited: mb === 0 });
});

/** 手动跑一次回收（返回删了什么、现在用量多少） */
router.post('/admin/attachments/sweep', requireSuper, (req, res) => {
  const r = enforceQuota({ db, dir: ATTACHMENTS_DIR, quotaBytes: getQuotaBytes(db) });
  const u = usage(ATTACHMENTS_DIR);
  audit.fromReq(req, {
    action: 'attachments.sweep',
    target: ATTACHMENTS_DIR,
    meta: { removed: r.removed, freed: r.freed, stillOver: r.stillOver },
  });
  res.json({
    removed: r.removed,
    freed: r.freed,
    freedText: formatBytes(r.freed),
    skippedFresh: r.skippedFresh,
    stillOver: r.stillOver,
    unlimited: r.unlimited,
    bytes: u.bytes,
    bytesText: formatBytes(u.bytes),
    files: u.files,
  });
});

module.exports = router;
