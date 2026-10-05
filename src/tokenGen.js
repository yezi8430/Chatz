const crypto = require('crypto');

/**
 * Token 生成器
 *
 * 两类凭据都在这里生成：
 *   - 应用 Token（generateAppToken）：发件人凭据，被写进 Webhook 地址
 *         POST {地址}/hook/{应用Token}
 *   - 设备 Token（generateDeviceToken）：登录凭据，形如 cz.xxxxxxxxxxxxxx
 *
 * ⚠️ 这里**只**放纯生成逻辑，绝不 require db / 不查重。
 *
 * 原因：本文件被 migrate.js 引用，而 migrate.js 是被 db.js **在模块顶层**
 * 同步 require 的（db.js:4）。只要这里碰了 db，就会形成
 * `db → migrate → tokenGen → db` 的循环依赖，Node 会返回一个不完整的
 * exports，报错信息还很难懂。查重/重试请放在调用点做（见 index.js）。
 *
 * ── 为什么是 10 位、62 进制 ──
 * 密钥空间 62^10 ≈ 8.4e17，熵 ≈ 59.5 比特。
 * 配合 hook 端点的限流（60 次/分钟），线上爆破撞中概率约 1.2e-15；
 * 即使限流完全失效，全量穷举也要 265 万年 —— 物理上不可行。
 * 这是刻意选在「不依赖任何防护措施也安全」的那一侧。
 *
 * （对比：6 位只有 35.7 比特，全量穷举 66 天，安全性完全押在限流不出错上，
 *   所以没有采用。详见 2026-09-29 的讨论记录。）
 */

/** 字符集：大写 + 小写 + 数字（62 个） */
const TOKEN_CHARSET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Token 长度 */
const TOKEN_LENGTH = 10;

/** 审计日志里保留的 token 前缀长度。
 *
 * 曾用 8 —— 那是给 48 位 token 设计的。10 位 token 取前 8 位等于泄露 80%，
 * 脱敏就形同虚设，所以跟着缩到 3。
 * 够用来和别的日志对上，又不会把凭据原文写进审计表。
 */
const TOKEN_PREFIX_LEN = 3;

/**
 * 生成一枚应用 Token
 *
 * ⚠️ 必须用 crypto.randomBytes —— 不能用 Math.random()。
 * Math.random() 在 V8 里是 xorshift128+ 伪随机，**可通过若干输出反推出内部状态**，
 * 知道几枚 token 就能预测后面生成的。凭据生成绝不能用它。
 *
 * 这里用「拒绝采样」（rejection sampling）而不是 `byte % 62`：
 * 62 不整除 256，直接取模会让前 8 个字符（0..7 对应的映射）出现概率略高
 * （256 = 4*62 + 8，余数 8 个值被多算一次）。虽然偏差极小，
 * 但既然都写了，不如做对 —— 丢弃落在 [248, 255] 的字节重取即可。
 *
 * @returns {string} 10 位大小写+数字的随机串
 */
function generateAppToken() {
  const charsetLen = TOKEN_CHARSET.length; // 62
  // 可安全取模的上界：248 = 62 * 4。>= 248 的字节会造成分布不均，丢弃。
  const maxValid = Math.floor(256 / charsetLen) * charsetLen;

  let out = '';
  while (out.length < TOKEN_LENGTH) {
    // 多取一些，通常一轮就够（需要丢弃的概率只有 8/256 ≈ 3%）
    const buf = crypto.randomBytes(TOKEN_LENGTH * 2);
    for (let i = 0; i < buf.length && out.length < TOKEN_LENGTH; i++) {
      const b = buf[i];
      if (b >= maxValid) continue;
      out += TOKEN_CHARSET[b % charsetLen];
    }
  }
  return out;
}

/**
 * 截取 token 前缀，用于审计日志脱敏
 * @param {string} token
 * @returns {string}
 */
function tokenPrefix(token) {
  return String(token || '').slice(0, TOKEN_PREFIX_LEN);
}

