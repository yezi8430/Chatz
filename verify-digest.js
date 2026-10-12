// 离线校验「每日摘要」的纯逻辑（src/digestCore.js）。
//
// digest.js 要 require db / ws（ws 又拉 npm 包），本机没有 node_modules require 不动，
// 所以拆出了零依赖的 digestCore.js —— 这个脚本测的就是那部分：
// 默认值合并、日期键、分组渲染、截断、「还有 N 条」、×N、无标题回退。
//
// 碰数据库的那半（SQL 过滤 / 懒创建 / 幂等 / 定时）由 verify-full.sh 在真机上验。
const C = require('./src/digestCore');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n        got  ' + g + '\n        want ' + w); }
}
function ok(name, cond) { eq(name, !!cond, true); }

// 造一条假消息（字段名和 buildDigest 的 SELECT 一致）
function row(id, over = {}) {
  return {
    id,
    title: '标题' + id,
    message: '正文' + id,
    priority: 5,
    date: '2026-10-13T00:00:0' + id + '.000Z',
    agg_count: 1,
    channel_id: 10,
    channel_name: 'Jellyfin',
    extras: null,
    ...over,
  };
}

console.log('\n=== 1. 默认值合并 ===');
eq('空用户 → 全默认', C.digestSettingsOf({}), C.DEFAULT_DIGEST);
eq('settings 不是 JSON → 全默认', C.digestSettingsOf({ settings: '{oops' }), C.DEFAULT_DIGEST);
eq('只存了 enabled，其余补默认',
  C.digestSettingsOf({ settings: JSON.stringify({ digest: { enabled: true } }) }),
  { ...C.DEFAULT_DIGEST, enabled: true });
eq('digest 不是对象（比如 true）→ 当没配过',
  C.digestSettingsOf({ settings: JSON.stringify({ digest: true }) }), C.DEFAULT_DIGEST);

console.log('\n=== 2. dayKey 格式 ===');
eq('补零', C.dayKey(new Date(2026, 0, 5, 8, 0)), '2026-01-05');
eq('十二月', C.dayKey(new Date(2026, 11, 31, 23, 59)), '2026-12-31');

console.log('\n=== 2b. 时区（每个用户自己选，默认北京时间）===');
eq('默认时区是北京时间', C.DEFAULT_TZ, 'Asia/Shanghai');
eq('空设置 → 默认时区', C.digestSettingsOf({}).tz, 'Asia/Shanghai');
// 同一个时刻，不同时区必须给出不同的「几点」和不同的「今天」
const instant = new Date('2026-10-13T00:30:00Z');   // UTC 的 00:30 = 北京 08:30 = 纽约(前一天) 20:30
eq('北京：08:30', C.zoneNow('Asia/Shanghai', instant).hhmm, 830);
eq('北京：10-13', C.zoneNow('Asia/Shanghai', instant).day, '2026-10-13');
eq('UTC：00:30', C.zoneNow('UTC', instant).hhmm, 30);
eq('UTC：还是 10-13', C.zoneNow('UTC', instant).day, '2026-10-13');
eq('纽约：20:30', C.zoneNow('America/New_York', instant).hhmm, 2030);
eq('纽约：还是 10-12（日期键必须跟着时区走，否则当天漏发）',
  C.zoneNow('America/New_York', instant).day, '2026-10-12');
// 午夜不能被渲染成 24 点（hour12:false 在部分 ICU 版本上的坑）
eq('午夜是 0 点不是 24 点', C.zoneNow('Asia/Shanghai', new Date('2026-10-12T16:00:00Z')).hhmm, 0);
eq('非法时区退回默认（宁可按北京时间发，也别永远不发）',
  C.zoneNow('Not/AZone', instant).tz, 'Asia/Shanghai');
eq('isValidTz: 正常', C.isValidTz('Asia/Shanghai'), true);
eq('isValidTz: UTC', C.isValidTz('UTC'), true);
eq('isValidTz: 空串', C.isValidTz(''), false);
eq('isValidTz: 不存在', C.isValidTz('Mars/Olympus'), false);
eq('isValidTz: 非字符串', C.isValidTz(123), false);
eq('isValidTz: 超长', C.isValidTz('A'.repeat(200)), false);
eq('normalizeTz: 非法 → 默认', C.normalizeTz('Mars/Olympus'), 'Asia/Shanghai');
eq('normalizeTz: 带空格也能用', C.normalizeTz('  Asia/Shanghai  '), 'Asia/Shanghai');

