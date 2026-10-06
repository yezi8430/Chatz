// 离线校验 users.js 里的界面偏好（settings）校验逻辑。
// 本机没有 node_modules，所以用「抠真函数」的办法：把源码里 SETTINGS_SPEC /
// coerceSetting / normalizeSettings 那一段原样切出来 eval，保证测的就是真代码。
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'src', 'users.js'), 'utf8');

const start = src.indexOf('const SETTINGS_SPEC = {');
const end = src.indexOf('function readSettings(userId)');
if (start < 0 || end < 0 || end < start) {
  console.error('切不出源码片段：标记位置变了，测试脚本要跟着改');
  process.exit(1);
}
const snippet = src.slice(start, end);

const factory = new Function(snippet + '\nreturn { SETTINGS_SPEC, coerceSetting, normalizeSettings };');
const { SETTINGS_SPEC, coerceSetting, normalizeSettings } = factory();

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n        got  ' + g + '\n        want ' + w); }
}

console.log('— 1. 白名单：不认识的键一律丢弃 —');
eq('unknown key', normalizeSettings({ theme: 'dark', evil: 'x', theme2: 1 }), { theme: 'dark' });
eq('null / 非对象', normalizeSettings(null), {});
eq('数组不算对象', normalizeSettings(['a']), {});
eq('字符串不算对象', normalizeSettings('nope'), {});
eq('空对象', normalizeSettings({}), {});

console.log('— 2. enum：只收登记过的取值 —');
eq('theme=dark', normalizeSettings({ theme: 'dark' }), { theme: 'dark' });
eq('theme=light', normalizeSettings({ theme: 'light' }), { theme: 'light' });
eq('theme=DARK 大小写敏感', normalizeSettings({ theme: 'DARK' }), {});
eq('theme=blue 不存在', normalizeSettings({ theme: 'blue' }), {});
eq('lang=en', normalizeSettings({ lang: 'en' }), { lang: 'en' });
eq('lang=zh', normalizeSettings({ lang: 'zh' }), { lang: 'zh' });
eq('lang=jp 不支持', normalizeSettings({ lang: 'jp' }), {});

console.log('— 3. int：必须是整数且落在范围内 —');
eq('bgBlur=12', normalizeSettings({ bgBlur: 12 }), { bgBlur: 12 });
eq('bgBlur=0 边界', normalizeSettings({ bgBlur: 0 }), { bgBlur: 0 });
eq('bgBlur=40 上界', normalizeSettings({ bgBlur: 40 }), { bgBlur: 40 });
eq('bgBlur=41 越界', normalizeSettings({ bgBlur: 41 }), {});
eq('bgBlur=-1 越界', normalizeSettings({ bgBlur: -1 }), {});
eq('bgBlur=1.5 非整数', normalizeSettings({ bgBlur: 1.5 }), {});
eq('bgBlur="8" 字符串宽松收', normalizeSettings({ bgBlur: '8' }), { bgBlur: 8 });
eq('bgBlur="" 空串', normalizeSettings({ bgBlur: '' }), {});
eq('bgDim=100 上界', normalizeSettings({ bgDim: 100 }), { bgDim: 100 });
eq('bgDim=101 越界', normalizeSettings({ bgDim: 101 }), {});
eq('bgBlur=NaN', normalizeSettings({ bgBlur: NaN }), {});

console.log('— 4. bool：真/假都认，其它一律丢 —');
eq('accentFromBg=true', normalizeSettings({ accentFromBg: true }), { accentFromBg: true });
eq('accentFromBg=false', normalizeSettings({ accentFromBg: false }), { accentFromBg: false });
eq('accentFromBg=1', normalizeSettings({ accentFromBg: 1 }), { accentFromBg: true });
eq('accentFromBg="0"', normalizeSettings({ accentFromBg: '0' }), { accentFromBg: false });
eq('accentFromBg="yes"', normalizeSettings({ accentFromBg: 'yes' }), {});
eq('accentFromBg=null', normalizeSettings({ accentFromBg: null }), {});
eq('imageBottom=true', normalizeSettings({ imageBottom: true }), { imageBottom: true });

console.log('— 5. 整体：合法项保留、非法项剔除，互不影响 —');
eq(
  '混合',
  normalizeSettings({ theme: 'dark', bgBlur: 999, bgDim: 35, accentFromBg: false, imageBottom: true, junk: 1 }),
  { theme: 'dark', bgDim: 35, accentFromBg: false, imageBottom: true }
);

console.log('— 6. 规格表本身的健全性 —');
eq('登记的键齐全', Object.keys(SETTINGS_SPEC).sort(), ['accentFromBg', 'bgBlur', 'bgDim', 'imageBottom', 'lang', 'theme']);
eq('每个 kind 都认识', Object.values(SETTINGS_SPEC).every(s => ['enum', 'int', 'bool'].includes(s.kind)), true);
eq('每个 int 都有上下界', Object.values(SETTINGS_SPEC).filter(s => s.kind === 'int').every(s => Number.isInteger(s.min) && Number.isInteger(s.max)), true);
eq('每个 enum 都有取值表', Object.values(SETTINGS_SPEC).filter(s => s.kind === 'enum').every(s => Array.isArray(s.values) && s.values.length > 0), true);

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + '  pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
