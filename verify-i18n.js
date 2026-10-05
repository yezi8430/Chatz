#!/usr/bin/env node
// ============================================================
// 服务端日志 i18n 自检（离线）
// ============================================================
// 为什么单独一个脚本：验证「日志会不会好好说英文」不需要 docker、不需要网络、
// 不需要 node_modules —— serverI18n.js 是零依赖模块，node 直接 require 就能跑。
// 真机联网那部分在 verify-full.sh 的 §16（I18N_TEST=1）。
//
// 用法（项目目录里）：node verify-i18n.js
//
// 检查四件事：
//   1. 词条完整性 —— 每条都有 zh 和 en，且都不为空（少了就回落中文，等于没翻）
//   2. 占位符对齐 —— zh 里的 {port} 在 en 里也必须有。漏了英文日志会留字面 "{port}"
//   3. 引用一致性 —— 代码里 i18n.log/warn/error/t('key') 用的 key 必须在词典里；
//                     词典里有、但没人用的 key 也要报（多半是改代码时忘了删）
//   4. 行为冒烟   —— 假 db 跑一遍：默认中文 / 库里 en 就英文 / saveLang 立刻生效 /
//                     非法值归一化为中文 / LOG_LANG 锁死 / 查不到 key 回落中文不抛
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const i18n = require(path.join(SRC, 'serverI18n.js'));
const DICT = i18n.DICT;

let pass = 0;
let fail = 0;

function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('   ✅ ' + label);
  } else {
    fail++;
    console.log('   ❌ ' + label + (extra ? '\n      ' + extra : ''));
  }
}
function section(t) {
  console.log('');
  console.log('──────── ' + t + ' ────────');
}

// ============================================================
console.log('================ Chatz 日志 i18n 自检（离线）================');

// ------------------------------------------------------------
section('1. 词条完整性');
// ------------------------------------------------------------
const keys = Object.keys(DICT);
console.log('   共 ' + keys.length + ' 条词条');

let noZh = [];
let noEn = [];
for (const k of keys) {
  const e = DICT[k];
  if (!e || !e.zh) noZh.push(k);
  if (!e || !e.en) noEn.push(k);
}
ok(noZh.length === 0, '每条都有 zh', '缺 zh: ' + noZh.join(', '));
ok(noEn.length === 0, '每条都有 en（缺了就回落中文，等于没翻）', '缺 en: ' + noEn.join(', '));

// en 和 zh 一模一样，多半是忘了翻（有例外：纯 ASCII 的、只有符号的）
const suspicious = keys.filter((k) => {
  const e = DICT[k];
  return /[一-龥]/.test(e.zh) && e.zh === e.en;
});
ok(suspicious.length === 0, '没有「中文原文没翻」的词条', '疑似未翻: ' + suspicious.join(', '));

// ------------------------------------------------------------
section('2. 占位符对齐（zh 的 {x} 必须在 en 里也有）');
// ------------------------------------------------------------
function vars(s) {
  const out = [];
  const re = /\{(\w+)\}/g;
  let m;
  while ((m = re.exec(String(s)))) if (out.indexOf(m[1]) < 0) out.push(m[1]);
  return out.sort();
}
let mismatch = [];
for (const k of keys) {
  const e = DICT[k];
  const a = vars(e.zh).join(',');
  const b = vars(e.en).join(',');
  if (a !== b) mismatch.push(k + '  zh={' + a + '}  en={' + b + '}');
}
ok(mismatch.length === 0, 'zh / en 的变量集合一致', mismatch.join('\n      '));

