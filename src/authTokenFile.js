'use strict';

// ============================================================
// 主密钥的「非数据库来源」解析
// ============================================================
//
// 主密钥（AUTH_TOKEN）最终只有三个去处：
//   1. 环境变量 AUTH_TOKEN        —— 明文写在 .env / compose environment 里
//   2. 环境变量 AUTH_TOKEN_FILE   —— 只写一个**路径**，值存在挂载进来的文件里
//   3. 数据库 meta.auth_token     —— 默认路径（引导页生成后存在这里）
//
// 为什么要有 2：
//   环境变量的暴露面比文件大得多 —— `docker inspect` 会原样打印整个 env，
//   `docker compose config` 会回显，容器编排面板 / 监控系统 / 崩溃上报常常连 env 一起采集，
//   /proc/<pid>/environ 也能被同主机的人读到。换成文件之后，env 里只剩一个路径，
//   真正的密钥由 docker secret / k8s secret / 一个 chmod 600 的挂载文件保管。
//   （`*_FILE` 是 docker 生态的既定约定，官方 mysql / postgres / grafana 镜像都这么干。）
//
// ⚠️ 本模块**绝不能 require db**：它在 migrate 里被调用，那时数据库连接刚建立、
// 表结构还没迁移完。也不做任何网络 / 子进程操作。
//
// 优先级：AUTH_TOKEN（明文） > AUTH_TOKEN_FILE > 交给调用方读数据库。
//
// 调用方（migrate.js）拿到 error 时应当**硬失败退出** —— 配置了 secret 文件却读不到，
// 几乎总是挂载 / 路径 / 权限错了。静默回落到数据库里的旧值会造成「以为换了密钥其实没换」，
// 这类无声失败比启动失败难查得多（参考 RELEASE.md 里轮换踩过的坑）。

const fs = require('fs');
const i18n = require('./serverI18n');

/**
 * 解析环境变量里给出的主密钥。
 * @returns {{value:string, source:string|null, error:Error|null}}
 *   source: 'env' | 'file' | null（null = 两个变量都没设，交给调用方读数据库）
 *   error : 仅当 source === 'file' 且读取/内容有问题时非空
 */
function resolveAuthTokenOutsideDb() {
  const direct = process.env.AUTH_TOKEN;
  const file = process.env.AUTH_TOKEN_FILE;

  // 两个都给了就吵一句 —— 否则用户改了文件却发现不生效，会以为是挂载的问题
  if (direct && file) {
    i18n.warn('authToken.bothSet');
    i18n.warn('authToken.bothSetHint');
  }

  if (direct) return { value: String(direct), source: 'env', error: null };
  if (!file) return { value: '', source: null, error: null };

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return {
      value: '',
      source: 'file',
      error: new Error(i18n.t('authToken.readFileFailed', { file, msg: e.message })),
    };
  }

  // secret 文件几乎总是以换行结尾（`echo x > f`、k8s mount、heredoc 都会带），
  // 不 trim 的话密钥会多一个 \n，而等值匹配会全线失败且极难排查。
  // base62 里不含空白，整串 trim 是安全的。
  const value = String(raw).trim();
  if (!value) {
    return {
      value: '',
      source: 'file',
      error: new Error(i18n.t('authToken.fileEmpty', { file })),
    };
  }

  return { value, source: 'file', error: null };
}

module.exports = { resolveAuthTokenOutsideDb };
