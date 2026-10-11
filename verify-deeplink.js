// 离线校验「深链」这条链路的两端真代码：
//   · 服务端 messageCreate.js 的 normalizeMainDeepLink —— 折叠主卡的 url 一致性兜底
//   · 网页 app.js 的 renderOpenLink —— extras.url 渲染成「打开」按钮
// 本机没有 node_modules，照旧「抠真函数」：从源码原样切出来 eval，测的就是真代码。
// 另附「接线检查」，防止以后有人把这俩调用顺手删了。
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n        got  ' + g + '\n        want ' + w); }
}
function ok(name, cond) { eq(name, !!cond, true); }

// ── 1. normalizeMainDeepLink（从 messageCreate.js 抠真函数）──
const mcSrc = fs.readFileSync(path.join(__dirname, 'src', 'messageCreate.js'), 'utf8');
const s1 = mcSrc.indexOf('function normalizeMainDeepLink');
const e1 = mcSrc.indexOf('function broadcastAggregated');
if (s1 < 0 || e1 < 0 || e1 <= s1) { console.error('切不出 normalizeMainDeepLink：标记变了'); process.exit(1); }
const normalizeMainDeepLink = new Function(
  mcSrc.slice(s1, e1) + '\nreturn normalizeMainDeepLink;'
)();

const U_A = 'https://jellyfin.example.com/web/#/details?id=aaa';
const U_B = 'https://jellyfin.example.com/web/#/details?id=bbb';

console.log('— 1. 主卡深链一致性：url 全一致 ⇒ 原样保留 —');
const mainSame = JSON.stringify({ url: U_A, urlLabel: '在 Jellyfin 中打开', sender: { id: 1 } });
const kidsSame = [
  { extras: { url: U_A, urlLabel: '在 Jellyfin 中打开' } },
  { extras: { url: U_A, urlLabel: '在 Jellyfin 中打开' } },
];
eq('一致 ⇒ 主卡原样', normalizeMainDeepLink(mainSame, kidsSame), mainSame);

console.log('— 2. url 不一致 ⇒ 摘掉主卡的 url/urlLabel，其余键保留 —');
const mainDiff = JSON.stringify({ url: U_A, urlLabel: '在 Jellyfin 中打开', sender: { id: 1 } });
const kidsDiff = [
  { extras: { url: U_A } },
  { extras: { url: U_B } },
];
const got2 = JSON.parse(normalizeMainDeepLink(mainDiff, kidsDiff));
ok('url 已摘掉', !('url' in got2));
ok('urlLabel 已摘掉', !('urlLabel' in got2));
eq('sender 等其余键保留', got2.sender, { id: 1 });
eq('子项不受影响（函数只动主卡串）', kidsDiff[1].extras.url, U_B);

console.log('— 3. 有 url 和没 url 的子项混在一起 ⇒ 也算不一致 —');
const kidsMixed = [
  { extras: { url: U_A } },
  { extras: { sender: { id: 2 } } },
];
const got3 = JSON.parse(normalizeMainDeepLink(mainDiff, kidsMixed));
ok('混合 ⇒ 主卡 url 被摘掉', !('url' in got3));

console.log('— 4. 边界：主卡没有 extras / 坏 JSON / 空数组 —');
eq('主卡 extras 为 null', normalizeMainDeepLink(null, kidsSame), null);
eq('主卡 extras 为空串', normalizeMainDeepLink('', kidsSame), '');
const badJson = '{not json';
eq('主卡 extras 坏 JSON ⇒ 原样返回', normalizeMainDeepLink(badJson, kidsDiff), badJson);
// children 为空（真实流程不会发生，children 至少 1 条）⇒ 无法证明一致 ⇒ 按不一致处理，宁缺毋错
const got4 = JSON.parse(normalizeMainDeepLink(mainDiff, []));
ok('children 为空 ⇒ 主卡 url 被摘掉', !('url' in got4));

