// ============================================================
// 服务端日志的 i18n
// ============================================================
// 为什么要有这个模块：以前 `src/*.js` 里所有 console.log 都硬编码中文，
// 而日志是给运维看的 —— 界面选了英文、日志还是中文，切换体验是割裂的。
//
// 设计取舍：
// 1. **只能按 key 查，绝不做子串替换。** 日志里混着用户数据（频道名、用户名、
//    文件名、消息标题），按片段替换会把「备份是否完成」翻成「backup yes/no 完成」
//    这种鬼东西 —— 前端 i18n 踩过一模一样的坑。
// 2. **中文原文就是 zh 模板**，所以 zh 模式下输出和改动前逐字节一致，
//    不会出现"翻译了一遍结果中文也变了"。
// 3. **查不到就回落中文**，绝不抛异常 —— 日志打不出来比语言不对严重得多。
//
// 语言从 `meta.lang` 读（整机设置），可由 `LOG_LANG` 环境变量强制覆盖。
// 只有超级管理员能改（注册是完全开放的，任何登录用户都能改 = 谁都能改）。

const DICT = {
  // ── 启动横幅 ────────────────────────────────────────────
  'boot.separator': {
    zh: '──────── 启动 {time} ────────',
    en: '──────── start {time} ────────',
  },
  'boot.started': {
    zh: '✅ Chatz 已启动，监听端口 {port}',
    en: '✅ Chatz started, listening on port {port}',
  },
  'boot.dataDir': {
    zh: '   数据目录: {path}',
    en: '   data directory: {path}',
  },
  'boot.webUrl': {
    zh: '   网页版: http://<主机>:{port}/',
    en: '   web UI: http://<host>:{port}/',
  },
  'boot.hookUrl': {
    zh: '   推送接口: http://<主机>:{port}/hook/<应用Token>',
    en: '   push endpoint: http://<host>:{port}/hook/<app-token>',
  },
  'boot.aggWindow': {
    zh: '   消息聚合窗口: {window}ms（单条最长寿命 {lifetime}）',
    en: '   aggregation window: {window}ms (single-message max lifetime {lifetime})',
  },
  'boot.trustProxyOff': {
    zh: '   🛡️  TRUST_PROXY=off  →  限速 / 审计只认 TCP 对端地址（忽略 X-Forwarded-For）',
    en: '   🛡️  TRUST_PROXY=off  →  rate limiting / audit use the TCP peer only (X-Forwarded-For ignored)',
  },
  'boot.trustProxyOffHint': {
    zh: '      （前面挂了反代的话要改：否则所有人被记成反代的内网 IP，一人触发限速全站 429）',
    en: '      (change this if a proxy sits in front: otherwise everyone is logged as the proxy\'s internal IP and one person tripping the limiter 429s the whole site)',
  },
  'boot.trustProxyTrue': {
    zh: '   ⚠️  TRUST_PROXY=true  →  限速 / 审计取 X-Forwarded-For 第一段',
    en: '   ⚠️  TRUST_PROXY=true  →  rate limiting / audit take the first X-Forwarded-For segment',
  },
  'boot.trustProxyTrueHint': {
    zh: '      ⚠️  反代用 $proxy_add_x_forwarded_for（追加）时，客户端伪造的值就在第一段',
    en: '      ⚠️  with $proxy_add_x_forwarded_for (append) the client\'s forged value sits in that first segment',
  },
  'boot.trustProxyTrueAdvice': {
    zh: '         建议改用 TRUST_PROXY=1 或 TRUST_PROXY=<反代内网IP>',
    en: '         use TRUST_PROXY=1 or TRUST_PROXY=<proxy-internal-IP> instead',
  },
  'boot.trustProxyHops': {
    zh: '   ⚠️  TRUST_PROXY={hops}  →  按 {hops} 跳反代计算客户端 IP',
    en: '   ⚠️  TRUST_PROXY={hops}  →  client IP computed by skipping {hops} proxy hop(s)',
  },
  'boot.trustProxyHopsHint': {
    zh: '      ⚠️  跳数模式不校验对端：本端口若也能被公网直连，绕过反代 + 伪造 XFF 可取任意 IP',
    en: '      ⚠️  hop-count mode does not verify the peer: if this port is also reachable from the internet, bypassing the proxy with a forged XFF yields any IP',
  },
  'boot.trustProxyHopsAdvice': {
    zh: '         要么防火墙只放行 80/443，要么改成 TRUST_PROXY=<反代内网IP>',
    en: '         either let the firewall allow only 80/443, or switch to TRUST_PROXY=<proxy-internal-IP>',
  },
  'boot.trustProxyList': {
    zh: '   🛡️  TRUST_PROXY={shown}  →  只信任来自本机 / 内网的代理',
    en: '   🛡️  TRUST_PROXY={shown}  →  trust proxies from loopback / private networks only',
  },
  'boot.ready': {
    zh: '──────── 就绪 ────────',
    en: '──────── ready ────────',
  },

  // ── 关闭 ────────────────────────────────────────────────
  'boot.unknown': { zh: '(未知)', en: '(unknown)' },
  'boot.aggUnlimited': { zh: '不限制', en: 'unlimited' },
  'shutdown.separator': {
    zh: '──────── 收到 {signal}，正在关闭 ────────',
    en: '──────── received {signal}, shutting down ────────',
  },
  'shutdown.duplicateSignal': {
    zh: '   （已在关闭中，忽略重复的 {signal}）',
    en: '   (already shutting down, ignoring duplicate {signal})',
  },
  'shutdown.dbClosed': { zh: '✅ 数据库已关闭', en: '✅ database closed' },
  'shutdown.dbCloseFailed': {
    zh: '❌ 数据库关闭失败: {msg}',
    en: '❌ failed to close database: {msg}',
  },

  // ── 主密钥 ──────────────────────────────────────────────
  'authToken.notInitialized': {
    zh: '⏳ 尚未初始化：主密钥还没生成',
    en: '⏳ not initialised: master key not generated yet',
  },
  'authToken.notInitializedHint': {
    zh: '   → 打开网页版走首次引导，设置管理员账号后会自动生成',
    en: '   → open the web UI and complete first-run setup; it is generated once you set the admin account',
  },
  'authToken.freshDataDir': {
    zh: '   ℹ️  连的是全新数据目录：{path}',
    en: '   ℹ️  using a brand-new data directory: {path}',
  },
  'authToken.freshDataDirHint': {
    zh: '      如果这不是你想要的，说明部署目录 / 挂载的数据卷和上次不一样',
    en: '      if that is not what you want, the deployment directory or mounted volume differs from last time',
  },
  'authToken.headlessHint': {
    zh: '   💡 想无头预置：AUTH_TOKEN_FILE=<容器内文件路径>（推荐）或在 .env 里写 AUTH_TOKEN=<固定值>',
    en: '   💡 headless provisioning: AUTH_TOKEN_FILE=<path-inside-container> (recommended), or AUTH_TOKEN=<fixed-value> in .env',
  },
  'authToken.readyFile': {
    zh: '🔑 AUTH_TOKEN 就绪 [文件] · 指纹 {fp}…',
    en: '🔑 AUTH_TOKEN ready [file] · fingerprint {fp}…',
  },
  'authToken.readyFileHint': {
    zh: '   完整值不进日志 —— 它只存在于 {path}',
    en: '   full value never logged — it exists only in {path}',
  },
  'authToken.readyDb': {
    zh: '🔑 AUTH_TOKEN 就绪 [数据库] · 指纹 {fp}…',
    en: '🔑 AUTH_TOKEN ready [database] · fingerprint {fp}…',
  },
  'authToken.readyDbHint': {
    zh: '   完整值不进日志 —— 需要时到网页版「安全与登录 → 登录设备」复制',
    en: '   full value never logged — copy it from "Security & sign-in → Signed-in devices" in the web UI',
  },
  'authToken.readyEnv': {
    zh: '🔑 AUTH_TOKEN 就绪 [环境变量] · 指纹 {fp}…',
    en: '🔑 AUTH_TOKEN ready [environment] · fingerprint {fp}…',
  },
  'authToken.readyEnvHint': {
    zh: '   完整值见 .env 里的 AUTH_TOKEN',
    en: '   full value is in AUTH_TOKEN inside .env',
  },
  'authToken.envFileAdvice': {
    zh: '   💡 不想让明文待在 env 里：改用 AUTH_TOKEN_FILE=<挂载进来的文件路径>',
    en: '   💡 to keep the plaintext out of the environment: use AUTH_TOKEN_FILE=<mounted-file-path>',
  },
  'authToken.bothSet': {
    zh: '⚠️  AUTH_TOKEN 和 AUTH_TOKEN_FILE 同时设置了，以 AUTH_TOKEN（明文）为准',
    en: '⚠️  both AUTH_TOKEN and AUTH_TOKEN_FILE are set; AUTH_TOKEN (plaintext) wins',
  },
  'authToken.bothSetHint': {
    zh: '    想改用文件方式，请把 .env 里的 AUTH_TOKEN 那行删掉或注释掉',
    en: '    to switch to the file source, delete or comment out the AUTH_TOKEN line in .env',
  },
  'authToken.sourceError': {
    zh: '❌ 主密钥来源配置有问题，拒绝启动：',
    en: '❌ master key source is misconfigured, refusing to start:',
  },
  'authToken.sourceErrorHint1': {
    zh: '   排查：文件挂进容器了吗？路径对吗？容器里读得到吗？',
    en: '   check: is the file mounted into the container? is the path right? is it readable inside the container?',
  },
  'authToken.sourceErrorHint2': {
    zh: '   不想用文件方式就删掉 AUTH_TOKEN_FILE，主密钥会回落到数据库里的值。',
    en: '   drop AUTH_TOKEN_FILE if you do not want the file source; the master key falls back to the database value.',
  },
  'authToken.sourceErrorDetail': { zh: '   {msg}', en: '   {msg}' },
  'authToken.readFileFailed': {
    zh: '读不到 AUTH_TOKEN_FILE 指向的文件「{file}」：{msg}',
    en: 'cannot read the file pointed to by AUTH_TOKEN_FILE "{file}": {msg}',
  },
  'authToken.fileEmpty': {
    zh: 'AUTH_TOKEN_FILE 指向的文件「{file}」是空的',
    en: 'the file pointed to by AUTH_TOKEN_FILE "{file}" is empty',
  },

  // ── 数据库迁移 ──────────────────────────────────────────
  'migrate.applied': {
    zh: '🔧 数据库迁移：应用 {n} 项变更 → {list}',
    en: '🔧 database migration: applied {n} change(s) → {list}',
  },
  'migrate.failed': { zh: '❌ 迁移失败: {msg}', en: '❌ migration failed: {msg}' },

  // ── HTTPS / 证书 ────────────────────────────────────────
  'certs.hotReloaded': { zh: '✅ 证书已热更新', en: '✅ certificate hot-reloaded' },
  'certs.hotReloadFailed': {
    zh: '❌ 证书热更新失败: {msg}',
    en: '❌ certificate hot-reload failed: {msg}',
  },
  'certs.httpsCreateFailed': {
    zh: '❌ HTTPS 创建失败: {msg}',
    en: '❌ failed to create HTTPS server: {msg}',
  },
  'certs.httpsListenFailed': {
    zh: '❌ HTTPS 监听失败: {msg}',
    en: '❌ HTTPS listen failed: {msg}',
  },
  'certs.httpsRuntimeError': {
    zh: '❌ HTTPS 运行时错误: {msg}',
    en: '❌ HTTPS runtime error: {msg}',
  },
  'certs.httpsStarted': {
    zh: '🔒 HTTPS 已启动，监听端口 {port}',
    en: '🔒 HTTPS started, listening on port {port}',
  },
  'certs.httpsStopped': { zh: '🛑 HTTPS 服务已关闭', en: '🛑 HTTPS service stopped' },
  'certs.httpsStopFailed': { zh: '关闭 HTTPS 失败: {msg}', en: 'failed to stop HTTPS: {msg}' },
  'certs.httpsStartupFailed': {
    zh: '启动时启用 HTTPS 失败: {msg}',
    en: 'failed to enable HTTPS at startup: {msg}',
  },

  // ── 客户端 IP / TRUST_PROXY ─────────────────────────────
  'trustProxy.invalid': {
    zh: '[trust proxy] "{raw}" 不是合法的信任配置，按不信任处理: {msg}',
    en: '[trust proxy] "{raw}" is not a valid trust configuration, treating as untrusted: {msg}',
  },
  'trustProxy.unrecognized': {
    zh: '[clientIp] TRUST_PROXY="{raw}" 无法识别，按不信任处理',
    en: '[clientIp] TRUST_PROXY="{raw}" not recognised, treating as untrusted',
  },
  'trustProxy.allowedValues': {
    zh: '           可填：off/false/0 · true · 正整数跳数 · IP或CIDR（如 172.17.0.1、172.16.0.0/12）',
    en: '           accepted: off/false/0 · true · positive hop count · IP or CIDR (e.g. 172.17.0.1, 172.16.0.0/12)',
  },

  // ── 附件 ────────────────────────────────────────────────
  'attachment.sweptWithMessage': {
    zh: '🧹 随消息删除清理附件 {n} 个',
    en: '🧹 removed {n} attachment(s) along with the message',
  },
  'attachment.sweptOrphan': {
    zh: '🧹 启动清理孤儿附件 {n} 个',
    en: '🧹 swept {n} orphaned attachment(s) at startup',
  },

  // ── 审计 ────────────────────────────────────────────────
  'audit.trimmed': { zh: '🧾 审计日志裁剪：删除 {n} 条', en: '🧾 audit trimming: removed {n} row(s)' },

  // ── Webhook ─────────────────────────────────────────────
  'hook.templateRenderFailed': {
    zh: '[hook] 模板渲染失败: {msg}',
    en: '[hook] template rendering failed: {msg}',
  },
  'hook.rejected': {
    zh: '[hook] {app} -> 已拒绝: {reason}',
    en: '[hook] {app} -> rejected: {reason}',
  },
  'hook.dropped': {
    zh: '[hook] {app} -> 被路由规则丢弃',
    en: '[hook] {app} -> dropped by a routing rule',
  },

  // ── 路由规则 ────────────────────────────────────────────
  'route.webhookRejected': {
    zh: '[route] call_webhook 已拒绝: {url} —— {reason}',
    en: '[route] call_webhook rejected: {url} — {reason}',
  },

  // ── WebSocket ───────────────────────────────────────────
  'ws.userUpdatedFailed': {
    zh: '[user] userUpdated 推送失败: {msg}',
    en: '[user] failed to push userUpdated: {msg}',
  },

  // ── 忘记密码（打印到日志的邮件）─────────────────────────
  'resetMail.header': { zh: '📧 密码重置请求', en: '📧 password reset requested' },
  'resetMail.user': { zh: '   用户: {username} <{email}>', en: '   user: {username} <{email}>' },
  'resetMail.link': { zh: '   链接: {link}', en: '   link: {link}' },
  'resetMail.ttl': {
    zh: '   有效期: {minutes} 分钟（一次性，用一次即失效）',
    en: '   valid for: {minutes} minutes (single use)',
  },

  // ── 命令行：reset-password.js ───────────────────────────
  'cli.resetUsage': {
    zh: `从服务器侧重置用户密码

  node src/reset-password.js --list                                    列出所有用户
  node src/reset-password.js <用户名> <新密码>                          重置密码
  echo '<新密码>' | node src/reset-password.js <用户名> --stdin         从标准输入读密码

密码长度 {min}-{max} 位。重置后不会吊销任何已登录设备。`,
    en: `Reset a user's password from the server side

  node src/reset-password.js --list                                    list all users
  node src/reset-password.js <username> <new-password>                 reset a password
  echo '<new-password>' | node src/reset-password.js <username> --stdin  read it from stdin

Password length {min}-{max} chars. Resetting does not revoke any signed-in device.`,
  },
  'cli.noUsers': { zh: '（数据库里没有任何用户）', en: '(the database has no users)' },
  'cli.userCount': { zh: '共 {n} 个用户：', en: '{n} user(s) total:' },
  'cli.userRow': {
    zh: '  #{id}  {username}  {role}  {pw}',
    en: '  #{id}  {username}  {role}  {pw}',
  },
  'cli.roleAdmin': { zh: '管理员', en: 'admin' },
  'cli.roleUser': { zh: '普通用户', en: 'user' },
  'cli.pwSet': { zh: '密码已设置', en: 'password set' },
  'cli.pwUnset': { zh: '密码未设置', en: 'password not set' },
  'cli.missingPassword': {
    zh: '缺少新密码。用 --stdin 从标准输入读取，或直接写在第二个参数里。',
    en: 'Missing new password. Use --stdin to read it from standard input, or pass it as the second argument.',
  },
  'cli.passwordLength': {
    zh: '新密码长度必须是 {min}-{max} 位（当前 {len} 位）。',
    en: 'New password must be {min}-{max} chars (currently {len}).',
  },
  'cli.userNotFound': {
    zh: '没有名为「{username}」的用户。先跑 --list 看看有哪些：',
    en: 'No user named "{username}". Run --list first to see what exists:',
  },
  'cli.resetOk': {
    zh: '✅ 已重置「{username}」（#{id}{suffix}）的密码。',
    en: '✅ reset the password of "{username}" (#{id}{suffix}).',
  },
  'cli.resetOkRoleSuffix': { zh: '，管理员', en: ', admin' },
  'cli.resetOkHint': { zh: '   现在可以用新密码登录了。', en: '   you can sign in with the new password now.' },
  'cli.resetOkDevices': {
    zh: '   已登录的设备不受影响（devices 记录没动）。',
    en: '   signed-in devices are unaffected (no devices row touched).',
  },
  'cli.resetFailed': { zh: '重置失败：{msg}', en: 'reset failed: {msg}' },

  // ── 数据库迁移（续）──────────────────────────────────────
  'migrate.dupToken': {
    zh: '⚠️ applications 存在重复 token，已跳过建唯一索引（请手动处理）: {list}',
    en: '⚠️ applications has duplicate tokens, skipped creating the unique index (fix manually): {list}',
  },

  // ── 日志语言本身 ────────────────────────────────────────
  // ── 预置数据（种子）────────────────────────────────────
  // 全新实例由 migrate 建出来的东西。它不是用户数据，所以应该跟着语言走；
  // 但**只在还是预置原文时才动** —— 用户改过名就绝不能覆盖（见 users.js 的 /setup）。
  'channel.defaultName': { zh: '默认频道', en: 'Default channel' },
  'channel.defaultDesc': { zh: 'v1 数据自动归属', en: 'legacy v1 data fallback' },

  'lang.changed': { zh: '🌐 日志语言已切换为 {name}', en: '🌐 log language switched to {name}' },
  'lang.zh': { zh: '中文', en: 'Chinese' },
  'lang.en': { zh: '英文', en: 'English' },
};

