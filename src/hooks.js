const express = require('express');
const db = require('./db');
const { renderTemplate } = require('./template');
const { createMessage } = require('./messageCreate');
const { rateLimit } = require('./rateLimit');
const audit = require('./audit');
const { tokenPrefix } = require('./tokenGen');

const router = express.Router();

// ============================================================
// 模板预览（无鉴权，但限速）
// ============================================================
router.post('/hook/preview',
  rateLimit({ windowMs: 60000, max: 30, name: 'hook-preview', message: '预览过于频繁' }),
  (req, res) => {
    let body = req.body;
    if (Buffer.isBuffer(body)) {
      try { body = JSON.parse(body.toString('utf8')); }
      catch { return res.status(400).json({ error: 'JSON 格式错误' }); }
    }
    const { template, data } = body || {};
    if (!template) return res.status(400).json({ error: '缺少 template' });

    let tpl;
    try { tpl = typeof template === 'string' ? JSON.parse(template) : template; }
    catch { return res.status(400).json({ error: 'template 不是合法的 JSON' }); }

    try {
      const rendered = renderTemplate(tpl, data || {});
      res.json({ ok: true, rendered });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// ============================================================
// 解析 multipart/form-data
// ============================================================
/**
 * 手写一个最小的 multipart 解析（不引 multer 之类的依赖，这里只需要文本字段）
 *
 * 为什么需要：qBittorrent 这类外部程序习惯用 `curl -F` 推送。种子名里经常带
 * 空格、引号、百分号、方括号，用 JSON 拼字符串很容易转义出错，而 `-F` 天然安全。
 * 原来不认这种格式，整段报文会被当成消息正文 —— 表现就是内容里出现
 * `------xxxx\r\nContent-Disposition: form-data; name="title"` 这一大坨。
 *
 * 只取文本字段（name / 值），文件内容直接忽略 —— webhook 用不上。
 */
function parseMultipart(text, boundary) {
  const result = {};
  if (!boundary) return null;

  for (const part of text.split('--' + boundary)) {
    const trimmed = part.trim();
    // 跳过开头空段和结尾的 "--"
    if (!trimmed || trimmed === '--') continue;

    // 头与正文之间是空行（兼容 CRLF 与 LF）
    const sep = trimmed.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
    const idx = trimmed.indexOf(sep);
    if (idx < 0) continue;

    const headers = trimmed.slice(0, idx);
    let value = trimmed.slice(idx + sep.length);
    // 去掉分隔线前残留的换行
    value = value.replace(/\r?\n$/, '');

    const nameMatch = headers.match(/name\s*=\s*"([^"]+)"/i)
      || headers.match(/name\s*=\s*([^;\r\n]+)/i);
    if (!nameMatch) continue;

    result[nameMatch[1].trim()] = value;
  }

  return Object.keys(result).length ? result : null;
}

// ============================================================
// 解析 body
// ============================================================
function parseBody(req) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  const raw = req.body;

  if (!raw || raw.length === 0) {
    const q = req.query || {};
    if (q.message) {
      return {
        message: String(q.message),
        title: q.title ? String(q.title) : null,
        priority: q.priority != null ? parseInt(q.priority, 10) : null,
        channel_id: q.channel_id != null ? parseInt(q.channel_id, 10) : null,
        tags: q.tags ? String(q.tags).split(',').map(s => s.trim()).filter(Boolean) : null,
        _isJSON: false,
      };
    }
    return { message: '', _isJSON: false };
  }

  const text = raw.toString('utf8');

  // multipart/form-data（curl -F）：解析成普通字段，
  // 否则整段报文会被当成消息正文（见 parseMultipart 的说明）
  if (ct.includes('multipart/form-data')) {
    const bm = ct.match(/boundary=(?:"([^"]+)"|([^;\r\n]+))/i);
    const boundary = bm ? (bm[1] || bm[2]).trim() : null;
    const form = parseMultipart(text, boundary);
    if (form) {
      // 表单里取值全是字符串，按 JSON 那套语义转成对应类型
      if (form.priority != null) form.priority = parseInt(form.priority, 10);
      if (form.channel_id != null) form.channel_id = parseInt(form.channel_id, 10);
      if (typeof form.tags === 'string') {
        form.tags = form.tags.split(',').map(s => s.trim()).filter(Boolean);
      }
      if (form.silent != null) form.silent = form.silent === 'true' || form.silent === '1';
      return { ...form, _isJSON: false };
    }
  }

  if (ct.includes('application/json') || text.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      return { ...parsed, _isJSON: true };
    } catch {
      return { message: text, _isJSON: false };
    }
  }

  return { message: text, _isJSON: false };
}