console.log('— 5. url 不是字符串 / extras 是数组 ⇒ 当没 url 处理 —');
const kidsWeird = [{ extras: { url: 123 } }, { extras: [1, 2] }, { extras: '不是对象' }];
const got5 = JSON.parse(normalizeMainDeepLink(mainDiff, kidsWeird));
ok('怪异子项 ⇒ 主卡 url 被摘掉', !('url' in got5));

// ── 2. renderOpenLink（从 public/app.js 抠真函数）──
const appSrc = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
const s2 = appSrc.indexOf('function renderOpenLink');
const e2 = appSrc.indexOf('function renderAggChildren');
if (s2 < 0 || e2 < 0 || e2 <= s2) { console.error('切不出 renderOpenLink：标记变了'); process.exit(1); }
// escapeHtml / chatzT 是 app.js 里的既有工具，测试环境给等价实现
// （chatzT 在中文下就是"查不到就原样返回"，用恒等函数即可）
const escapeHtml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const chatzT = s => s;
const renderOpenLink = new Function(
  'escapeHtml',
  'chatzT',
  appSrc.slice(s2, e2) + '\nreturn renderOpenLink;'
)(escapeHtml, chatzT);

console.log('— 6. 深链按钮渲染 —');
const html6 = renderOpenLink({ url: U_A, urlLabel: '在 Jellyfin 中打开' });
ok('http(s) 正常渲染成 <a>', html6.includes('<a class="msg-open-btn'));
ok('href 带 noopener', html6.includes('rel="noopener noreferrer"'));
ok('label 用发送方给的', html6.includes('在 Jellyfin 中打开'));
eq('javascript: 被拒', renderOpenLink({ url: 'javascript:alert(1)' }), '');
eq('data: 被拒', renderOpenLink({ url: 'data:text/html,x' }), '');
eq('畸形 URL 被拒', renderOpenLink({ url: 'ht!tp://x' }), '');
eq('空 url 不渲染', renderOpenLink({ url: '' }), '');
eq('没有 extras 不渲染', renderOpenLink(null), '');
eq('url 不是字符串不渲染', renderOpenLink({ url: 42 }), '');
const html6b = renderOpenLink({ url: U_A });
ok('没给 label ⇒ 回落显示域名', html6b.includes('jellyfin.example.com'));
const html6c = renderOpenLink({ url: 'https://x.com/a"><script>' });
ok('url/label 均被 escape', !html6c.includes('<script>'));

console.log('— 6b. 「已删除」标记（extras.urlGone）—');
const goneHtml = renderOpenLink({ url: U_A, urlLabel: '在 Jellyfin 中打开', urlGone: true });
ok('灰化：不再是链接（没有 <a href）', !goneHtml.includes('<a '));
ok('灰化：带 gone 类', goneHtml.includes('msg-open-btn gone'));
ok('灰化：文案仍保留原按钮名', goneHtml.includes('在 Jellyfin 中打开'));
ok('灰化：带「已删除」字样', goneHtml.includes('已删除'));
ok('灰化：不可点（span 没有 href）', !goneHtml.includes('href='));
ok('灰化时子项小号类也保留', renderOpenLink({ url: U_A, urlGone: true }, 'agg-child-open').includes('agg-child-open'));
const notGone = renderOpenLink({ url: U_A, urlLabel: 'x', urlGone: false });
ok('urlGone 不是 true ⇒ 仍是可点链接', notGone.includes('<a '));
eq('没有 url 时即使 urlGone 也不渲染', renderOpenLink({ urlGone: true }), '');

