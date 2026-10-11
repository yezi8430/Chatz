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
// escapeHtml 是 app.js 里的既有工具，测试环境给它一个等价实现
const escapeHtml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const renderOpenLink = new Function(
  'escapeHtml',
  appSrc.slice(s2, e2) + '\nreturn renderOpenLink;'
)(escapeHtml);

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

// ── 3. 接线检查：两处调用点还在，防止以后被顺手删掉 ──
console.log('— 7. 接线检查 —');
ok('折叠流程里调用了 normalizeMainDeepLink', /mainExtrasRaw = normalizeMainDeepLink\(mainExtrasRaw, children\)/.test(mcSrc));
// ⚠️ 模板字面量里调用是 ${renderAggChildren(m)}，(m) 后面紧跟 `}` 不是换行 —— 别忘了 \}
ok('主卡渲染调用了 renderOpenLink', /renderAggChildren\(m\)\}\s*\n\s*\$\{renderOpenLink\(m\.extras\)\}/.test(appSrc));
ok('合并子项渲染调用了 renderOpenLink', /renderOpenLink\(extras, 'agg-child-open'\)/.test(appSrc));
ok('主卡 extras 的 stripCoverKeys 不清 url（保留 sender/app/url）', !/delete out\.url\b/.test(mcSrc.split('function stripCoverKeys')[1].split('}')[0]));

console.log(`\n合计：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