// ============================================================
// 语言状态
// ============================================================
// 优先级：LOG_LANG 环境变量 > meta.lang（数据库） > 中文
//
// 环境变量是「硬覆盖」：设了它，数据库里那个值就改不动了（接口仍然返回 200，
// 但实际生效的仍是 env）。这样部署时想钉死语言（比如整机日志统一进英文采集）
// 就不会被某个超管在界面上随手改掉。
const META_KEY = 'lang';

let LANG = 'zh';
let LOCKED = false;

function normalize(l) {
  return (String(l || '').toLowerCase() === 'en') ? 'en' : 'zh';
}

// 模块一加载就先吃环境变量 —— 最早的一批日志（迁移、主密钥来源报错）
// 发生在 migrate() 里，那时候还没人来得及调 initFromDb()。
if (process.env.LOG_LANG) {
  LANG = normalize(process.env.LOG_LANG);
  LOCKED = true;
}

function setLang(l) { LANG = normalize(l); }
function getLang() { return LANG; }
function isEn() { return LANG === 'en'; }
function isLocked() { return LOCKED; }

/**
 * 建好 meta 表之后用它把语言读进来。
 *
 * 两处调用：migrate() 里建完表立刻调一次（覆盖 migrate 自己那几条日志），
 * db.js 在 migrate() 之后再调一次（正常路径）。幂等，重复调没副作用。
 *
 * 🔴 必须 try/catch：全新库 / 表被锁 / db 句柄异常时，读不到语言只是
 *    "日志语言不对"，绝不能因此把启动流程打断。
 */
