// 离线校验「环路闸门 / 扇出闸门 / 附件清理」这三项防线。
//
// 本机没有 node_modules（better-sqlite3 装不了），所以还是「抠真函数」那一套：
// 把源码里那段原样切出来 eval，保证测的就是真代码，不是复制品。
// 需要 db 的部分（applyAction 的完整执行）测不了，改成「接线检查」——
// 断言关键代码还在，防止以后被顺手删掉。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n        got  ' + g + '\n        want ' + w); }
}
function ok(name, cond) { eq(name, !!cond, true); }

// ── 1. findSelfWebhook（从 routes-api.js 抠真函数）──
const routesSrc = fs.readFileSync(path.join(SRC, 'routes-api.js'), 'utf8');
const s1 = routesSrc.indexOf('function findSelfWebhook');
const e1 = routesSrc.indexOf('function rowToRoute');
if (s1 < 0 || e1 < 0) { console.error('切不出 findSelfWebhook：标记变了'); process.exit(1); }
const findSelfWebhook = new Function(
  routesSrc.slice(s1, e1) + '\nreturn findSelfWebhook;'
)();

// req 里带 Host 头，模拟"用户从 192.168.2.100:20010 打开网页改规则"
const REQ = { headers: { host: '192.168.2.100:20010' } };
const PUB = { headers: { host: 'chatz.guojuice.asia' } };

console.log('— 1. 自指 webhook：路径 /hook/ + host 是自己 ⇒ 拦 —');
eq('localhost',        findSelfWebhook([{ type: 'call_webhook', value: 'http://localhost:20010/hook/abc' }], REQ), 'http://localhost:20010/hook/abc');
eq('127.0.0.1',        findSelfWebhook([{ type: 'call_webhook', value: 'http://127.0.0.1:20010/hook/abc' }], REQ), 'http://127.0.0.1:20010/hook/abc');
eq('IPv6 回环',         findSelfWebhook([{ type: 'call_webhook', value: 'http://[::1]:20010/hook/abc' }], REQ), 'http://[::1]:20010/hook/abc');
eq('请求的 Host 自己',   findSelfWebhook([{ type: 'call_webhook', value: 'http://192.168.2.100:20010/hook/abc' }], REQ), 'http://192.168.2.100:20010/hook/abc');
eq('公网域名=用户访问的地址', findSelfWebhook([{ type: 'call_webhook', value: 'https://chatz.guojuice.asia/hook/abc' }], PUB), 'https://chatz.guojuice.asia/hook/abc');
eq('多个动作里挑出那一个', findSelfWebhook([
  { type: 'set_priority', value: 8 },
  { type: 'call_webhook', value: 'https://example.com/x' },
  { type: 'call_webhook', value: 'http://localhost:20010/hook/abc' },
], REQ), 'http://localhost:20010/hook/abc');

console.log('— 2. 不该拦的：外部地址 / 别的路径 / 别的动作 —');
eq('外部 webhook',       findSelfWebhook([{ type: 'call_webhook', value: 'https://example.com/hook/abc' }], REQ), null);
eq('内网别的机器',        findSelfWebhook([{ type: 'call_webhook', value: 'http://192.168.2.50:8123/hook/abc' }], REQ), null);
eq('Home Assistant 风格', findSelfWebhook([{ type: 'call_webhook', value: 'http://192.168.2.100:8123/api/webhook/x' }], REQ), null);
eq('Node-RED 的 /hook/ 但不是自己', findSelfWebhook([{ type: 'call_webhook', value: 'http://192.168.2.50:1880/hook/x' }], REQ), null);
eq('自己但不是 /hook/',   findSelfWebhook([{ type: 'call_webhook', value: 'http://localhost:20010/api/x' }], REQ), null);
eq('非 call_webhook',    findSelfWebhook([{ type: 'set_priority', value: 'http://localhost:20010/hook/abc' }], REQ), null);
eq('空 actions',         findSelfWebhook([], REQ), null);
eq('actions 不是数组',    findSelfWebhook(null, REQ), null);
eq('value 不是合法 URL',  findSelfWebhook([{ type: 'call_webhook', value: '这不是个网址' }], REQ), null);
eq('没有 host 头也不崩',  findSelfWebhook([{ type: 'call_webhook', value: 'http://localhost:20010/hook/abc' }], { headers: {} }), 'http://localhost:20010/hook/abc');

console.log('— 3. 闸门常量（从 routing.js 抠）—');
const routingSrc = fs.readFileSync(path.join(SRC, 'routing.js'), 'utf8');
function constOf(name) {
  const m = new RegExp('const ' + name + ' = ([^;]+);').exec(routingSrc);
  if (!m) return undefined;
  return new Function('return ' + m[1])();
}
eq('HOP_HEADER', constOf('HOP_HEADER'), 'x-chatz-hop');
const hops = constOf('MAX_ROUTE_HOPS');
ok('MAX_ROUTE_HOPS 是个小正整数（2-10）', Number.isInteger(hops) && hops >= 2 && hops <= 10);
const fan = constOf('MAX_EXTRA_CHANNELS');
ok('MAX_EXTRA_CHANNELS 是个正整数', Number.isInteger(fan) && fan > 0);

console.log('— 4. 接线检查（防止以后被顺手删掉）—');
const hookSrc = fs.readFileSync(path.join(SRC, 'hooks.js'), 'utf8');
const mcSrc = fs.readFileSync(path.join(SRC, 'messageCreate.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(SRC, 'db.js'), 'utf8');
const attSrc = fs.readFileSync(path.join(SRC, 'attachments.js'), 'utf8');

ok('hooks.js 从请求头读代次',        /req\.headers\[HOP_HEADER\]/.test(hookSrc));
ok('hooks.js 代次做了正整数校验',      /rawHop > 0/.test(hookSrc));
ok('createMessage 收 hops 参数',     /function createMessage\(\{[^}]*\bhops\b/.test(mcSrc));
ok('createMessage 校验 hops 上界',    /hops < 1000/.test(mcSrc));
ok('ctx 里带了 _hops',               /_hops: safeHops/.test(mcSrc));
ok('call_webhook 带 X-Chatz-Hop 发出去', /\[HOP_HEADER\]: String\(hops \+ 1\)/.test(routingSrc));
ok('代次到上限就不发 webhook',         /hops >= MAX_ROUTE_HOPS/.test(routingSrc));
ok('broadcast_to 有扇出上限',         /MAX_EXTRA_CHANNELS - ctx\.extraChannels\.length/.test(routingSrc));
ok('routing.js 导出 HOP_HEADER',      /HOP_HEADER,/.test(routingSrc));
ok('POST /route 拦自指',             /findSelfWebhook\(actions, req\)/.test(routesSrc));
ok('PATCH /route/:id 也拦自指',       (routesSrc.match(/findSelfWebhook\(actions, req\)/g) || []).length >= 2);
// 注意 db.js 里那句是模板字符串（要插值），所以引号可能是 ' 也可能是 `
ok('db.js 设了 synchronous',          /pragma\([`']synchronous =/.test(dbSrc));
ok('db.js 设了 busy_timeout',         /pragma\('busy_timeout = 5000'\)/.test(dbSrc));
ok('synchronous 有白名单',            /SYNC_MODES\.includes/.test(dbSrc));
ok('unlink 失败区分 ENOENT',          (attSrc.match(/e\.code !== 'ENOENT'/g) || []).length >= 2);
ok('sweep 有宽限期',                  /ORPHAN_GRACE_MS/.test(attSrc));

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + '  pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
