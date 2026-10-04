const { WebSocketServer, WebSocket } = require('ws');
const { resolveToken, getUserChannels, getChannelSubscriberIds, getUserIdentity } = require('./auth');

const clients = new Set();

// 连接数限制
const MAX_TOTAL = 1000;
const MAX_PER_USER = 10;

function attach(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname !== '/stream') {
      socket.destroy();
      return;
    }

    // 全局上限
    if (clients.size >= MAX_TOTAL) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    const token =
      url.searchParams.get('token') ||
      (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

    const identity = resolveToken(token);
    if (!identity) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // 单用户上限
    let userConnCount = 0;
    for (const c of clients) {
      if (c.userId === identity.userId) userConnCount++;
    }
    if (userConnCount >= MAX_PER_USER) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, identity);
    });
  });

  wss.on('connection', (ws, req, identity) => {
    ws.isAlive = true;
    ws.userId = identity.userId;
    ws.isAdmin = identity.isAdmin;
    ws.isSuper = !!identity.isSuper;
    ws.isLegacyAuth = identity.isLegacyAuth;
    // 一律按订阅集合收消息（超管也不例外）—— 见 auth.js 的 getUserChannels 注释。
    // 超管的"全知"保留在拉取侧（GET /message、GET /channel），推送侧不搞特殊，
    // 否则他连"退订"都做不到。
    ws.subscribedChannels = getUserChannels(identity.userId);

    clients.add(ws);

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      try {
        const text = raw.toString();
        if (text === '' || text === '{}') return;
      } catch {}
    });

    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  const interval = setInterval(() => {
    for (const ws of clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  wss.on('close', () => clearInterval(interval));

  return wss;
}

/**
 * 向某个频道的订阅者广播（消息用这条）
 *
 * 收件人一律是订阅者 —— **超管也不例外**（2026-09-30 起）。
 * 以前超管的 `subscribedChannels` 是 null，会在这里被当成"全收"，
 * 结果超管收到所有频道的消息、且退订无效。现在没有人走特殊通道。
 *
 * @param {number|null} channelId 传 null 表示"发给所有人"（Gotify 兼容：
 *   没有频道概念的老客户端发的消息）。
 */
function broadcastToChannel(channelId, obj) {
  const data = JSON.stringify(obj);
  let n = 0;
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    // null 现在只可能来自"无频道消息"这条 Gotify 兼容路径，不是超管特权
    if (channelId == null) {
      ws.send(data); n++;
      continue;
    }
    if (ws.subscribedChannels.has(channelId)) {
      ws.send(data); n++;
    }
  }
  return n;
}

/**
 * 向多个频道广播同一条消息，但【每个客户端只发一次】
 *
 * 为什么需要：
 *   路由规则的 broadcast_to 会把一条消息同时投给多个频道
 *   （比如消息属于频道 5，规则又转发到频道 2）。
 *   原来对每个频道各调一次 broadcastToChannel，而同时订阅了这几个频道的用户
 *   会被每一个频道都命中一次 → 同一条消息收到 N 遍。
 *   客户端若去重不严，状态栏就会弹出 N 条重复通知。
 *
 * @param channelIds 目标频道 id 列表；含 null 表示"发给所有人"（无频道的 Gotify 消息）
 */
function broadcastToChannels(channelIds, obj) {
  const data = JSON.stringify(obj);

  const ids = [];
  let toEveryone = false;
  for (const cid of channelIds) {
    if (cid == null) toEveryone = true;
    else ids.push(cid);
  }

  let n = 0;
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const hit = toEveryone ||
      ws.subscribedChannels === null ||
      ids.some(id => ws.subscribedChannels.has(id));
    if (hit) {
      ws.send(data);
      n++;
    }
  }
  return n;
}

function broadcastToUser(userId, obj) {
  const data = JSON.stringify(obj);
  let n = 0;
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.userId === userId) {
      ws.send(data); n++;
    }
  }
  return n;
}

/**
 * 重新计算某个用户**所有在线连接**的订阅频道集合
 *
 * 为什么需要：`ws.subscribedChannels` 是**连接建立时算一次的快照**
 * （见 `wss.on('connection')`，全仓库仅此一处赋值）。用户中途订阅 / 退订
 * 频道后它不会跟着变，而消息推送走的是 `broadcastToChannel` /
 * `broadcastToChannels`，它们正是按这个集合筛人的 ——
 * 不刷新的话：刚订阅的频道推不进来（要等 WS 断线重连才恢复），
 * 已退订的频道反而还在推。
 *
 * 订阅关系一变就必须调一次（见 `channels.js` 的 subscribe / unsubscribe）。
 *
 * ⚠️ 管理员的集合恒为 `null`（约定：null = 全收），与订阅表无关，
 *    不需要刷、也不能刷 —— 刷成集合反而会把管理员的可见性收窄。
 *
 * @param {number} userId
 * @returns {number} 实际刷新的连接数
 */
