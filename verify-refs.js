// 离线扫描：src/ 里的每个文件，有没有「调用了但没定义」的函数。
//
// 为什么需要它：本机没有 node_modules，require 不动 db / ws，
// 所以 digest.js 这类文件**加载不了** —— 而 node --check 只查语法，
// 查不出「require 改窄了漏掉一个名字」「module.exports 引用了没定义的名字」。
// 2026-10-13 一天内踩了三次同一个坑：
//   ① digest.js exports 了 dayKey 但 require 里删掉了 ⇒ 容器起不来
//   ② digest.js 还在用 renderDigest，require 行改窄时一起删了 ⇒ POST /user/digest/run 500
//   ③ users.js 用 digestChannelId 却没 import ⇒ GET /user/digest 500（本脚本抓出来的）
// 这类错误只有真机能发现，代价太大 —— 所以加一层静态兜底。
//
// 做法：把注释和字符串整体「涂白」（逐字符扫描，按引号状态机），
// 只在剩下的真代码里找 `标识符(` 与 `module.exports = {...}`，对照本文件的声明。
// ⚠️ 涂白是必须的：SQL 里 `INSERT INTO users (` 会被当成函数调用，噪声大到没法看。
//
// 用法：node verify-refs.js

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, 'src');

// 语言内置 + Node 全局 + 本项目里出现的中间件参数名
const GLOBALS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new',
  'else', 'do', 'try', 'delete', 'await', 'throw', 'case', 'in', 'of', 'void',
  'require', 'module', 'exports', 'process', 'console', 'Buffer', 'setTimeout',
  'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'Promise',
  'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Date', 'Math',
  'Error', 'TypeError', 'RangeError', 'Map', 'Set', 'WeakMap', 'RegExp', 'Symbol',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'URL', 'fetch', 'AbortController', 'Intl',
  'async', 'next', 'resolve', 'reject', 'fn', 'keyFn', 'rej', 'cb', 'done',
  'http', 'https', 'path', 'fs', 'os', 'crypto', 'util', 'events', 'net',
]);

/**
 * 把注释与字符串的位置涂成空格（保持长度不变，方便对照位置）
 *
 * 逐字符状态机，不走正则 —— 正则一遇到字符串里的引号/反引号就会配对错位，
 * 结果是把大段真代码当成字符串吃掉（serverI18n.js 就吃过这个亏）。
 */
function maskLiterals(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  const blank = (k) => { if (k < n) out[k] = ' '; };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { blank(i); i++; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { blank(i); i++; }
      blank(i); i++; blank(i); i++;
      continue;
    }
    // 模板字符串可以跨行；单/双引号的普通字符串**不跨行**（遇到换行就当它结束）。
    // 为什么这么武断：正则/注释里出现一个没配对的引号时，跨行扫描会把后面几百行
    // 全当成字符串吃掉（hooks.js 的 /name\s*=\s*"..." /i 就踩过），
    // 而本项目里并没有跨行的普通字符串。
    if (c === "'" || c === '"') {
      const q = c;
      blank(i); i++;
      while (i < n && src[i] !== q && src[i] !== '\n') {
        if (src[i] === '\\') { blank(i); i++; }
        blank(i); i++;
      }
      if (i < n && src[i] === q) { blank(i); i++; }
      continue;
    }
    if (c === '`') {
      blank(i); i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { blank(i); i++; }
        blank(i); i++;
      }
      blank(i); i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** 本文件里所有「被定义出来」的名字 */
function declaredNames(src) {
  const out = new Set();
  const res = [
    /function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
    /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require/g,
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*;/g,
    /function\s*\(([^)]*)\)/g,
    /function\s+[A-Za-z_$][\w$]*\s*\(\s*\{([^}]*)\}/g,
    /\(([^)]*)\)\s*=>/g,
    /([A-Za-z_$][\w$]*)\s*=>/g,
    /catch\s*\(\s*([A-Za-z_$][\w$]*)/g,
  ];
  for (const re of res) {
    let m;
    while ((m = re.exec(src))) {
      m[1].split(',').forEach((p) => {
        const n = p.split(':')[0].split('=')[0].trim();
        if (n && /^[A-Za-z_$][\w$]*$/.test(n)) out.add(n);
      });
    }
  }
  return out;
}

let pass = 0, fail = 0;

const files = fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.js')).sort();
for (const f of files) {
  const code = maskLiterals(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'));
  const decl = declaredNames(code);
  const missing = new Set();

  // ① 函数调用：名字左边不能是 . 或标识符字符（排除 obj.method()）
  let m;
  const callRe = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = callRe.exec(code))) {
    const n = m[1];
    if (!decl.has(n) && !GLOBALS.has(n) && n.includes('_') === false) {
      missing.add(n);
    }
  }

  // ② module.exports = { A, B } 里的名字
  const ex = code.match(/module\.exports\s*=\s*\{([\s\S]*?)\n?\};/);
  if (ex) {
    for (const part of ex[1].split(',')) {
      const n = part.split('//')[0].trim();
      if (n && /^[A-Za-z_$][\w$]*$/.test(n) && !decl.has(n)) missing.add(n);
    }
  }

  if (missing.size === 0) {
    pass++;
    console.log('  ok   ' + f);
  } else {
    fail++;
    console.log('  FAIL ' + f + ' → 未定义: ' + [...missing].join(', '));
  }
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + '  pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
