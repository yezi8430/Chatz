// 数据目录与各子目录的路径（单一真值）
//
// 为什么单独成文件：index.js / channels.js / hooks.js 各自算了一遍
// `path.join(DATA_DIR, 'xxx')`，公式一样但散在三处 —— 新模块（比如
// admin-api 的附件配额接口）再抄第四遍只会更容易 drift。
// 这里只**算路径**，不建目录（建目录的时机由调用方决定，见 index.js 的 mkdir 循环）。
const path = require('path');

const DATA_DIR = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : './data';

const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const ICONS_DIR = path.join(DATA_DIR, 'icons');
const CHANNEL_ICONS_DIR = path.join(DATA_DIR, 'channel-icons');
const CERT_DIR = path.join(DATA_DIR, 'certs');
const BACKGROUND_DIR = path.join(DATA_DIR, 'background');

module.exports = {
  DATA_DIR,
  ATTACHMENTS_DIR,
  ICONS_DIR,
  CHANNEL_ICONS_DIR,
  CERT_DIR,
  BACKGROUND_DIR,
};
