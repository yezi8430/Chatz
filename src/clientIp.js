// ============================================================
// 客户端 IP 的唯一判定入口
// ============================================================
// 限速（rateLimit.js）和审计日志（audit.js）都必须走这里，
// 不能各自实现一遍 —— 两份逻辑一旦不一致，就会出现
// "限速按 A 地址算、日志里记的是 B 地址" 这种排查不动的坑。
//
// 为什么默认不信 X-Forwarded-For：
//   这个头是客户端自己带的，谁都能伪造。只要端口直接暴露在公网
//   （前面没有反向代理覆盖掉客户端传来的 XFF），攻击者每发一个请求
//   换一个 XFF 值，就能换一个限速 bucket —— 注册 / 登录限速等于失效。
//
// 所以策略是「默认只看 TCP 对端，显式开启才认 XFF」：
//
//   TRUST_PROXY 未设置 / false  →  req.ip（TCP 对端地址），XFF 完全不参与
//   TRUST_PROXY=true            →  XFF 第一段（最不安全，见下）
//   TRUST_PROXY=<正整数 N>      →  由 express 按跳数算，取 req.ip
//   TRUST_PROXY=<IP/CIDR 列表>  →  只信任来自这些地址的代理，其它来源不解析 XFF
//
// 三种"开"的方式，安全程度差很多（用 express 4 + proxy-addr 2 实测过）：
//
//   1. 跳数 N：取 XFF 倒数第 N 段，**不校验对端是不是真代理**。
//      所以端口若同时能绕过反代直连，攻击者伪造的 XFF 会被当成第 1 跳取出来。
//      → 用法：确保本端口只能由反代到达（防火墙只放行 80/443）。
//
//   2. 信任列表：**先校验对端**在不在列表里，不在就直接忽略 XFF。
//      即使端口暴露在公网也安全，是最稳的写法。
//      → 用法：TRUST_PROXY=172.17.0.1  或  172.16.0.0/12（docker 网桥网段）
//
//   3. true：直接取 XFF 第一段。反代用 $proxy_add_x_forwarded_for（追加）时，
//      客户端伪造的值就留在第一段 —— 开了等于把限速交出去。**不要用**。
//
// Nginx 侧两种写法都行，但建议显式覆盖：
//   proxy_set_header X-Forwarded-For $remote_addr;   ← 推荐（覆盖，只有一段真实值）
//   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;  ← 追加，配 N 仍正确，配 true 会出事

// `TRUST_PROXY=auto` 展开后的实际值。index.js 的启动日志要用它反推显示成 auto
const AUTO_TRUST_LIST = 'loopback,linklocal,uniquelocal';

// 日志 i18n（零依赖模块，这里 require 不会产生循环）
const i18n = require('./serverI18n');

// 返回：null（不信任）/ true（信任全部）/ 正整数 N（信任 N 跳）/ 字符串（信任指定地址）
function trustProxyConfig() {
  const raw = String(process.env.TRUST_PROXY ?? '').trim().toLowerCase();
  if (!raw || raw === 'false' || raw === 'off' || raw === '0' || raw === 'no') return null;
  if (raw === 'true' || raw === 'yes' || raw === 'on') return true;

  // ⚠️ 必须整串都是数字才能当跳数。用 Number.parseInt("172.18.0.5") 会得到 172，
  //    一个 IP 就这么被当成"信任 172 跳"了；"1.2.3.4/99" 同理会变成 1。
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n > 0) return n;
    return null;
  }

  // 别名：本机 / 内网来源一律当代理 —— 省得去 docker inspect 查反代的内网 IP。
  // 覆盖绝大多数自托管场景：
  //   NPM 装在宿主机 → 对端 127.0.0.1（loopback）
  //   NPM 是 Docker 容器 → 对端 172.17.0.1 / 172.18.0.1（uniquelocal）
  //   IPv6 ULA 内网 → fc00::/7（uniquelocal）
  // 代价：同内网的其它机器也被信任（见 README 的取舍说明）。
  if (raw === 'auto' || raw === 'private' || raw === 'local') {
    return AUTO_TRUST_LIST;
  }

  // 显式信任列表：IP / CIDR / 命名网段（loopback、uniquelocal、linklocal），逗号分隔。
  //
  // 这是比数字跳数更严的写法。数字模式下"第 N 跳"是按 XFF 里的位置取的，
  // 不校验对端是不是真的代理 —— 只要攻击者能绕过反代直连本端口并伪造 XFF，
  // 他伪造的那个值就会被当成"第 1 跳"取出来（实测确认）。
  // 指定地址时 proxy-addr 会先校验对端在不在列表里，不在就直接忽略 XFF。
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (list.length > 0 && list.every(isValidTrustEntry)) return list.join(',');

  // 认不出来的值：宁可不信任，也不要悄悄当成 true
    i18n.warn('trustProxy.unrecognized', { raw: process.env.TRUST_PROXY });
  i18n.warn('trustProxy.allowedValues');
  return null;
}

// 在交给 express 之前先自己校验一遍：proxyaddr.compile() 遇到非法值会直接抛
// TypeError，那会在启动阶段崩掉，不如提前降级成"不信任"并说明原因。
const NAMED_RANGES = new Set(['loopback', 'uniquelocal', 'linklocal']);
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
const IPV6_RE = /^[0-9a-f:.]+(?:\/\d{1,3})?$/;

function isValidTrustEntry(v) {
  if (NAMED_RANGES.has(v)) return true;

  const m4 = IPV4_RE.exec(v);
  if (m4) {
    for (let i = 1; i <= 4; i++) {
      if (Number(m4[i]) > 255) return false;
    }
    const bits = m4[5] === undefined ? 32 : Number(m4[5]);
    return bits >= 0 && bits <= 32;
  }

  // IPv6 / IPv6 CIDR：这里只做形状校验（必须含冒号且至少一个十六进制位，
  // 这样 ":::::" 之类会先被否掉），精确解析交给 proxy-addr
  return v.includes(':') && IPV6_RE.test(v) && /[0-9a-f]/.test(v);
}

// 给 express 的 app.set('trust proxy', ...) 用
function expressTrustProxy() {
  return trustProxyConfig();
}

/**
 * 取客户端 IP。
 * @param {object} req
 * @param {string|null} fallback 取不到时的兜底值
 */
function clientIp(req, fallback = 'unknown') {
  if (!req) return fallback;

  // 只有「显式信任全部代理」时才自己解析 XFF 第一段。
  // 数字跳数的情况交给 express —— 它已经按跳数算好了 req.ip，
  // 自己再取第一段反而会错（第一段可能就是被追加进来的伪造值）。
  if (trustProxyConfig() === true) {
    const xff = req.headers?.['x-forwarded-for'];
    if (xff) {
      const first = String(xff).split(',')[0].trim();
      if (first) return first;
    }
  }

  // 未开启信任时 req.ip 就是 socket 地址；开启跳数时是跳过的那一跳
  return req.ip || req.socket?.remoteAddress || fallback;
}

module.exports = { clientIp, trustProxyConfig, expressTrustProxy, isValidTrustEntry, AUTO_TRUST_LIST };