// ------------------------------------------------------------
section('3. 引用一致性（代码用到的 key ↔ 词典）');
// ------------------------------------------------------------
// 只认字面量 key。三元表达式这种（`i18n.t(x === 'en' ? 'lang.en' : 'lang.zh')`）
// 字面量不在紧跟的括号后，所以取「调用后 200 字符内的所有单引号字面量」，
// 再按「必须带点」筛掉 'en' / 'zh' 这类普通字符串 —— 真正的 key 都是 a.b 形式。
// 按**行**扫，不按字符窗口：200 字符的窗口会跨界捞到后面那行的
// `audit.fromReq(... action: 'config.set_lang' ...)` —— 那是审计动作名，不是词条 key。
const CALL_RE = /i18n\.(?:log|warn|error|t)\(/;
const LIT_RE = /'([A-Za-z0-9_.]+)'/g;
const used = new Set();
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js') && f !== 'serverI18n.js');
for (const f of files) {
  const src = fs.readFileSync(path.join(SRC, f), 'utf8');
  src.split(/\r?\n/).forEach((line) => {
    if (!CALL_RE.test(line)) return;
    if (/action:\s*'/.test(line)) return;      // 审计动作名（auth.* / config.*），不是词条
    let lit;
    LIT_RE.lastIndex = 0;
    while ((lit = LIT_RE.exec(line))) {
      if (lit[1].indexOf('.') > 0) used.add(lit[1]);
    }
  });
}
const usedList = [...used].sort();
console.log('   代码里引用 ' + usedList.length + ' 个 key（' + files.length + ' 个 src 文件）');

const missing = usedList.filter((k) => !DICT[k]);
ok(missing.length === 0, '用到的 key 都在词典里', '缺词条: ' + missing.join(', '));

const unused = keys.filter((k) => !used.has(k));
ok(unused.length === 0, '词典里没有没人用的 key', '未引用: ' + unused.join(', '));

// 反向：还有没有漏网的硬编码 console.log（新加日志时最容易忘了走 i18n）
let hardcoded = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(SRC, f), 'utf8');
  src.split(/\r?\n/).forEach((line, idx) => {
    if (!/console\.(log|warn|error)/.test(line)) return;
    if (/i18n\.(log|warn|error|raw|rawErr)/.test(line)) return; // 已走 i18n 的转发不算
    if (/[一-龥]/.test(line)) hardcoded.push(f + ':' + (idx + 1) + '  ' + line.trim());
  });
}
ok(hardcoded.length === 0, 'src/ 里没有残留的中文 console.*', hardcoded.join('\n      '));

// ------------------------------------------------------------
section('4. 行为冒烟（假 db）');
// ------------------------------------------------------------
function fakeDb(initial) {
  const store = Object.assign({}, initial || {});
  return {
    store,
    prepare(sql) {
      if (/^SELECT/i.test(sql)) {
        return { get(k) { const v = store[k]; return v === undefined ? undefined : { value: v }; } };
      }
      return { run(k, v) { store[k] = v; return { changes: 1 }; } };
    },
  };
}

// 4.1 默认中文
i18n.setLang('zh');
ok(i18n.getLang() === 'zh', '默认 zh');
ok(i18n.t('boot.ready') === '──────── 就绪 ────────', 'zh 输出中文',
  '实际: ' + i18n.t('boot.ready'));

// 4.2 库里 lang=en ⇒ 启动后就是英文
i18n.setLang('zh');
let db = fakeDb({ lang: 'en' });
ok(i18n.initFromDb(db) === 'en', 'initFromDb 读到 en');
ok(i18n.t('boot.ready') === '──────── ready ────────', 'en 输出英文',
  '实际: ' + i18n.t('boot.ready'));

// 4.3 saveLang 立刻生效（不用重启）
i18n.setLang('zh');
db = fakeDb();
ok(i18n.saveLang(db, 'en') === 'en', 'saveLang(en) 返回 en');
ok(db.store.lang === 'en', 'saveLang 写进了 meta.lang', 'store: ' + JSON.stringify(db.store));
ok(i18n.t('shutdown.dbClosed') === '✅ database closed', 'saveLang 后立刻说英文（不用重启）',
  '实际: ' + i18n.t('shutdown.dbClosed'));

// 4.4 非法值归一化：不在 {en, zh} 里的一律当中文
ok(i18n.saveLang(db, 'fr') === 'zh', "saveLang('fr') 归一化为 zh");
ok(i18n.saveLang(db, 'EN') === 'en', "saveLang('EN') 大小写不敏感 → en");
ok(i18n.saveLang(db, null) === 'zh', 'saveLang(null) → zh');
ok(db.store.lang === 'zh', '非法值也如实写库（zh，不是 null）', 'store: ' + JSON.stringify(db.store));

// 4.5 查不到 key 回落中文、不抛异常
i18n.setLang('en');
let threw = false;
let fell = '';
try { fell = i18n.t('no.such.key.at.all'); } catch (e) { threw = true; }
ok(!threw, '未知 key 不抛异常');
ok(fell === 'no.such.key.at.all', '未知 key 原样返回（日志打不出来比语言不对严重）',
  '实际: ' + fell);

// 4.6 变量替换 + 缺失变量保留字面量（不能把 {port} 静默吞掉）
i18n.setLang('en');
ok(i18n.t('boot.started', { port: 20010 }) === '✅ Chatz started, listening on port 20010',
  '变量替换正确', '实际: ' + i18n.t('boot.started', { port: 20010 }));
ok(i18n.t('boot.started', {}) === '✅ Chatz started, listening on port {port}',
  '变量缺失时保留字面量（不静默吞掉）', '实际: ' + i18n.t('boot.started', {}));

