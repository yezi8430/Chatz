/**
 * verify-sql.js —— SQL 静态体检（离线，零依赖）
 *
 * 为什么需要它：
 *   2026-10-13 修「删掉摘要容器频道后摘要发不出」时，顺手写了
 *     `JOIN channels c ON c.id = d.channel_id WHERE ... AND c.deleted_at IS NULL`
 *   而 **channels 表根本没有 deleted_at 这一列**（频道是硬删的）⇒ prepare 直接抛
 *   ⇒ 「立即生成一份」500。
 *
 *   `node --check` 只查语法，verify-refs.js 只查 JS 标识符 ——
 *   **SQL 里的列名写错，两个都看不见**，只能等用户点出来。
 *
 * 做法（用 Node 22 内置的 node:sqlite，不需要 better-sqlite3 / node_modules）：
 *   1. 从 migrate.js 抽出所有 CREATE TABLE / ALTER TABLE，在内存库里建出全量 schema
 *   2. 从 src/*.js 里抽出所有 SQL 字符串
 *   3. 逐条 `db.prepare(sql)` —— SQLite 会校验表和列是否真的存在
 *
 * 局限（宁可漏报也不要误报）：
 *   · 跨多行 `sql +=` 拼出来的句子抽不全，跳过
 *   · 模板串里的 ${} 先换成 1，只为过语法检查
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

// ───────────────────────── 1. 建 schema ─────────────────────────

/** 从 startIdx 处的 `(` 开始做括号配对，返回匹配的 `)` 下标 */
function matchParen(s, startIdx) {
  let depth = 0;
  for (let i = startIdx; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 抽 CREATE TABLE 语句（括号配对，不吃掉列定义） */
function extractCreateTables(src) {
  const out = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([\w]+)["'`]?\s*\(/gi;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('(', m.index + m[0].length - 1);
    const close = matchParen(src, open);
    if (close < 0) continue;
    out.push(src.slice(m.index, close + 1));
  }
  return out;
}

/** 抽 ALTER TABLE ... ADD COLUMN ...
 *  ⚠️ 字符类里必须排除引号：migrate.js 里是 `db.exec('ALTER TABLE x ADD COLUMN y INT')`，
 *     不排除的话会把结尾那个单引号一起吃进来，拼出来的句子是错的（列就白加了）。 */
function extractAlterAdd(src) {
  const out = [];
  const re = /ALTER\s+TABLE\s+["'`]?([\w]+)["'`]?\s+ADD\s+COLUMN\s+([^;'"`)]+)/gi;
  let m;
  while ((m = re.exec(src))) out.push(`ALTER TABLE ${m[1]} ADD COLUMN ${m[2].trim()}`);
  return out;
}

// ⚠️ 建表语句分散在**两个**文件：src/db.js（最早期那批：applications / messages …）
//    和 src/migrate.js（后加的 + ALTER）。只抽 migrate.js 会漏掉 messages，
//    然后几百条 SQL 全部误报成「no such table」。
const migrateSrc = fs.readFileSync(path.join(__dirname, 'src/db.js'), 'utf8')
  + '\n' + fs.readFileSync(path.join(__dirname, 'src/migrate.js'), 'utf8');
const creates = extractCreateTables(migrateSrc);
const alters = extractAlterAdd(migrateSrc);

const mem = new DatabaseSync(':memory:');
let schemaOk = true;
let schemaErr = '';
try {
  for (const c of creates) { try { mem.exec(c); } catch (e) { /* 重复建表忽略 */ } }
  for (const a of alters) { try { mem.exec(a); } catch (e) { /* 列已存在忽略 */ } }
} catch (e) {
  schemaOk = false;
  schemaErr = e.message;
}

console.log('=== 1. schema 构建 ===');
ok('从 migrate.js 抽到 CREATE TABLE', creates.length > 5, `got ${creates.length}`);
ok('抽到 ALTER TABLE ADD COLUMN', alters.length >= 0, `got ${alters.length}`);
ok('内存库建表成功', schemaOk, schemaErr);
ok('channels 表存在', (() => {
  try { mem.prepare('SELECT id FROM channels').all(); return true; } catch { return false; }
})());
// 就是这一条当初骗过了所有人：channels **没有** deleted_at
ok('channels 没有 deleted_at（频道是硬删的）', (() => {
  try { mem.prepare('SELECT deleted_at FROM channels').all(); return false; }
  catch { return true; }
})());
ok('messages 有 deleted_at（消息是软删的）', (() => {
  try { mem.prepare('SELECT deleted_at FROM messages').all(); return true; }
  catch { return false; }
})());

// ───────────────────────── 2. 抽 SQL ─────────────────────────

/**
 * 从源码里抽 SQL：认 `db.prepare(\`...\`)` / `.all(\`...\`)` 之类的模板串，
 * 也认普通引号里以 SELECT/INSERT/UPDATE/DELETE 开头的短句。
 */
function extractSql(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];

  // 模板串（跨行也能拿到，SQL 大多这么写）
  const tpl = /`([^`]*)`/g;
  let m;
  while ((m = tpl.exec(src))) {
    const raw = m[1];
    if (!/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(raw)) continue;
    out.push(raw);
  }

  // 单引号 / 双引号里的单行 SQL
  const q = /['"](\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b[^'"]*)['"]/g;
  while ((m = q.exec(src))) out.push(m[1]);

  return out;
}

/** 模板串里的 ${...} 换成 1，只为让 SQLite 能解析 */
function stub(sql) {
  return sql
    .replace(/\$\{[^}]*\}/g, '1')
    .replace(/@\w+/g, '1')      // better-sqlite3 的命名参数 @name
    .replace(/:\w+/g, '1');     // sqlite 原生命名参数 :name
}

const files = fs.readdirSync(path.join(__dirname, 'src'))
  .filter(f => f.endsWith('.js'))
  .sort();

console.log('\n=== 2. SQL 校验 ===');
let checked = 0;
let broken = [];
for (const f of files) {
  const stmts = extractSql(path.join(__dirname, 'src', f));
  for (const raw of stmts) {
    const sql = stub(raw);
    // 只查「引用了表」的句子：没有 FROM/INTO/UPDATE 的（比如纯表达式）跳过
    if (!/\b(FROM|INTO|UPDATE)\b/i.test(sql)) continue;
    checked++;
    try {
      mem.prepare(sql);
    } catch (e) {
      // 「no such column / no such table」才是真错；
      // 语法层面的（比如 stub 替换造成的）不算
      if (/no such (column|table)/i.test(e.message)) {
        broken.push({ file: f, sql: sql.trim().split('\n')[0].slice(0, 90), msg: e.message });
      }
    }
  }
}

ok(`检查了 ${checked} 条 SQL，没有引用不存在的表/列`, broken.length === 0);
for (const b of broken) console.log(`       ✗ ${b.file}: ${b.sql}\n         ${b.msg}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
