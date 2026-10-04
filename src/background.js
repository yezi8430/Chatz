const express = require('express');
const fs = require('fs');
const path = require('path');
const audit = require('./audit');

function createBackgroundRouter({ backgroundDir, onBackgroundUpdated }) {
  const router = express.Router();

  function userDir(userId) {
    const dir = path.join(backgroundDir, 'user-' + userId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function metaPath(userId) {
    return path.join(userDir(userId), 'meta.json');
  }

  function getCurrent(userId) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath(userId), 'utf8'));
      const file = path.join(userDir(userId), meta.filename);
      if (fs.existsSync(file)) return meta;
    } catch {}
    return null;
  }

  // GET /background  — 返回当前用户的背景状态
  router.get('/background', (req, res) => {
    const userId = req.user.id;
    const cur = getCurrent(userId);
    if (cur) {
      res.json({
        enabled: true,
        url: `/background-files/user-${userId}/${cur.filename}`,
        uploadedAt: cur.uploadedAt,
      });
    } else {
      res.json({ enabled: false });
    }
  });

  // POST /background  — 上传当前用户的背景
  router.post('/background',
    express.raw({ type: 'image/*', limit: '8mb' }),
    (req, res) => {
      const userId = req.user.id;

      if (!req.body || req.body.length === 0) {
        return res.status(400).json({ error: '请求内容为空' });
      }

      const { detectImageExt } = require('./sanitize');
      const ext = detectImageExt(req.body);
      if (!ext || ext === 'svg') {
        return res.status(400).json({ error: '图片格式不支持（仅 png/jpg/webp）' });
      }

      // 删除旧文件
      const cur = getCurrent(userId);
      if (cur) {
        try { fs.unlinkSync(path.join(userDir(userId), cur.filename)); } catch {}
      }

      const filename = `bg-${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(userDir(userId), filename), req.body);
      fs.writeFileSync(metaPath(userId), JSON.stringify({ filename, uploadedAt: Date.now() }));

      onBackgroundUpdated?.();

      // 和头像一样属于「往服务器写文件」的动作，记一笔（只记文件名，不记内容）
      audit.fromReq(req, { action: 'user.background.upload', target: filename });

      res.json({
        ok: true,
        url: `/background-files/user-${userId}/${filename}`,
      });
    }
  );

  // DELETE /background  — 删除当前用户的背景
  router.delete('/background', (req, res) => {
    const userId = req.user.id;
    const cur = getCurrent(userId);
    if (cur) {
      try { fs.unlinkSync(path.join(userDir(userId), cur.filename)); } catch {}
    }
    try { fs.unlinkSync(metaPath(userId)); } catch {}
    onBackgroundUpdated?.();

    audit.fromReq(req, {
      action: 'user.background.delete',
      target: cur ? cur.filename : null,
    });

    res.json({ ok: true });
  });

  return router;
}

module.exports = { createBackgroundRouter };