console.log('\n=== 2c. 不再有 onlyUnread（摘要汇总全部消息）===');
eq('默认值里没有 onlyUnread', 'onlyUnread' in C.DEFAULT_DIGEST, false);
eq('旧的 onlyUnread 设置被读进来也不影响渲染',
  C.digestSettingsOf({ settings: JSON.stringify({ digest: { onlyUnread: true } }) }).onlyUnread, true);
ok('汇总全部消息（正文里不再提「未读」）', !C.renderDigest(
  [{ channelId: 10, name: 'J', items: [row(1)] }], 1, 20
).text.includes('未读'));

console.log('\n=== 3. 标题回退 ===');
eq('有标题用标题', C.digestItemTitle(row(1, { title: 'A' })), 'A');
eq('空标题 → 正文第一行', C.digestItemTitle(row(1, { title: '   ', message: '第一行\n第二行' })), '第一行');
eq('都没有 → （无标题）', C.digestItemTitle(row(1, { title: '', message: '' })), '（无标题）');
eq('超长正文截到 40', C.digestItemTitle(row(1, { title: null, message: 'x'.repeat(80) })).length, 40);

console.log('\n=== 4. 分组渲染 ===');
const groups = [
  { channelId: 10, name: 'Jellyfin', items: [row(3), row(1, { agg_count: 4 })] },
  { channelId: 13, name: 'qBittorrent', items: [row(2)] },
];
const r4 = C.renderDigest(groups, 3, 20);
eq('总条数写进标题', /## 今日摘要 · 3 条 \/ 2 个频道/.test(r4.text), true);
ok('Jellyfin 组头是（2）', r4.text.includes('**Jellyfin**（2）'));
ok('qBittorrent 组头是（1）', r4.text.includes('**qBittorrent**（1）'));
ok('聚合条目标 ×4', r4.text.includes('- 标题1 ×4'));
ok('普通条目不带 ×', r4.text.includes('- 标题3\n'));
eq('没有「还有 N 条」', r4.hidden, 0);
eq('items 条数', r4.items.length, 3);
eq('items[0] 带 messageId', r4.items[0].messageId, 3);

console.log('\n=== 5. 截断与「还有 N 条」===');
const many = [];
for (let i = 1; i <= 8; i++) many.push(row(i, { channel_id: 10, channel_name: 'Ch' }));
const r5 = C.renderDigest([{ channelId: 10, name: 'Ch', items: many }], 8, 3);
eq('只列 3 条', (r5.text.match(/^- /gm) || []).length, 3);
eq('hidden = 5', r5.hidden, 5);
ok('提示语带条数', r5.text.includes('还有 5 条未列入（上限 3 条）'));
eq('items 也只有 3 条', r5.items.length, 3);
eq('标题仍是总数 8', /## 今日摘要 · 8 条/.test(r5.text), true);

console.log('\n=== 6. 截断后组头数字与实际列出一致 ===');
// 截断口径：**全局**取最新 N 条（按时间倒序展平后 slice），不是每组各分一点。
// 这里 A 有 2 条、B 有 1 条、maxItems=2 ⇒ A 两条都在，B 整组消失。
const mixed = [
  { channelId: 10, name: 'A', items: [row(1, { channel_id: 10 }), row(2, { channel_id: 10 })] },
  { channelId: 11, name: 'B', items: [row(3, { channel_id: 11 })] },
];
const r6 = C.renderDigest(mixed, 3, 2);
ok('A 组两条都在（截断按全局最新的来）', r6.text.includes('**A**（2）'));
ok('B 组整组消失（没被截到）', !r6.text.includes('**B**'));
eq('hidden = 1', r6.hidden, 1);
eq('标题仍是总数 3', /## 今日摘要 · 3 条/.test(r6.text), true);

console.log('\n=== 7. maxItems 边界 ===');
const one = [{ channelId: 10, name: 'A', items: [row(1)] }];
eq('maxItems=1', (C.renderDigest(one, 1, 1).text.match(/^- /gm) || []).length, 1);
eq('maxItems=0 也不炸（至少列 1 条）',
  (C.renderDigest(one, 1, 0).text.match(/^- /gm) || []).length, 1);

console.log('\n=== 8. 空输入 ===');
eq('没有任何条目 → 空正文（调用方据此不发摘要）', C.renderDigest([], 0, 20).items.length, 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