// ── 3. 折叠主卡的封面一致性（applyMainCover / allChildrenShareCover / coverUrlOf）──
const s3 = mcSrc.indexOf('function coverUrlOf');
const e3 = mcSrc.indexOf('function normalizeMainDeepLink');
if (s3 < 0 || e3 < 0 || e3 <= s3) { console.error('切不出封面相关函数：标记变了'); process.exit(1); }
const coverMod = new Function(
  'stripCoverKeys',
  'stripMarkdownImages',
  mcSrc.slice(s3, e3) + '\nreturn { coverUrlOf, allChildrenShareCover, applyMainCover };'
)(
  // stripCoverKeys / stripMarkdownImages 是文件里既有的工具，按同语义给测试实现
  (extras) => {
    if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return extras;
    const out = { ...extras };
    delete out.image;
    for (const [key, field] of [['client::display', 'url'], ['client::notification', 'bigImageUrl']]) {
      const obj = out[key];
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const copy = { ...obj };
        delete copy[field];
        if (Object.keys(copy).length > 0) out[key] = copy; else delete out[key];
      }
    }
    return out;
  },
  (text) => !text ? text : String(text).replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
);
const { coverUrlOf, allChildrenShareCover, applyMainCover } = coverMod;

const IMG_A = 'https://jellyfin.example.com/Items/aaa/Images/Primary';
const IMG_B = 'https://jellyfin.example.com/Items/bbb/Images/Primary';
const BODY_IMG = (u) => '🆕 新增媒体\n📺 进击的巨人 S01E03\n\n![封面](' + u + ')';

console.log('— 8. 封面取值优先级 —');
eq('image 优先', coverUrlOf({ image: IMG_A, 'client::display': { url: IMG_B } }), IMG_A);
eq('回落 client::display.url', coverUrlOf({ 'client::display': { url: IMG_A } }), IMG_A);
eq('回落 bigImageUrl', coverUrlOf({ 'client::notification': { bigImageUrl: IMG_A } }), IMG_A);
eq('都没有 → null', coverUrlOf({ sender: { id: 1 } }), null);
eq('extras 是数组 → null', coverUrlOf([1, 2]), null);

console.log('— 9. 封面一致 ⇒ 主卡留图（extras 图键 + 正文 markdown 图都补回来）—');
const mainStripped = JSON.stringify({ sender: { id: 1 } });          // 上一轮被摘过
const kidsSameCover = [
  { extras: { image: IMG_A }, message: BODY_IMG(IMG_A) },
  { extras: { image: IMG_A }, message: BODY_IMG(IMG_A) },
];
const r9 = applyMainCover(mainStripped, '🆕 新增媒体\n📺 进击的巨人 S01E03', kidsSameCover);
ok('一致 ⇒ 主卡 extras.image 补回', JSON.parse(r9.extrasRaw).image === IMG_A);
ok('一致 ⇒ sender/app 等其它键保留', JSON.parse(r9.extrasRaw).sender && JSON.parse(r9.extrasRaw).sender.id === 1);
ok('一致 ⇒ 正文里的 markdown 图补回（WebUI 靠它出图）', r9.messageRaw.includes('![封面](' + IMG_A + ')'));

console.log('— 10. 封面不一致 ⇒ 主卡两通道都摘干净 —');
const mainWithCover = JSON.stringify({
  image: IMG_A, sender: { id: 1 },
  'client::display': { url: IMG_A, contentType: 'text/markdown' },
  'client::notification': { bigImageUrl: IMG_A },
});
const kidsDiffCover = [
  { extras: { image: IMG_A } },
  { extras: { image: IMG_B } },
];
const r10 = applyMainCover(mainWithCover, BODY_IMG(IMG_A), kidsDiffCover);
const m10 = JSON.parse(r10.extrasRaw);
ok('不一致 ⇒ extras.image 摘掉', !('image' in m10));
ok('不一致 ⇒ client::display.url 摘掉（contentType 保留）', !m10['client::display'] || !m10['client::display'].url);
ok('不一致 ⇒ bigImageUrl 摘掉', !m10['client::notification'] || !m10['client::notification'].bigImageUrl);
ok('不一致 ⇒ sender 保留', m10.sender && m10.sender.id === 1);
ok('不一致 ⇒ 正文里的 markdown 图也摘掉', !r10.messageRaw.includes('!['));

