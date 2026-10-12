// 每日摘要的**纯逻辑**：默认值、设置合并、日期键、正文渲染。
//
// 为什么单独成文件：digest.js 要 require db / ws（ws 又拉 npm 包 `ws`），
// 离线 verify 脚本（本机没有 node_modules）require 不动它。而「分组 / 截断 /
// ×N / 还有 N 条」这些渲染规则恰恰是最该被测的东西。
// 所以按 attachmentLimits.js 的老规矩：零依赖的纯逻辑挪出来，
// digest.js 只留碰数据库的那部分。

/** 服务端默认值（客户端有自己的默认值，两边保持一致即可） */
const DEFAULT_DIGEST = {
  enabled: false,
  time: '08:00',
  priority: 8,
  onlyUnread: true,
  includeMuted: true,
  excludeOwn: true,
  maxItems: 20,
};

/**
 * 取出某个用户的 digest 设置，缺项补默认值
 *
 * 库里的值可能只有一半（前端改一个开关只推那一个子键），所以必须逐项补。
 */
function digestSettingsOf(user) {
  let stored = {};
  try {
    const s = user && user.settings ? JSON.parse(user.settings) : null;
    stored = (s && typeof s.digest === 'object' && s.digest) ? s.digest : {};
  } catch { /* 设置坏了就当没配过 */ }
  return { ...DEFAULT_DIGEST, ...stored };
}

/** 今天（服务器时区）的日期键，用于幂等 */
function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 一条消息在摘要里显示的文字：标题优先，没有就取正文第一行 */
function digestItemTitle(row) {
  const t = row.title && String(row.title).trim();
  if (t) return t;
  const first = String(row.message || '').split('\n')[0].trim();
  return first ? first.slice(0, 40) : '（无标题）';
}

/**
 * 渲染摘要正文 + 结构化条目
 *
 * @param groups  分组结果：[{ channelId, name, items:[row...] }]，items 按时间倒序
 * @param total   过滤后的总条数（可能大于 maxItems）
 * @param maxItems 最多列出多少条
 * @returns {{ text, items, hidden }}
 */
function renderDigest(groups, total, maxItems) {
  // 展平保序（groups 已按时间倒序排好），取前 maxItems 条
  const flat = [];
  for (const g of groups) for (const it of g.items) flat.push(it);
  const keep = flat.slice(0, Math.max(1, maxItems));
  const keepIds = new Set(keep.map(r => r.id));
  const hidden = total - keep.length;

  // 分组只装「会显示出来的」条目 —— 否则组头数字和下面列出来的对不上
  const outGroups = [];
  for (const g of groups) {
    const items = g.items.filter(r => keepIds.has(r.id));
    if (items.length === 0) continue;
    outGroups.push({ channelId: g.channelId, name: g.name, count: items.length, items });
  }

  const lines = [];
  lines.push(`## 今日摘要 · ${total} 条 / ${outGroups.length} 个频道`);
  lines.push('');
  for (const g of outGroups) {
    lines.push(`**${g.name}**（${g.count}）`);
    for (const r of g.items) {
      const n = (r.agg_count || 1) > 1 ? ` ×${r.agg_count}` : '';
      lines.push(`- ${digestItemTitle(r)}${n}`);
    }
    lines.push('');
  }
  if (hidden > 0) {
    lines.push(`> 还有 ${hidden} 条未列入（上限 ${maxItems} 条），去对应频道看吧`);
    lines.push('');
  }
  lines.push('_过去 24 小时的未读消息汇总。时间按服务器时区。_');

  // 结构化列表（extras.items）：客户端现在还没用，先带上 ——
  // v2 做「点标题跳到原消息」时不用改消息格式。
  const items = keep.map(r => ({
    messageId: r.id,
    channelId: r.channel_id,
    channelName: r.channel_name,
    title: (r.title && String(r.title).trim()) ? String(r.title).trim() : null,
    aggCount: r.agg_count || 1,
    priority: r.priority,
    date: r.date,
  }));

  return { text: lines.join('\n'), items, hidden };
}

module.exports = {
  DEFAULT_DIGEST,
  digestSettingsOf,
  dayKey,
  digestItemTitle,
  renderDigest,
};