// 4.7 initFromDb 在 meta 表不存在 / 查不动时不能崩
i18n.setLang('zh');
let threw2 = false;
try { i18n.initFromDb({ prepare() { throw new Error('no such table: meta'); } }); } catch (e) { threw2 = true; }
ok(!threw2, 'meta 表不存在时 initFromDb 不抛（启动流程不能被日志语言打断）');

// ------------------------------------------------------------
section('5. LOG_LANG 环境变量锁定');
// ------------------------------------------------------------
// 环境变量是硬覆盖：设了它，数据库里那个值改不动。
// 🔴 不能用子进程 spawn 来验（Windows 上 spawnSync node 会 EBUSY）；
//    改成清掉 require 缓存重加载 —— 模块是加载时就吃 env 的，重新 require 等于重新加载。
const MOD = path.join(SRC, 'serverI18n.js');
function loadWithEnv(envVal) {
  delete require.cache[require.resolve(MOD)];
  if (envVal === undefined || envVal === null) delete process.env.LOG_LANG;
  else process.env.LOG_LANG = envVal;
  return require(MOD);
}
function fakeDb2() {
  const store = {};
  return {
    store,
    prepare(sql) {
      if (/^SELECT/i.test(sql)) {
        return { get(k) { const v = store[k]; return v === undefined ? undefined : { value: v }; } };
      }
      return { run(k, v) { store[k] = v; return { changes: 1 }; } };
    },
  };
}

let m = loadWithEnv('en');
let db2 = fakeDb2();
let r = {
  lang: m.getLang(),
  locked: m.isLocked(),
  ready: m.t('boot.ready'),
  afterInit: m.initFromDb(db2),            // 库里没值，不该改变
  afterSave: m.saveLang(db2, 'zh'),        // 想改回中文
  storeLang: db2.store.lang,               // 库仍然如实写
  stillEn: m.t('boot.ready'),              // 但进程里还是英文
};
ok(r.lang === 'en', 'LOG_LANG=en ⇒ 加载即英文');
ok(r.locked === true, 'LOG_LANG 设了 ⇒ locked=true（接口要如实报出来）');
ok(r.ready === '──────── ready ────────', '锁定后输出英文', '实际: ' + r.ready);
ok(r.afterInit === 'en', '锁定时 initFromDb 不改动语言');
ok(r.afterSave === 'en', '锁定时 saveLang(zh) 仍返回 en（改不动）');
ok(r.storeLang === 'zh', '锁定时 saveLang 照样写库（env 一撤就按库里的来）',
  '实际写入: ' + r.storeLang);
ok(r.stillEn === '──────── ready ────────', '锁定时进程内语言没被带跑');

ok(loadWithEnv('EN').getLang() === 'en', 'LOG_LANG 大小写不敏感（EN → en）');

m = loadWithEnv('fr');
ok(m.getLang() === 'zh' && m.isLocked() === true,
  'LOG_LANG 为非法值时归一化 zh 且仍然锁定（设了就锁，别半锁不锁）',
  'lang=' + m.getLang() + ' locked=' + m.isLocked());

m = loadWithEnv('');
ok(m.getLang() === 'zh' && m.isLocked() === false,
  'LOG_LANG 空串 = 没设（不锁）—— .env 里那行被注释掉就是这种情况',
  'lang=' + m.getLang() + ' locked=' + m.isLocked());

// 还原：清掉 env 重加载，别把后面（以及同进程里别的脚本）带跑
delete process.env.LOG_LANG;
loadWithEnv(null);

// ------------------------------------------------------------
section('6. zh 模式与改动前逐字节一致');
// ------------------------------------------------------------
// 中文原文就是 zh 模板，所以 zh 模式输出必须和「没有 i18n 之前」完全一样。
// 这里不做逐文件 diff（那是提交前一次性核对的活），只守住最关键的一条：
// 词典里**没有**为了 i18n 而改写过的中文 —— 若改了，zh 用户的日志也会变。
const zhSamples = {
  'boot.ready': '──────── 就绪 ────────',
  'shutdown.dbClosed': '✅ 数据库已关闭',
  'lang.changed': '🌐 日志语言已切换为 中文',
};
i18n.setLang('zh');
for (const k of Object.keys(zhSamples)) {
  const got = i18n.t(k, { name: i18n.t('lang.zh') });
  ok(got === zhSamples[k], 'zh: ' + k, '期望 ' + JSON.stringify(zhSamples[k]) + ' 实际 ' + JSON.stringify(got));
}

// ============================================================
console.log('');
console.log('================================================');
console.log('通过 ' + pass + '  失败 ' + fail);
console.log('================================================');
if (fail > 0) {
  console.log('');
  console.log('真机联网那段在 verify-full.sh 的 §16：I18N_TEST=1 bash verify-full.sh');
  process.exit(1);
}
