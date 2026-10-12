// 离线校验「附件磁盘配额与自动回收」（src/attachmentQuota.js）。
//
// 本机没有 node_modules，但 attachmentQuota 的依赖是零依赖的
// （fs/path + serverI18n + attachmentRefs），所以直接 require 真模块，
// 用一个临时目录当附件目录，测的就是生产代码走的那条路。
//
// 覆盖：
//   1. 未超配 → 一个文件都不动
//   2. 超配 + 有孤儿 → 只删孤儿，压回配额以下就停
//   3. 孤儿删完还不够 → 删**被引用的缓存封面**，且按 mtime 最旧优先
//   4. 被引用的**用户附件**（非 cached- 前缀）→ 绝不删
//   5. 宽限期内的孤儿 → 不删（skippedFresh）
//   6. 只剩引用中的用户附件 → stillOver=true，一个不删
//   7. quotaBytes=0 → unlimited，什么都不做
//   8. usage() 的统计口径（含 cached- 单列）
//   9. formatBytes 的边界
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n        got  ' + g + '\n        want ' + w); }
}
function ok(name, cond) { eq(name, !!cond, true); }

const Q = require('./src/attachmentQuota');
const MB = Q.MB;

// ── 临时附件目录 ──
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chatz-quota-'));

function write(name, size, ageSec) {
  const p = path.join(DIR, name);
  fs.writeFileSync(p, Buffer.alloc(size, 1));
  const t = new Date(Date.now() - ageSec * 1000);
  fs.utimesSync(p, t, t);
}
function exists(name) { return fs.existsSync(path.join(DIR, name)); }
function clean() { for (const f of fs.readdirSync(DIR)) fs.unlinkSync(path.join(DIR, f)); }
function total() {
  let n = 0;
  for (const f of fs.readdirSync(DIR)) n += fs.statSync(path.join(DIR, f)).size;
  return n;
}

console.log('\n=== 1. 未超配：什么都不动 ===');
clean();
write('a.bin', 100, 3600);
write('b.bin', 100, 3600);
const r1 = Q.enforceQuota({ dir: DIR, quotaBytes: 1000, referenced: new Set() });
eq('removed', r1.removed, 0);
eq('after == before', r1.after, r1.before);
ok('文件都还在', exists('a.bin') && exists('b.bin'));

console.log('\n=== 2. 超配：只删孤儿，一直删到压回配额以下 ===');
clean();
write('orphan1.bin', 400, 3600);   // 孤儿，最旧
write('orphan2.bin', 400, 1800);   // 孤儿
write('live.bin', 400, 3600);      // 被引用的用户附件
const ref2 = new Set(['live.bin']);
const r2 = Q.enforceQuota({ dir: DIR, quotaBytes: 600, referenced: ref2 });
// 1200 - 400 = 800 仍 > 600，所以第二个孤儿也得删；用户附件从头到尾不动
eq('两个孤儿都删了', r2.removed, 2);
ok('最旧的孤儿被删', !exists('orphan1.bin'));
ok('第二个孤儿也被删（删到压回配额为止）', !exists('orphan2.bin'));
ok('被引用的用户附件没动', exists('live.bin'));
eq('after <= quota', r2.after <= 600, true);
eq('freed', r2.freed, 800);
eq('after', r2.after, 400);

console.log('\n=== 3. 孤儿删完还不够：删被引用的缓存封面，最旧优先 ===');
clean();
write('cached-old.jpg', 300, 7200);    // 被引用的缓存封面，最旧
write('cached-new.jpg', 300, 60);      // 被引用的缓存封面，较新
write('live.bin', 300, 3600);          // 被引用的用户附件
const ref3 = new Set(['cached-old.jpg', 'cached-new.jpg', 'live.bin']);
const r3 = Q.enforceQuota({ dir: DIR, quotaBytes: 400, referenced: ref3 });
eq('删了 2 个缓存封面', r3.removed, 2);
ok('最旧的封面先删', !exists('cached-old.jpg'));
ok('第二个封面也跟着删（还不够）', !exists('cached-new.jpg'));
ok('用户附件仍然没动', exists('live.bin'));
eq('after <= quota', r3.after <= 400, true);

console.log('\n=== 4. 只剩引用中的用户附件：不删，只告警 ===');
clean();
write('live1.bin', 500, 3600);
write('live2.bin', 500, 3600);
const r4 = Q.enforceQuota({ dir: DIR, quotaBytes: 300, referenced: new Set(['live1.bin', 'live2.bin']) });
eq('一个都没删', r4.removed, 0);
eq('stillOver', r4.stillOver, true);
eq('after == before', r4.after, 1000);
ok('两个用户附件都还在', exists('live1.bin') && exists('live2.bin'));

console.log('\n=== 5. 宽限期内的孤儿不删 ===');
clean();
write('fresh.bin', 500, 30);      // 30 秒前：宽限期内
write('old-orphan.bin', 500, 3600);
const r5 = Q.enforceQuota({ dir: DIR, quotaBytes: 600, referenced: new Set() });
eq('只删了老孤儿', r5.removed, 1);
ok('宽限期内的文件还在', exists('fresh.bin'));
eq('skippedFresh', r5.skippedFresh, 1);

console.log('\n=== 6. quotaBytes=0（不限）===');
clean();
write('x.bin', 999999, 3600);
const r6 = Q.enforceQuota({ dir: DIR, quotaBytes: 0, referenced: new Set() });
eq('unlimited', r6.unlimited, true);
eq('什么都没删', r6.removed, 0);
ok('文件还在', exists('x.bin'));

console.log('\n=== 7. usage() 统计口径 ===');
clean();
write('cached-1.jpg', 100, 3600);
write('cached-2.jpg', 200, 3600);
write('user.bin', 300, 3600);
const u = Q.usage(DIR);
eq('files', u.files, 3);
eq('bytes', u.bytes, 600);
eq('cachedFiles', u.cachedFiles, 2);
eq('cachedBytes', u.cachedBytes, 300);

console.log('\n=== 8. formatBytes ===');
eq('B', Q.formatBytes(512), '512 B');
eq('KB', Q.formatBytes(2048), '2.0 KB');
eq('MB', Q.formatBytes(5 * Q.MB), '5.0 MB');
eq('GB', Q.formatBytes(2 * 1024 * Q.MB), '2.00 GB');

console.log('\n=== 9. normalizeQuotaMb 边界 ===');
eq('0 = 不限', Q.normalizeQuotaMb(0), 0);
eq('正常值', Q.normalizeQuotaMb('2048'), 2048);
eq('负数不合法', Q.normalizeQuotaMb(-1), null);
eq('超大不合法', Q.normalizeQuotaMb(999999), null);
eq('非数字不合法', Q.normalizeQuotaMb('abc'), null);

console.log('\n=== 10. 缓存封面优先于用户附件被牺牲 ===');
// 同样超配，先删缓存封面（可再生），用户附件留到最后
clean();
write('cached-x.jpg', 500, 7200);   // 被引用，旧
write('user.bin', 500, 3600);       // 被引用
const r10 = Q.enforceQuota({
  dir: DIR, quotaBytes: 600,
  referenced: new Set(['cached-x.jpg', 'user.bin']),
});
eq('只删了缓存封面', r10.removed, 1);
ok('封面没了（裂图，可接受）', !exists('cached-x.jpg'));
ok('用户附件保住了', exists('user.bin'));

// ── 收尾 ──
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