function refreshUserChannels(userId) {
  let n = 0;
  for (const ws of clients) {
    if (ws.userId !== userId) continue;
    // 超管现在也有真实的订阅集合了（不再是 null），所以**必须**一起刷，
    // 否则他订阅/退订之后推送范围还是旧的 ⇒ 退订了照样收
    ws.subscribedChannels = getUserChannels(ws.userId);
    n++;
  }
  return n;
}

/**
 * 重新计算某个用户**所有在线连接**的身份（role / isAdmin / isSuper / 订阅集合）
 *
 * 什么时候必须调：**管理员被提升或降级之后**。
 * `ws.isAdmin` / `ws.isSuper` / `ws.subscribedChannels` 都是连接建立时算一次的快照，
 * 不刷的话刚改完角色的那些连接行为还是旧的：
 *   · 降级（超管 → 管理员）→ 频道元信息该少收了，却还在全收
 *   · 提升（用户 → 超管）→ 频道元信息该全收了，却还只在订阅者名单里
 *
 * ⚠️ 连 `subscribedChannels` 也要一起刷：它是推送范围的依据，
 *    订阅关系一变就必须重算，否则刚退订的连接照样收消息。
 *    （超管同样有订阅集合 —— 2026-09-30 起消息推送不再对超管搞特殊。）
 *
 * @param {number} userId
 * @returns {number} 刷新的连接数
 */
function refreshUserIdentity(userId) {
  const id = getUserIdentity(userId);
  if (!id) return 0;
  let n = 0;
  for (const ws of clients) {
    if (ws.userId !== userId) continue;
    ws.isAdmin = id.isAdmin;
    ws.isSuper = id.isSuper;
    // 同 refreshUserChannels：超管也有订阅集合，必须一起刷
    ws.subscribedChannels = getUserChannels(userId);
    n++;
  }
  return n;
}

/**
 * 广播**频道元信息**变更（channelCreated / channelUpdated / channelDeleted）
 *
 * ⚠️ 收件人必须收窄，不能直接用 `broadcast()`：
 *    它发给所有在线客户端，会把**私有频道**（`is_public = 0`）的名字、描述、
 *    图标也推给根本看不到它的人。客户端虽然不会把它显示出来
 *    （Android `handleChannelUpsertEvent` 会保留本地 subscribed 状态），
 *    但元信息确实到了别人设备上并写进了本地库。
 *
 * ⚠️ 也不能直接用 `broadcastToChannel()`：
 *    它判断的是 `ws.subscribedChannels`，而那是**连接建立时算一次的快照**
 *    （见本文件 `wss.on('connection')`），用户中途订阅的频道不在里面 ——
 *    用它反而会漏掉刚订阅的人。
 *
 * 所以这里**每次实时查库**，收件人收窄成「**订阅者 ∪ 创建者**」。
 * 频道元信息变更是低频操作（不像消息那样每条都走），这点开销可以接受。
 *
 * ⚠️ 2026-10-01 起**不再给超管全收**（原来是 `ws.isSuper || subscribers`）：
 *    超管全收的后果是，别人频繁建/删频道时，超管在线的手机端会频繁收到
 *    channelCreated/Deleted、跟着频繁 `refreshChannels`（重拉 /channel），费电。
 *    超管收不到未订阅频道的删除事件，本地会残留 `subscribed=0` 的幽灵记录，
 *    但那是**无害**的：抽屉只查 subscribed=1、发现页只查 discover 返回的公开频道，
 *    真正清幽灵靠客户端「打开抽屉/前台时的 refreshChannelList 全量对账」兜底。
 *
 * @param {number} channelId 频道 id
 * @param {object} obj 事件体
 * @param {Set<number>} [subscriberIds] 调用方已经取好的订阅者集合。
 *   传入时直接用它、不再查库 —— **删频道必须传**，
 *   因为那边的事务会先 `DELETE FROM subscriptions`，事后再查就是空的。
 * @param {number} [creatorId] 频道创建者 id —— 创建者即使没订阅也要收（自己建的频道）。
 * @returns {number} 实际发出的连接数
 */
function broadcastChannelMeta(channelId, obj, subscriberIds, creatorId) {
  const subscribers = subscriberIds || getChannelSubscriberIds(channelId);
  const data = JSON.stringify(obj);
  let n = 0;
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    // 订阅者 ∪ 创建者。超管不再全收（见上方注释）
    if (subscribers.has(ws.userId) || (creatorId != null && ws.userId === creatorId)) {
      ws.send(data);
      n++;
    }
  }
  return n;
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  let n = 0;
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data); n++;
    }
  }
  return n;
}

function onlineCount() {
  return clients.size;
}

module.exports = {
  attach,
  broadcast,
  broadcastChannelMeta,
  getChannelSubscriberIds,
  broadcastToChannel,
  broadcastToChannels,
  broadcastToUser,
  refreshUserChannels,
  refreshUserIdentity,
  onlineCount,
};
