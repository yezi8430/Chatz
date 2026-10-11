// 「缓存封面图」：把 extras.image 指的外链图片抓下来，存成本地附件。
//
// 为什么要有这个：封面是**热链**在发送方服务器上的（如 Jellyfin 的
// /Items/{id}/Images/Primary）。媒体一删，那边连图带元数据一起没了 ⇒
// 老通知的封面全变 404。在本地存一份，图就永久可看（删消息时再回收）。
//
// 设计要点：
//   · **应用级开关**（applications.cache_images）—— 策略在服务端配，
//     发送方（插件 / curl）什么都不用改
//   · **入库前同步抓**（超时封顶 5s）：一次成型，不用事后回改消息再广播一遍。
//     webhook 本来就是 setImmediate fire-and-forget，慢几百毫秒不影响响应
//   · **按 URL 哈希命名**（cached-<sha1>.<ext>）：同一部剧的 N 集通知共享同一张
//     海报，只抓一次存一份；和附件回收天然配套（isStillReferenced 发现还有
//     别处引用就不删）
//   · **原始 URL 存进 extras.imageSource**：聚合主卡的「封面一致性」得拿原始
//     URL 比 —— 否则「有的子项缓存成功、有的抓取失败」会被判成不一致，主卡
//     就没图了（渲染永远用 image，比较用 imageSource）
//   · 扩展名以**魔数**为准（detectImageExt），不信 content-type / 文件名；
//     **svg 一律不缓存** —— 附件目录和 WebUI 同源，可内联的 svg 等于存储型 XSS
//
// ⚠️ 安全边界（已知并接受，文档里要写明）：这个功能允许持有应用 Token 的人
//    让服务端去 GET 任意 http(s) 地址。自托管 + Token 在管理员手里，风险可控；
//    想收紧就在应用配置里把开关关掉。跟着重定向走（follow）也是同样的取舍。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { detectImageExt } = require('./sanitize');
const { dirSize, MAX_TOTAL_BYTES } = require('./attachmentLimits');
const i18n = require('./serverI18n');

// 单张上限：封面图不该太大；超了就放弃（保持外链，不影响消息）
const MAX_FILE_BYTES =
  (parseInt(process.env.IMAGE_CACHE_MAX_MB, 10) || 5) * 1024 * 1024;

// 抓取超时：webhook 是 fire-and-forget，但不能让一条消息把投递拖太久
const FETCH_TIMEOUT_MS =
  parseInt(process.env.IMAGE_CACHE_TIMEOUT_MS, 10) || 5000;

// 允许缓存的图片类型（detectImageExt 的返回值）。**没有 svg**，见文件头说明
const OK_EXTS = new Set(['png', 'jpg', 'gif', 'webp']);

// 探测已缓存文件时要试的扩展名（顺序无所谓，命中即返回）
const PROBE_EXTS = ['jpg', 'png', 'webp', 'gif'];

function isHttpUrl(u) {
  if (typeof u !== 'string' || !u) return false;
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:';
  } catch {
    return false;
  }
}

function cachedFileBase(url) {
  return 'cached-' + crypto.createHash('sha1').update(url).digest('hex');
}

/** 这个 URL 已经缓存过了吗（去重：同一张图只抓一次、只存一份） */
function findCachedName(attachmentsDir, url) {
  const base = cachedFileBase(url);
  for (const ext of PROBE_EXTS) {
    const name = base + '.' + ext;
    try {
      if (fs.existsSync(path.join(attachmentsDir, name))) return name;
    } catch { /* 目录异常：当作没缓存 */ }
  }
  return null;
}

/**
 * 抓一张图。返回 { buffer, ext } 或 null（任何一步不达标都返回 null，绝不抛）。
 *
 * 防护顺序：协议 → 状态码 → content-length 预检 → 流式读 + 实读上限 →
 *          魔数识别（只认 png/jpg/gif/webp）。
 */
async function fetchImage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow', // ⚠️ 跟着重定向走，见文件头的安全说明
      headers: { accept: 'image/*' },
    });
    if (!resp.ok) return null;

    const len = parseInt(resp.headers.get('content-length') || '0', 10);
    if (Number.isFinite(len) && len > MAX_FILE_BYTES) return null;

    const chunks = [];
    let total = 0;
    for await (const chunk of resp.body) {
      total += chunk.length;
      if (total > MAX_FILE_BYTES) { try { ctrl.abort(); } catch { } return null; }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const ext = detectImageExt(buffer);
    if (!ext || !OK_EXTS.has(ext)) return null;
    return { buffer, ext };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 缓存一个图片 URL，返回可直接放进消息的本地地址（'/attachments/cached-xxx.jpg'）
 * 或 null（不缓存 / 抓取失败 —— 调用方保持外链即可）。
 */
async function cacheImageUrl(url, attachmentsDir) {
  if (!isHttpUrl(url)) return null;

  const hit = findCachedName(attachmentsDir, url);
  if (hit) return '/attachments/' + hit;

  const got = await fetchImage(url);
  if (!got) return null;

  // 容量：和附件上传共用同一套上限口径（单张另有限制，见 MAX_FILE_BYTES）
  if (dirSize(attachmentsDir) + got.buffer.length > MAX_TOTAL_BYTES) {
    i18n.warn('imageCache.dirFull', {});
    return null;
  }

  const name = cachedFileBase(url) + '.' + got.ext;
  const dest = path.join(attachmentsDir, name);
  const tmp = dest + '.tmp';
  try {
    // 先写临时文件再改名：避免"写了一半"的文件被消息引用（改名是原子的）
    fs.writeFileSync(tmp, got.buffer);
    fs.renameSync(tmp, dest);
    return '/attachments/' + name;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { }
    i18n.warn('imageCache.writeFailed', { name, msg: e.message });
    return null;
  }
}

/**
 * 消息级的入口：按应用开关决定要不要缓存 extras.image，并同步改写
 *   · extras.image（客户端/App 读它）
 *   · extras['client::display'].url / extras['client::notification'].bigImageUrl（与它同源时一起换）
 *   · 正文里的图片 URL（WebUI 读正文第一张图）
 * 缓存成功时保留原始 URL 到 extras.imageSource（供聚合一致性比较）。
 *
 * @returns { extras, message, cachedUrl }  —— 失败/未开启时原样返回
 */
async function applyImageCache({ app, extras, message, attachmentsDir }) {
  const same = { extras, message, cachedUrl: null };
  if (!app || !app.cache_images) return same;
  if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return same;

  const src = typeof extras.image === 'string' && extras.image ? extras.image : null;
  if (!src) return same;

  const local = await cacheImageUrl(src, attachmentsDir);
  if (!local) return same; // 失败就保持外链：消息照发，不影响其它任何东西

  const outExtras = { ...extras, imageSource: src, image: local };
  for (const [key, field] of [['client::display', 'url'], ['client::notification', 'bigImageUrl']]) {
    const obj = outExtras[key];
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj[field] === src) {
      outExtras[key] = { ...obj, [field]: local };
    }
  }

  // 正文：把出现过的原始 URL 整体替换成本地地址（split/join 免正则转义）
  const outMessage = typeof message === 'string' && message.includes(src)
    ? message.split(src).join(local)
    : message;

  return { extras: outExtras, message: outMessage, cachedUrl: local };
}

module.exports = {
  applyImageCache,
  cacheImageUrl,
  fetchImage,
  isHttpUrl,
  cachedFileBase,
  findCachedName,
  MAX_FILE_BYTES,
  FETCH_TIMEOUT_MS,
};