function initFromDb(db) {
  if (LOCKED) return LANG;
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY);
    if (row && row.value) LANG = normalize(row.value);
  } catch (e) { /* 表还不存在 / 查不动：保持当前值 */ }
  return LANG;
}

/**
 * 改语言：写库 + 立刻生效（不用重启）。
 * 返回实际生效的语言（env 锁定时会与入参不同）。
 */
function saveLang(db, lang) {
  const want = normalize(lang);
  try {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(META_KEY, want);
  } catch (e) { /* 写不进去也别崩：至少内存里切了 */ }
  if (!LOCKED) setLang(want);
  return getLang();
}

function applyVars(s, vars) {
  if (!vars) return s;
  return String(s).replace(/\{(\w+)\}/g, function (m, k) {
    const v = vars[k];
    return (v === undefined || v === null) ? m : String(v);
  });
}

/**
 * 按 key 取当前语言的文案。
 * 🔴 查不到就**回落中文**并返回中文模板（绝不抛异常）——
 *    日志打不出来，比"语言不对"严重得多。
 */
function t(key, vars) {
  const e = DICT[key];
  if (!e) return applyVars(String(key), vars);
  const tpl = (LANG === 'en' && e.en) ? e.en : e.zh;
  return applyVars(tpl, vars);
}

/**
 * 按**指定**语言取文案（不看当前 LANG）。
 *
 * 用来判断「这条预置数据现在是不是还是种子原文」—— 判断的那一侧很可能和当前
 * 语言相反（比如当前已经是英文，要去比对中文原文），所以不能用 t()。
 */
function tIn(key, lang, vars) {
  const e = DICT[key];
  if (!e) return applyVars(String(key), vars);
  const tpl = (lang === 'en' && e.en) ? e.en : e.zh;
  return applyVars(tpl, vars);
}

const out = {
  t,
  tIn,
  setLang,
  getLang,
  isEn,
  isLocked,
  initFromDb,
  saveLang,
  META_KEY,
  log: function (key, vars) { console.log(t(key, vars)); },
  warn: function (key, vars) { console.warn(t(key, vars)); },
  error: function (key, vars) { console.error(t(key, vars)); },
  /** 已翻译好的整串直接输出（比如多行 usage、空行分隔） */
  raw: function (s) { console.log(s); },
  rawErr: function (s) { console.error(s); },
  DICT,
};

module.exports = out;
