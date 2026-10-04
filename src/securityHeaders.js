// ============================================================
// 安全响应头
// ============================================================
// 目前服务端一个安全头都没发，浏览器只能按最宽松的默认行为处理，
// 主要缺口是：可被 <iframe> 嵌套（点击劫持）、Referer 会把 URL 里的
// ?token= 带给第三方、以及完全没有 CSP 兜底。

// HSTS 默认关闭。
//
// 为什么默认不开：HSTS 是"一旦下发、浏览器就记住"，max-age 到期前
// 无法撤销。自建服务经常换证书 / 换域名 / 临时退回 HTTP 调试，
// 一旦证书出问题或者改用 IP 访问，浏览器会**硬拒绝**连接，
// 而且普通用户不知道怎么清。所以把它做成显式开启：
//   HSTS_MAX_AGE=15552000   （180 天，常见取值）
function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? String(fallback), 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

const HSTS_MAX_AGE = envInt('HSTS_MAX_AGE', 0);
const HSTS_INCLUDE_SUBDOMAINS = (process.env.HSTS_INCLUDE_SUBDOMAINS || '').toLowerCase() === 'true';

// Host 头是客户端可控的，拼进 CSP 之前先校验形状，别把任意字符串塞进响应头
const HOST_RE = /^[A-Za-z0-9._-]+(:\d{1,5})?$/;

// CSP 里唯一需要按请求定制的部分：WebSocket 的目标。
// 页面连的是 `${proto}//${location.host}/stream`，也就是和页面同一个 host+port，
// 但 scheme 是 ws/wss —— CSP 的 'self' 只认 http/https 同 scheme，
// 光写 'self' 会把 WebSocket 挡掉（表现为 WebUI 连不上实时推送）。
// 所以按请求的 Host 显式放行 ws/wss 到同一 host。
function wsSources(host) {
  if (host && HOST_RE.test(host)) return `ws://${host} wss://${host}`;
  // Host 畸形（或被伪造）时退回通配 —— 只是放宽这一条，不至于把 CSP 整体作废
  return 'ws: wss:';
}

function buildCsp(host) {
  return [
    "default-src 'self'",
    // 只允许自家脚本 + WebUI 用于 markdown 渲染的两个 CDN 库。
    // 注意：不能加 'unsafe-inline' —— 加它就等于 CSP 对 XSS 基本失效。
    // 代价是 index.html 里不能写内联 <script>（已外置到 /boot.js）。
    "script-src 'self' https://cdn.jsdelivr.net",
    // 'unsafe-inline' 是必需的：页面里大量用 style="..." 内联属性，
    // 不改完所有模板之前去掉就会整页掉样式。CSS 注入的危害远小于 JS，可接受。
    "style-src 'self' 'unsafe-inline'",
    // 消息里的封面图、markdown 图片可以来自任意外链，必须放开 https/http
    "img-src 'self' data: blob: https: http:",
    `connect-src 'self' ${wsSources(host)}`,
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    "frame-src 'none'",
    // 禁止被嵌套（点击劫持）。X-Frame-Options 是给不支持 CSP3 的老浏览器兜底
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

function createSecurityHeaders() {
  return (req, res, next) => {
    // 别告诉外面这是 Express
    res.removeHeader('X-Powered-By');

    // 阻止浏览器猜 MIME 类型（把 text/plain 当 HTML 执行）
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // 老的点击劫持防护（覆盖面比 frame-ancestors 广）
    res.setHeader('X-Frame-Options', 'DENY');

    // URL 里带 ?token= 的接口（/stream、Gotify 兼容的 /message?token=）
    // 会把凭据塞进 Referer 发给任何外链目标，no-referrer 直接掐掉
    res.setHeader('Referrer-Policy', 'no-referrer');

    // 这个页面不需要任何设备能力，全关掉
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');

    res.setHeader('Content-Security-Policy', buildCsp(req.headers.host));

    // 只在确实是 HTTPS 的时候下发：明文响应上的 HSTS 会被浏览器忽略，
    // 发过去只是白占带宽；而通过反代访问时 req.secure 由 X-Forwarded-Proto 决定，
    // 所以前置反代必须同时设置 TRUST_PROXY，否则这里永远是 false。
    if (HSTS_MAX_AGE > 0 && req.secure) {
      res.setHeader(
        'Strict-Transport-Security',
        `max-age=${HSTS_MAX_AGE}${HSTS_INCLUDE_SUBDOMAINS ? '; includeSubDomains' : ''}`
      );
    }

    next();
  };
}

module.exports = { createSecurityHeaders, buildCsp, HSTS_MAX_AGE };