console.log('— 11. 封面混着来 / 空封面也算不一致 —');
const r11a = applyMainCover(mainWithCover, BODY_IMG(IMG_A), [{ extras: { image: IMG_A } }, { extras: { sender: {} } }]);
ok('有图+无图混着 ⇒ 主卡摘图', !('image' in JSON.parse(r11a.extrasRaw)));
const r11b = applyMainCover(mainWithCover, BODY_IMG(IMG_A), [{ extras: { sender: {} } }, { extras: { sender: {} } }]);
ok('全都没有封面 ⇒ 摘掉主卡残留的图', !('image' in JSON.parse(r11b.extrasRaw)));

console.log('— 11b. 缓存后的封面一致性（imageSource 归一化）—');
// 一集缓存成功（image 是本地地址、imageSource 是原始外链），另一集抓取失败（还是外链）：
// 比较必须认它们「同一张图」，否则主卡就没图了
const cachedKid = { extras: { image: '/attachments/cached-abc.jpg', imageSource: IMG_A } };
const rawKid = { extras: { image: IMG_A } };
ok('缓存成功 vs 抓取失败 ⇒ 仍判为一致', allChildrenShareCover([cachedKid, rawKid]));
eq('比较值取原始外链', coverUrlOf(cachedKid.extras), IMG_A);
eq('没有 imageSource 时用 image', coverUrlOf(rawKid.extras), IMG_A);
// 一致时主卡恢复封面，要把本地地址（image）和原始地址（imageSource）**都**带走
const r11c = applyMainCover(JSON.stringify({ sender: { id: 1 } }), 'x', [cachedKid, { extras: { image: '/attachments/cached-abc.jpg', imageSource: IMG_A } }]);
const m11c = JSON.parse(r11c.extrasRaw);
eq('恢复时带上本地地址（渲染用）', m11c.image, '/attachments/cached-abc.jpg');
eq('恢复时带上原始地址（比较用）', m11c.imageSource, IMG_A);

console.log('— 11c. 混合折叠（老子项外链 + 新子项已缓存）优先用本地副本 —');
// 场景：昨晚发的通知还没缓存，今天开关打开后新增的集是本地图。两条折在一起时，
// 主卡若照抄"第 1 条"（老的）就会留着外链 —— 源站一删图就裂，尽管本地副本就在附件目录里
const EXT_A = IMG_A;
const LOCAL_A = '/attachments/cached-deadbeef.jpg';
const kidsMixFold = [
  { extras: { image: EXT_A }, message: '🆕 新增\n\n![封面](' + EXT_A + ')' },
  { extras: { image: LOCAL_A, imageSource: EXT_A }, message: '🆕 新增\n\n![封面](' + LOCAL_A + ')' },
];
const r11d = applyMainCover(JSON.stringify({ image: EXT_A, sender: { id: 1 } }), kidsMixFold[0].message, kidsMixFold);
const m11d = JSON.parse(r11d.extrasRaw);
eq('混合折叠 ⇒ 主卡改用本地缓存图', m11d.image, LOCAL_A);
eq('混合折叠 ⇒ imageSource 记着原始外链', m11d.imageSource, EXT_A);
ok('混合折叠 ⇒ 正文也换成本地地址', r11d.messageRaw.includes(LOCAL_A) && !r11d.messageRaw.includes(EXT_A));
ok('混合折叠 ⇒ 其它键（sender）保留', m11d.sender && m11d.sender.id === 1);

