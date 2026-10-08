const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { migrate } = require('./migrate');
// 日志 i18n（自身零依赖，放这里不会形成循环）
const serverI18n = require('./serverI18n');

const DB_PATH = process.env.DB_PATH || './data/app.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// 启动日志要显示「这次用的是哪个数据目录」。
// Token / 账号 / 频道全都存在这个目录的 app.db 里 —— 数据目录一换，
// 全部都是新的，这就是「重新部署后 token 怎么变了」的直接原因。
global.__DB_PATH__ = DB_PATH;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── synchronous ──────────────────────────────────────────
//
// WAL 模式下 NORMAL 是 SQLite 官方推荐的搭配，也是这里最大的一个写入性能开关：
//   FULL（默认） 每次 commit 都 fsync ⇒ 单进程写入上限大概几百条/秒
//   NORMAL       WAL 只在 checkpoint 时 fsync
//
// 取舍要说清楚：NORMAL 下**掉电/系统崩溃**可能丢掉最后几个已提交的事务，
// 但**不会损坏库文件**（这个保证来自 WAL，不来自 synchronous）。
// 进程自己崩（SIGKILL / 未捕获异常）则一条都不丢 —— 数据早就交给操作系统了。
// 对一个通知服务来说，"极端情况下少收最后几条通知"远好过"平时写入就慢"。
//
// 想改回去：SQLITE_SYNCHRONOUS=FULL。白名单收一下，别让 env 拼进 pragma。
const SYNC_MODES = ['OFF', 'NORMAL', 'FULL', 'EXTRA'];
const syncMode = String(process.env.SQLITE_SYNCHRONOUS || 'NORMAL').toUpperCase();
db.pragma(`synchronous = ${SYNC_MODES.includes(syncMode) ? syncMode : 'NORMAL'}`);

// ── busy_timeout ─────────────────────────────────────────
//
// 5000ms 本来就是 better-sqlite3 的默认值，这里**显式写出来**是为了让它可查：
// 代码里看不见的东西，没人会想到去调，也没人知道它到底是多少。
//
// 注意它防的是**进程外**的连接（`docker exec ... sqlite3`、备份脚本、
// 或者误开了第二个容器共用同一个 data/）—— 本进程只有一个 db 连接，
// 自己不会跟自己抢写锁。真被外部写者占住超过 5 秒才会抛 SQLITE_BUSY。
db.pragma('busy_timeout = 5000');

// ============================================================
// v1 表结构（保留，不做改动，只作为首次创建时的骨架）
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS applications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    image       TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    appid      INTEGER NOT NULL,
    message    TEXT NOT NULL,
    title      TEXT,
    priority   INTEGER NOT NULL DEFAULT 5,
    date       TEXT NOT NULL,
    extras     TEXT,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id);
  CREATE INDEX IF NOT EXISTS idx_messages_appid ON messages(appid);
`);

// ============================================================
// v2 迁移：加字段 + 建新表 + 补默认数据
// ============================================================
migrate(db);

// 日志语言：migrate() 已经把 meta 表建好了，这里才能读。
// migrate 自己那几条日志也在 migrate.js 里各读了一次（那会儿表刚建出来）。
serverI18n.initFromDb(db);

module.exports = db;