// ============================================================
// Webhook 入口（按 token 限速：每分钟 60 次）
// ============================================================
router.post('/hook/:token',
  rateLimit({
    windowMs: 60000,
    max: 60,
    name: 'hook',
    keyFn: (req) => 'hook:' + req.params.token,
    message: '该 Webhook 调用过于频繁',
  }),
  (req, res) => {
    if (req.params.token === 'preview') return;

    const app = db.prepare('SELECT * FROM applications WHERE token = ?').get(req.params.token);
    if (!app) {
      // token 不对 = 有人在扫 webhook 地址。这个信号值得留，
      // 但攻击者能一分钟刷几百次，逐条记会直接把审计表撑爆，
      // 所以按 IP 节流成 5 分钟一条（见 audit.logThrottled）。
      //
      // 只记 token 前 3 位：够用来和别的日志对上，又不会把别人（可能接近正确的）
      // 凭据原文写进数据库 —— 审计表是给管理员在 WebUI 上翻的，不该存密钥原文。
      //
      // ⚠️ 这个位数必须跟着 token 长度走：token 从 48 位缩到 10 位之后，
      //    原来取 8 位等于把 80% 的凭据写进审计表，脱敏就名存实亡了。
      //    常量定义在 tokenGen.js（TOKEN_PREFIX_LEN），改长度时一起看。
      audit.logThrottled('hook-bad-token:' + audit.getIp(req), 300000, {
        ip: audit.getIp(req),
        action: 'hook.bad_token',
        success: false,
        meta: { tokenPrefix: tokenPrefix(req.params.token) },
      });
      return res.status(404).json({ error: '应用 Token 无效' });
    }

    res.json({ received: true, appid: app.id });

    setImmediate(() => {
      try {
        const data = parseBody(req);
        const isJSON = data._isJSON;

        if (!isJSON) {
          const q = req.query || {};
          if (q.title != null) data.title = String(q.title);
          if (q.priority != null) data.priority = parseInt(q.priority, 10);
          if (q.channel_id != null) data.channel_id = parseInt(q.channel_id, 10);
          if (q.tags != null) {
            data.tags = String(q.tags).split(',').map(s => s.trim()).filter(Boolean);
          }
          if (q.silent != null) data.silent = q.silent === 'true' || q.silent === '1';
        }

        const final = {};

        if (app.template && isJSON) {
          try {
            const tpl = JSON.parse(app.template);
            const rendered = renderTemplate(tpl, data);
            final.title = rendered.title;
            final.message = rendered.message;
            final.priority = rendered.priority;
            final.extras = rendered.extras;
            final.tags = rendered.tags;
          } catch (e) {
            console.error('[hook] 模板渲染失败:', e.message);
          }
        }

        if (!final.message) {
          final.title = final.title || data.title || app.name;
          final.message = data.message != null ? String(data.message) : '';
          final.priority = final.priority != null ? final.priority : (data.priority || 5);
          final.tags = final.tags || data.tags;
          final.extras = final.extras || data.extras;
        }

        if (!final.message || !final.message.trim()) return;

        if (typeof final.message !== 'string') final.message = JSON.stringify(final.message);
        const p = parseInt(final.priority, 10);
        final.priority = isNaN(p) ? 5 : p;

        const channel_id = data.channel_id != null ? data.channel_id : app.channel_id;
        const silent = data.silent === true;

        const result = createMessage({
          appid: app.id,
          channel_id,
          title: final.title,
          message: final.message,
          priority: final.priority,
          extras: final.extras,
          tags: final.tags,
          silent,
        });

        // 被权限/存在性校验挡下：响应在 setImmediate 之前就已经发了
        // （webhook 是 fire-and-forget，不能让第三方等着），所以这里只能记日志。
        // 消息不会落库 —— 安全目标是达成的，但排查全靠这条日志，必须打出来。
        if (result?.error) {
          console.warn(`[hook] ${app.name} -> 已拒绝: ${result.error}`);
          return;
        }

        if (result?.dropped) {
          console.log(`[hook] ${app.name} -> 被路由规则丢弃`);
        }
      } catch (e) {
        console.error('[hook] error:', e);
      }
    });
  }
);

module.exports = { router };
