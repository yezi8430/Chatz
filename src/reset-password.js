#!/usr/bin/env node
// ============================================================
// 从服务器侧重置密码 —— 忘记密码 / 被锁在外面时的逃生口
// ============================================================
// 改密码的前提是「已经登录」（PATCH /user/password 有 requireAuth）。
// 所以一旦连登录都进不去（忘了密码 / 没任何可用设备），就只能从服务器侧恢复 ——
// 自托管软件必须留这么一条路，否则用户只能删库重装。
//
// 用法（在项目目录下执行）：
//   docker compose exec chatz node src/reset-password.js --list
//   docker compose exec chatz node src/reset-password.js <用户名> <新密码>
//   echo '<新密码>' | docker compose exec -T chatz node src/reset-password.js <用户名> --stdin
//
// ⚠️ 直接写在命令行里的密码会进 shell 历史，也会短暂出现在容器内的进程列表；
//    在意的话用 --stdin 那条，历史里只留下命令、不留密码。
//
// 信任模型：能执行这条命令 = 能读写容器和 data/app.db = 本来就有完全控制权。
// 所以它不构成新增的攻击面，只是把「手写一条 UPDATE」变成一个不会打错的命令。
//
// 重置后**不会**碰任何 devices 记录 —— 手机端/其它浏览器不会被踢下线。
// 想要踢人就去网页端「安全与登录 → 登录设备」删掉对应行。
//
// 哈希算法和 src/migrate.js 的 hashPassword 共用同一个函数，
// 所以这里写进去的值一定能被登录接口的 verifyPassword 验证通过。

const fs = require('fs');
const db = require('./db');
const { hashPassword } = require('./migrate');
const i18n = require('./serverI18n');

const MIN_LEN = 6;
const MAX_LEN = 128;

function usage(code) {
  i18n.log('cli.resetUsage', { min: MIN_LEN, max: MAX_LEN });
  process.exit(code);
}

function listUsers() {
  const rows = db.prepare(
    'SELECT id, username, is_admin, length(password_hash) AS hlen FROM users ORDER BY id'
  ).all();

  if (rows.length === 0) {
    i18n.log('cli.noUsers');
    return 0;
  }

  i18n.log('cli.userCount', { n: rows.length });
  for (const u of rows) {
    const role = u.is_admin ? i18n.t('cli.roleAdmin') : i18n.t('cli.roleUser');
    const pw = u.hlen > 0 ? i18n.t('cli.pwSet') : i18n.t('cli.pwUnset');
    i18n.log('cli.userRow', { id: u.id, username: u.username, role, pw });
  }
  return 0;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) usage(1);
  if (args[0] === '--list' || args[0] === '-l') return listUsers();
  if (args[0] === '--help' || args[0] === '-h') usage(0);

  const username = args[0];
  let password = args[1];

  if (password === '--stdin') {
    // 去掉结尾换行；不动中间的空格（密码可以含空格）
    password = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  }

  if (!password) {
    i18n.error('cli.missingPassword');
    return 1;
  }
  if (password.length < MIN_LEN || password.length > MAX_LEN) {
    i18n.error('cli.passwordLength', { min: MIN_LEN, max: MAX_LEN, len: password.length });
    return 1;
  }

  const user = db.prepare('SELECT id, username, is_admin FROM users WHERE username = ?').get(username);
  if (!user) {
    i18n.error('cli.userNotFound', { username });
    i18n.rawErr('');
    listUsers();
    return 1;
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);

  i18n.log('cli.resetOk', {
    username: user.username,
    id: user.id,
    suffix: user.is_admin ? i18n.t('cli.resetOkRoleSuffix') : '',
  });
  i18n.log('cli.resetOkHint');
  i18n.log('cli.resetOkDevices');
  return 0;
}

let code = 1;
try {
  code = main();
} catch (err) {
  i18n.error('cli.resetFailed', { msg: (err && err.message) ? err.message : err });
  code = 1;
}
process.exit(code);
