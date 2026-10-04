const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const audit = require('./audit');
const { requireSuper } = require('./auth');

// ============================================================
// 工具函数
// ============================================================

// 拆出 PEM 里的每个 CERTIFICATE 块
function splitCerts(pem) {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
}

// 解析证书信息
function inspectCert(crtPem) {
  const blocks = splitCerts(crtPem);
  if (blocks.length === 0) {
    return { valid: false, reason: '没有找到 CERTIFICATE 块' };
  }

  let leaf;
  try {
    leaf = new crypto.X509Certificate(blocks[0]);
  } catch (e) {
    return { valid: false, reason: '解析失败：' + e.message };
  }

  const now = Date.now();
  const notBefore = new Date(leaf.validFrom).getTime();
  const notAfter = new Date(leaf.validTo).getTime();

  return {
    valid: true,
    certCount: blocks.length,
    subject: leaf.subject.replace(/\n/g, ', '),
    issuer: leaf.issuer.replace(/\n/g, ', '),
    validFrom: leaf.validFrom,
    validTo: leaf.validTo,
    expired: now > notAfter,
    notYetValid: now < notBefore,
    selfSigned: leaf.subject === leaf.issuer,
    hasChain: blocks.length >= 2,
  };
}

// 校验私钥格式
function inspectKey(keyPem) {
  try {
    const key = crypto.createPrivateKey(keyPem);
    return {
      valid: true,
      type: key.asymmetricKeyType,
      bits: key.asymmetricKeyDetails?.modulusLength,
    };
  } catch (e) {
    return { valid: false, reason: e.message };
  }
}

// 验证证书和私钥是否配对
function verifyKeyPair(crtPem, keyPem) {
  try {
    const privateKey = crypto.createPrivateKey(keyPem);
    const publicFromKey = crypto.createPublicKey(privateKey);

    const blocks = splitCerts(crtPem);
    if (blocks.length === 0) return { match: false, reason: '没有证书' };

    const leaf = new crypto.X509Certificate(blocks[0]);
    const publicFromCert = leaf.publicKey;

    const a = publicFromKey.export({ type: 'spki', format: 'pem' });
    const b = publicFromCert.export({ type: 'spki', format: 'pem' });

    return { match: a === b };
  } catch (e) {
    return { match: false, reason: e.message };
  }
}