const kidsAllExt = [
  { extras: { image: EXT_A }, message: '🆕 新增\n\n![封面](' + EXT_A + ')' },
  { extras: { image: EXT_A }, message: '🆕 新增' },
];
const r11e = applyMainCover(JSON.stringify({ image: EXT_A }), '这条主卡正文没图', kidsAllExt);
eq('没有本地副本 ⇒ 保持外链（现状不变）', JSON.parse(r11e.extrasRaw).image, EXT_A);
ok('没有本地副本 ⇒ 正文从第 1 子项补回（原本就没图）', /!\[/.test(r11e.messageRaw));

console.log('— 12. 接线检查（新增的调用点与前端口径）—');
ok('折叠流程里调用了 applyMainCover', /const cover = applyMainCover\(mainExtrasRaw, mainMessageRaw, children\)/.test(mcSrc));
ok('后端仍有 stripCoverKeys（不一致时要摘）', /function stripCoverKeys/.test(mcSrc));
ok('前端有 coverUrlFromExtras 且子项据此决定是否画图', /const hideChildImg = !!mainCover/.test(appSrc) && /if \(imgUrl && !hideChildImg\)/.test(appSrc));

console.log('— 6d. DOMPurify 的 URI 白名单必须放行同源相对路径 —');
// 缓存封面 / 上传附件都是 `/attachments/xxx`（相对路径）。白名单只认 https?/mailto/
// data:image 时，DOMPurify 会把 src/href 删掉 ⇒ <img alt="封面"> 裂图（实测踩到）。
{
  // 从源码里抠出这个正则字面量：不能简单用 /(.+?)\// —— 模式内部有转义的 \/
  // 会被提前截断。改成"取整行、从第一个 / 到最后一个 /"。
  const line = appSrc.split('\n').find(l => l.includes('ALLOWED_URI_REGEXP:'));
  const rest = line ? line.slice(line.indexOf('ALLOWED_URI_REGEXP:') + 'ALLOWED_URI_REGEXP:'.length).trim() : '';
  const lastSlash = rest.lastIndexOf('/');
  const pattern = rest.slice(1, lastSlash);
  const flags = rest.slice(lastSlash + 1).replace(/[^a-z]/g, '');
  ok('能从 app.js 里抠出这个白名单正则', !!pattern && pattern.startsWith('^'));
  if (pattern) {
    const re = new RegExp(pattern, flags);
    ok('放行 /attachments/cached-xxx.jpg', re.test('/attachments/cached-abc123.jpg'));
    ok('放行普通相对路径 /icons/x.png', re.test('/icons/x.png'));
    ok('放行 https', re.test('https://jellyfin.example.com/Items/x/Images/Primary'));
    ok('放行 mailto', re.test('mailto:a@b.com'));
    ok('放行 data:image', re.test('data:image/png;base64,AAAA'));
    ok('挡掉协议相对 //evil.com/x.png', !re.test('//evil.com/x.png'));
    ok('挡掉 javascript:', !re.test('javascript:alert(1)'));
    ok('挡掉 data:text/html', !re.test('data:text/html,<script>x</script>'));
    ok('挡掉 vbscript:', !re.test('vbscript:msgbox(1)'));
  }
}

// ── 4. 接线检查：两处调用点还在，防止以后被顺手删掉 ──
console.log('— 7. 接线检查 —');
ok('折叠流程里调用了 normalizeMainDeepLink', /mainExtrasRaw = normalizeMainDeepLink\(mainExtrasRaw, children\)/.test(mcSrc));
// ⚠️ 模板字面量里调用是 ${renderAggChildren(m)}，(m) 后面紧跟 `}` 不是换行 —— 别忘了 \}
ok('主卡渲染调用了 renderOpenLink', /renderAggChildren\(m\)\}\s*\n\s*\$\{renderOpenLink\(m\.extras\)\}/.test(appSrc));
ok('合并子项渲染调用了 renderOpenLink', /renderOpenLink\(extras, 'agg-child-open'\)/.test(appSrc));
ok('主卡 extras 的 stripCoverKeys 不清 url（保留 sender/app/url）', !/delete out\.url\b/.test(mcSrc.split('function stripCoverKeys')[1].split('}')[0]));

console.log(`\n合计：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