// ============================================================
// 设备 Token
// ============================================================
//
// 设备 Token 是「登录凭据」：浏览器 localStorage、手机客户端配置里存的就是它。
// 它是长期凭据，不是一次性令牌。
//
// ── 为什么要加前缀 ──
// 用户的要求是「一眼能认出这是 Chatz 的凭据」。加固定前缀后：
//   · 日志/截图里能立刻分辨是 Chatz 的设备 Token，还是别的服务串进来的
//   · 粘贴到「用 Token 登录」输入框时，拼错/漏字符能被前端一眼看出来
//   · 用 `cz.` 开头，正好和「应用 Token」区分开 —— 后者没有前缀，
//     因为它要嵌入 Webhook URL 被第三方填进配置，越朴素越不容易被转义出错
//
// ⚠️ 前缀**不是**安全边界：
//   认证判定始终是「整串去 devices 表做等值匹配」（auth.js resolveToken），
//   没有任何地方靠前缀来放行或拒绝。所以前缀可以被伪造，
//   但它伪造不出「表里有这一行」。
//
// ── 为什么是 base62 而不是 hex ──
// hex 只有 16 个字符，30 位 hex 里的熵和 30 位 base62 差一倍多。
// 用 62 进制能把长度压短，同时保住熵。
//
// ── 熵 ──
// DEVICE_TOKEN_BODY_LEN = 30 位 base62 → 62^30 ≈ 6.2e53，熵 ≈ 178.6 比特。
//   全量穷举 ~5.4e36 年（不可行）；配合全局 600 次/分钟限流更无从下手。
// 对比旧的 64 位 hex（256 比特）：降幅巨大但**离危险线极远**，
//   仍然是「不依赖任何防护措施也安全」的量级。
//
// ── 长度 ──
// 30 位 body + `cz.` 前缀 = 33 字符。
// ⚠️ 别缩到 20 位以下：20 位 base62 ≈ 119 比特，虽然仍然安全，
//    但收益已经不大了 —— 短到能被暴力猜的区间（< 80 比特）之前，
//    每减一位都是在拿安全换「看起来短一点」，不划算。

/** 设备 Token 的固定前缀。**改这里要考虑存量**：devices 表里已发出去的不会变 */
const DEVICE_TOKEN_PREFIX = 'cz.';

/** 设备 Token 前缀之后的本体长度（base62 字符数） */
const DEVICE_TOKEN_BODY_LEN = 30;

/**
 * 生成一枚设备 Token：`cz.` + 30 位 base62
 *
 * 与应用 Token 同样用**拒绝采样**，理由见 generateAppToken 的注释
 * （62 不整除 256，直接取模会让前 8 个字符概率略高）。
 *
 * ⚠️ 同样必须用 crypto.randomBytes。Math.random() 可被反推内部状态，
 * 凭据生成绝不能用它。
 *
 * @returns {string} 形如 `cz.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`（33 字符）
 */
function generateDeviceToken() {
  const charsetLen = TOKEN_CHARSET.length; // 62
  const maxValid = Math.floor(256 / charsetLen) * charsetLen; // 248

  let out = '';
  while (out.length < DEVICE_TOKEN_BODY_LEN) {
    // 多取一些，通常两轮就够（需要丢弃的概率只有 8/256 ≈ 3%）
    const buf = crypto.randomBytes(DEVICE_TOKEN_BODY_LEN * 2);
    for (let i = 0; i < buf.length && out.length < DEVICE_TOKEN_BODY_LEN; i++) {
      const b = buf[i];
      if (b >= maxValid) continue;
      out += TOKEN_CHARSET[b % charsetLen];
    }
  }
  return DEVICE_TOKEN_PREFIX + out;
}

/**
 * token 的**指纹**：只用来和别的记录对上，不用于认证
 *
 * 8 位，跳过 `cz.` 固定前缀 —— 前缀每个 token 都一样，算进指纹等于白占 3 位。
 * 启动日志、设备列表里显示的都是这个，避免把完整凭据摊在屏幕上 / 写进日志。
 *
 * @param {string} token
 * @returns {string} 8 位字符（token 本身短于 8 位时返回能取到的部分）
 */
function tokenFingerprint(token) {
  const s = String(token || '');
  const body = s.startsWith(DEVICE_TOKEN_PREFIX) ? s.slice(DEVICE_TOKEN_PREFIX.length) : s;
  return body.slice(0, 8);
}

/** 判断一枚 token 是否符合当前设备 Token 格式（不含前缀校验以外的语义） */
function isDeviceTokenFormat(token) {
  if (typeof token !== 'string') return false;
  if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return false;
  const body = token.slice(DEVICE_TOKEN_PREFIX.length);
  if (body.length !== DEVICE_TOKEN_BODY_LEN) return false;
  // 逐字符确认都在字符集内（防止有人拿 cz. 开头塞别的东西当作"已经是新格式"）
  for (const ch of body) {
    if (!TOKEN_CHARSET.includes(ch)) return false;
  }
  return true;
}

module.exports = {
  generateAppToken,
  generateDeviceToken,
  isDeviceTokenFormat,
  tokenPrefix,
  tokenFingerprint,
  TOKEN_LENGTH,
  TOKEN_PREFIX_LEN,
  DEVICE_TOKEN_PREFIX,
  DEVICE_TOKEN_BODY_LEN,
};
