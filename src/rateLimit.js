const { clientIp } = require('./clientIp');

// 计数器仓库：key = `${实例命名空间}:${业务维度}`，见下面 rateLimit() 的说明。
// 单个进程内存态，重启即清空 —— 自托管场景可以接受。
const buckets = new Map();

// 每分钟清理过期 bucket
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}, 60000).unref();

// 限速 key 的基础维度：客户端 IP。
//
// 以前这里是无条件取 XFF 第一段 —— 那个头客户端可以随便伪造，
// 端口一旦直接对外，攻击者每请求换一个 XFF 就换一个 bucket，
// 注册 / 登录限速形同虚设。现在收敛到 clientIp.js：
// 默认只看 TCP 对端地址，只有显式设置 TRUST_PROXY 才认 XFF。
function defaultKey(req) {
  return clientIp(req);
}

// ⚠️ 每个 rateLimit 实例必须有自己的 key 命名空间，别再退回裸 IP。
//
// buckets 是**模块级共享**的 Map，而 defaultKey 只返回 IP。所以只要某个
// limiter 不写 keyFn，它和别的裸 limiter 就是同一个计数器：
//   全局限速（600/分钟，index.js）先把 count 推到几十 →
//   改密码限速（10/10分钟，users.js）直接判定超限 → 用户第一次点就报
//   「操作过于频繁，请稍后再试」，而且每重试一次自己又 +1，页面还有别的
//   请求就永远出不来。（2026-09-29 用户实测踩到，已用复现脚本确认。）
//
// 现在自动加 ns 前缀，实例之间彻底隔离；传 name 只是为了让 bucket 的
// key 可读，方便以后 debug。
let nsSeq = 0;

function rateLimit({ windowMs = 60000, max = 60, keyFn, message, name } = {}) {
  const ns = name || `rl#${++nsSeq}`;
  return (req, res, next) => {
    const key = ns + ':' + (keyFn ? keyFn(req) : defaultKey(req));
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > max) {
      const retryAfter = Math.ceil((b.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: message || '请求过于频繁，请稍后再试',
        retryAfter,
      });
    }
    next();
  };
}


// ============================================================
// 手动计数：给「只有失败才该计数」的场景用（比如频道订阅密码输错）
//
// 普通的 rateLimit 是中间件，**每次请求都 +1**，不管结果。但「密码错误」
// 是失败才要计，成功不计 —— 用中间件会把正确的订阅也计进去，反而误伤。
// 所以这里提供一个手动版：调用方在失败分支里 consume 一次。
//
// 返回 0 = 还没超限；>0 = 已超限，返回剩余冷却秒数（调用方据此回 429 + Retry-After）。
// ============================================================
function consume(namespace, windowMs, max) {
  const now = Date.now();
  let b = buckets.get(namespace);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(namespace, b);
  }
  b.count++;
  return b.count > max ? Math.ceil((b.resetAt - now) / 1000) : 0;
}

// ============================================================
// 登录专用：双维度限速
//   - 每个 IP 每 5 分钟 30 次（防扫描）
//   - 每个 IP + 用户名 每 5 分钟 5 次（防爆破单账号）
// ============================================================
function rateLimitLogin() {
  const ipLimit = rateLimit({
    windowMs: 300000, max: 30,
    name: 'login-ip',
    keyFn: (req) => 'login-ip:' + defaultKey(req),
    message: '登录尝试过多，请 5 分钟后再试',
  });

  const userLimit = rateLimit({
    windowMs: 300000, max: 5,
    name: 'login-user',
    keyFn: (req) => {
      const ip = defaultKey(req);
      const username = (req.body?.username || '').toString().slice(0, 64);
      return `login-user:${ip}:${username}`;
    },
    message: '该账号登录尝试过多，请 5 分钟后再试',
  });

  return [ipLimit, userLimit];
}

module.exports = { rateLimit, rateLimitLogin, defaultKey, consume };
