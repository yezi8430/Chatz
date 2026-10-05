const crypto = require('crypto');
const { generateAppToken, generateDeviceToken, isDeviceTokenFormat, TOKEN_LENGTH } = require('./tokenGen');
// ⚠️ 只做「读环境变量 / 读文件」，本身不碰数据库 —— 保持无依赖，便于单独测
const { resolveAuthTokenOutsideDb } = require('./authTokenFile');

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * 校验密码是否匹配 `hashPassword` 产出的 `salt:hash` 串
 *
 * 与 users.js 里的旧实现等价，只是收进这里让「用户密码」和「频道密码」
 * 共用同一套哈希/校验，避免两处各写一份、将来改一处漏一处。
 */
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const idx = stored.indexOf(':');
  if (idx < 0) return false;
  const salt = stored.slice(0, idx);
  const hash = stored.slice(idx + 1);
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function columnExists(db, table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === column);
}

function migrate(db) {
  // 刻意**不**输出"开始迁移 / 迁移完成"这类固定横幅。
  //
  // 迁移是幂等的，每次启动都会完整跑一遍检查，绝大多数时候什么都没改。
  // 天天打印两行固定内容只会把真正有用的日志淹掉 —— 真出事时反倒看不出
  // 哪一行才是异常。所以原则是：**只在真的改动了数据库时才输出一行**，
  // 其余情况一个字都不打。
  //
  // 各项变更先收集进 applied，最后合并成一行输出（见函数末尾）。
  const applied = [];
  const note = (msg) => applied.push(msg);

  const tx = db.transaction(() => {
    // applications
    if (!columnExists(db, 'applications', 'channel_id')) {
      db.exec('ALTER TABLE applications ADD COLUMN channel_id INTEGER');
    }
    if (!columnExists(db, 'applications', 'template')) {
      db.exec('ALTER TABLE applications ADD COLUMN template TEXT');
    }
    if (!columnExists(db, 'applications', 'token')) {
      db.exec('ALTER TABLE applications ADD COLUMN token TEXT');
    }
    if (!columnExists(db, 'applications', 'created_at')) {
      db.exec('ALTER TABLE applications ADD COLUMN created_at INTEGER');
      db.prepare('UPDATE applications SET created_at = ? WHERE created_at IS NULL').run(Date.now());
    }
    // 归属用户：应用按用户隔离（谁创建的谁能看/改）。存量数据的归属在 admin 确定后回填
    if (!columnExists(db, 'applications', 'user_id')) {
      db.exec('ALTER TABLE applications ADD COLUMN user_id INTEGER');
      note('applications.user_id');
    }

    // messages
    if (!columnExists(db, 'messages', 'channel_id')) {
      db.exec('ALTER TABLE messages ADD COLUMN channel_id INTEGER');
    }
    if (!columnExists(db, 'messages', 'tags')) {
      db.exec('ALTER TABLE messages ADD COLUMN tags TEXT');
    }
    if (!columnExists(db, 'messages', 'archived_at')) {
      db.exec('ALTER TABLE messages ADD COLUMN archived_at INTEGER');
    }
    if (!columnExists(db, 'messages', 'agg_count')) {
      db.exec('ALTER TABLE messages ADD COLUMN agg_count INTEGER DEFAULT 1');
      note('messages.agg_count');
    }
    if (!columnExists(db, 'messages', 'agg_last_at')) {
      db.exec('ALTER TABLE messages ADD COLUMN agg_last_at INTEGER');
      note('messages.agg_last_at');
    }
    if (!columnExists(db, 'messages', 'agg_children')) {
      db.exec('ALTER TABLE messages ADD COLUMN agg_children TEXT');
      note('messages.agg_children');
    }

    // 初始化老数据
    db.prepare('UPDATE messages SET agg_count = 1 WHERE agg_count IS NULL').run();
    db.prepare('UPDATE messages SET agg_last_at = created_at WHERE agg_last_at IS NULL').run();

    // 删除墓碑增量查询（GET /message/deleted）的索引
    //
    // 那个查询是 `WHERE deleted_at IS NOT NULL AND deleted_at > ? ORDER BY deleted_at`，
    // 没有索引就是全表扫描 —— messages 表越大越慢，而它每次客户端增量同步都会调。
    // 部分索引（WHERE deleted_at IS NOT NULL）比全列索引小得多：绝大多数行是 NULL，
    // 不需要进索引；SQLite 支持这种写法。
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_deleted_at
        ON messages (deleted_at) WHERE deleted_at IS NOT NULL
    `);

    // 新表
    db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        description TEXT,
        image       TEXT,
        is_public   INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name  TEXT,
        is_admin      INTEGER NOT NULL DEFAULT 0,
        role          INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        user_id     INTEGER NOT NULL,
        channel_id  INTEGER NOT NULL,
        muted       INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (user_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS message_reads (
        message_id  INTEGER NOT NULL,
        user_id     INTEGER NOT NULL,
        read_at     INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS devices (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,
        name        TEXT,
        token       TEXT NOT NULL UNIQUE,
        last_seen   INTEGER,
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS routes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        priority    INTEGER NOT NULL DEFAULT 50,
        conditions  TEXT NOT NULL,
        actions     TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_archived ON messages(archived_at);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
      CREATE INDEX IF NOT EXISTS idx_reads_user ON message_reads(user_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(token);
      CREATE INDEX IF NOT EXISTS idx_routes_priority ON routes(enabled, priority);

      CREATE TABLE IF NOT EXISTS audit_log (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      INTEGER NOT NULL,
        user_id INTEGER,
        ip      TEXT,
        action  TEXT NOT NULL,
        target  TEXT,
        meta    TEXT,
        success INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, ts DESC);

      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,
        token_hash  TEXT NOT NULL,
        expires_at  INTEGER NOT NULL,
        used_at     INTEGER,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reset_token_hash ON password_reset_tokens(token_hash);
      CREATE INDEX IF NOT EXISTS idx_reset_token_user ON password_reset_tokens(user_id);
    `);

    if (!columnExists(db, 'channels', 'creator_id')) {
      db.exec('ALTER TABLE channels ADD COLUMN creator_id INTEGER');
    }

    // 归属用户：路由规则按用户隔离（谁创建的谁能看/改，且只作用于自己的消息）。
    // ⚠️ 必须放在上面的 db.exec（建表）**之后** —— 全新库里 routes 表是那一步才建的，
    //    在这之前 ALTER 会报「no such table」。存量数据的归属在 admin 确定后回填。
    if (!columnExists(db, 'routes', 'user_id')) {
      db.exec('ALTER TABLE routes ADD COLUMN user_id INTEGER');
      note('routes.user_id');
    }

    // 频道订阅密码（订阅门槛）。可空：空 = 无密码
    if (!columnExists(db, 'channels', 'password_hash')) {
      db.exec('ALTER TABLE channels ADD COLUMN password_hash TEXT');
      note('channels.password_hash');
    }

    // 频道名允许重名（像 QQ 群：群号 id 唯一、群名随便）——去掉 name 的 UNIQUE 约束。
    //
    // SQLite 的列级 UNIQUE 会生成隐式索引 sqlite_autoindex_channels_*，没法用 ALTER 去掉，
    // 只能重建表。用 meta 标记位保证只跑一次（重建动表结构，不能每次启动都跑）。
    const CHANNEL_NAME_FLAG = 'channel_name_nonunique_v1';
    if (!db.prepare('SELECT value FROM meta WHERE key = ?').get(CHANNEL_NAME_FLAG)) {
      // origin='u' 表示「列级 UNIQUE 约束」生成的隐式索引（PRIMARY KEY 是 'pk'）
      const hasNameUnique = db.prepare('PRAGMA index_list(channels)').all()
        .some((i) => i.origin === 'u');
      if (hasNameUnique) {
        db.exec(`
          CREATE TABLE channels_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            name          TEXT NOT NULL,
            description   TEXT,
            image         TEXT,
            is_public     INTEGER NOT NULL DEFAULT 0,
            creator_id    INTEGER,
            created_at    INTEGER NOT NULL,
            password_hash TEXT
          );
        `);
        db.exec(`
          INSERT INTO channels_new
            (id, name, description, image, is_public, creator_id, created_at, password_hash)
          SELECT id, name, description, image, is_public, creator_id, created_at, password_hash
          FROM channels
        `);
        db.exec('DROP TABLE channels');
        db.exec('ALTER TABLE channels_new RENAME TO channels');
        note('channels.name 去掉唯一约束（允许重名）');
      }
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(CHANNEL_NAME_FLAG, '1');
    }

    // 默认频道
    let defaultChannel = db.prepare('SELECT * FROM channels WHERE id = 1').get();
    if (!defaultChannel) {
      db.prepare(
        'INSERT INTO channels (id, name, description, is_public, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(1, '默认频道', 'v1 数据自动归属', 1, Date.now());
    }

    db.prepare('UPDATE applications SET channel_id = 1 WHERE channel_id IS NULL').run();
    db.prepare('UPDATE messages SET channel_id = 1 WHERE channel_id IS NULL').run();

    // ============================================================
    if (!columnExists(db, 'users', 'avatar')) {
      db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
      note('users.avatar');
    }
    if (!columnExists(db, 'users', 'email')) {
      db.exec('ALTER TABLE users ADD COLUMN email TEXT');
      note('users.email');
    }
    // 邮箱选填，但填了就不能重复。SQLite 的 UNIQUE 允许多个 NULL，
    // 用部分索引只约束「非空」的那些行。
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL');

    // ── 两级管理员 ──
    //   role 0 = 普通用户
    //   role 1 = 管理员（只能管应用和路由规则，**看不到**未订阅的私有频道）
    //   role 2 = 超级管理员（全知 + 能提升他人 + 管证书/审计/频道）
    //
    // ⚠️ `is_admin` 列**保留**，语义退化为「role >= 1」，写入时同步维护。
    //    这样所有已有的 `isAdmin` 判断一行都不用动，只把「能看全部数据」的
    //    那批改成 isSuper —— 改动面直接砍掉一半以上，风险也小得多。
    if (!columnExists(db, 'users', 'role')) {
      db.exec('ALTER TABLE users ADD COLUMN role INTEGER NOT NULL DEFAULT 0');
      note('users.role');
    }
    // 存量管理员一律升为超级管理员：他们本来就有全部权限，
    // 不能因为加字段就把已有能力收窄 —— 那是破坏性升级。
    db.prepare('UPDATE users SET role = 2 WHERE is_admin = 1 AND role < 2').run();
    // 反向兜底：万一有 role>=1 但 is_admin=0 的不一致数据，以 role 为准回写
    db.prepare('UPDATE users SET is_admin = 1 WHERE role >= 1 AND is_admin = 0').run();

    // AUTH_TOKEN 四级解析：env 明文 → secret 文件 → db → 未初始化
    // ============================================================
    // 🔴 第三种情况**不再凭空生成**（2026-10-05 改）。
    //
    // 以前这里直接 generateDeviceToken()，然后：
    //   · 拿它当预置 admin 的初始密码 ⇒ 只能把明文往容器日志打一次让人去捞；
    //   · 顺手插进 devices 表当「默认 Token」。
    // 引导页上线后这条路就没必要了 —— 现在改成由 POST /setup 在引导页生成：
    //   ① 密钥**永远不进容器日志**（日志会被采集/转发/备份，暴露面太大）；
    //   ② 超管手上只有一枚凭据，设备列表里不会再多出一行 'Web'；
    //   ③ 引导完成前实例处于「无凭据」状态，比留一个可猜的默认更安全。
    // ① 先看环境变量：AUTH_TOKEN（明文）→ AUTH_TOKEN_FILE（文件）→ 都没有
    //    配了 AUTH_TOKEN_FILE 却读不到时**硬失败退出**：那种情况基本都是挂载/路径/权限错了，
    //    静默回落到数据库里的旧值 = 「以为换了主密钥其实没换」，比起不来难查得多。
    const outside = resolveAuthTokenOutsideDb();
    if (outside.error) {
      console.error('');
      console.error('❌ 主密钥来源配置有问题，拒绝启动：');
      console.error(`   ${outside.error.message}`);
      console.error('');
      console.error('   排查：文件挂进容器了吗？路径对吗？容器里读得到吗？');
      console.error('   不想用文件方式就删掉 AUTH_TOKEN_FILE，主密钥会回落到数据库里的值。');
      console.error('');
      process.exit(1);
    }

    let authToken = outside.value || '';
    let tokenSource = outside.source; // 'env' | 'file' | null

    if (!authToken) {
      // 从 meta 表读（老实例升级，或已走过引导页的实例）
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'auth_token'").get();
      if (meta && meta.value) {
        authToken = meta.value;
        tokenSource = 'db';
      } else {
        authToken = '';
        tokenSource = 'uninitialized';
      }
    }

    // ── 把「这次实际生效的值」回写 meta（幂等） ──
    //
    // 为什么要写回去：以前 env / file 来源的值**从不落库**，于是
    //   meta.auth_token 停在很久以前的某个旧值上。用户哪天把 .env 里的
    //   AUTH_TOKEN 删掉（以为"不用了，反正库里有"），来源就变成 db，
    //   主密钥**静默变成那个旧值** —— devices 表的「默认 Token」行还会被
    //   下面的对齐逻辑一起改过去，于是所有用新密钥的东西全部失效，
    //   而服务端日志只打一句「已对齐」，看不出密钥其实换了。
    //
    // 写回去以后，「去掉 env」就变成一个真正无副作用的操作：值不变。
    // ⚠️ 这里只同步**值**，不做格式转换 —— 格式迁移那条规矩没变（见下）。
    // ⚠️ 不算新的暴露面：主密钥本来就在库里（引导页生成的就在 meta），
    //    devices 表那行也是明文副本。
    if (authToken && tokenSource !== 'db') {
      const cur = db.prepare("SELECT value FROM meta WHERE key = 'auth_token'").get();
      if (!cur || cur.value !== authToken) {
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('auth_token', ?)").run(authToken);
        note(`主密钥已同步进数据库（来源：${tokenSource === 'file' ? '文件' : '环境变量'}）`);
      }
    }

    // ── 主密钥换 cz. 格式（一次性，仅当值来自数据库时） ──
    //
    // 为什么不碰 env 来源：`.env` 里的 AUTH_TOKEN 优先级高于数据库
    // （上面第三条分支才读 meta）。若用户在 .env 里写死了一枚旧格式值，
    // 这里把它改了也没用 —— 下次启动 env 又覆盖回来，只会造成
    // 「meta 和实际生效值不一致」这种更难查的状态。所以：**env 来源一律不动**，
    // 要换格式请用户自己改 .env。
    //
    // ⚠️ 换掉主密钥 = 所有持有它的人都失效：
    //   · 管理员密码登录返回的就是它（users.js 里 user.is_admin 分支）
    //   · 用「粘贴 Token」直登的入口也是拿它
    //   · 兼容 Gotify 的老客户端（X-Gotify-Key）可能也在用它
    //   换完这些人全部要重新取新值。
    //
    // 幂等：已经是 cz. 格式就跳过（`isDeviceTokenFormat` 判）。
    // 用同一套格式判定函数，保证「设备 Token 和主密钥」格式定义永远一致。
    const AUTH_TOKEN_V2_FLAG = 'auth_token_cz_v2';
    const authV2Done = db.prepare('SELECT value FROM meta WHERE key = ?').get(AUTH_TOKEN_V2_FLAG);
    if (!authV2Done && tokenSource === 'db' && !isDeviceTokenFormat(authToken)) {
      const next = generateDeviceToken();
      db.prepare("UPDATE meta SET value = ? WHERE key = 'auth_token'").run(next);
      // devices 表里那行「默认 Token」存的就是主密钥的副本，必须同步换 ——
      // 否则设备列表显示的 token 和实际生效的对不上，复制出来是废的。
      db.prepare('UPDATE devices SET token = ? WHERE token = ?').run(next, authToken);
      authToken = next;
      note('主密钥 AUTH_TOKEN 换为 cz. 格式');
    }
    // 标记位无条件写入：即使这次是 env 来源 / 已经是新格式，也标记为「检查过了」，
    // 免得以后 .env 被删掉、值回落到 meta 时又触发一次意外的换密钥。
    if (!authV2Done) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(AUTH_TOKEN_V2_FLAG, '1');
    }

    // ── 「默认 Token」行与当前主密钥对齐（每次启动，幂等） ──
    //
    // devices 表里那行「默认 Token」存的是主密钥的**副本**，但只在首次创建和
    // 上面的 v2 一次性迁移时写入 —— 用户后来手动改 `.env` 轮换 AUTH_TOKEN 时，
    // 这行不会自动跟着变。不同步的后果很严重：
    //   1) resolveToken 按 token 匹配 devices 行 → 旧主密钥仍然查得到 → 轮换等于没换；
    //   2) 登录查询 `token != masterToken` 用的是新值，id=19（旧主密钥行）不再被排除、
    //      且 id 最小 → 管理员密码登录会返回**旧主密钥**。
    // 所以每次启动都对齐一次：只在「行存在且值 ≠ 当前主密钥」时 UPDATE，幂等无副作用。
    // （行不存在则由上面的创建逻辑负责，这里不补建。）
    // 未初始化时 authToken 是空串 —— 这时没有「默认 Token」行可对齐，跳过。
    const defaultTokenRow = db.prepare("SELECT id, token FROM devices WHERE name = '默认 Token'").get();
    if (authToken && defaultTokenRow && defaultTokenRow.token !== authToken) {
      db.prepare('UPDATE devices SET token = ? WHERE id = ?').run(authToken, defaultTokenRow.id);
      note('devices「默认 Token」行已与当前 AUTH_TOKEN 对齐');
    }

    // 挂到 global，供其他模块读取
    global.__AUTH_TOKEN__ = authToken;
    global.__AUTH_TOKEN_SOURCE__ = tokenSource;
    // 🔴 未初始化标记：getAuthToken() 靠它区分「主密钥不存在」和「主密钥是某个值」，
    //    否则 `'' || env || 'dev-token'` 会退化成 'dev-token' —— 一个谁都能猜到的常量。
    global.__AUTH_TOKEN_UNINITIALIZED__ = (tokenSource === 'uninitialized');

    // 管理员
    //
    // ⚠️ 按 is_admin 找，不能按 username='admin' 找！
    // 用户名是用户可以随便改的（PATCH /user/username）。一旦管理员把 admin
    // 改成别的名字，按名字查就会 miss，于是每次重启都：
    //   1) 重新 INSERT 一个叫 admin 的管理员（实例里冒出两个管理员）
    //   2) 顺手把 meta.setup_completed 重置成 '0' ⇒ 重启后弹首次引导页
    // 只要「已经存在任意一个 is_admin 用户」就说明初始化过了，直接复用。
    // 用 role >= 2 找超级管理员（等价于旧的 is_admin = 1）
    let admin = db.prepare('SELECT * FROM users WHERE role >= 2 ORDER BY id ASC LIMIT 1').get();
    if (!admin) {
      // 🔴 初始密码**不再用主密钥**：
      //    以前是 hashPassword(authToken) —— 主密钥既是登录凭据又是密码，
      //    于是只能把它的明文往日志打一次（「去 docker logs 里捞」）。
      //    现在塞一枚没人知道的随机值：引导页走完之前，这个账号谁也登不进去，
      //    而引导页（POST /setup）会把密码换成用户自己设的那一个。
      const hashed = hashPassword(crypto.randomBytes(32).toString('hex'));
      const info = db.prepare(
        'INSERT INTO users (username, password_hash, display_name, is_admin, role, created_at) VALUES (?, ?, ?, 1, 2, ?)'
      ).run('admin', hashed, '管理员', Date.now());
      admin = { id: info.lastInsertRowid, username: 'admin', is_admin: 1, role: 2 };
      note('创建管理员用户 admin');

      // 给启动日志用：这次是新建的管理员（基本等于「数据目录是全新的」）
      global.__FRESH_ADMIN__ = true;

      // 全新安装：标记「还没走完初始化」，网页端据此显示首次引导页，
      // 让用户在浏览器里直接设管理员账号 —— 省得翻 docker logs 找随机 Token。
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('setup_completed', '0')").run();
    }

    if (db.prepare('SELECT id FROM channels WHERE id = 1').get()) {
      const ch = db.prepare('SELECT creator_id FROM channels WHERE id = 1').get();
      if (ch && ch.creator_id == null) {
        db.prepare('UPDATE channels SET creator_id = ? WHERE id = 1').run(admin.id);
      }
    }

    // 应用 / 规则改成按用户隔离后，存量数据统一归给 admin（第一个超管）：
    // 老实例上这些本来就是管理员建的，归给 admin 最贴近原意，也不会让它们
    // 因为「没有归属」而从任何人（含超管管理页）的视野里消失。
    db.prepare('UPDATE applications SET user_id = ? WHERE user_id IS NULL').run(admin.id);
    db.prepare('UPDATE routes SET user_id = ? WHERE user_id IS NULL').run(admin.id);

    // 存量部署从来没写过这个标记 —— 它们的 admin 早就建好了，
    // 必须视作「已完成初始化」，否则升级后所有老用户都会被弹一次首次引导。
    if (!db.prepare("SELECT value FROM meta WHERE key = 'setup_completed'").get()) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('setup_completed', '1')").run();
    }

    // authToken 作为默认设备（未初始化时没有主密钥，这一步跳过 ——
    // 「默认 Token」那一行由 POST /setup 在引导页生成主密钥时插入）
    if (authToken) {
      const existing = db.prepare('SELECT * FROM devices WHERE token = ?').get(authToken);
      if (!existing) {
        db.prepare(
          'INSERT INTO devices (user_id, name, token, created_at) VALUES (?, ?, ?, ?)'
        ).run(admin.id, '默认 Token', authToken, Date.now());
      }
    }

    // ── 设备 Token：全量重签为 `cz.` 前缀格式（一次性，不可逆） ──
    //
    // 背景：设备 token 原本是 64 位 hex（randomBytes(32).toString('hex')）。
    // 2026-09-30 决定统一改成 `cz.` + 30 位 base62（见 tokenGen.js 的熵论证），
    // 好处是一眼能认出这是 Chatz 的凭据、且比 hex 短一半。
    //
    // ⚠️ 这次迁移是**破坏性的**：旧的 64 位 token 全部作废，
    //    所有已登录的浏览器 / 手机客户端都会掉线，必须用密码重新登录。
    //    （用户明确选择了这条路：「全部作废，强制重新登录」。）
    //
    // ⚠️ 唯一**不动**的是「默认 Token」那一行 —— 它的值就是全局 AUTH_TOKEN，
    //    也就是管理员登录复用的主密钥。它由 .env / meta.auth_token 决定，
    //    不在设备表这一层换（换它要改 AUTH_TOKEN 本身）。
    //    所以它保持 64 位 hex，这是刻意的：它是主密钥，不是普通设备凭据。
    //
    // 判定依据用「是不是当前格式」而不是「长度」：
    //    以后若再想调长度，isDeviceTokenFormat 会跟着变，逻辑不会失效。
    //    但仍用标记位保证只跑一次 —— 因为重签会让所有设备掉线，
    //    不能让它在每次启动时因为某行被手工改坏而重跑。
    //
    // 关于用户可能自己把 AUTH_TOKEN 设成 cz. 格式：
    //    若 .env 里 AUTH_TOKEN 恰好是 `cz.`+30 位，它会被 isDeviceTokenFormat
    //    判为「已是新格式」而跳过重签 —— 正好是我们要的结果（主密钥不动）。
    const DEVICE_TOKEN_V2_FLAG = 'device_token_cz_v2';
    const deviceV2Done = db.prepare('SELECT value FROM meta WHERE key = ?').get(DEVICE_TOKEN_V2_FLAG);
    if (!deviceV2Done) {
      const allDevices = db.prepare('SELECT id, name, token FROM devices').all();
      const toResign = allDevices.filter((d) => d.token !== authToken);

      // UNIQUE 索引挡着，重签必须查重。用 seen 防本轮内自撞车
      // （概率极低，但同一批里两把一样就没法写回去了），
      // 再对现有全表 token 做一次排除，保证和「没被选中的行」也不撞。
      const taken = new Set(allDevices.map((d) => d.token));
      const stmt = db.prepare('UPDATE devices SET token = ? WHERE id = ?');
      let resigned = 0;
      for (const d of toResign) {
        // 已经是新格式的跳过（幂等；也覆盖「用户手工填过 cz. 格式」的情况）
        if (isDeviceTokenFormat(d.token)) continue;

        let candidate = null;
        for (let i = 0; i < 20; i++) {
          const c = generateDeviceToken();
          if (!taken.has(c)) { candidate = c; break; }
        }
        if (!candidate) {
          throw new Error(`设备 Token 重签失败：设备 #${d.id} 连续 20 次碰撞`);
        }
        taken.add(candidate);
        stmt.run(candidate, d.id);
        resigned++;
      }

      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(DEVICE_TOKEN_V2_FLAG, '1');
      if (resigned > 0) {
        note(`设备 Token 重签为 cz. 格式（${resigned} 台，原凭据已全部作废）`);
      }
    }

    db.prepare(`
      INSERT OR IGNORE INTO subscriptions (user_id, channel_id, created_at)
      VALUES (?, 1, ?)
    `).run(admin.id, Date.now());

    // ── 应用 Token：补齐缺失 + 全量缩短为 10 位（一次性） ──
    //
    // 背景：应用 token 原本是 48 位 hex（randomBytes(24).toString('hex')），
    // 因为要写进 Webhook 地址 `POST /hook/{token}`，太长不好用。
    // 2026-09-29 决定统一改成 10 位大小写+数字（详见 tokenGen.js 的熵值论证）。
    //
    // ⚠️ 这次迁移是**不可逆**的：48 位原文会被直接覆盖，找不回来。
    //    用户明确表示「这些 token 本来就无所谓」，所以不做备份。
    //    如果你是在别的部署上跑这段代码 —— 先确认那些 token 没接到自动化流程里，
    //    否则迁移后所有已对接的服务会立刻 404。
    //
    // 执行顺序（重要）：
    //   1) 先把 token IS NULL 的老应用补上
    //   2) 再找出所有「不是 10 位」的 token，全量重写
    //   3) 最后才建 UNIQUE 索引 —— 索引必须在重写**之后**建，
    //      因为重写时已经保证了唯一性；反过来建在重写前，一旦存量有重复会直接失败。
    //
    // 用 meta 里的标记位保证只跑一次。不用「长度是否为 10」来判断：
    // 万一以后又想调长度，那个判断会失效；标记位是明确的。
    const TOKEN_V2_FLAG = 'app_token_10_v2';
    const tokenV2Done = db.prepare('SELECT value FROM meta WHERE key = ?').get(TOKEN_V2_FLAG);

    if (!tokenV2Done) {
      // 1) 补齐 NULL
      const appsMissingToken = db.prepare('SELECT id FROM applications WHERE token IS NULL').all();
      if (appsMissingToken.length > 0) {
        const stmt = db.prepare('UPDATE applications SET token = ? WHERE id = ?');
        for (const a of appsMissingToken) {
          stmt.run(generateAppToken(), a.id);
        }
        note(`applications.token 补齐 ${appsMissingToken.length} 个`);
      }

      // 2) 全量重写为 10 位
      const toRewrite = db
        .prepare('SELECT id, token FROM applications WHERE token IS NOT NULL')
        .all()
        .filter((a) => a.token.length !== TOKEN_LENGTH);

      if (toRewrite.length > 0) {
        // seen 用来防本轮内自撞车（概率极低，但同一批里两把一样就前功尽弃）
        const seen = new Set();
        const stmt = db.prepare('UPDATE applications SET token = ? WHERE id = ?');
        let rewritten = 0;
        for (const a of toRewrite) {
          let candidate;
          let tries = 0;
          do {
            candidate = generateAppToken();
            tries++;
          } while (seen.has(candidate) && tries < 10);
          seen.add(candidate);
          stmt.run(candidate, a.id);
          rewritten++;
        }
        note(`applications.token 缩短为 ${TOKEN_LENGTH} 位（${rewritten} 个）`);
      }

      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(TOKEN_V2_FLAG, '1');
    }

    // 3) UNIQUE 索引 —— 每次启动都尝试建（IF NOT EXISTS 幂等）
    //
    // 为什么不建在 CREATE TABLE 里：applications 是最早期的表，
    // 存量库的建表语句早跑过了，往老表加约束只能走 CREATE INDEX。
    //
    // 兜底：万一存量真有重复（理论上不该有），建索引会抛错并**中止整个迁移**。
    // 这里先探测一次，有重复就跳过建索引并在日志里点名，
    // 让服务还能正常启动（功能不受影响，只是暂时没有唯一性保护）。
    const dupTokens = db
      .prepare('SELECT token, COUNT(*) AS n FROM applications WHERE token IS NOT NULL GROUP BY token HAVING n > 1')
      .all();
    if (dupTokens.length > 0) {
      console.warn(
        '⚠️ applications 存在重复 token，已跳过建唯一索引（请手动处理）:',
        dupTokens.map((d) => d.token).join(', ')
      );
    } else {
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_token ON applications(token)');
    }

    // 规则优先级语义反转（一次性）
    const migratedRulePrio = db.prepare("SELECT value FROM meta WHERE key = 'rule_priority_v2'").get();
    if (!migratedRulePrio) {
      const allRoutes = db.prepare('SELECT id, priority FROM routes').all();
      const updatePrio = db.prepare('UPDATE routes SET priority = ? WHERE id = ?');
      for (const r of allRoutes) {
        const reversed = Math.max(0, Math.min(100, 100 - (r.priority || 0)));
        updatePrio.run(reversed, r.id);
      }
      db.prepare("INSERT INTO meta (key, value) VALUES ('rule_priority_v2', '1')").run();
    }

    // ── 库纪元（db_epoch）：给客户端识别「这是不是同一个数据库」 ──
    //
    // 为什么需要：客户端的删除对账用 **deleted_at 时间戳水位线**按 serverId 存在本地。
    // 用户有个历史习惯是把整个 ./data 目录覆盖到服务器 —— 一旦换成更旧的备份：
    //   本地水位线（如 1774000000000）> 恢复库里 deleted_at 的最大值
    //   ⇒ 之后所有墓碑都被 `deleted_at > since` 挡掉，**永久失去清理能力**，
    //      幽灵消息再也删不掉，连全量同步都救不了。
    //
    // 解法：每次客户端对账时带上它上次见到的纪元号。对不上 ⇒ 水位线作废重拉。
    //
    // 纪元号怎么保证「换库后必然变化」：
    //   - 全新库：meta 里没有 db_epoch ⇒ 生成一个随机串（含创建时间，可读）
    //   - 换库/回滚：恢复出来的 meta 里带着**旧**纪元串。若它恰好等于当前值，
    //     我们无法从 meta 单表判断；所以再叠加一个**库指纹**校验（见下方）：
    //     比对 sqlite_sequence 的关键计数 + messages 行数，与纪元一起返回，
    //     任何一项对不上都算「换了库」。
    //
    // 注意：纪元串本身**不是**机密，它只是个标签；客户端只做相等比较。
    let dbEpoch = db.prepare("SELECT value FROM meta WHERE key = 'db_epoch'").get();
    if (!dbEpoch || !dbEpoch.value) {
      // 随机 12 位 + 创建时间：随机部分保证「删掉 meta 重建」也换号，
      // 时间部分纯粹为了人工排查时一眼看出这库是什么时候诞生的。
      const value = `${crypto.randomBytes(6).toString('hex')}@${Date.now()}`;
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('db_epoch', ?)").run(value);
      dbEpoch = { value };
      note('生成库纪元 db_epoch');
    }
    global.__DB_EPOCH__ = dbEpoch.value;
  });

  try {
    tx();

    // 强制把 WAL 数据 checkpoint 到主数据库文件
    // 避免容器被强杀时丢失数据
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) {
      // 忽略：checkpoint 失败不影响主流程
    }

    // 只在真的改了东西时才输出，且合并成一行
    if (applied.length > 0) {
      console.log(`🔧 数据库迁移：应用 ${applied.length} 项变更 → ${applied.join(', ')}`);
    }
  } catch (e) {
    console.error('❌ 迁移失败:', e.message);
    throw e;
  }
}

module.exports = { migrate, hashPassword, verifyPassword };
