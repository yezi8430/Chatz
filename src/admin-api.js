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

module.exports = router;