// ============================================================
// 主逻辑
// ============================================================
function createCertsRouter({ certsDir, onCertsUpdated, onCertsRemoved }) {
  const router = express.Router();
  const CRT = path.join(certsDir, 'fullchain.pem');
  const KEY = path.join(certsDir, 'privkey.pem');

  // 只允许超级管理员 —— 证书是「服务器级」操作，普通管理员（role 1）够不到。
  //
  // ⚠️ 必须走统一的 requireSuper，**不要**以前那样内联一个 if：
  //    内联版本不记越权审计（`requireSuper` 会 `audit.logThrottled` 记 `auth.forbidden_super`），
  //    于是别人拿普通账号试探 /certs/* 在审计里完全看不到；而且措辞是"需要管理员权限"，
  //    与实际检查的 isSuper 不符（会误导排查方向）。
  router.use('/certs', requireSuper);

  function readFiles() {
    return {
      hasCrt: fs.existsSync(CRT),
      hasKey: fs.existsSync(KEY),
    };
  }

  // ============================================================
  // GET /certs/status — 真实状态
  // ============================================================
  router.get('/certs/status', (req, res) => {
    const { hasCrt, hasKey } = readFiles();
    const httpsEnabled = hasCrt && hasKey;

    let certInfo = null;
    let keyInfo = null;
    let keyMatch = null;
    let error = null;

    if (hasCrt) {
      try {
        certInfo = inspectCert(fs.readFileSync(CRT, 'utf8'));
      } catch (e) {
        error = '读取证书失败：' + e.message;
      }
    }
    if (hasKey) {
      try {
        keyInfo = inspectKey(fs.readFileSync(KEY, 'utf8'));
      } catch (e) {
        error = '读取私钥失败：' + e.message;
      }
    }
    if (hasCrt && hasKey) {
      try {
        const kp = verifyKeyPair(
          fs.readFileSync(CRT, 'utf8'),
          fs.readFileSync(KEY, 'utf8')
        );
        keyMatch = kp.match;
        if (!kp.match) {
          error = '证书与私钥不匹配' + (kp.reason ? '：' + kp.reason : '');
        }
      } catch (e) {
        error = e.message;
      }
    }

    res.json({
      httpsEnabled,
      hasCrt,
      hasKey,
      certInfo,
      keyInfo,
      keyMatch,
      error,
    });
  });

  // ============================================================
  // POST /certs/fullchain
  // ============================================================
  router.post('/certs/fullchain', async (req, res) => {
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: '请求内容为空' });
    }
    const content = req.body.toString('utf8');

    // 解析证书
    const info = inspectCert(content);
    if (!info.valid) {
      return res.status(400).json({ error: '证书无效：' + info.reason });
    }
    if (info.expired) {
      return res.status(400).json({
        error: '证书已过期',
        hint: 'validTo: ' + info.validTo,
      });
    }
    if (info.notYetValid) {
      return res.status(400).json({
        error: '证书尚未生效',
        hint: 'validFrom: ' + info.validFrom,
      });
    }

    // 如果私钥已经存在，先验证配对
    if (fs.existsSync(KEY)) {
      const keyPem = fs.readFileSync(KEY, 'utf8');
      const kp = verifyKeyPair(content, keyPem);
      if (!kp.match) {
        return res.status(400).json({
          error: '证书与已上传的私钥不匹配',
          hint: '请确认它们是同一个证书对',
        });
      }
    }

    // 写临时文件，再原子替换
    const tmp = CRT + '.new';
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, CRT);

    // 只有证书和私钥都齐了才触发 HTTPS
    const hasKey = fs.existsSync(KEY);

    if (!hasKey) {
      // 只上传了证书，正常等待私钥
      audit.fromReq(req, {
        action: 'certs.upload.crt',
        meta: { subject: info.subject, validTo: info.validTo, certCount: info.certCount, httpsStarted: false },
      });
      return res.json({
        ok: true,
        certInfo: {
          subject: info.subject,
          issuer: info.issuer,
          validTo: info.validTo,
          certCount: info.certCount,
          hasChain: info.hasChain,
        },
        httpsStarted: false,
        message: '证书已保存，等待上传私钥',
      });
    }

    // 两边都齐了，触发启动/热更新
    let result = { ok: true, started: false };
    if (typeof onCertsUpdated === 'function') {
      try {
        result = await onCertsUpdated();
      } catch (e) {
        result = { ok: false, error: e.message };
      }
    }

    // 只记元信息，绝不记 PEM 内容 —— 私钥一旦进审计日志，
    // 就等于让所有能看 /audit 的人拿到了 TLS 私钥
    const crtMeta = {
      subject: info.subject,
      validTo: info.validTo,
      certCount: info.certCount,
      httpsStarted: !!result.started,
    };

    if (!result.ok) {
      audit.fromReq(req, {
        action: 'certs.upload.crt',
        success: false,
        meta: { ...crtMeta, error: result.error || '未知错误' },
      });
      return res.status(500).json({
        error: '证书已保存，但 HTTPS 启动失败：' + (result.error || '未知错误'),
        hint: '请查看服务端日志',
      });
    }

    audit.fromReq(req, { action: 'certs.upload.crt', meta: crtMeta });

    res.json({
      ok: true,
      certInfo: {
        subject: info.subject,
        issuer: info.issuer,
        validTo: info.validTo,
        certCount: info.certCount,
        hasChain: info.hasChain,
      },
      httpsStarted: result.started,
      message: result.started
        ? '证书已上传，HTTPS 已启用'
        : '证书已更新，HTTPS 已热重载',
    });
  });

  // ============================================================
  // POST /certs/privkey
  // ============================================================
  router.post('/certs/privkey', async (req, res) => {
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: '请求内容为空' });
    }
    const content = req.body.toString('utf8');

    // 校验私钥格式
    const ki = inspectKey(content);
    if (!ki.valid) {
      return res.status(400).json({ error: '私钥无效：' + ki.reason });
    }

    // 如果证书已存在，先验证配对
    if (fs.existsSync(CRT)) {
      const crtPem = fs.readFileSync(CRT, 'utf8');
      const kp = verifyKeyPair(crtPem, content);
      if (!kp.match) {
        return res.status(400).json({
          error: '私钥与已上传的证书不匹配',
          hint: '请确认它们是同一个证书对',
        });
      }
    }

    const tmp = KEY + '.new';
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, KEY);

    // 只有证书和私钥都齐了才触发 HTTPS
    const hasCrt = fs.existsSync(CRT);

    if (!hasCrt) {
      // 私钥类型 / 位数可以记，密钥内容本身不能进日志
      audit.fromReq(req, {
        action: 'certs.upload.key',
        meta: { type: ki.type, bits: ki.bits, httpsStarted: false },
      });
      return res.json({
        ok: true,
        keyInfo: { type: ki.type, bits: ki.bits },
        httpsStarted: false,
        message: '私钥已保存，等待上传证书',
      });
    }

    let result = { ok: true, started: false };
    if (typeof onCertsUpdated === 'function') {
      try {
        result = await onCertsUpdated();
      } catch (e) {
        result = { ok: false, error: e.message };
      }
    }

    const keyMeta = { type: ki.type, bits: ki.bits, httpsStarted: !!result.started };

    if (!result.ok) {
      audit.fromReq(req, {
        action: 'certs.upload.key',
        success: false,
        meta: { ...keyMeta, error: result.error || '未知错误' },
      });
      return res.status(500).json({
        error: '私钥已保存，但 HTTPS 启动失败：' + (result.error || '未知错误'),
        hint: '请查看服务端日志',
      });
    }

    audit.fromReq(req, { action: 'certs.upload.key', meta: keyMeta });

    res.json({
      ok: true,
      keyInfo: { type: ki.type, bits: ki.bits },
      httpsStarted: result.started,
      message: result.started
        ? '私钥已上传，HTTPS 已启用'
        : '私钥已更新，HTTPS 已热重载',
    });
  });

  // ============================================================
  // DELETE /certs — 真删 + 关闭 HTTPS
  // ============================================================
  router.delete('/certs', (req, res) => {
    const { hasCrt, hasKey } = readFiles();

    try { if (hasCrt) fs.unlinkSync(CRT); } catch {}
    try { if (hasKey) fs.unlinkSync(KEY); } catch {}

    let stopped = false;
    if (typeof onCertsRemoved === 'function') {
      try {
        const r = onCertsRemoved();
        stopped = r?.stopped || false;
      } catch {}
    }

    // 删证书 = 主动关掉 HTTPS 让全站退回明文，属于安全相关操作
    audit.fromReq(req, {
      action: 'certs.delete',
      meta: { hadCrt: hasCrt, hadKey: hasKey, httpsStopped: stopped },
    });

    res.json({
      ok: true,
      message: '证书已删除',
      httpsStopped: stopped,
      note: stopped
        ? 'HTTPS 服务已关闭'
        : 'HTTPS 服务仍在运行（已有连接不受影响，重启容器完全关闭）',
    });
  });

  return router;
}

module.exports = { createCertsRouter };
