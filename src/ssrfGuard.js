const dns = require('dns').promises;
const net = require('net');

/**
 * call_webhook 的目标地址守卫（SSRF 防护）
 *
 * ── 为什么需要 ──
 *
 * 路由规则的 `call_webhook` 动作会让**服务端**去请求一个由规则填写的 URL。
 * 触发者不是普通用户，但仍然是"能改路由规则的人" —— 也就是管理员。
 * 而在两级权限模型下，管理员（role 1）是可以分给别人的。
 *
 * 不设防的话，任何一个管理员都能让服务器去请求：
 *   · 内网其它机器（NAS、路由器、摄像头…）
 *   · 回环地址（本机其它端口）
 *   · 169.254.169.254（云厂商的元数据端点）
 * 而且 `body` 里带的是**完整消息内容**，所以不只是探测，还能把消息往外送。
 *
 * ── 为什么默认禁止内网，而不是直接全部禁止 ──
 *
 * 自托管场景里「告警 → 调家里 Home Assistant / Node-RED 的 webhook」是真实需求，
 * 那些地址本来就是内网。一刀切禁止会砍掉合理用法；默认放行又不安全。
 *
 * 所以取「**安全的默认值 + 明确的逃生开关**」：
 * 默认只放行公网地址；确实要打内网，自己设 `ALLOW_PRIVATE_WEBHOOK=1`。
 * 公开发布的镜像默认值必须是安全的那个。
 *
 * ── 已知局限（诚实写出来）──
 *
 * 域名在 `dns.lookup` 时解析到公网、真正 fetch 时却被改指内网
 * （DNS rebinding），理论上仍可绕过 —— 因为 undici 会重新解析一次。
 * 彻底解决要在 undici 的 connect 阶段锁定 IP（自定义 dispatcher），复杂得多。
 * 考虑到触发者需要管理员身份，这里接受这个残留风险。
 */

/** DNS 解析超时。解析慢不该把整条消息的处理拖住 */
const DNS_TIMEOUT_MS = 3000;

/**
 * 某个 IP 是否属于「不该由服务端主动访问」的网段
 *
 * @param {string} ip
 * @returns {boolean} true = 要拦下
 */
function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    const [a, b] = p;
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a === 10) return true;                         // 10.0.0.0/8   私有
    if (a === 127) return true;                        // 127.0.0.0/8  回环
    if (a === 169 && b === 254) return true;           // 169.254.0.0/16 链路本地（含云元数据 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12 私有
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16 私有
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 运营商级 NAT
    if (a >= 224) return true;                         // 多播 224/4 + 保留 240/4
    return false;
  }

  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;        // 未指定 / 回环
    if (s.startsWith('fe80')) return true;             // 链路本地
    if (s.startsWith('fc') || s.startsWith('fd')) return true; // 唯一本地地址 ULA
    // IPv4-mapped，如 ::ffff:127.0.0.1 —— 剥出来按 IPv4 再判一次
    const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isBlockedIp(m[1]);
    return false;
  }

  // 既不是 IPv4 也不是 IPv6，别冒险放行
  return true;
}

/**
 * 这个 URL 能不能作为 call_webhook 的目标
 *
 * @param {string} rawUrl
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function isWebhookTargetAllowed(rawUrl) {
  // 逃生开关：确实要打内网就显式打开，并在日志里看得到
  if (process.env.ALLOW_PRIVATE_WEBHOOK === '1') {
    return { ok: true, reason: 'ALLOW_PRIVATE_WEBHOOK=1，已放行' };
  }

  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'URL 无法解析' };
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `协议不允许：${u.protocol}` };
  }

  // hostname 对 IPv6 会带方括号，去掉
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: '缺少主机名' };

  // 直接写的 IP 字面量，不用走 DNS
  if (net.isIP(host)) {
    return isBlockedIp(host)
      ? { ok: false, reason: `目标 IP 属于内网/保留网段：${host}` }
      : { ok: true };
  }

  // 域名：解析出来逐个检查
  let addrs;
  try {
    addrs = await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('DNS 超时')), DNS_TIMEOUT_MS)),
    ]);
  } catch (e) {
    return { ok: false, reason: `DNS 解析失败：${e.message}` };
  }

  if (!addrs || addrs.length === 0) {
    return { ok: false, reason: 'DNS 无结果' };
  }

  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      return { ok: false, reason: `域名解析到内网地址：${host} → ${a.address}` };
    }
  }

  return { ok: true };
}

module.exports = { isWebhookTargetAllowed, isBlockedIp };
