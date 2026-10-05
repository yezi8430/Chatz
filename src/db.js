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
