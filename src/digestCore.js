// 每日摘要的**纯逻辑**：默认值、设置合并、日期键、正文渲染。
//
// 为什么单独成文件：digest.js 要 require db / ws（ws 又拉 npm 包 `ws`），
// 离线 verify 脚本（本机没有 node_modules）require 不动它。而「分组 / 截断 /
// ×N / 还有 N 条」这些渲染规则恰恰是最该被测的东西。
// 所以按 attachmentLimits.js 的老规矩：零依赖的纯逻辑挪出来，
// digest.js 只留碰数据库的那部分。

// ── 时区 ──
// 每个用户自己选时区，默认北京时间。为什么不再按「服务器时区」：
// 家庭 NAS 的容器 TZ 常常是 UTC，用户看到「08:00 发」结果凌晨就来了。
// 默认给 Asia/Shanghai（绝大多数使用场景），想改就填别的 IANA 时区名。
const DEFAULT_TZ = 'Asia/Shanghai';

/** 服务端默认值（客户端有自己的默认值，两边保持一致即可） */
const DEFAULT_DIGEST = {
  enabled: false,
  time: '08:00',
  tz: DEFAULT_TZ,
  priority: 8,
  includeMuted: true,
  excludeOwn: true,
  maxItems: 20,
};

/**
 * 是否是一个能用的时区名
 *
 * 判定交给 Intl：自己维护一张时区表既造不完也必然过时。
 * 字符白名单只是挡掉乱七八糟的输入（Intl 对某些奇怪字符串也会接受）。
 */
function isValidTz(v) {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (!t || t.length > 64) return false;
  if (!/^[A-Za-z0-9_+\-\/:]+$/.test(t)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: t });
    return true;
  } catch {
    return false;
  }
}

/** 归一化时区名（不合格就退回默认） */
function normalizeTz(v) {
  if (typeof v !== 'string') return DEFAULT_TZ;
  const t = v.trim();
  return isValidTz(t) ? t : DEFAULT_TZ;
}

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

/** 某个时区「现在」的分钟数与日期键 —— 摘要的定时与幂等都按它算 */
function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 取某个时区「现在」的时刻与日期键
 *
 * 用 formatToParts 而不是拼字符串：不同 ICU 版本对 hour12:false 的处理不一致
 * （有的把午夜渲染成 24），逐段取最稳。
 *
 * ⚠️ 时区不对就退回默认时区 —— 宁可按北京时间发，也不要因为一条脏设置永远不发。
 */
function zoneNow(tz, d = new Date()) {
  const zone = normalizeTz(tz);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  const pick = (t) => {
    const p = parts.find(x => x.type === t);
    return p ? p.value : '';
  };
  const h = parseInt(pick('hour'), 10);
  const m = parseInt(pick('minute'), 10);
  return {
    tz: zone,
    hhmm: (Number.isNaN(h) ? 0 : h) * 100 + (Number.isNaN(m) ? 0 : m),
    day: `${pick('year')}-${pick('month')}-${pick('day')}`,
  };
}

/**
 * 日期键 → 人看的日期：`2026-10-13` → `10月13日`
 *
 * ⚠️ 年份只在**不是今年**时才带上：摘要是回看清单，翻上个月的大多是同年，
 *    天天顶着「2026年」很吵；跨了年才需要区分（否则「1月2日」不知道哪年的）。
 *
 * @param day      日期键 `YYYY-MM-DD`
 * @param nowYear  「今年」是哪年（按同一时区算的），null 就一律不显示年份
 */
function dayLabel(day, nowYear = null) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return '';
  const yy = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const dd = parseInt(m[3], 10);
  const showYear = nowYear != null && yy !== nowYear;
  return `${showYear ? yy + '年' : ''}${mo}月${dd}日`;
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
 *
 * ⚠️ 正文首行**不带日期**：日期只在消息标题上（`今日摘要（10月13日） · 12 条`）。
 *    列表里每条都顶着标题，正文再写一遍是重复。
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

  // 标题带日期：同一天的两份摘要（手动生成 + 定时）一眼能分清，
  // 翻历史也知道这份是哪天的 —— 日期按用户自己选的时区算，不是服务器时区。
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
  // 「未读」这个概念对摘要没意义：它本来就是一份「过去 24 小时都发生了什么」的回看清单，
  // 已读的也算 —— 真按未读过滤，白天看过的消息晚上就找不到了。
  lines.push(`_过去 24 小时的消息汇总，共 ${total} 条。_`);

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
  DEFAULT_TZ,
  DEFAULT_DIGEST,
  digestSettingsOf,
  isValidTz,
  normalizeTz,
  dayKey,
  zoneNow,
  dayLabel,
  digestItemTitle,
  renderDigest,
};
