// 离线校验「缓存封面图」（src/imageCache.js）。
//
// 本机没有 node_modules（better-sqlite3 装不了），但 imageCache 的依赖是
// 零依赖的（fs/path/crypto + sanitize + attachmentLimits + serverI18n），
// 所以这次不用「抠函数」—— 直接 require 真模块，起一个本地 HTTP 服务器喂它，
// 测的就是生产代码走的那条路（含真实 fetch / 超时 / 魔数识别 / 落盘）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n        got  ' + g + '\n        want ' + w); }
}
function ok(name, cond) { eq(name, !!cond, true); }

const MINI_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const MINI_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>');

const { applyImageCache, cacheImageUrl, isHttpUrl, cachedFileBase, MAX_FILE_BYTES } = require('./src/imageCache');

// ── 本地测试服务器 ──
const hits = {};
const server = http.createServer((req, res) => {
  hits[req.url] = (hits[req.url] || 0) + 1;
  if (req.url === '/ok.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(MINI_PNG); }
  else if (req.url === '/ok.gif') { res.writeHead(200, { 'content-type': 'image/gif' }); res.end(MINI_GIF); }
  else if (req.url === '/evil.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end(SVG); }
  else if (req.url === '/text') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello, not an image'); }
  else if (req.url === '/big.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.concat([MINI_PNG, Buffer.alloc(MAX_FILE_BYTES + 1024)])); }
  else if (req.url === '/redir') { res.writeHead(302, { location: '/ok.png' }); res.end(); }
  else if (req.url === '/slow') { setTimeout(() => { try { res.writeHead(200, { 'content-type': 'image/png' }); res.end(MINI_PNG); } catch {} }, 8000); }
  else { res.writeHead(404); res.end('nope'); }
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatz-imgcache-'));
  console.log('临时附件目录: ' + dir);

  console.log('— 1. 协议白名单 —');
  eq('http 放行', isHttpUrl('http://x/y.png'), true);
  eq('https 放行', isHttpUrl('https://x/y.png'), true);
  eq('ftp 拒绝', isHttpUrl('ftp://x/y.png'), false);
  eq('data: 拒绝', isHttpUrl('data:image/png;base64,AAAA'), false);
  eq('相对路径拒绝', isHttpUrl('/attachments/x.png'), false);
  eq('空串拒绝', isHttpUrl(''), false);

  console.log('— 2. 抓取成功 + 命名/去重 —');
  const u1 = base + '/ok.png';
  const r1 = await cacheImageUrl(u1, dir);
  const expectName = cachedFileBase(u1) + '.png';
  eq('返回本地地址', r1, '/attachments/' + expectName);
  ok('文件真的落盘了', fs.existsSync(path.join(dir, expectName)));
  eq('落盘内容与源一致', fs.readFileSync(path.join(dir, expectName)).equals(MINI_PNG), true);
  eq('第一次抓取命中 1 次', hits['/ok.png'], 1);

  const r1b = await cacheImageUrl(u1, dir);
  eq('再次调用命中缓存（地址相同）', r1b, r1);
  eq('第二次没再请求服务器（去重生效）', hits['/ok.png'], 1);

  console.log('— 3. 各种拒绝路径都保持不缓存（返回 null）—');
  eq('404 → null', await cacheImageUrl(base + '/nope', dir), null);
  eq('非图片（text/plain）→ null', await cacheImageUrl(base + '/text', dir), null);
  eq('svg 一律拒绝（同源可内联 = XSS）', await cacheImageUrl(base + '/evil.svg', dir), null);
  eq('超过单张上限 → null', await cacheImageUrl(base + '/big.png', dir), null);
  eq('超时 → null', await cacheImageUrl(base + '/slow', dir), null);
  const gifName = await cacheImageUrl(base + '/ok.gif', dir);
  ok('gif 正常缓存（魔数识别，扩展名按真实类型）', typeof gifName === 'string' && gifName.endsWith('.gif'));

  console.log('— 4. 跟随重定向 —');
  const redir = await cacheImageUrl(base + '/redir', dir);
  ok('302 → 最终图缓存成功', typeof redir === 'string' && redir.endsWith('.png'));

  console.log('— 5. applyImageCache：开关 / 重写 / 失败回退 —');
  const msg = '🆕 新增媒体\n\n![封面](' + u1 + ')';
  const ex = { image: u1, 'client::display': { url: u1, contentType: 'text/markdown' }, 'client::notification': { bigImageUrl: u1 }, sender: { id: 1 } };
  const off = await applyImageCache({ app: { cache_images: 0 }, extras: ex, message: msg, attachmentsDir: dir });
  eq('开关关着 → 原样返回', off.extras, ex);
  eq('开关关着 → 正文不动', off.message, msg);

  const on = await applyImageCache({ app: { cache_images: 1 }, extras: ex, message: msg, attachmentsDir: dir });
  eq('开关打开 → extras.image 换成本地', on.extras.image, r1);
  eq('开关打开 → 原始 URL 存进 imageSource（聚合比较用）', on.extras.imageSource, u1);
  eq('client::display.url 一起换', on.extras['client::display'].url, r1);
  eq('bigImageUrl 一起换', on.extras['client::notification'].bigImageUrl, r1);
  eq('display 里的 contentType 保留', on.extras['client::display'].contentType, 'text/markdown');
  eq('其它键（sender）保留', on.extras.sender, { id: 1 });
  ok('正文里的图片 URL 也换成本地', on.message.includes(r1) && !on.message.includes(u1));

  const failExtras = { image: base + '/nope' };
  const failed = await applyImageCache({ app: { cache_images: 1 }, extras: failExtras, message: 'x', attachmentsDir: dir });
  eq('抓取失败 → extras 原样（消息照发）', failed.extras, failExtras);
  eq('抓取失败 → 不写 imageSource', 'imageSource' in failed.extras, false);

  const noImg = await applyImageCache({ app: { cache_images: 1 }, extras: { sender: {} }, message: 'x', attachmentsDir: dir });
  eq('没有 extras.image → 原样', noImg.extras, { sender: {} });

  console.log('— 6. 没落下的临时文件 —');
  const leftovers = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
  eq('目录里没有 .tmp 残留', leftovers, []);

  server.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

  console.log(`\n合计：${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
