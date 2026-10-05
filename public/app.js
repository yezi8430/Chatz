
// ── 中英切换 ────────────────────────────────────────────────
// chatzT() 由 /i18n.js 提供（index.html 里排在 app.js 之前加载）。
// 兜一层：万一 i18n.js 没加载成功，退化成原样返回，界面照旧中文，
// 不会整个脚本 ReferenceError 崩掉。
//
// ⚠️ 为什么叫 chatzT 而不是更短的 t：app.js 里有
//    function ruleRowHtml(idx, row, types, t, kind) 和一堆 .map(t => ...)，
//    用 t 会被局部作用域遮蔽，静默出错。
var chatzT = (typeof window.chatzT === 'function')
  ? window.chatzT
  : function (s) { return s; };

const ICON_CHANNEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>';
const ICON_MAILBOX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 8l9 6 9-6"/></svg>';
const ICON_MUTED = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

const state = {
  token: localStorage.getItem('chatz_token') || '',
  currentUser: null,
  channels: [],
  apps: [],
  messages: [],
  currentChannelId: -1,
  currentView: 'inbox',
  ws: null,
  reconnectTimer: null,
  theme: localStorage.getItem('chatz_theme') || 'light',
  unreadByChannel: {},
  loadingMessages: false,
  focusedMsgId: null,
  searchQuery: '',
  searchResults: null,
  searchResultCount: 0,
  // 标签筛选：点消息卡片上的 #tag 进入，null = 不筛选。
  // 与频道/视图是**正交**的维度（跨频道看同一标签），
  // 所以不放进 currentView，而是单独一个字段，由 renderMessages 叠加过滤。
  currentTag: null,
  httpsPort: 20443,
};

let editingAppId = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60000) return chatzT('刚刚');
    if (diff < 3600000) return Math.floor(diff / 60000) + chatzT(' 分钟前');
    if (diff < 86400000) return Math.floor(diff / 3600000) + chatzT(' 小时前');
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    if (y === new Date().getFullYear()) return `${m}-${day} ${hh}:${mm}`;
    return `${y}-${m}-${day} ${hh}:${mm}`;
  } catch { return iso; }
}

function prioClass(p) {
  if (p <= 3) return 'prio-low';
  if (p <= 7) return 'prio-normal';
  if (p <= 9) return 'prio-high';
  return 'prio-urgent';
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${state.token}`,
      ...(opts.body && !opts.raw ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    state.token = '';
    localStorage.removeItem('chatz_token');
    showLogin();
    throw new Error(chatzT('登录状态已失效，请重新登录'));
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    let msg = `HTTP ${res.status}`;
    try { const j = JSON.parse(txt); if (j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const ICON_MOON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
const ICON_SUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`;

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  // 毛玻璃从第一帧就挂上，不等背景图（见 style.css「毛玻璃」区块的说明）。
  // 晚一步启用就会出现"先半透明、隔一帧才模糊"的两段观感 ——
  // 浏览器首次应用 backdrop-filter 要新开合成层，必然晚一帧。
  document.body.classList.add('glass-on');
  const t = $('#themeToggle');
  if (t) t.innerHTML = state.theme === 'dark' ? ICON_SUN : ICON_MOON;
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('chatz_theme', state.theme);
  applyTheme();
  // 主题的明暗基准变了，accent 的亮度也要跟着换（暗底下得更亮才看得清），
  // 所以按当前背景重算一次（缓存 key 带主题，不会重复遍历像素）
  applyAccentFromBackground(localStorage.getItem('chatz_bg_url'));
}

// ============ 登录/注册 ============

function showLogin() {
  $('#loginView').classList.remove('hidden');
  $('#mainView').classList.add('hidden');
  if ($('#setupView')) $('#setupView').classList.add('hidden');
  const rv = document.getElementById('resetView');
  if (rv) rv.classList.add('hidden');
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  state.currentUser = null;

  // 回到「登录」标签：显示登录表单，收起注册 / 忘记密码表单
  $$('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'login'));
  const lf = document.getElementById('loginForm');
  const rf = document.getElementById('registerForm');
  const ff = document.getElementById('forgotForm');
  if (lf) lf.classList.remove('hidden');
  if (rf) rf.classList.add('hidden');
  if (ff) ff.classList.add('hidden');
  $('#loginError').textContent = '';

  // 清空敏感字段（保留用户名）
  const pwd = document.getElementById('loginPassword');
  const token = document.getElementById('loginToken');
  if (pwd) pwd.value = '';
  if (token) token.value = '';
}

function hideLogin() {
  $('#loginView').classList.add('hidden');
  $('#mainView').classList.remove('hidden');
}

// ============ 首次引导 ============

function showSetup() {
  const view = $('#setupView');
  if (!view) { showLogin(); return; }
  $('#loginView').classList.add('hidden');
  $('#mainView').classList.add('hidden');
  view.classList.remove('hidden');
  $('#setupError').textContent = '';
  const u = document.getElementById('setupUsername');
  if (u) u.focus();
}

/**
 * 决定首屏到底是「首次引导」「登录」还是「直接进应用」。
 *
 * 全新安装的标志由服务端给（GET /setup/status），前端不自己猜 ——
 * 判断依据（meta.setup_completed）在数据库里，前端拿不到也不该拿。
 */
async function checkSetupOrLogin() {
  try {
    const res = await fetch('/setup/status');
    if (res.ok) {
      const s = await res.json();
      if (s && s.needsSetup) { showSetup(); return; }
    }
  } catch {
    // 服务器不可达 / 极老的后端没这个接口 → 一律走常规登录，不要卡住首屏
  }
  showLogin();
}

async function doSetup() {
  const username = $('#setupUsername').value.trim();
  const displayName = $('#setupDisplayName').value.trim();
  const emailEl = document.getElementById('setupEmail');
  const email = emailEl ? emailEl.value.trim() : '';
  const password = $('#setupPassword').value;
  const password2 = $('#setupPassword2').value;
  const err = $('#setupError');

  if (!username || !password) { err.textContent = chatzT('请填写用户名和密码'); return; }
  if (password !== password2) { err.textContent = chatzT('两次密码不一致'); return; }
  if (password.length < 6) { err.textContent = chatzT('密码至少 6 位'); return; }

  const btn = $('#setupBtn');
  btn.disabled = true;
  btn.textContent = chatzT('正在创建…');

  try {
    const res = await fetch('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, displayName, email }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || chatzT('初始化失败'));

    state.token = j.token;
    localStorage.setItem('chatz_token', j.token);

    // 清掉这一页上的明文，之后不会再显示了
    ['setupPassword', 'setupPassword2'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    $('#setupView').classList.add('hidden');

    await start();
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = chatzT('创建管理员');
  }
}

function switchAuthTab(tab) {
  $$('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('#loginForm').classList.toggle('hidden', tab !== 'login');
  $('#registerForm').classList.toggle('hidden', tab !== 'register');
  const ff = document.getElementById('forgotForm');
  if (ff) ff.classList.add('hidden');
  $('#loginError').textContent = '';
}

// ============ 忘记密码 / 重置 ============

function showForgot() {
  $('#loginForm').classList.add('hidden');
  $('#registerForm').classList.add('hidden');
  const ff = document.getElementById('forgotForm');
  if (ff) ff.classList.remove('hidden');
  $('#loginError').textContent = '';
  const el = document.getElementById('forgotEmail');
  if (el) el.focus();
}

async function doForgotPassword() {
  const emailEl = document.getElementById('forgotEmail');
  const email = emailEl ? emailEl.value.trim() : '';
  const err = $('#loginError');
  if (!email) { err.textContent = chatzT('请输入邮箱'); return; }

  const btn = $('#forgotSubmitBtn');
  btn.disabled = true; btn.textContent = chatzT('正在提交…');
  try {
    const res = await fetch('/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const j = await res.json().catch(() => ({}));
    // 服务端固定回 200 + 一句通用提示（不泄露邮箱是否注册过）
    err.textContent = j.message || chatzT('已提交，请查看服务日志');
  } catch (e) {
    err.textContent = chatzT('请求失败：') + (e.message || e);
  } finally {
    btn.disabled = false; btn.textContent = chatzT('获取重置链接');
  }
}

function showReset(token) {
  $('#loginView').classList.add('hidden');
  $('#mainView').classList.add('hidden');
  if ($('#setupView')) $('#setupView').classList.add('hidden');
  const rv = document.getElementById('resetView');
  if (!rv) { showLogin(); return; }
  rv.classList.remove('hidden');
  rv.dataset.token = token;
  $('#resetError').textContent = '';

  // 先问服务端这枚令牌还有没有效，失效就直接提示（不展开表单也可以）
  fetch(`/auth/reset-password/validate?token=${encodeURIComponent(token)}`)
    .then(r => r.json())
    .then(j => {
      if (j && j.valid === false) {
        const reason = { used: chatzT('链接已被使用过'), expired: chatzT('链接已过期'), invalid: chatzT('链接无效') }[j.reason] || chatzT('链接无效');
        $('#resetError').textContent = reason + chatzT('，请重新申请');
      }
    })
    .catch(() => {});

  const el = document.getElementById('resetPassword');
  if (el) el.focus();
}

async function doResetPassword() {
  const rv = document.getElementById('resetView');
  const token = rv ? rv.dataset.token : '';
  const p1 = $('#resetPassword').value;
  const p2 = $('#resetPassword2').value;
  const err = $('#resetError');

  if (!p1) { err.textContent = chatzT('请输入新密码'); return; }
  if (p1.length < 6) { err.textContent = chatzT('新密码至少 6 位'); return; }
  if (p1 !== p2) { err.textContent = chatzT('两次输入的新密码不一致'); return; }

  const btn = $('#resetBtn');
  btn.disabled = true; btn.textContent = chatzT('正在修改…');
  try {
    const res = await fetch('/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: p1 }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || chatzT('重置失败'));

    toast(chatzT('密码已修改，请重新登录'));
    showLogin();
  } catch (e) {
    err.textContent = e.message || chatzT('重置失败');
  } finally {
    btn.disabled = false; btn.textContent = chatzT('修改密码');
  }
}

async function doLogin() {
  const username = $('#loginUsername').value.trim();
  const password = $('#loginPassword').value;
  if (!username || !password) { $('#loginError').textContent = chatzT('请输入用户名和密码'); return; }
  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, deviceName: 'Web' }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || chatzT('登录失败'));
    }
    const data = await res.json();
    state.token = data.token;
    localStorage.setItem('chatz_token', data.token);
    $('#loginError').textContent = '';
    await start();
  } catch (e) { $('#loginError').textContent = e.message; }
}

async function doTokenLogin() {
  const token = $('#loginToken').value.trim();
  if (!token) { $('#loginError').textContent = chatzT('请输入 Token'); return; }
  state.token = token;
  try {
    await fetch('/channel', { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => { if (!r.ok) throw new Error(chatzT('Token 无效')); });
    localStorage.setItem('chatz_token', token);
    $('#loginError').textContent = '';
    await start();
  } catch (e) {
    $('#loginError').textContent = chatzT('Token 无效或服务器不可达');
    state.token = '';
  }
}

async function doRegister() {
  const username = $('#regUsername').value.trim();
  const displayName = $('#regDisplayName').value.trim();
  const emailEl = document.getElementById('regEmail');
  const email = emailEl ? emailEl.value.trim() : '';
  const password = $('#regPassword').value;
  const password2 = $('#regPassword2').value;

  if (!username || !password) { $('#loginError').textContent = chatzT('请填写完整'); return; }
  if (password !== password2) { $('#loginError').textContent = chatzT('两次密码不一致'); return; }

  try {
    const res = await fetch('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, displayName, email }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || chatzT('注册失败'));
    }
    const data = await res.json();
    state.token = data.token;
    localStorage.setItem('chatz_token', data.token);
    $('#loginError').textContent = '';
    await start();
  } catch (e) { $('#loginError').textContent = e.message; }
}

// ============ 数据加载 ============

async function loadCurrentUser() {
  try { state.currentUser = await api('/auth/me'); }
  catch { state.currentUser = null; }
  updateUserMini();
}

function updateUserMini() {
  if (!state.currentUser) return;
  const u = state.currentUser;
  const name = u.displayName || u.username;
  const nameEl = $('#userMiniName');
  const avEl = $('#userMiniAvatar');
  if (nameEl) nameEl.textContent = name;
  if (avEl) {
    if (u.avatar) {
      avEl.innerHTML = `<img src="${escapeHtml(u.avatar)}" alt="" onerror="this.replaceWith('${name.charAt(0).toUpperCase()}')">`;
    } else {
      avEl.textContent = name.charAt(0).toUpperCase();
    }
  }
}

async function loadChannels() {
  state.channels = (await api('/channel')) || [];
  renderChannels();
  populateSendChannelSelect();
}

async function loadApps() {
  // 接口现在有 requireAdmin，普通用户调了只会 403。
  // 这里提前跳过，省掉一次注定失败的请求（下面的 try/catch 只是兜底，
  // 不该拿来当正常流程用）。
  if (!state.currentUser?.isAdmin) {
    state.apps = [];
    return;
  }
  try {
    state.apps = (await api('/application')) || [];
  } catch {
    state.apps = [];
  }
}

async function loadUnreadCounts() {
  try {
    const data = await api('/message/unread-counts');
    state.unreadByChannel = data.byChannel || {};
    renderChannels();
  } catch {}
}

async function loadMessages() {
  state.loadingMessages = true;
  renderMessages();

  try {
    const params = new URLSearchParams();
    params.set('limit', '200');
    params.set('since', '0');
    if (state.currentChannelId !== -1) params.set('channel', String(state.currentChannelId));
    if (state.currentView === 'unread') params.set('unread', '1');
    if (state.currentView === 'archived') params.set('archived', '1');

    const data = await api(`/message?${params.toString()}`);
    state.messages = (data.messages || []).reverse();
  } catch (e) {
    state.messages = [];
  } finally {
    state.loadingMessages = false;
    renderMessages();
  }
}

// ============ WebSocket ============

function connectWS() {
  if (state.ws) { try { state.ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/stream?token=${encodeURIComponent(state.token)}`;
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onopen = () => setConnStatus('connected');
  ws.onerror = () => setConnStatus('disconnected');
  ws.onclose = () => {
    setConnStatus('disconnected');
    if (state.token) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(connectWS, 3000);
    }
  };
  ws.onmessage = (e) => {
    try { handleWsEvent(JSON.parse(e.data)); } catch {}
  };
}

function handleWsEvent(data) {
  if (data.id && data.message != null && !data.event) {
    if (!state.messages.find(m => m.id === data.id)) {
      state.messages.unshift(data);
      renderMessages();
    }
    if (!data.isRead) {
      const ch = data.channel_id;
      state.unreadByChannel[ch] = (state.unreadByChannel[ch] || 0) + 1;
      renderChannels();
    }
    return;
  }

  switch (data.event) {
    case 'messageAggregated': {
      const aggMsg = data.message;
      if (!aggMsg) break;
      const idx = state.messages.findIndex(m => m.id === aggMsg.id);
      if (idx >= 0) {
        state.messages[idx] = { ...state.messages[idx], ...aggMsg };
      } else {
        state.messages.unshift(aggMsg);
      }
      renderMessages();
      // ★ 折叠 ≠ 新消息：消息已存在时只是"内容变大了"，绝不能再把未读 +1。
      //   而且广播体里本来就没有 isRead（服务端 messageCreate 的 rowToMsg 不带它，
      //   只有 REST 列表 messages.js 才带），所以 `if (!aggMsg.isRead)` 恒成立
      //   ⇒ 每折叠一次徽标就 +1。直接问服务端要准确值。
      loadUnreadCounts();
      break;
    }
    case 'messageDeleted':
      state.messages = state.messages.filter(m => m.id !== data.id);
      renderMessages();
      loadUnreadCounts();
      break;
    case 'messageRead': {
      const m = state.messages.find(m => m.id === data.messageId);
      if (m) { m.isRead = true; m.readAt = data.readAt; renderMessages(); }
      loadUnreadCounts();
      break;
    }
    case 'messageUnread': {
      const m = state.messages.find(m => m.id === data.messageId);
      if (m) { m.isRead = false; delete m.readAt; renderMessages(); }
      loadUnreadCounts();
      break;
    }
    case 'messagesReadAll':
      state.messages.forEach(m => {
        if (data.channelId == null || m.channel_id === data.channelId) m.isRead = true;
      });
      renderMessages();
      loadUnreadCounts();
      break;
    case 'messageArchived':
      state.messages = state.messages.filter(m => m.id !== data.messageId);
      renderMessages();
      break;
    case 'messageUnarchived':
      loadMessages();
      break;
    case 'channelCreated':
    case 'channelUpdated':
      loadChannels();
      break;
    case 'channelDeleted':
      state.channels = state.channels.filter(c => c.id !== data.channelId);
      if (state.currentChannelId === data.channelId) state.currentChannelId = -1;
      renderChannels();
      populateSendChannelSelect();
      loadMessages();
      loadUnreadCounts();
      break;
    case 'subscriptionChanged':
      loadChannels();
      loadMessages();
      break;
    // 账号信息（头像/昵称/用户名/邮箱/密码）在别处被改了
    //
    // 场景：Android 客户端换了头像 → 网页这边本来毫无察觉，得手动刷新才更新。
    // 现在服务端主动推这个信号，我们重拉一次 /auth/me 并刷新头像与昵称显示。
    //
    // 刻意不把新内容塞进事件里：只推"你该重拉了"，接收端 re-fetch 即可。
    // 这样服务端加字段时前端不用跟着改（漏一个就静默不同步）。
    case 'userUpdated':
      refreshCurrentUser();
      break;
  }
}

/**
 * 重新拉取当前用户并刷新所有显示位（侧栏 mini 头像 + 设置页头像）
 *
 * 与 loadCurrentUser() 的区别：这个是"从服务端校正"，会同时刷新两处头像。
 * 拉失败就不动界面 —— 保持旧显示比清空/闪一下好。
 */
async function refreshCurrentUser() {
  let u;
  try { u = await api('/auth/me'); }
  catch { return; }
  if (!u) return;
  state.currentUser = u;

  updateUserMini();
  // 自己的角色可能被别的超级管理员改了（对应服务端的 userUpdated 推送）
  refreshUserMgmtVisibility();

  const name = u.displayName || u.username || '?';
  const letter = name.charAt(0).toUpperCase();
  updateAvatarDisplay(u.avatar, letter);

  // 设置页里的昵称/用户名/邮箱输入框：如果弹窗开着，同步成服务端的新值
  // （只在值确实不同的时候写，避免把用户正在输入的内容顶掉）
  const nameInput = document.getElementById('userNameInput');
  if (nameInput && document.activeElement !== nameInput && nameInput.value !== name) {
    nameInput.value = name;
  }
  const unameInput = document.getElementById('accountUsernameInput');
  if (unameInput && document.activeElement !== unameInput
      && unameInput.value !== (u.username || '')) {
    unameInput.value = u.username || '';
  }
  const emailInput = document.getElementById('emailInput');
  if (emailInput && document.activeElement !== emailInput
      && emailInput.value !== (u.email || '')) {
    emailInput.value = u.email || '';
  }
}

function setConnStatus(s) {
  const el = $('#connStatus');
  el.classList.remove('connected', 'disconnected');
  el.classList.add(s);
  el.querySelector('.text').textContent = s === 'connected' ? chatzT('已连接') : chatzT('连接断开');
}

// ============ 渲染 ============

function renderChannels() {
  const list = $('#channelList');
  list.innerHTML = '';

  const totalUnread = Object.values(state.unreadByChannel).reduce((a, b) => a + b, 0);
  const allItem = document.createElement('div');
  allItem.className = 'ch-item' + (state.currentChannelId === -1 ? ' active' : '');
  allItem.innerHTML = `
    <span class="icon">${ICON_MAILBOX}</span>
    <span class="name">${chatzT('所有频道')}</span>
    ${totalUnread > 0 ? `<span class="badge">${totalUnread > 99 ? '99+' : totalUnread}</span>` : ''}
  `;
  allItem.onclick = () => switchChannel(-1);
  list.appendChild(allItem);

  for (const ch of state.channels) {
    const el = document.createElement('div');
    el.className = 'ch-item' + (state.currentChannelId === ch.id ? ' active' : '');
    const unread = state.unreadByChannel[ch.id] || 0;
    const iconHtml = ch.image
      ? `<img src="${escapeHtml(ch.image)}" alt="" onerror="this.replaceWith(ICON_CHANNEL)">`
      : ICON_CHANNEL;

    el.innerHTML = `
      <span class="icon">${iconHtml}</span>
      <span class="name">${escapeHtml(ch.name)}${ch.muted ? ` ${ICON_MUTED}` : ''}</span>
      <span class="ch-id">(ID:${ch.id})</span>
      ${unread > 0 ? `<span class="badge">${unread > 99 ? '99+' : unread}</span>` : ''}
      <button class="more-btn" title="${chatzT('更多操作')}">\u22EF</button>
    `;

    el.querySelector('.more-btn').onclick = (e) => openChannelMenu(e, ch);
    // 右键也能唤出同一个菜单。原来只有 ⋮ 按钮一个入口，而它默认隐藏、
    // 要 hover 才显形（见 style.css 的 .ch-item .more-btn），触屏和键盘用户基本摸不到。
    el.oncontextmenu = (e) => openChannelMenu(e, ch);
    el.onclick = () => switchChannel(ch.id);
    list.appendChild(el);
  }
}

function renderSkeleton() {
  // 占位数量按**可视高度**算，骨架要铺满整个列表区域。
  // 写死数量（哪怕提到 7）在换成真实消息时覆盖面积还是会变，
  // 整片区域的明暗就跟着跳一下 —— 看着像毛玻璃在变，其实是覆盖面积在变。
  const listEl = $('#messageList');
  const cardPitch = 96; // 单张卡片高度 + 间距的估算值
  const viewportH = listEl?.clientHeight || window.innerHeight || 600;
  const count = Math.max(4, Math.min(24, Math.ceil(viewportH / cardPitch)));

  let html = '';
  for (let i = 0; i < count; i++) {
    html += `
      <div class="skeleton-card">
        <div class="skeleton-line title"></div>
        <div class="skeleton-line w80"></div>
        <div class="skeleton-line w60"></div>
      </div>
    `;
  }
  return html;
}

function getAppIcon(appid) {
  const app = state.apps.find(a => a.id === appid);
  if (app && app.image) return app.image;
  return null;
}

// filterMessages 已被后端搜索取代


/**
 * 正文过高就折叠，并挂上「展开全文 / 收起」按钮
 *
 * 会被调用两次：初次渲染时一次，以及图片加载完成后再来一次
 * （见 renderMessages —— 图片异步加载，初次判定时高度还没撑开）。
 * 所以这里必须能安全地重复执行。
 *
 * ⚠️ 阈值要和 style.css 里 .msg-body.collapsed 的 max-height 成对调：
 *    阈值(200) 必须大于折叠高度(160)，否则会出现"折叠完反而更高"。
 */
function collapseIfTall(body) {
  // 已经展开过、或者按钮已经在位了，就不再动它
  if (body.classList.contains('expanded')) return;
  if (body.parentNode && body.parentNode.querySelector('.msg-expand')) return;

  if (body.scrollHeight <= 200) return;

  body.classList.add('collapsed');
  const btn = document.createElement('button');
  btn.className = 'msg-expand';
  btn.textContent = chatzT('展开全文');
  // 展开后按钮要留着并变成「收起」：原来这里直接 btn.remove()，
  // 展开之后就再也折叠不回去了，只能刷新页面才能重新变短
  btn.onclick = () => {
    const collapsed = body.classList.toggle('collapsed');
    body.classList.toggle('expanded', !collapsed);
    btn.textContent = collapsed ? chatzT('展开全文') : chatzT('收起');
  };
  body.parentNode.insertBefore(btn, body.nextSibling);
}

/**
 * 进入 / 退出标签筛选
 *
 * 与客户端的交互保持一致（点卡片上的 #tag → 列表顶部出现筛选条，
 * 筛选条上有清除按钮），两端口径统一，用户换端不用重新适应。
 *
 * tag 传 null 表示退出筛选。
 */
function applyTagFilter(tag) {
  state.currentTag = tag || null;
  state.focusedMsgId = null;
  // 刻意不重置 searchQuery：标签和搜索可以叠加（见 renderMessages）。
  // 但也不主动清空输入框，避免用户切个标签就把搜索词弄丢。
  renderMessages();
  // 列表整体淡入一下，让「内容变了」这件事有反馈 ——
  // 尤其是筛选后条数没变（比如当前频道内所有消息都带该标签）时，
  // 没有反馈会让人以为点击没生效。
  const list = $('#messageList');
  if (list) {
    list.classList.add('switching');
    setTimeout(() => list.classList.remove('switching'), 50);
  }
}

/**
 * 渲染标签筛选提示条
 *
 * 独立于 #messageList 的 innerHTML 重写（renderMessages 会整体重写列表），
 * 所以单独占一个 #tagFilterBar 元素，只改它自己。
 * 不筛选时整个隐藏，不占高度。
 */
function renderTagBanner() {
  const bar = $('#tagFilterBar');
  if (!bar) return;
  const tag = state.currentTag;
  if (!tag) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  bar.innerHTML = `
    <span class="tag-filter-label">${chatzT('标签筛选')}</span>
    <span class="tag-filter-chip">#${escapeHtml(tag)}</span>
    <button class="tag-filter-clear" title="${chatzT('清除筛选')}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;
  bar.querySelector('.tag-filter-clear').onclick = () => applyTagFilter(null);
}

function renderMessages() {
  const list = $('#messageList');
  const empty = $('#emptyState');

  // 骨架
  if (state.loadingMessages) {
    list.innerHTML = renderSkeleton();
    empty.classList.add('hidden');
    return;
  }

  let filtered;
  if (state.searchQuery && state.searchResults !== null) {
    filtered = state.searchResults;
  } else if (state.currentChannelId === -1) {
    filtered = state.messages;
  } else {
    filtered = state.messages.filter(m => m.channel_id === state.currentChannelId);
  }

  // 标签筛选叠加在最后：它与「频道 / 视图 / 搜索」是「与」关系，
  // 不是替换关系 —— 所以不能写成 else if，否则会导致
  // 「搜到结果后又点标签」这类组合失效。
  if (state.currentTag) {
    filtered = filtered.filter(m => Array.isArray(m.tags) && m.tags.includes(state.currentTag));
  }

  renderTagBanner();

  if (filtered.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    updateEmptyState();
    return;
  }
  empty.classList.add('hidden');

  // 找到最后一条未读（索引最大的），分隔线放在它下面
  let lastUnreadIdx = -1;
  if (state.currentView === 'inbox' && !state.searchQuery) {
    filtered.forEach((m, idx) => {
      if (!m.isRead) lastUnreadIdx = idx;
    });
  }

  const cards = filtered.map((m, idx) => {
    const showDivider = lastUnreadIdx >= 0 && idx === lastUnreadIdx + 1;
    const divider = showDivider
      ? chatzT('<div class="unread-divider">以下为已读消息</div>', []) : '';

    return divider + renderCard(m);
  }).join('');

  list.innerHTML = cards;

  // 图片置底：把 data 里存的地址真正挂成卡片背景。
  // 用 setProperty 而不是在 HTML 里拼 style，URL 里的引号就不会破坏属性。
  document.querySelectorAll('.msg-card[data-bg-image]').forEach(card => {
    card.style.setProperty('--msg-image', `url("${card.dataset.bgImage}")`);
  });

  bindCardEvents();
  bindAggToggles();
  bindImagePreview();
  bindExpandButtons();
}

function renderCard(m) {
  const pc = prioClass(m.priority);
  const chName = state.channels.find(c => c.id === m.channel_id)?.name || '';
  const readClass = m.isRead ? 'read' : 'unread';
  // 文案统一叫「收藏」（内部字段仍是 archivedAt，API 也没改，只是换个说法）
  const archiveLabel = m.archivedAt ? chatzT('取消收藏') : chatzT('收藏');
  const appIcon = getAppIcon(m.appid);

  const iconHtml = appIcon
    ? `<img class="msg-app-icon" src="${escapeHtml(appIcon)}" alt="" onerror="this.style.display='none'">`
    : '';

  const focusedClass = state.focusedMsgId === m.id ? ' focused' : '';

  // ===== 非订阅频道 → 只读 =====
  //
  // 超级管理员能看到别人的频道（排障用），但那不是他的频道：
  // 收藏 / 标已读 / 删除这几个按钮一律不给 —— 服务端也已经拦了
  // （`getMessageWithPermission` 和 `DELETE /message/:id` 现在都要求订阅）。
  //
  // ⚠️ 收藏和删除是**全局**操作（改 messages 表，不是 per-user），
  //    在未订阅频道上点一下，频道所有者那边消息真的会变/消失 —— 那是真串。
  //    标已读倒是 per-user 的，但既然不显示它的未读数了，给按钮也没意义。
  //
  // 前端不给按钮 + 服务端拦住，两层都在 —— 光有服务端的话，点了只弹个错，
  // 体验上仍是"我好像能操作"。
  const ch = state.channels.find(c => c.id === m.channel_id);
  const canOperate = !!ch && ch.subscribed === true;

  // ===== 图片置底（对应客户端的 image_as_background） =====
  // 两边的图片来源不一样：客户端是独立的 extras.image 字段，
  // 而 WebUI 的图是**正文 markdown 渲染出来的**，所以要额外做一步 ——
  // 从正文 HTML 里摘掉第一张图，再把它的地址挂到整张卡片的背景上。
  // 地址只经 data 属性传递，真正的 background-image 由 JS 用 setProperty 设置
  // （见 renderMessages），不拼进 style 属性，免得 URL 里的引号把属性撑破。
  let bodyHtml = renderMarkdown(m.message);
  let bgImage = null;
  if (imageBottomEnabled()) {
    const imgTag = bodyHtml.match(/<img\b[^>]*>/i);
    const src = imgTag && imgTag[0].match(/src="([^"]+)"/i);
    if (src) {
      bgImage = src[1];
      bodyHtml = bodyHtml.replace(imgTag[0], '');
    }
  }

  return `
    <div class="msg-card ${pc} ${readClass}${focusedClass}${bgImage ? ' has-image-bg' : ''}"
         data-id="${m.id}"${bgImage ? ` data-bg-image="${escapeHtml(bgImage)}"` : ''}>
      <div class="msg-header">
        ${iconHtml}
        <div class="msg-title-row">
          <span class="msg-prio-dot ${pc}"></span>
          <span class="msg-title">${escapeHtml(m.title || chatzT('无标题'))}</span>
        </div>
        <div class="msg-time">${formatTime(m.date)}</div>
        <div class="msg-actions">
          ${canOperate ? `
          <button class="icon-btn act-archive" title="${archiveLabel}" data-archived="${m.archivedAt ? '1' : '0'}">
            ${m.archivedAt
              ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M5 6v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6"/><path d="M12 16V9M9 12l3-3 3 3"/></svg>'
              : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M5 6v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6"/><path d="M12 11v7M9 14l3 3 3-3"/></svg>'}
          </button>
          <button class="icon-btn act-unread" title="${m.isRead ? chatzT('标未读') : chatzT('标已读')}">
            ${m.isRead
              ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 5-5"/></svg>'
              : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/></svg>'}
          </button>
          <button class="icon-btn delete-msg" title="${chatzT('删除')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
          </button>
          ` : chatzT('<span class="msg-readonly" title="别人的频道，只能查看">只读</span>', [])}
        </div>
      </div>
      ${renderSender(m)}
      ${renderReplyQuote(m)}
      <div class="msg-body" data-msg-id="${m.id}">${bodyHtml}</div>
      ${renderAggChildren(m)}
      <div class="msg-footer">
        ${chName ? `<span class="msg-app-tag">${escapeHtml(chName)}</span>` : ''}
        <span class="msg-prio-tag ${pc}">${chatzT('优先级')} ${m.priority}</span>
        ${m.tags ? m.tags.map(t => chatzT('<span class="msg-app-tag tag-clickable" data-tag="{0}" title="筛选此标签">#{1}</span>', [escapeHtml(t), escapeHtml(t)])).join('') : ''}
      </div>
    </div>
  `;
}

/**
 * 剥掉正文里的 markdown 图片语法 `![alt](url)`。
 *
 * ⚠️ 必须与 Android 的 `MessageText.stripImageMarkdown` 保持**同一套语义**（无条件剥除 + trim）：
 * 图片在聚合子项里有专属呈现（下面的 `agg-child-img`，取自 extras 的 image →
 * client::display.url → client::notification.bigImageUrl），正文里再留一段 `![](...)` 就是重复信息。
 *
 * 客户端早就在子项里这么做了（MessageCard.kt 的 cleanText），WebUI 漏了这一步
 * ⇒ 同一张图会显示两次：正文 markdown 一次 + agg-child-img 一次。
 */
function stripImageMarkdown(text) {
  return String(text || '').replace(/!\[.*?\]\(.*?\)/g, '').trim();
}

function renderAggChildren(m) {
  if (!m.aggCount || m.aggCount <= 1) return '';
  const children = m.aggChildren || [];
  const mainTitle = m.title || '';

  const items = children.slice().reverse().map((c, idx) => {
    const num = m.aggCount - idx;
    const pc = prioClass(c.priority || 5);
    const title = c.title && c.title !== mainTitle ? c.title : '';

    let imgHtml = '';
    const extras = c.extras || {};
    let imgUrl = null;
    if (extras['image']) imgUrl = extras['image'];
    else if (extras['client::display']?.url) imgUrl = extras['client::display'].url;
    else if (extras['client::notification']?.bigImageUrl) imgUrl = extras['client::notification'].bigImageUrl;
    if (imgUrl) imgHtml = `<img class="agg-child-img" src="${escapeHtml(imgUrl)}" alt="">`;

    return `
      <div class="agg-child">
        <div class="agg-child-head">
          <span class="agg-child-num">#${num}</span>
          <span class="agg-child-time">${formatTime(c.date)}</span>
          <span class="agg-child-prio ${pc}">P${c.priority || 5}</span>
        </div>
        ${title ? `<div class="agg-child-title">${escapeHtml(title)}</div>` : ''}
        <div class="agg-child-body">${renderMarkdown(stripImageMarkdown(c.message))}</div>
        ${imgHtml}
      </div>
    `;
  }).join('');

  return `
    <div class="agg-block">
      <button class="agg-toggle" data-id="${m.id}">
        <span class="agg-badge">× ${m.aggCount}</span>
        <span class="agg-label">${chatzT('点击展开合并的消息')}</span>
      </button>
      <div class="agg-children" id="agg-${m.id}">
        ${items}
      </div>
    </div>
  `;
}

/**
 * 发送者：昵称 @用户名 [+ 管理员标签]
 *
 * 快照由**服务端**在消息创建时写进 extras.sender（不是客户端传的，伪造不了）。
 * webhook 发的消息没有登录用户 → 没有这个字段 → 返回空串。
 *
 * ⚠️ 昵称/用户名都是用户可改的，必须 escapeHtml。
 */
function renderSender(m) {
  const s = m.extras && m.extras.sender;
  if (!s || !s.username) return '';
  const name = s.displayName || s.username;
  // 昵称与用户名相同时只显示一个（注册时 display_name 会回落成 username）
  const label = name === s.username
    ? escapeHtml(name)
    : `${escapeHtml(name)} <span class="msg-sender-at">@${escapeHtml(s.username)}</span>`;
  const badge = s.isAdmin ? chatzT('<span class="msg-sender-admin">管理员</span>') : '';
  return `<div class="msg-sender">${label}${badge}</div>`;
}

/**
 * 引用条：这条消息是"回复某条"时，显示被回复内容的摘要
 *
 * 引用关系由**客户端**写在 extras 里（reply_to / reply_to_text）—— 服务端不认识这
 * 两个 key，只是原样透传并存下来。没有就是普通消息，返回空串。
 *
 * ⚠️ 摘要必须 escapeHtml：extras 是外部可写的（webhook / 其他客户端都能塞），
 *    这里不能直接拼进 HTML。
 */
function renderReplyQuote(m) {
  const quote = m.extras && m.extras['reply_to_text'];
  if (!quote) return '';
  return `<div class="msg-reply-quote" title="${chatzT('引用的消息')}">
      <span class="msg-reply-bar"></span>
      <span class="msg-reply-text">${escapeHtml(String(quote))}</span>
    </div>`;
}

function renderMarkdown(text) {
  if (!text) return '';

  let html;
  if (window.marked && typeof window.marked.parse === 'function') {
    try {
      html = window.marked.parse(text, { breaks: true, gfm: true });
    } catch {
      html = escapeHtml(text).replace(/\n/g, '<br>');
    }
  } else {
    html = escapeHtml(text).replace(/\n/g, '<br>');
  }

  // 用 DOMPurify 过滤 XSS
  if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
    return window.DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [
        'a','b','i','u','em','strong','p','br','hr','ul','ol','li',
        'blockquote','pre','code','h1','h2','h3','h4','h5','h6',
        'img','table','thead','tbody','tr','th','td','del','s','span'
      ],
      ALLOWED_ATTR: ['href','title','src','alt','class','align','target','rel'],
      ALLOWED_URI_REGEXP: /^(?:https?|mailto|data:image\/)/i,
      // 强制外链安全
      FORBID_TAGS: ['script','style','iframe','object','embed','form','input','button'],
      FORBID_ATTR: ['onerror','onload','onclick','onmouseover','onfocus','onblur','style'],
    });
  }

  // 兜底：如果没有 DOMPurify，只输出纯文本
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function updateEmptyState() {
  const text = $('#emptyText');
  const action = $('#emptyAction');
  if (state.searchQuery) {
    text.textContent = chatzT('没有匹配「{0}」的消息', [state.searchQuery]);
    action.classList.add('hidden');
  } else if (state.currentTag) {
    // 标签筛选用单独文案：否则会显示「还没有消息」，
    // 让用户以为库里空了，其实是筛选条件的问题。
    // 这里也顺手把当前频道名带上，解释「为什么只看到这个范围」。
    const scope = state.currentChannelId === -1
      ? ''
      : chatzT('「{0}」中', [state.channels.find(c => c.id === state.currentChannelId)?.name || chatzT('当前频道')]);
    text.textContent = chatzT('{0}没有带 #{1} 标签的消息', [scope, state.currentTag]);
    // 给一条出路：一键清掉筛选回到全部消息，而不是让用户自己找入口
    action.classList.remove('hidden');
    action.textContent = chatzT('清除标签筛选');
    action.onclick = () => applyTagFilter(null);
  } else if (state.currentView === 'unread') {
    text.textContent = chatzT('没有未读消息');
    action.classList.add('hidden');
  } else if (state.currentView === 'archived') {
    text.textContent = chatzT('没有收藏消息');
    action.classList.add('hidden');
  } else if (state.currentChannelId !== -1) {
    text.textContent = chatzT('这个频道还没有消息');
    action.classList.remove('hidden');
    action.textContent = chatzT('发送第一条消息');
    action.onclick = openSendModal;
  } else {
    text.textContent = chatzT('还没有消息');
    action.classList.remove('hidden');
    action.textContent = chatzT('发送第一条消息');
    action.onclick = openSendModal;
  }
}

// ============ 事件绑定 ============

function bindCardEvents() {
  // 标签 chip → 进入标签筛选。
  // stopPropagation 必须加：卡片本身有「点空白处聚焦/标记已读」的处理器，
  // 不拦住的话点标签会顺带触发一次卡片点击。
  document.querySelectorAll('.tag-clickable').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      applyTagFilter(el.dataset.tag);
    };
  });
  document.querySelectorAll('.delete-msg').forEach(b => {
    b.onclick = (e) => {
      e.stopPropagation();
      deleteMessage(parseInt(b.closest('.msg-card').dataset.id, 10));
    };
  });
  document.querySelectorAll('.act-archive').forEach(b => {
    b.onclick = (e) => {
      e.stopPropagation();
      const id = parseInt(b.closest('.msg-card').dataset.id, 10);
      // ⚠️ 原来是拿 title 文案判断状态（title === '取消归档'）——
      //    那样一改文案这个按钮就废了。改成看 data 属性，以后改文案不影响逻辑。
      const isArchived = b.dataset.archived === '1';
      toggleArchive(id, isArchived);
    };
  });
  document.querySelectorAll('.act-unread').forEach(b => {
    b.onclick = (e) => {
      e.stopPropagation();
      const id = parseInt(b.closest('.msg-card').dataset.id, 10);
      // ⚠️ 这里比较的是「标未读」这个文案本身，必须跟着语言走：
      //   英文下 title 已经被翻成 "Mark as unread"，写死中文会永远判 false。
      const isRead = b.getAttribute('title') === chatzT('标未读');
      toggleRead(id, isRead);
    };
  });

  // 右键菜单
  document.querySelectorAll('.msg-card').forEach(card => {
    card.oncontextmenu = (e) => {
      e.preventDefault();
      const id = parseInt(card.dataset.id, 10);
      openMsgContextMenu(e, id);
    };
  });

  // 检测长消息折叠
  // ⚠️ 阈值要和 style.css 里 .msg-body.collapsed 的 max-height 成对调：
  //    阈值(200) 必须大于折叠高度(160)，否则会出现"折叠完反而更高"的怪事。
  //    原来这对是 300 / 240，卡片偏高（240px ≈ 10 行文字），收窄了一档。
  document.querySelectorAll('.msg-body').forEach(body => {
    collapseIfTall(body);
    // ⚠️ 图片是**异步加载**的：上面这一次判定时它还没撑开高度，
    //    scrollHeight 只算了文字 —— 于是带图的消息明明很高却没被折叠，
    //    也没有"展开全文"按钮。每张图加载完必须再判一次。
    body.querySelectorAll('img').forEach(img => {
      if (!img.complete) {
        img.addEventListener('load', () => collapseIfTall(body), { once: true });
      }
    });
  });
}

function bindExpandButtons() {
  // 已在 bindCardEvents 里处理
}

function bindAggToggles() {
  document.querySelectorAll('.agg-toggle').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const el = document.getElementById('agg-' + id);
      if (!el) return;
      const open = !el.classList.contains('open');
      el.classList.toggle('open', open);
      btn.querySelector('.agg-label').textContent = open
        ? chatzT('点击收起')
        : chatzT('点击展开合并的消息');
    };
  });
}

/**
 * 打开大图预览（点遮罩任意处关闭）
 *
 * 两处在用：正文里的 <img>，以及**图片置底**模式下的卡片背景。
 */
function openImagePreview(src) {
  const overlay = document.createElement('div');
  overlay.className = 'img-preview-overlay';
  const big = document.createElement('img');
  big.src = src;
  overlay.appendChild(big);
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

function bindImagePreview() {
  document.querySelectorAll('.msg-body img, .agg-child-img').forEach(img => {
    img.onclick = (e) => {
      e.stopPropagation();
      openImagePreview(img.src);
    };
  });

  // 图片置底模式：正文里那张图已经被摘掉当背景了（见 renderCard），
  // 不补这个入口就再也点不开大图 —— 所以让整张卡片可点开预览。
  document.querySelectorAll('.msg-card.has-image-bg').forEach(card => {
    card.onclick = (e) => {
      // 卡片内的按钮（展开全文 / 收藏 / 删除 / 标已读…）和链接各有其职，
      // 点它们时不该弹大图
      if (e.target.closest('button, a, .agg-child-img, .agg-toggle')) return;
      openImagePreview(card.dataset.bgImage);
    };
  });
}

// ============ 消息右键菜单 ============

function openMsgContextMenu(e, id) {
  closeCtxMenu();
  const m = state.messages.find(x => x.id === id);
  if (!m) return;

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';

  const items = [
    { text: chatzT('复制内容'), fn: () => { navigator.clipboard.writeText(m.message || ''); toast(chatzT('已复制')); } },
    { text: chatzT('复制标题 + 内容'), fn: () => {
        const text = (m.title ? m.title + '\n\n' : '') + (m.message || '');
        navigator.clipboard.writeText(text);
        toast(chatzT('已复制'));
      } },
    { sep: true },
    { text: m.isRead ? chatzT('标为未读') : chatzT('标为已读'), fn: () => toggleRead(id, m.isRead) },
    { text: m.archivedAt ? chatzT('取消收藏') : chatzT('收藏'), fn: () => toggleArchive(id, !!m.archivedAt) },
    { sep: true },
    { text: chatzT('删除'), fn: () => deleteMessage(id), danger: true },
  ];

  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'sep';
      menu.appendChild(sep);
    } else {
      const btn = document.createElement('button');
      btn.textContent = item.text;
      if (item.danger) btn.classList.add('danger');
      btn.onclick = () => { closeCtxMenu(); item.fn(); };
      menu.appendChild(btn);
    }
  }

  document.body.appendChild(menu);
  ctxMenuEl = menu;

  const rect = menu.getBoundingClientRect();
  let x = e.clientX, y = e.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

// ============ 键盘快捷键 ============

function bindKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // 输入框里不响应
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }

    // 忽略带修饰键
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        navigateFocused(1);
        break;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        navigateFocused(-1);
        break;
      case 'r':
        if (state.focusedMsgId) {
          const m = state.messages.find(x => x.id === state.focusedMsgId);
          if (m) toggleRead(m.id, m.isRead);
        }
        break;
      case 'u':
        if (state.focusedMsgId) {
          const m = state.messages.find(x => x.id === state.focusedMsgId);
          if (m) toggleRead(m.id, !m.isRead);
        }
        break;
      case 'd':
        if (state.focusedMsgId) deleteMessage(state.focusedMsgId);
        break;
      case 'a':
        if (state.focusedMsgId) {
          const m = state.messages.find(x => x.id === state.focusedMsgId);
          if (m) toggleArchive(m.id, !!m.archivedAt);
        }
        break;
      case '/':
        e.preventDefault();
        focusSearch();
        break;
      case 'n':
        e.preventDefault();
        openSendModal();
        break;
      case 'Escape':
        if (state.focusedMsgId) {
          state.focusedMsgId = null;
          renderMessages();
        }
        break;
    }
  });

  // 显示快捷键提示
  const hint = document.createElement('div');
  hint.className = 'kbd-hint';
  hint.innerHTML = chatzT('<kbd>j</kbd><kbd>k</kbd> 导航 · <kbd>r</kbd> 已读 · <kbd>d</kbd> 删除 · <kbd>/</kbd> 搜索 · <kbd>n</kbd> 新消息');
  hint.id = 'kbdHint';
  document.body.appendChild(hint);
}

function navigateFocused(delta) {
  const visible = state.currentChannelId === -1
    ? state.messages
    : state.messages.filter(m => m.channel_id === state.currentChannelId);

  if (visible.length === 0) return;

  let idx = visible.findIndex(m => m.id === state.focusedMsgId);
  if (idx === -1) idx = delta > 0 ? -1 : visible.length;
  idx += delta;
  if (idx < 0) idx = 0;
  if (idx >= visible.length) idx = visible.length - 1;

  state.focusedMsgId = visible[idx].id;
  renderMessages();

  // 滚动到聚焦卡片
  const card = document.querySelector(`.msg-card[data-id="${state.focusedMsgId}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function focusSearch() {
  const box = $('#searchBox');
  const input = $('#searchInput');
  if (box && input) {
    box.style.display = '';
    input.focus();
  }
}

// ============ 搜索 ============

function bindSearch() {
  const input = $('#searchInput');
  const clear = $('#searchClear');
  if (!input) return;

  let searchTimer;

  async function performSearch(q) {
    if (!q) {
      state.searchResults = null;
      state.searchResultCount = 0;
      await loadMessages();
      return;
    }
    try {
      const data = await api(`/message/search?q=${encodeURIComponent(q)}&limit=100`);
      state.searchResults = data.messages || [];
      state.searchResultCount = data.count || 0;
      renderMessages();
    } catch (e) {
      toast(chatzT('搜索失败：') + (e.message || chatzT('未知错误')));
    }
  }

  input.addEventListener('input', () => {
    const val = input.value.trim();
    state.searchQuery = val;
    clear.classList.toggle('hidden', !val);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => performSearch(val), 200);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      state.searchQuery = '';
      state.searchResults = null;
      state.searchResultCount = 0;
      clear.classList.add('hidden');
      input.blur();
      loadMessages();
    }
  });

  clear.onclick = () => {
    input.value = '';
    state.searchQuery = '';
    state.searchResults = null;
    state.searchResultCount = 0;
    clear.classList.add('hidden');
    loadMessages();
  };
}

// ============ 交互 ============

function switchChannel(channelId) {
  state.currentChannelId = channelId;
  state.focusedMsgId = null;
  state.searchQuery = '';
  state.searchResults = null;
  state.searchResultCount = 0;
  // 切频道顺带清掉标签筛选：标签虽然是跨频道的视角，但用户主动切频道
  // 说明关注点已经变了，残留的筛选只会让「切过去怎么还是空的」变困惑。
  state.currentTag = null;
  const _si = document.getElementById('searchInput');
  if (_si) _si.value = '';
  const _sc = document.getElementById('searchClear');
  if (_sc) _sc.classList.add('hidden');
  const title = channelId === -1
    ? chatzT('所有消息')
    : (state.channels.find(c => c.id === channelId)?.name || chatzT('频道'));
  $('#currentTitle').textContent = title;
  renderChannels();

  const list = $('#messageList');
  list.classList.add('switching');

  loadMessages().then(() => {
    setTimeout(() => list.classList.remove('switching'), 50);
  });

  closeSidebarOnMobile();
}

function switchView(view) {
  state.currentView = view;
  state.focusedMsgId = null;
  state.searchQuery = '';
  state.searchResults = null;
  state.searchResultCount = 0;
  // 同 switchChannel：切视图（收件箱/未读/收藏）也清掉标签筛选
  state.currentTag = null;
  const _si2 = document.getElementById('searchInput');
  if (_si2) _si2.value = '';
  const _sc2 = document.getElementById('searchClear');
  if (_sc2) _sc2.classList.add('hidden');
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  loadMessages();
}

async function deleteMessage(id) {
  if (!confirm(chatzT('确定删除这条消息？'))) return;

  const card = document.querySelector(`.msg-card[data-id="${id}"]`);
  if (card) {
    card.classList.add('removing');
    await new Promise(r => setTimeout(r, 250));
  }

  try {
    await api(`/message/${id}`, { method: 'DELETE' });
    state.messages = state.messages.filter(m => m.id !== id);
    if (state.focusedMsgId === id) state.focusedMsgId = null;
    renderMessages();
    loadUnreadCounts();
    toast(chatzT('已删除'));
  } catch { toast(chatzT('删除失败')); }
}

async function toggleRead(id, wasRead) {
  try { await api(`/message/${id}/${wasRead ? 'unread' : 'read'}`, { method: 'POST' }); }
  catch { toast(chatzT('操作失败')); }
}

async function toggleArchive(id, wasArchived) {
  try { await api(`/message/${id}/${wasArchived ? 'unarchive' : 'archive'}`, { method: 'POST' }); }
  catch { toast(chatzT('操作失败')); }
}

async function markAllRead() {
  try {
    const r = await api('/message/read-all', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    toast(chatzT('已读 {0} 条', [r.count]));
  } catch { toast(chatzT('操作失败')); }
}

async function deleteChannel(id, name) {
  if (!confirm(chatzT('删除频道「{0}」及其所有消息？', [name]))) return;
  try {
    await api(`/channel/${id}`, { method: 'DELETE' });
    toast(chatzT('频道已删除'));
  } catch { toast(chatzT('删除失败')); }
}

function openSendModal() {
  $('#sendModal').classList.remove('hidden');
  $('#sendTitle').value = '';
  $('#sendBody').value = '';
  $('#sendPriority').value = '5';
  populateSendChannelSelect();
  if (state.currentChannelId > 0) $('#sendChannelId').value = state.currentChannelId;
  setTimeout(() => $('#sendBody').focus(), 50);
}

function populateSendChannelSelect() {
  const sel = $('#sendChannelId');
  if (!sel) return;
  sel.innerHTML = state.channels.map(c =>
    `<option value="${c.id}">${escapeHtml(c.name)} (ID:${c.id})</option>`
  ).join('');
}

async function submitSend() {
  const channel_id = parseInt($('#sendChannelId').value, 10);
  const title = $('#sendTitle').value.trim();
  const message = $('#sendBody').value;
  const priority = parseInt($('#sendPriority').value, 10);

  if (!message.trim()) { toast(chatzT('内容不能为空')); return; }

  try {
    await api('/message', {
      method: 'POST',
      body: JSON.stringify({ channel_id, title: title || null, message, priority }),
    });
    $('#sendModal').classList.add('hidden');
    toast(chatzT('已发送'));
  } catch { toast(chatzT('发送失败')); }
}

function openChannelModal() {
  $('#channelModal').classList.remove('hidden');
  $('#chName').value = '';
  $('#chDesc').value = '';
  $('#chIconFile').value = '';
  $('#chIconPreview').innerHTML = '';
  $('#chPublic').checked = true;
  setTimeout(() => $('#chName').focus(), 50);
}

async function submitChannel() {
  const name = $('#chName').value.trim();
  const description = $('#chDesc').value.trim();
  const is_public = $('#chPublic').checked;
  const file = $('#chIconFile').files[0];

  if (!name) { toast(chatzT('名称不能为空')); return; }

  try {
    const created = await api('/channel', {
      method: 'POST',
      body: JSON.stringify({ name, description: description || null, is_public }),
    });

    if (file) {
      const res = await fetch(`/channel/${created.id}/icon`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${state.token}`,
          'Content-Type': file.type || 'image/png',
        },
        body: file,
      });
      if (!res.ok) throw new Error(chatzT('图标上传失败'));
    }

    $('#channelModal').classList.add('hidden');
    await loadChannels();
    toast(chatzT('频道已创建'));
  } catch (e) { toast(e.message || chatzT('创建失败')); }
}

// ============ 订阅管理 ============

let ctxMenuEl = null;

function closeCtxMenu() {
  if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
}

/**
 * 能不能改这个频道（换图标 / 删频道）
 *
 * 判断口径必须和服务端一致：`src/channels.js` 里 `PATCH /channel/:id` 和
 * `POST /channel/:id/icon` 都是 `isSuper || creator_id === userId`。
 * 这里同样判断，避免给出「点了必定 403」的菜单项。
 *
 * ⚠️ 必须用 `isSuper` 不是 `isAdmin`：普通管理员（role 1）只管应用和路由规则，
 *    管不到频道（服务端也是按 isSuper 判）。用 isAdmin 会给 role 1 的人
 *    显示菜单项，点下去服务端照样 403。
 *
 * 注意**默认频道（id=1）不特殊**：migrate 把它的 `creator_id` 补成了 admin 的 id
 * （`src/migrate.js`），所以管理员对它持有创建者权限，换图标是被放行的。
 */
function canEditChannel(ch) {
  const u = state.currentUser;
  if (!u) return false;
  return !!u.isSuper || ch.creatorId === u.id;
}

function openChannelMenu(e, ch) {
  // 右键触发时要挡掉浏览器自带菜单；click（⋮ 按钮）触发时这一句无副作用
  e.preventDefault();
  e.stopPropagation();
  closeCtxMenu();

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';

  const items = [];
  items.push({ text: ch.muted ? chatzT('取消静音') : chatzT('静音'), fn: () => toggleMute(ch.id, !ch.muted) });
  items.push({ text: chatzT('取消订阅'), fn: () => unsubscribeChannel(ch.id, ch.name) });

  const canEdit = canEditChannel(ch);
  if (canEdit) {
    items.push({ sep: true });
    // 改名 / 描述 / 公开性 / 图标全都在这一个弹窗里，菜单不再堆散项
    items.push({ text: chatzT('管理频道'), fn: () => openChannelEdit(ch) });
  }

  // 默认频道只允许改，不允许删（删了没有回落目标）
  if (ch.id !== 1 && canEdit) {
    items.push({ sep: true });
    items.push({ text: chatzT('删除频道'), fn: () => deleteChannel(ch.id, ch.name), danger: true });
  }

  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'sep';
      menu.appendChild(sep);
    } else {
      const btn = document.createElement('button');
      btn.textContent = item.text;
      if (item.danger) btn.classList.add('danger');
      btn.onclick = () => { closeCtxMenu(); item.fn(); };
      menu.appendChild(btn);
    }
  }

  document.body.appendChild(menu);
  ctxMenuEl = menu;

  const rect = menu.getBoundingClientRect();
  let x = e.clientX, y = e.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

// ============ 频道管理（改名 / 描述 / 公开性 / 图标） ============

/** 当前正在编辑的频道对象（保存时要用） */
let channelEditTarget = null;

/** 频道管理弹窗里是否点了「清除密码」（与输入框留空区分：留空=不修改，点了清除=保存时传空串） */
let chEditPwdCleared = false;

/** 订阅受保护频道时，等待输密码的那个频道 id */
let pendingSubscribeId = null;

/** 密码尝试次数过多的锁定倒计时（429 后禁用「订阅」按钮） */
let passwordLockTimer = null;

/**
 * 打开「管理频道」弹窗
 *
 * 弹窗里两件事是分开的，别混为一谈：
 *   - 名称 / 描述 / 公开性 → 点「保存」才提交（`PATCH /channel/:id`）
 *   - 图标 → **选完立即生效**，和设置界面里的换头像一样，不走保存按钮
 */
function openChannelEdit(ch) {
  channelEditTarget = ch;

  $('#chEditName').value = ch.name || '';
  $('#chEditDesc').value = ch.description || '';
  $('#chEditPublic').checked = !!ch.isPublic;

  // 密码：每次打开都清空输入框（服务端不回密码原文，只能重新输入）。
  // 「清除密码」只在当前有密码时显示；「已标记清除」状态也要复位。
  chEditPwdCleared = false;
  const pwdInput = $('#chEditPassword');
  if (pwdInput) pwdInput.value = '';
  updateChannelPwdUI(!!ch.passwordProtected);

  // ⚠️ 每次打开都要清空上一次的残留，否则编辑 B 频道时会看到 A 频道选的文件
  const fileInput = $('#chEditIconFile');
  if (fileInput) fileInput.value = '';
  updateChannelIconDisplay(ch.image);

  $('#channelEditModal').classList.remove('hidden');
  setTimeout(() => $('#chEditName').focus(), 50);
}

/** 刷新频道管理弹窗里的密码控件状态 */
function updateChannelPwdUI(hasPwd) {
  const btn = $('#chEditPwdClear');
  if (!btn) return;
  if (chEditPwdCleared) {
    btn.style.display = '';
    btn.textContent = chatzT('已标记清除（点保存生效）');
    btn.disabled = true;
  } else {
    btn.style.display = hasPwd ? '' : 'none';
    btn.textContent = chatzT('清除密码');
    btn.disabled = false;
  }
}

/** 点「清除密码」：只标记，真正清除在点「保存」时走 PATCH */
function markChannelPwdClear() {
  chEditPwdCleared = true;
  const pwdInput = $('#chEditPassword');
  if (pwdInput) pwdInput.value = '';
  updateChannelPwdUI(true);
}

async function submitChannelEdit() {
  const ch = channelEditTarget;
  if (!ch) return;

  const name = $('#chEditName').value.trim();
  if (!name) { toast(chatzT('名称不能为空')); return; }
  const description = $('#chEditDesc').value.trim();
  const isPublic = $('#chEditPublic').checked;
  const pwd = $('#chEditPassword') ? $('#chEditPassword').value : '';

  const body = {
    name,
    description: description || null,
    is_public: isPublic,
  };
  if (chEditPwdCleared) {
    body.password = '';               // 清除密码
  } else if (pwd) {
    if (pwd.length < 4 || pwd.length > 64) { toast(chatzT('频道密码需 4-64 位')); return; }
    body.password = pwd;              // 设置新密码
  }

  try {
    // 只提交文字字段 + 密码。图标走自己的接口、选完立即生效，不在这里处理 ——
    // 否则「保存」会把已经换好的图标再覆盖一次
    await api(`/channel/${ch.id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

    $('#channelEditModal').classList.add('hidden');
    channelEditTarget = null;
    chEditPwdCleared = false;
    await loadChannels();
    toast(chatzT('频道已更新'));
  } catch (e) { toast(e.message || chatzT('保存失败')); }
}

/**
 * 刷新弹窗里的图标预览
 *
 * 与 `updateAvatarDisplay` 同构（换头像那套），保持两处行为一致：
 * 有图显示图、无图显示占位符，右上角 ✕ 只在有图时出现。
 */
function updateChannelIconDisplay(imageUrl) {
  const img = document.getElementById('chEditIconImg');
  const span = document.getElementById('chEditIconLetter');
  const removeBtn = document.getElementById('chEditIconRemove');
  if (!img || !span) return;

  if (imageUrl) {
    img.src = imageUrl;
    img.style.display = 'block';
    span.style.display = 'none';
    // 图标文件坏了（比如手动清了 data/）时退回占位符，别留个裂图
    img.onerror = () => { img.style.display = 'none'; span.style.display = 'block'; };
    if (removeBtn) removeBtn.classList.remove('hidden');
  } else {
    img.style.display = 'none';
    img.removeAttribute('src');
    span.style.display = 'block';
    if (removeBtn) removeBtn.classList.add('hidden');
  }
}

/**
 * 选完图立即上传 —— 和换头像一样，不走弹窗的「保存」按钮
 */
async function uploadChannelIcon() {
  const ch = channelEditTarget;
  const inp = document.getElementById('chEditIconFile');
  const file = inp?.files[0];
  if (!ch || !file) return;

  const reset = () => { if (inp) inp.value = ''; };
  if (file.size > 5 * 1024 * 1024) { toast(chatzT('图片太大（限 5MB）')); reset(); return; }

  try {
    const res = await fetch(`/channel/${ch.id}/icon`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${state.token}`,
        // 这条路由挂的是 express.raw({ type: 'image/*' })（src/index.js），
        // Content-Type 必须是图片类型，否则 body 解析不出来 → 400「请求内容为空」
        'Content-Type': file.type || 'image/png',
      },
      body: file,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || chatzT('上传失败'));
    }
    const data = await res.json();

    // 同步回编辑目标，否则关掉弹窗再打开时预览还是旧的
    if (channelEditTarget) channelEditTarget.image = data.image;
    updateChannelIconDisplay(data.image);
    reset();
    await loadChannels();
    toast(chatzT('图标已更新'));
  } catch (e) {
    toast(e.message || chatzT('上传失败'));
    reset();
  }
}

async function removeChannelIconNow() {
  const ch = channelEditTarget;
  if (!ch) return;
  if (!confirm(chatzT('移除「{0}」的图标？', [ch.name]))) return;

  try {
    await api(`/channel/${ch.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ image: '' }),
    });
    if (channelEditTarget) channelEditTarget.image = null;
    updateChannelIconDisplay(null);
    await loadChannels();
    toast(chatzT('图标已移除'));
  } catch (e) { toast(e.message || chatzT('操作失败')); }
}

function bindChannelEditIcon() {
  const picker = document.getElementById('chEditIcon');
  const removeBtn = document.getElementById('chEditIconRemove');
  const fileInput = document.getElementById('chEditIconFile');

  if (picker && fileInput) {
    picker.addEventListener('click', (e) => {
      // 点右上角 ✕ 是「移除」，不能顺带弹出选图框
      if (e.target.closest('#chEditIconRemove')) return;
      fileInput.click();
    });
  }
  if (fileInput) fileInput.addEventListener('change', uploadChannelIcon);
  if (removeBtn) removeBtn.addEventListener('click', removeChannelIconNow);
}

async function subscribeChannel(id, password) {
  try {
    await api(`/channel/${id}/subscribe`, {
      method: 'POST',
      body: password ? JSON.stringify({ password }) : undefined,
    });
    await loadChannels();
    await loadMessages();
    await loadUnreadCounts();
    toast(chatzT('已订阅'));
  } catch (e) { toast(e.message || chatzT('订阅失败')); }
}

async function unsubscribeChannel(id, name) {
  if (!confirm(chatzT('取消订阅「{0}」？', [name]))) return;
  try {
    await api(`/channel/${id}/subscribe`, { method: 'DELETE' });
    if (state.currentChannelId === id) state.currentChannelId = -1;
    await loadChannels();
    await loadMessages();
    await loadUnreadCounts();
    toast(chatzT('已取消订阅'));
  } catch (e) { toast(e.message || chatzT('操作失败')); }
}

async function toggleMute(id, muted) {
  try {
    await api(`/channel/${id}/subscribe`, {
      method: 'PATCH',
      body: JSON.stringify({ muted }),
    });
    await loadChannels();
    toast(muted ? chatzT('已静音') : chatzT('已取消静音'));
  } catch (e) { toast(e.message || chatzT('操作失败')); }
}

// ============ 发现频道 ============

async function openDiscoverModal() {
  $('#discoverModal').classList.remove('hidden');
  const search = $('#discoverSearch');
  if (search) search.value = '';
  await loadDiscoverList();
}

async function loadDiscoverList(q) {
  try {
    // 没显式传 q 时读搜索框当前值（订阅/退订后刷新能保持搜索状态）
    const kw = (q !== undefined ? q : ($('#discoverSearch') ? $('#discoverSearch').value : '')).trim();
    const query = kw ? `?q=${encodeURIComponent(kw)}` : '';
    const list = await api(`/channel/discover${query}`);
    const el = $('#discoverList');

    if (list.length === 0) {
      el.innerHTML = chatzT('<div style="text-align:center;color:var(--text-muted);padding:20px;">没有公开频道</div>');
      return;
    }

    el.innerHTML = list.map(ch => {
      const iconSrc = ch.image
        ? `<img src="${escapeHtml(ch.image)}" alt="" onerror="this.replaceWith(ICON_CHANNEL)">`
        : ICON_CHANNEL;
      const lockBadge = ch.passwordProtected
        ? chatzT(' <span class="ch-id" title="订阅需要密码">需密码</span>')
        : '';
      return `
        <div class="discover-item" data-id="${ch.id}">
          <div class="icon">${iconSrc}</div>
          <div class="info">
            <div class="name">${escapeHtml(ch.name)} <span class="ch-id">(ID:${ch.id})</span>${lockBadge}</div>
            <div class="desc">${escapeHtml(ch.description || '无描述')}</div>
          </div>
          <button class="${ch.subscribed ? 'subscribed' : ''}">${ch.subscribed ? '已订阅' : '订阅'}</button>
        </div>
      `;
    }).join('');

    el.querySelectorAll('.discover-item').forEach(item => {
      const id = parseInt(item.dataset.id, 10);
      const ch = list.find(c => c.id === id);
      const btn = item.querySelector('button');
      btn.onclick = async () => {
        if (ch.subscribed) {
          await unsubscribeChannel(id, ch.name);
          await loadDiscoverList();
        } else if (ch.passwordProtected && !canEditChannel(ch)) {
          // 受保护频道 + 非创建者/超管：先要密码，订阅动作移到 passwordSubmit
          pendingSubscribeId = id;
          $('#passwordPromptText').textContent = chatzT('「{0}」设置了订阅密码，输入后才能订阅', [ch.name]);
          const pwdInput = $('#passwordInput');
          if (pwdInput) pwdInput.value = '';
          $('#passwordModal').classList.remove('hidden');
          setTimeout(() => { if (pwdInput) pwdInput.focus(); }, 50);
        } else {
          // 无密码，或创建者/超管（服务端免密）：直接订阅
          await subscribeChannel(id);
          await loadDiscoverList();
        }
      };
    });
  } catch (e) {
    toast(e.message || chatzT('加载失败'));
  }
}

/** 受保护频道密码框的「订阅」：带密码重试订阅。密码错了**不关框**，提示 + 限次 */
async function submitPasswordSubscribe() {
  const id = pendingSubscribeId;
  const pwd = $('#passwordInput') ? $('#passwordInput').value : '';
  if (id == null) return;
  if (!pwd) { toast(chatzT('请输入密码')); return; }

  let res;
  try {
    res = await fetch(`/channel/${id}/subscribe`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd }),
    });
  } catch (e) {
    toast(chatzT('网络异常，请重试'));
    return;
  }

  // 成功：关框 + 刷新发现列表
  if (res.ok) {
    $('#passwordModal').classList.add('hidden');
    pendingSubscribeId = null;
    await loadDiscoverList();
    toast(chatzT('已订阅'));
    return;
  }

  let msg = chatzT('订阅失败');
  let retryAfter = 0;
  try {
    const j = await res.json();
    if (j.error) msg = j.error;
    if (j.retryAfter) retryAfter = j.retryAfter;
  } catch {}

  // 登录失效：走全局登出流程
  if (res.status === 401) {
    state.token = '';
    localStorage.removeItem('chatz_token');
    $('#passwordModal').classList.add('hidden');
    pendingSubscribeId = null;
    showLogin();
    return;
  }

  // 失败：**不关框**。429 锁按钮倒计时，其余（密码错误）清空输入让用户重试
  if (res.status === 429) {
    lockPasswordSubmit(retryAfter || 60);
  } else {
    const inp = $('#passwordInput');
    if (inp) { inp.value = ''; inp.focus(); }
  }
  toast(msg);
}

/** 密码尝试次数过多：禁用「订阅」按钮并倒计时 */
function lockPasswordSubmit(seconds) {
  const btn = $('#passwordSubmit');
  if (!btn) return;
  btn.disabled = true;
  let remain = seconds;
  const render = () => { btn.textContent = chatzT('稍后再试（{0}s）', [remain]); };
  render();
  if (passwordLockTimer) clearInterval(passwordLockTimer);
  passwordLockTimer = setInterval(() => {
    remain--;
    if (remain <= 0) {
      clearInterval(passwordLockTimer);
      passwordLockTimer = null;
      btn.disabled = false;
      btn.textContent = chatzT('订阅');
    } else {
      render();
    }
  }, 1000);
}

// ============ 账户面板 ============

// ============================================================
// 设置面板：首页 + 分类子页
// ============================================================
// 原来的账户面板是一条长列表，头像、背景、证书、设备全挤在一起 ——
// 改成「首页列出分类 → 点进去是具体设置」，每类只装自己的东西。
// ⚠️ title 必须是**惰性**的：写成 chatzT('外观') 会在脚本加载时就定死，
//    切语言后设置页标题不会跟着变（实测踩过）。下面统一用 labelKey + getter。
const SETTINGS_PAGES = {
  appearance: { el: 'settingsAppearance', labelKey: '外观' },
  security:   { el: 'settingsSecurity',   labelKey: '安全与登录' },
  certs:      { el: 'settingsCerts',      labelKey: 'HTTPS 证书' },
  users:      { el: 'settingsUsers',      labelKey: '用户管理' },
};

/**
 * 给「{ key, labelKey }」这类表项挂一个 .label getter，值 = chatzT(labelKey)。
 *
 * 为什么用 getter 而不是直接存字符串：这些表是模块级常量，加载时求值一次就定死了；
 * 挂 getter 后每次读都重新翻译，切语言即时生效，调用方 `t.label` 的写法还不用改。
 */
function lazyLabel(list) {
  for (const it of list) {
    Object.defineProperty(it, 'label', {
      configurable: true,
      get() { return chatzT(this.labelKey); }
    });
  }
  return list;
}

for (const p of Object.values(SETTINGS_PAGES)) {
  Object.defineProperty(p, 'title', {
    configurable: true,
    get() { return chatzT(this.labelKey); }
  });
}

// 同样是惰性：ROLE_LABEL[r] 直接给中文 key，显示时再翻
const ROLE_LABEL = { 0: '普通用户', 1: '管理员', 2: '超级管理员' };
function roleLabel(r) { return chatzT(ROLE_LABEL[r] ?? '-'); }

function showSettingsPage(key) {
  const home = document.getElementById('settingsHome');
  const back = document.getElementById('settingsBack');
  const title = document.getElementById('settingsTitle');

  for (const el of document.querySelectorAll('.settings-page')) {
    el.classList.add('hidden');
  }

  const page = key ? SETTINGS_PAGES[key] : null;
  if (page) {
    document.getElementById(page.el)?.classList.remove('hidden');
    if (title) title.textContent = page.title;
    back?.classList.remove('hidden');
  } else {
    home?.classList.remove('hidden');
    if (title) title.textContent = chatzT('账户');
    back?.classList.add('hidden');
  }

  // 切页后回到顶部，否则从长页面（比如设备列表）返回时位置会很怪
  const body = document.querySelector('#userModal .modal-body');
  if (body) body.scrollTop = 0;

  // 记住当前子页：切语言时要能原样重开（见文件末尾 chatz:langchange 的处理）
  state.settingsPage = key || null;

  // 每片子页的数据是 JS 渲染的，进页时拉一次；切语言重开时也会走到这里
  if (key === 'users') loadUserMgmt();
  if (key === 'security') loadDevices();
  if (key === 'certs') loadCertStatus();
  if (key === 'appearance') loadBackgroundStatus();
}

// ============ 用户管理（仅超级管理员） ============

/**
 * 「用户管理」入口只对超级管理员出现。
 *
 * 不在这里做权限判断的话，普通管理员会看到一个点进去必定 403 的入口。
 * 服务端当然也挡着，但界面上不该给出做不到的事情。
 */
function refreshUserMgmtVisibility() {
  const nav = document.getElementById('userMgmtNavItem');
  if (nav) nav.classList.toggle('hidden', !state.currentUser?.isSuper);
  // 侧栏「管理」入口：仅超管，看全站用户创建的频道 / 应用 / 路由规则
  const adminBtn = document.getElementById('adminBtn');
  if (adminBtn) adminBtn.style.display = state.currentUser?.isSuper ? '' : 'none';
}

// ============ 超管管理页（全站只读） ============

/**
 * 打开管理页
 *
 * 日常界面（消息 / 频道抽屉 / 应用 / 规则）都是**按用户隔离**的，超管也只看自己的；
 * 要看全站谁建了什么，就在这个页面 —— 数据来自 `/admin/*`。
 */
async function openAdminModal() {
  const modal = document.getElementById('adminModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  await loadAdminList(currentAdminTab);
}

let currentAdminTab = 'channels';

async function loadAdminList(tab) {
  currentAdminTab = tab || 'channels';
  document.querySelectorAll('#adminTabs .admin-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === currentAdminTab);
  });

  const list = document.getElementById('adminList');
  if (!list) return;
  list.textContent = chatzT('加载中...');

  const endpoint = { channels: '/admin/channels', apps: '/admin/applications', rules: '/admin/routes' }[currentAdminTab];

  try {
    const rows = await api(endpoint);
    if (!rows.length) { list.innerHTML = chatzT('<div class="admin-empty">没有数据</div>'); return; }

    if (currentAdminTab === 'channels') {
      list.innerHTML = rows.map(c => `
        <div class="admin-row">
          <div class="admin-main">${escapeHtml(c.name)} <span class="ch-id">(ID:${c.id})</span></div>
          <div class="admin-sub">
            ${chatzT('归属：')}<b>${escapeHtml(c.creatorName || chatzT('未知'))}</b>
            · ${c.isPublic ? chatzT('公开') : chatzT('私有')}
            ${c.passwordProtected ? chatzT(' · 有密码') : ''}
          </div>
        </div>`).join('');
    } else if (currentAdminTab === 'apps') {
      list.innerHTML = rows.map(a => `
        <div class="admin-row">
          <div class="admin-main">${escapeHtml(a.name)} <span class="ch-id">(ID:${a.id})</span></div>
          <div class="admin-sub">
            ${chatzT('归属：')}<b>${escapeHtml(a.ownerName || chatzT('未知'))}</b>
            ${chatzT('· 频道')} ${a.channelId ?? '-'}
            · Token <code>${escapeHtml(a.token || '-')}</code>
          </div>
        </div>`).join('');
    } else {
      list.innerHTML = rows.map(r => `
        <div class="admin-row">
          <div class="admin-main">${escapeHtml(r.name)} <span class="ch-id">(ID:${r.id})</span></div>
          <div class="admin-sub">
            ${chatzT('归属：')}<b>${escapeHtml(r.ownerName || chatzT('未知'))}</b>
            · ${r.enabled ? chatzT('启用') : chatzT('停用')} ${chatzT('· 优先级')} ${r.priority}
          </div>
        </div>`).join('');
    }
  } catch (e) {
    list.innerHTML = chatzT('<div class="admin-empty">加载失败：{0}</div>', [escapeHtml(e.message || '')]);
  }
}

async function loadUserMgmt() {
  const list = document.getElementById('userMgmtList');
  if (!list) return;
  list.textContent = chatzT('加载中...');

  try {
    const users = await api('/user/list');
    if (!users.length) { list.textContent = chatzT('没有用户'); return; }

    list.innerHTML = '';
    for (const u of users) {
      const row = document.createElement('div');
      row.className = 'user-mgmt-row';

      const info = document.createElement('div');
      info.className = 'user-mgmt-info';
      info.innerHTML = `
        <span class="user-mgmt-name">${escapeHtml(u.displayName || u.username)}</span>
        <span class="user-mgmt-sub">@${escapeHtml(u.username)}</span>
      `;

      const sel = document.createElement('select');
      sel.className = 'user-mgmt-role';
      for (const r of [0, 1, 2]) {
        const opt = document.createElement('option');
        opt.value = String(r);
        opt.textContent = roleLabel(r);
        if (u.role === r) opt.selected = true;
        sel.appendChild(opt);
      }
      // 自己不能改：服务端会拒绝（防止一次手滑把自己降下去）
      if (u.id === state.currentUser?.id) {
        sel.disabled = true;
        sel.title = chatzT('不能修改自己的角色');
      }
      sel.onchange = () => changeUserRole(u, parseInt(sel.value, 10), sel);

      row.appendChild(info);
      row.appendChild(sel);
      list.appendChild(row);
    }
  } catch (e) {
    list.textContent = chatzT('加载失败：') + (e.message || chatzT('未知错误'));
  }
}

async function changeUserRole(u, role, sel) {
  const name = u.displayName || u.username;
  if (!confirm(chatzT('把「{0}」的角色改成「{1}」？', [name, roleLabel(role)]))) {
    sel.value = String(u.role); // 撤销界面上的改动
    return;
  }

  try {
    await api(`/user/${u.id}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
    toast(chatzT('角色已更新'));
    // 推送范围是按 isSuper 算的连接时快照，服务端已刷新该用户的在线连接；
    // 这里重新拉一次列表，保证界面显示的是新角色
    await loadUserMgmt();
  } catch (e) {
    toast(e.message || chatzT('操作失败'));
    sel.value = String(u.role);
  }
}

async function openUserModal() {
  // 每次打开都回到首页：上次停在哪个子页不应该被记住
  showSettingsPage(null);
  // 角色可能在别处被改过（或被别的超级管理员改过），打开时重新判断一次
  refreshUserMgmtVisibility();

  $('#userModal').classList.remove('hidden');
  if (state.currentUser) {
    const u = state.currentUser;
    const name = u.displayName || u.username;
    $('#userName').textContent = name;
    $('#userSub').textContent = '@' + u.username + (u.isAdmin ? chatzT(' · 管理员') : '');
    updateAvatarDisplay(u.avatar, name.charAt(0).toUpperCase());
    const emailEl = document.getElementById('emailInput');
    if (emailEl) emailEl.value = u.email || '';
    const usernameEl = document.getElementById('accountUsernameInput');
    if (usernameEl) usernameEl.value = u.username || '';
  }
  await loadDevices();

  const isAdmin = !!state.currentUser?.isAdmin;

  // 读配置：证书 UI 是否启用 + HTTPS 端口
  let certsUiEnabled = true;
  try {
    const cfg = await api('/config');
    certsUiEnabled = cfg.certsUiEnabled !== false;
    if (cfg.httpsPort) state.httpsPort = cfg.httpsPort;
  } catch {}

  const certElements = [
    'certNavItem', 'certStatus', 'certCrtLabel', 'certCrtFile',
    'certKeyLabel', 'certKeyFile', 'certUploadBtn', 'certDeleteBtn',
  ];
  const showCerts = isAdmin && certsUiEnabled;
  for (const id of certElements) {
    const el = document.getElementById(id);
    if (el) el.style.display = showCerts ? '' : 'none';
  }

  if (showCerts) {
    await loadCertStatus();
  }
  await loadBackgroundStatus();
}

async function loadDevices() {
  try {
    const devices = await api('/device');
    const list = $('#deviceList');
    // 列表里只显示前缀，不显示完整 Token。完整值通过「复制」按钮取：
    // 设备面板经常被投屏 / 截图，完整密钥摊在屏幕上的暴露面没必要那么大。
    //
    // 截断长度按**当前两种 token 形态**取：
    //   - 设备 Token `cz.` + 30 位 ≈ 33 字符 → 显示前 16 位
    //   - 主密钥（AUTH_TOKEN）：自 2026-09-30 起同样是 `cz.` 格式；
    //     仅当它来自 .env 且用户填了旧格式时才是 64 位 hex
    // 16 位对两者都够「看个开头对得上」，又不至于把整串摊出来。
    // ⚠️ 不要改成显示完整串：这个面板太容易被截图了。
    const TOKEN_PREVIEW_LEN = 16;
    list.innerHTML = devices.map(d => `
      <div class="device-item">
        <div class="device-info">
          <div class="device-name">${escapeHtml(d.name || chatzT('未命名'))}${d.isMaster ? chatzT(' <span class="tag-current">主密钥</span>') : (d.isCurrent ? chatzT(' <span class="tag-current">当前</span>') : '')}</div>
          <div class="device-token">${escapeHtml(d.token.slice(0, TOKEN_PREVIEW_LEN))}…</div>
        </div>
        <div class="device-actions">
          <button class="icon-btn device-copy" data-id="${d.id}" title="${chatzT('复制完整 Token')}">${ICON_COPY}</button>
          ${d.isMaster
            // 主密钥（管理员登录复用的全局 AUTH_TOKEN）不给「注销」按钮：
            // 删它没有意义 —— AUTH_TOKEN 走兜底分支照样有效，下次登录又补回来。
            // 真要作废它，得换 .env / meta 里的 AUTH_TOKEN，不是在这个面板点两下。
            ? `<button class="icon-btn device-del" disabled title="${chatzT('主密钥，无法删除（要换请在 .env 里改 AUTH_TOKEN）')}" style="opacity:.35;cursor:not-allowed;">${ICON_TRASH}</button>`
            : (d.isCurrent
              // 当前这枚：给「更换」（旧值立即失效、当场拿到新的）而不是删除 ——
              // 删除会被服务端拒（id === req.deviceId）
              ? chatzT('<button class="icon-btn device-rotate" title="更换这枚 Token（旧值立即失效）">{0}</button>', [ICON_REFRESH])
                + chatzT('<button class="icon-btn device-logout" title="注销这台设备（等于删除它这枚 Token）">{0}</button>', [ICON_LOGOUT])
              : chatzT('<button class="icon-btn device-del" data-id="{0}" title="删除设备">{1}</button>', [d.id, ICON_TRASH]))}
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.device-copy').forEach(b => {
      const id = parseInt(b.dataset.id, 10);
      const dev = devices.find(d => d.id === id);
      b.onclick = () => { if (dev) copyToken(dev.token, dev.name); };
    });
    list.querySelectorAll('.device-del').forEach(b => {
      b.onclick = () => deleteDevice(parseInt(b.dataset.id, 10));
    });
    // 当前那行不给删除按钮（服务端会拒 id === deviceId），换成"注销"——
    // 退出登录本来就会把 req.deviceId 这一行删掉，效果一致但不制造死锁
    list.querySelectorAll('.device-logout').forEach(b => {
      b.onclick = () => logoutCurrentDevice();
    });
    list.querySelectorAll('.device-rotate').forEach(b => {
      b.onclick = () => rotateCurrentDevice();
    });
  } catch {}
}

/**
 * 更换当前正在用的这枚 Token
 *
 * 旧值**立即失效**、服务端当场返回新的，所以这里直接把新 token 写回 state 和
 * localStorage —— 当前会话不用重新登录，继续用。
 *
 * ⚠️ 别的设备若也用着这枚 token，会被一起踢下线，重新登录即可拿到新的。
 */
async function rotateCurrentDevice() {
  if (!confirm(chatzT('更换这枚 Token？\n\n旧的值会立即失效，别的设备如果用着它会需要重新登录。'))) return;
  try {
    const res = await api('/device/rotate', { method: 'POST' });
    if (!res?.token) { toast(chatzT('更换失败：没拿到新 Token')); return; }
    state.token = res.token;
    localStorage.setItem('chatz_token', res.token);
    await loadDevices();
    toast(chatzT('Token 已更换（旧值已失效）'));
  } catch (e) {
    toast(e.message || chatzT('更换失败'));
  }
}

/**
 * 复制完整 Token 到剪贴板
 *
 * 为什么不用 prompt() 弹框给用户抄：弹框会把完整密钥长期显示在屏幕上，
 * 而设备面板这类页面经常在被投屏 / 截图 / 远程协助的环境里打开。
 * 直接进剪贴板，屏幕上不会出现完整值。
 *
 * ⚠️ clipboard API 需要安全上下文（HTTPS 或 localhost）。
 *    明文 HTTP 访问时 navigator.clipboard 是 undefined，这里退回 prompt 兜底 ——
 *    功能不能因为环境不满足就直接坏掉。
 */
async function copyToken(token, deviceName) {
  const label = deviceName ? chatzT('「{0}」的', [deviceName]) : '';
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(token);
      toast(chatzT('已复制{0}完整 Token', [label]));
      return;
    }
  } catch {
    // 落到下面的兜底
  }
  // 明文 HTTP 环境下只能这样给；顺带提示用户这个页面的传输没加密
  prompt(chatzT('复制{0}Token 到设备上使用（当前为明文 HTTP，建议配好 HTTPS）：', [label]), token);
}

async function addDevice() {
  const name = prompt(chatzT('设备名称'), chatzT('我的手机'));
  if (!name) return;
  try {
    const d = await api('/device', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    await copyToken(d.token, name);
    await loadDevices();
  } catch { toast(chatzT('添加失败')); }
}

async function deleteDevice(id) {
  if (!confirm(chatzT('删除该设备？该设备将无法再连接。'))) return;
  try {
    await api(`/device/${id}`, { method: 'DELETE' });
    await loadDevices();
    toast(chatzT('设备已删除'));
  } catch (e) { toast(e.message || chatzT('删除失败')); }
}

// ============ HTTPS 证书 ============

async function loadCertStatus() {
  try {
    const s = await api('/certs/status');
    const el = $('#certStatus');

    if (s.error) {
      el.innerHTML = '<span style="color:var(--danger);">' + escapeHtml(s.error) + '</span>';
      return;
    }

    if (s.httpsEnabled) {
      const ci = s.certInfo || {};
      const parts = [chatzT('<span style="color:#22c55e;">已启用</span>')];

      const port = state.httpsPort || 20443;
      const host = location.hostname;
      const httpsUrl = `https://${host}${port !== 443 ? ':' + port : ''}/`;
      parts.push(chatzT('访问地址 <a href="{0}" target="_blank" style="color:var(--accent);text-decoration:none;">{1}</a>', [httpsUrl, httpsUrl]));

      if (ci.subject) parts.push(escapeHtml(ci.subject));
      if (ci.validTo) parts.push(chatzT('有效期至 ') + escapeHtml(ci.validTo));
      if (ci.hasChain === false) {
        parts.push(chatzT('<span style="color:#f59e0b;">证书链不完整（可能只有叶证书）</span>'));
      }
      el.innerHTML = parts.join(' · ');
    } else if (s.hasCrt || s.hasKey) {
      const missing = [];
      if (!s.hasCrt) missing.push(chatzT('证书'));
      if (!s.hasKey) missing.push(chatzT('私钥'));
      el.innerHTML = chatzT('<span style="color:#f59e0b;">还缺 ') + missing.join(chatzT(' 和 ')) + '</span>';
    } else {
      el.innerHTML = chatzT('<span style="color:var(--text-muted);">未配置（仅 HTTP）</span>');
    }
  } catch (e) {
    $('#certStatus').textContent = chatzT('加载失败：') + (e.message || '');
  }
}

async function uploadCert() {
  const crtFile = $('#certCrtFile').files[0];
  const keyFile = $('#certKeyFile').files[0];

  if (!crtFile || !keyFile) {
    toast(chatzT('请同时选择证书文件和私钥文件'));
    return;
  }

  try {
    const crtText = await crtFile.text();
    const keyText = await keyFile.text();

    // 上传证书
    const r1 = await fetch('/certs/fullchain', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${state.token}`,
        'Content-Type': 'application/x-pem-file',
      },
      body: crtText,
    });
    const j1 = await r1.json().catch(() => ({}));
    if (!r1.ok) {
      throw new Error(j1.error || chatzT('证书上传失败'));
    }

    // 上传私钥
    const r2 = await fetch('/certs/privkey', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${state.token}`,
        'Content-Type': 'application/x-pem-file',
      },
      body: keyText,
    });
    const j2 = await r2.json().catch(() => ({}));
    if (!r2.ok) {
      throw new Error(j2.error || chatzT('私钥上传失败'));
    }

    toast(j2.message || j1.message || chatzT('证书已上传并生效'));
    await loadCertStatus();

    // 清空 input
    const crtInput = document.getElementById('certCrtFile');
    const keyInput = document.getElementById('certKeyFile');
    if (crtInput) crtInput.value = '';
    if (keyInput) keyInput.value = '';
    const n1 = document.getElementById('certCrtFile-name');
    const n2 = document.getElementById('certKeyFile-name');
    if (n1) { n1.textContent = chatzT('未选择'); n1.classList.remove('has-file'); }
    if (n2) { n2.textContent = chatzT('未选择'); n2.classList.remove('has-file'); }
  } catch (e) {
    toast(e.message || chatzT('上传失败'));
  }
}

async function deleteCert() {
  if (!confirm(chatzT('删除证书？删除后 HTTPS 将不可用（需重启容器完全生效）。'))) return;
  try {
    await api('/certs', { method: 'DELETE' });
    toast(chatzT('证书已删除'));
    await loadCertStatus();
  } catch (e) {
    toast(e.message || chatzT('删除失败'));
  }
}

async function doLogout() {
  if (!confirm(chatzT('退出登录？'))) return;
  await finishLogout();
}

/**
 * 注销当前这台设备（等于删掉它那枚 Token）。
 *
 * 为什么单开一个入口：设备列表里带「当前」标签的那行原本不渲染删除按钮，
 * 服务端 `DELETE /device/:id` 也明确拒绝 `id === req.deviceId`
 * （否则用户正在用的会话被自己砍掉，会一脸懵）。
 *
 * 但这留了个死锁：**你永远删不掉自己正用着的那枚凭据** ——
 * 而轮换 AUTH_TOKEN 时，要废掉的那枚往往恰好就是它（旧 Token 在 devices 里
 * 占一行，浏览器 localStorage 里存的也是它）。
 *
 * 解法不是放开删除权限，而是绕到「退出登录」这条路：
 * `POST /auth/logout` 本来就会删掉 `req.deviceId` 对应的设备行。
 * 退出 = 删除，语义是一致的。
 *
 * ⚠️ 管理员例外：管理员登录复用的就是全局主密钥（「默认 Token」那行），
 * 这行前端根本不会渲染出「注销」按钮（显示成禁用的删除图标 + 「主密钥」标签），
 * 服务端也不会删它。所以本函数只对普通用户设备生效。
 */
async function logoutCurrentDevice() {
  if (!confirm(chatzT('注销这台设备？\n\n这枚 Token 会立即失效并被删除，之后需要用别的凭据重新登录。'))) return;
  await finishLogout();
}

/** 登出的收尾动作：清状态、清表单、回登录页。不做二次确认。 */
async function finishLogout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch {}

  state.token = '';
  localStorage.removeItem('chatz_token');
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }

  // 清空敏感字段
  const pwd = document.getElementById('loginPassword');
  const token = document.getElementById('loginToken');
  if (pwd) pwd.value = '';
  if (token) token.value = '';

  // 清空注册表单
  ['regUsername', 'regDisplayName', 'regPassword', 'regPassword2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  // 清空错误提示
  const err = document.getElementById('loginError');
  if (err) err.textContent = '';

  // 重置到"登录" tab
  switchAuthTab('login');

  $('#userModal').classList.add('hidden');
  showLogin();
}

// ============ 路由规则 ============

// ⚠️ 这两张表的 label 同样是**惰性**的（见 lazyLabel 的注释）：
//    直接写 chatzT(...) 会在加载时定死，切语言后规则编辑器的下拉还是旧语言。
const CONDITION_TYPES = lazyLabel([
  { key: 'priority_gte', labelKey: '优先级 ≥', type: 'number' },
  { key: 'priority_lte', labelKey: '优先级 ≤', type: 'number' },
  { key: 'priority_eq', labelKey: '优先级 =', type: 'number' },
  { key: 'body_matches', labelKey: '内容匹配（正则）', type: 'text' },
  { key: 'title_matches', labelKey: '标题匹配（正则）', type: 'text' },
  { key: 'channel', labelKey: '频道名 =', type: 'text' },
  { key: 'channel_id', labelKey: '频道 ID =', type: 'number' },
  { key: 'source_app', labelKey: '来源应用 =', type: 'text' },
  { key: 'time_between', labelKey: '时间段', type: 'time_pair' },
  { key: 'tag_includes', labelKey: '包含标签', type: 'tags' },
]);

const ACTION_TYPES = lazyLabel([
  { key: 'set_priority', labelKey: '设为优先级', type: 'number' },
  { key: 'add_tag', labelKey: '加标签', type: 'text' },
  { key: 'remove_tag', labelKey: '移除标签', type: 'text' },
  { key: 'set_silent', labelKey: '静默', type: 'bool' },
  { key: 'broadcast_to', labelKey: '转发到频道 ID', type: 'channels' },
  { key: 'add_prefix', labelKey: '加前缀', type: 'text' },
  { key: 'call_webhook', labelKey: '调用 Webhook', type: 'text' },
  { key: 'drop', labelKey: '丢弃消息', type: 'none' },
]);

let editingRouteId = null;
let editingConditions = [];
let editingActions = [];

async function openRouteModal() {
  $('#routeModal').classList.remove('hidden');
  await loadRouteList();
}

async function loadRouteList() {
  try {
    const routes = await api('/route');
    const el = $('#routeList');
    if (routes.length === 0) {
      el.innerHTML = chatzT('<div style="text-align:center;color:var(--text-muted);padding:20px;">还没有规则</div>');
      return;
    }

    el.innerHTML = routes.map(r => {
      const condText = Object.entries(r.conditions).map(([k, v]) => {
        const t = CONDITION_TYPES.find(c => c.key === k);
        const label = t ? t.label : k;
        const val = Array.isArray(v) ? v.join(',') : v;
        return `<code>${escapeHtml(label)} ${escapeHtml(String(val))}</code>`;
      }).join(' ');

      const actText = r.actions.map(a => {
        const t = ACTION_TYPES.find(c => c.key === a.type);
        const label = t ? t.label : a.type;
        const val = a.value != null ? ` ${Array.isArray(a.value) ? a.value.join(',') : a.value}` : '';
        return `<code>${escapeHtml(label)}${escapeHtml(val)}</code>`;
      }).join(' ');

      return `
        <div class="route-item ${r.enabled ? '' : 'disabled'}" data-id="${r.id}">
          <div class="rt-head">
            <div class="rt-name">${escapeHtml(r.name)}</div>
            <div class="rt-prio">P${r.priority}</div>
          </div>
          <div class="rt-desc">
            ${chatzT('条件：')}${condText || chatzT('<code>无</code>')}<br>
            ${chatzT('动作：')}${actText || chatzT('<code>无</code>')}
          </div>
          <div class="rt-actions">
            <button class="rt-toggle">${r.enabled ? chatzT('禁用') : chatzT('启用')}</button>
            <button class="rt-edit">${chatzT('编辑')}</button>
            <button class="rt-test">${chatzT('测试')}</button>
            <button class="rt-delete danger">${chatzT('删除')}</button>
          </div>
        </div>
      `;
    }).join('');

    el.querySelectorAll('.route-item').forEach(item => {
      const id = parseInt(item.dataset.id, 10);
      const r = routes.find(x => x.id === id);

      item.querySelector('.rt-toggle').onclick = () => toggleRoute(id, !r.enabled);
      item.querySelector('.rt-edit').onclick = () => openRouteEditor(r);
      item.querySelector('.rt-test').onclick = () => testRoute(r);
      item.querySelector('.rt-delete').onclick = () => deleteRoute(id, r.name);
    });
  } catch (e) { toast(e.message || chatzT('加载失败')); }
}

async function toggleRoute(id, enabled) {
  try {
    await api(`/route/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
    await loadRouteList();
    toast(enabled ? chatzT('已启用') : chatzT('已禁用'));
  } catch (e) { toast(e.message || chatzT('操作失败')); }
}

async function deleteRoute(id, name) {
  if (!confirm(chatzT('删除规则「{0}」？', [name]))) return;
  try {
    await api(`/route/${id}`, { method: 'DELETE' });
    await loadRouteList();
    toast(chatzT('已删除'));
  } catch (e) { toast(e.message || chatzT('删除失败')); }
}

async function testRoute(r) {
  const msg = prompt(chatzT('输入测试消息内容：'), chatzT('服务器挂了'));
  if (msg == null) return;
  const prio = prompt(chatzT('输入优先级：'), '9');
  if (prio == null) return;

  try {
    const result = await api('/route/test', {
      method: 'POST',
      body: JSON.stringify({
        conditions: r.conditions,
        actions: r.actions,
        message: { message: msg, priority: parseInt(prio, 10) || 5 },
      }),
    });
    alert(
      chatzT('命中：{0}\\n', [result.matched ? chatzT('是') : chatzT('否')]) +
      chatzT('丢弃：{0}\\n', [result.dropped ? chatzT('是') : chatzT('否')]) +
      chatzT('静默：{0}\\n', [result.silent ? chatzT('是') : chatzT('否')]) +
      chatzT('最终优先级：{0}\\n', [result.result.priority]) +
      chatzT('最终标签：{0}', [(result.result.tags || []).join(', ') || chatzT('无')])
    );
  } catch (e) { toast(e.message || chatzT('测试失败')); }
}

function openRouteEditor(route) {
  editingRouteId = route ? route.id : null;
  $('#routeEditTitle').textContent = route ? chatzT('编辑规则') : chatzT('新建规则');
  $('#rtName').value = route ? route.name : '';
  $('#rtPriority').value = route ? route.priority : 50;
  $('#rtEnabled').checked = route ? route.enabled : true;

  editingConditions = [];
  editingActions = [];

  if (route) {
    for (const [k, v] of Object.entries(route.conditions)) {
      editingConditions.push({ key: k, value: v });
    }
    for (const a of route.actions) {
      editingActions.push({ key: a.type, value: a.value });
    }
  }

  renderRuleRows('#rtConditions', editingConditions, CONDITION_TYPES, 'condition');
  renderRuleRows('#rtActions', editingActions, ACTION_TYPES, 'action');

  $('#routeModal').classList.add('hidden');
  $('#routeEditModal').classList.remove('hidden');
}

function renderRuleRows(selector, data, types, kind) {
  const el = $(selector);
  el.innerHTML = data.map((row, idx) => {
    const t = types.find(x => x.key === row.key) || types[0];
    return ruleRowHtml(idx, row, types, t, kind);
  }).join('');

  el.querySelectorAll('.rule-row').forEach((rowEl, idx) => {
    const typeSelect = rowEl.querySelector('select');
    const valInput = rowEl.querySelector('input');
    const delBtn = rowEl.querySelector('.del-row');

    typeSelect.onchange = () => {
      data[idx].key = typeSelect.value;
      const t = types.find(x => x.key === typeSelect.value);
      data[idx].value = defaultVal(t);
      renderRuleRows(selector, data, types, kind);
    };

    if (valInput) {
      valInput.oninput = () => {
        const t = types.find(x => x.key === row.key);
        data[idx].value = parseVal(valInput.value, t);
      };
    }

    delBtn.onclick = () => {
      data.splice(idx, 1);
      renderRuleRows(selector, data, types, kind);
    };
  });
}

function ruleRowHtml(idx, row, types, t, kind) {
  const opts = types.map(x =>
    `<option value="${x.key}" ${x.key === row.key ? 'selected' : ''}>${x.label}</option>`
  ).join('');

  let valHtml = '';
  if (t.type === 'none') {
    valHtml = '';
  } else if (t.type === 'bool') {
    valHtml = `<input type="text" value="${row.value === false ? 'false' : 'true'}" placeholder="true / false">`;
  } else if (t.type === 'time_pair') {
    const v = Array.isArray(row.value) ? row.value : ['23:00', '07:00'];
    valHtml = `<input type="text" value="${v.join(' - ')}" placeholder="23:00 - 07:00">`;
  } else if (t.type === 'tags' || t.type === 'channels') {
    const v = Array.isArray(row.value) ? row.value.join(',') : (row.value || '');
    valHtml = `<input type="text" value="${escapeHtml(String(v))}" placeholder="${t.type === 'tags' ? 'urgent,alert' : '2,3'}">`;
  } else {
    const v = row.value != null ? row.value : '';
    valHtml = chatzT('<input type="{0}" value="{1}" placeholder="值">', [t.type === 'number' ? 'number' : 'text', escapeHtml(String(v))]);
  }

  return `
    <div class="rule-row">
      <select>${opts}</select>
      ${valHtml}
      <button class="del-row" title="${chatzT('删除')}">\u2715</button>
    </div>
  `;
}

function defaultVal(t) {
  if (t.type === 'number') return 0;
  if (t.type === 'bool') return true;
  if (t.type === 'time_pair') return ['23:00', '07:00'];
  if (t.type === 'tags' || t.type === 'channels') return [];
  if (t.type === 'none') return null;
  return '';
}

function parseVal(str, t) {
  if (t.type === 'number') return parseInt(str, 10) || 0;
  if (t.type === 'bool') return str.trim().toLowerCase() === 'true';
  if (t.type === 'time_pair') {
    const m = str.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
    return m ? [m[1], m[2]] : ['23:00', '07:00'];
  }
  if (t.type === 'tags' || t.type === 'channels') {
    return str.split(',').map(s => {
      const trimmed = s.trim();
      return t.type === 'channels' ? parseInt(trimmed, 10) : trimmed;
    }).filter(x => x !== '' && !(typeof x === 'number' && isNaN(x)));
  }
  return str;
}

async function saveRoute() {
  const name = $('#rtName').value.trim();
  if (!name) { toast(chatzT('名称不能为空')); return; }

  const conditions = {};
  for (const c of editingConditions) {
    if (c.value === null || c.value === '') continue;
    conditions[c.key] = c.value;
  }

  const actions = editingActions.map(a => {
    const t = ACTION_TYPES.find(x => x.key === a.key);
    if (t && t.type === 'none') return { type: a.key };
    return { type: a.key, value: a.value };
  });

  const payload = {
    name,
    priority: Math.max(0, Math.min(100, parseInt($('#rtPriority').value, 10) || 50)),
    enabled: $('#rtEnabled').checked,
    conditions,
    actions,
  };

  try {
    if (editingRouteId) {
      await api(`/route/${editingRouteId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    } else {
      await api('/route', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
    $('#routeEditModal').classList.add('hidden');
    $('#routeModal').classList.remove('hidden');
    await loadRouteList();
    toast(chatzT('已保存'));
  } catch (e) { toast(e.message || chatzT('保存失败')); }
}

// ============ 规则模板 ============

async function openTemplateModal() {
  $('#templateModal').classList.remove('hidden');
  try {
    const templates = await api('/route/templates');
    const el = $('#templateList');
    el.innerHTML = templates.map(t => `
      <div class="template-item" data-id="${t.id}">
        <div class="tpl-name">${escapeHtml(t.name)}</div>
        <div class="tpl-desc">${escapeHtml(t.description)}</div>
      </div>
    `).join('');

    el.querySelectorAll('.template-item').forEach(item => {
      const id = item.dataset.id;
      const tpl = templates.find(x => x.id === id);
      item.onclick = () => applyTemplate(tpl);
    });
  } catch (e) {
    toast(e.message || chatzT('加载模板失败'));
  }
}

function applyTemplate(tpl) {
  editingRouteId = null;
  editingConditions = [];
  editingActions = [];

  for (const [k, v] of Object.entries(tpl.conditions)) {
    editingConditions.push({ key: k, value: v });
  }
  for (const a of tpl.actions) {
    editingActions.push({ key: a.type, value: a.value });
  }

  $('#routeEditTitle').textContent = chatzT('从模板创建：') + tpl.name;
  $('#rtName').value = tpl.name;
  $('#rtPriority').value = tpl.priority;
  $('#rtEnabled').checked = true;

  renderRuleRows('#rtConditions', editingConditions, CONDITION_TYPES, 'condition');
  renderRuleRows('#rtActions', editingActions, ACTION_TYPES, 'action');

  $('#templateModal').classList.add('hidden');
  $('#routeModal').classList.add('hidden');
  $('#routeEditModal').classList.remove('hidden');
}

// ============ 应用管理 ============

const ICON_APP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_LOGOUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';
const ICON_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';

async function openAppManageModal() {
  $('#appManageModal').classList.remove('hidden');
  await loadAppManageList();
}

async function loadAppManageList() {
  try {
    const apps = await api('/application');
    state.apps = apps || [];

    const el = $('#appManageList');
    if (apps.length === 0) {
      el.innerHTML = chatzT('<div style="text-align:center;color:var(--text-muted);padding:20px;">还没有应用</div>');
      return;
    }

    el.innerHTML = apps.map(a => {
      // token 正常一定有（创建时由 generateAppToken 生成）。但 rowToApp 不再
      // fallback 成 AUTH_TOKEN，空值必须优雅处理 —— 否则会拼出一个
      // `http://host/hook/null` 这种看着像能用、实际是废的 URL
      const webhookUrl = a.token ? `${location.origin}/hook/${a.token}` : '';
      const iconHtml = a.image
        ? `<img src="${escapeHtml(a.image)}" alt="" onerror="this.replaceWith(ICON_APP)">`
        : ICON_APP;

      const isDefault = a.id === 1;
      const chName = state.channels.find(c => c.id === a.channelId)?.name || chatzT('默认频道');

      return `
        <div class="app-manage-item" data-id="${a.id}">
          <div class="app-manage-head">
            <div class="app-manage-icon">${iconHtml}</div>
            <div class="app-manage-info">
              <div class="app-manage-name">
                ${escapeHtml(a.name)}
                ${isDefault ? chatzT('<span class="tag-default">默认</span>') : ''}
              </div>
              <div class="app-manage-desc">
                ${escapeHtml(a.description || chatzT('无描述'))} ${chatzT('· 发到')} ${escapeHtml(chName)}
              </div>
            </div>
          </div>
          <div class="app-manage-section">
            <div class="app-manage-label">Webhook URL</div>
            <div class="app-manage-url">
              <code title="${escapeHtml(webhookUrl)}">${escapeHtml(webhookUrl)}</code>
              <button class="copy-webhook" title="${chatzT('复制')}">${ICON_COPY}</button>
            </div>
          </div>
          <div class="app-manage-actions">
            <button class="app-edit">${chatzT('编辑')}</button>
            <button class="app-upload-icon">${chatzT('换图标')}</button>
            ${!isDefault ? chatzT('<button class="app-delete danger">删除</button>') : ''}
          </div>
        </div>
      `;
    }).join('');

    el.querySelectorAll('.app-manage-item').forEach(item => {
      const id = parseInt(item.dataset.id, 10);
      const a = apps.find(x => x.id === id);

      item.querySelector('.copy-webhook').onclick = () => {
        if (!a.token) { toast(chatzT('这个应用没有 Token，无法复制')); return; }
        const url = `${location.origin}/hook/${a.token}`;
        navigator.clipboard.writeText(url).then(() => toast(chatzT('已复制 Webhook URL')));
      };

      item.querySelector('.app-edit').onclick = () => openAppEditor(a);

      item.querySelector('.app-upload-icon').onclick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = async () => {
          const file = input.files[0];
          if (!file) return;
          try {
            const res = await fetch(`/application/${id}/icon`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${state.token}`,
                'Content-Type': file.type || 'image/png',
              },
              body: file,
            });
            if (!res.ok) throw new Error(chatzT('上传失败'));
            await loadAppManageList();
            await loadApps();
            toast(chatzT('图标已更新'));
          } catch (e) {
            toast(e.message || chatzT('上传失败'));
          }
        };
        input.click();
      };

      const delBtn = item.querySelector('.app-delete');
      if (delBtn) {
        delBtn.onclick = () => deleteApp(id, a.name);
      }
    });
  } catch (e) {
    toast(e.message || chatzT('加载失败'));
  }
}

function openAppEditor(app) {
  editingAppId = app ? app.id : null;
  $('#appEditTitle').textContent = app ? chatzT('编辑应用') : chatzT('新建应用');
  $('#appName').value = app ? app.name : '';
  $('#appDesc').value = app ? (app.description || '') : '';
  $('#appIconFile').value = '';
  $('#appIconPreview').innerHTML = '';

  // 填充频道下拉框
  const sel = $('#appChannel');
  sel.innerHTML = state.channels.map(c =>
    `<option value="${c.id}">${escapeHtml(c.name)} (ID:${c.id})</option>`
  ).join('');
  if (app && app.channelId) {
    sel.value = app.channelId;
  }

  $('#appManageModal').classList.add('hidden');
  $('#appEditModal').classList.remove('hidden');
  setTimeout(() => $('#appName').focus(), 50);
}

async function saveApp() {
  const name = $('#appName').value.trim();
  if (!name) { toast(chatzT('名称不能为空')); return; }

  const description = $('#appDesc').value.trim();
  const channel_id = parseInt($('#appChannel').value, 10);
  const file = $('#appIconFile').files[0];

  const payload = {
    name,
    description: description || null,
    channel_id,
  };

  try {
    let created;
    if (editingAppId) {
      created = await api(`/application/${editingAppId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    } else {
      created = await api('/application', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }

    // 上传图标（如果有）
    if (file && created && created.id) {
      await fetch(`/application/${created.id}/icon`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${state.token}`,
          'Content-Type': file.type || 'image/png',
        },
        body: file,
      });
    }

    $('#appEditModal').classList.add('hidden');
    $('#appManageModal').classList.remove('hidden');
    await loadAppManageList();
    await loadApps();
    toast(editingAppId ? chatzT('已保存') : chatzT('已创建'));
  } catch (e) {
    toast(e.message || chatzT('保存失败'));
  }
}

async function deleteApp(id, name) {
  if (!confirm(chatzT('删除应用「{0}」及其所有消息？', [name]))) return;
  try {
    const r = await api(`/application/${id}`, { method: 'DELETE' });
    await loadAppManageList();
    await loadApps();
    await loadMessages();
    toast(chatzT('已删除（连带 {0} 条消息）', [r.deletedMessages || 0]));
  } catch (e) {
    toast(e.message || chatzT('删除失败'));
  }
}

// ============ 侧栏 ============

function openSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (!sidebar || !overlay) return;
  sidebar.classList.add('open');
  overlay.classList.add('visible');
}

function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (!sidebar || !overlay) return;
  sidebar.classList.remove('open');
  overlay.classList.remove('visible');
}

function closeSidebarOnMobile() {
  if (window.innerWidth <= 900) closeSidebar();
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  if (sidebar.classList.contains('open')) closeSidebar();
  else openSidebar();
}

function closeModalAnimated(modal) {
  if (!modal) return;
  modal.classList.add('closing');
  setTimeout(() => {
    modal.classList.add('hidden');
    modal.classList.remove('closing');
  }, 150);
}

/**
 * 给一个 modal 挂上「点遮罩空白处关闭」的行为。
 *
 * ⚠️ 不能用 click 事件！这是踩过的坑：
 *
 * 浏览器派发 click 时，比较的是 mousedown 和 mouseup 的**共同祖先**。
 * 用户在设置页的输入框里按下鼠标（mousedown 的 target 是 input），
 * 拖着移到弹窗外、在遮罩上松开（mouseup 的 target 是 .modal 遮罩），
 * 两者的共同祖先正好就是遮罩本身 ⇒ click 事件的 target === 遮罩
 * ⇒ 被误判成「点了遮罩」，设置页啪地关掉。选文字、拖滚动条时都会中招。
 *
 * 正确做法是 mousedown / mouseup 配对判断：
 * **只有「在遮罩上按下」且「在遮罩上松开」才算真要关闭**。
 * 这样从输入框里拖出来的松开动作会被忽略，同时保留了
 * 「在遮罩上按下、移到窗口外再松开」应该不关闭的语义（符合直觉）。
 */
function bindModalBackdropClose(modal) {
  if (!modal) return;
  let downOnBackdrop = false;

  modal.addEventListener('mousedown', (e) => {
    // 只在遮罩自身上按下才算数（点弹窗内容不算）
    downOnBackdrop = (e.target === modal);
  });

  modal.addEventListener('mouseup', (e) => {
    const shouldClose = downOnBackdrop && e.target === modal;
    downOnBackdrop = false;
    if (shouldClose) closeModalAnimated(modal);
  });

  // 鼠标在遮罩上按下后移出窗口、在窗口外松开：浏览器不会派发 mouseup，
  // 状态会一直留着 —— 下次进弹窗随便点一下就误关。所以离开时清掉。
  modal.addEventListener('mouseleave', () => { downOnBackdrop = false; });
}

// ============ 启动 ============

async function start() {
  hideLogin();
  setConnStatus('disconnected');

  // 背景（以及随之而来的毛玻璃）**必须排在最前面**：它决定整个界面的观感，
  // 不能挂在 loadMessages 那串 await 后面 —— 否则界面早就渲染出来了，
  // 用户会先看到一版没有模糊的界面，过一会儿才「啪」地变模糊。
  // 这里先拿本地缓存的 URL 立刻铺上（图片通常已在浏览器缓存里，几乎是瞬时的），
  // 后面 loadBackgroundStatus 再用服务端的真实状态校正一次。
  const cachedBg = localStorage.getItem('chatz_bg_url');
  if (cachedBg) applyBackground(cachedBg);

  await loadCurrentUser();
  await loadApps();
  await loadChannels();
  await loadUnreadCounts();
  await loadMessages();
  applyBackgroundSettings();
  await loadBackgroundStatus();
  connectWS();

  // 「应用」「路由规则」对**所有登录用户**开放（不再按 isAdmin 隐藏）：
  // 两者都已按用户隔离，每人只看得到自己创建的。
  const rulesBtn = document.getElementById('rulesBtn');
  if (rulesBtn) rulesBtn.style.display = '';
  const appsBtn = document.getElementById('appsBtn');
  if (appsBtn) appsBtn.style.display = '';

  // ⚠️ 这里必须显式调一次：refreshUserMgmtVisibility 除了「用户管理」，
  //    还负责超管的「管理」入口显隐。它原来只在「打开设置面板」时才被调用，
  //    于是登录后「管理」按钮要等用户点一下设置再关掉才冒出来。放在
  //    loadCurrentUser() 之后（state.currentUser 已就绪）调，才能一次到位。
  refreshUserMgmtVisibility();
}




// ============ 昵称编辑 ============

function startEditUserName() {
  const nameEl = document.getElementById('userName');
  const editEl = document.getElementById('userNameEdit');
  const input = document.getElementById('userNameInput');
  if (!nameEl || !editEl || !input) return;

  input.value = state.currentUser?.displayName || state.currentUser?.username || '';
  nameEl.classList.add('hidden');
  editEl.classList.remove('hidden');
  input.focus();
  input.select();

  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveUserName();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEditUserName();
    }
  };

  input.onblur = () => {
    // blur 时延迟一下，避免 Enter 触发的 blur 覆盖保存
    setTimeout(() => {
      if (!editEl.classList.contains('hidden')) {
        saveUserName();
      }
    }, 100);
  };
}

async function saveUserName() {
  const editEl = document.getElementById('userNameEdit');
  const input = document.getElementById('userNameInput');
  const nameEl = document.getElementById('userName');
  if (!editEl || !input) return;

  const newName = input.value.trim();
  const oldName = state.currentUser?.displayName || state.currentUser?.username || '';

  // 没变或空 → 直接取消
  if (!newName || newName === oldName) {
    cancelEditUserName();
    return;
  }

  try {
    const res = await api('/user/profile', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: newName }),
    });
    state.currentUser = res.user;

    if (nameEl) {
      nameEl.textContent = newName;
      nameEl.classList.remove('hidden');
    }
    editEl.classList.add('hidden');

    updateUserMini();
    updateAvatarDisplay(state.currentUser.avatar, newName.charAt(0).toUpperCase());
    toast(chatzT('昵称已更新'));
  } catch (e) {
    toast(e.message || chatzT('保存失败'));
    cancelEditUserName();
  }
}

async function changePassword() {
  const newEl = document.getElementById('pwdNew');
  const confirmEl = document.getElementById('pwdNew2');
  const revokeEl = document.getElementById('pwdRevoke');
  if (!newEl) return;

  const newPassword = newEl.value;
  const confirmPassword = confirmEl ? confirmEl.value : newPassword;

  if (newPassword.length < 6) { toast(chatzT('新密码至少 6 位')); return; }
  if (newPassword !== confirmPassword) { toast(chatzT('两次输入的新密码不一致')); return; }

  try {
    const res = await api('/user/password', {
      method: 'PATCH',
      body: JSON.stringify({
        new_password: newPassword,
        revokeDevices: !!(revokeEl && revokeEl.checked),
      }),
    });

    newEl.value = '';
    if (confirmEl) confirmEl.value = '';
    if (revokeEl) revokeEl.checked = false;

    const n = res.revokedDevices || 0;
    toast(n > 0 ? chatzT('密码已更新，{0} 台设备已下线', [n]) : chatzT('密码已更新'));
  } catch (e) {
    toast(e.message || chatzT('修改失败'));
  }
}

function cancelEditUserName() {
  const nameEl = document.getElementById('userName');
  const editEl = document.getElementById('userNameEdit');
  if (nameEl) nameEl.classList.remove('hidden');
  if (editEl) editEl.classList.add('hidden');
}

async function saveUsername() {
  const input = document.getElementById('accountUsernameInput');
  if (!input) return;
  const username = input.value.trim();

  // 前端先做一遍同样的校验，省一次往返 —— 后端仍会再校验一次，这里只是体验优化
  if (username.length < 2 || username.length > 32) {
    toast(chatzT('用户名长度需要 2-32 个字符'));
    return;
  }
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(username)) {
    toast(chatzT('用户名只能包含字母、数字和 _ - .'));
    return;
  }

  const btn = document.getElementById('saveUsernameBtn');
  btn.disabled = true;
  try {
    const res = await api('/user/username', {
      method: 'PATCH',
      body: JSON.stringify({ username }),
    });
    if (state.currentUser) state.currentUser.username = res.user.username;

    // 名字可能出现在三个地方，都要刷新：
    //   1. 侧边栏/顶部的迷你头像（updateUserMini）
    //   2. 设置弹窗标题（#userName，只在没设昵称时等于 username）
    //   3. 设置弹窗副标题的 @handle（#userSub）
    updateUserMini();
    if (state.currentUser) {
      const u = state.currentUser;
      const name = u.displayName || u.username;
      const nameEl = document.getElementById('userName');
      const subEl = document.getElementById('userSub');
      if (nameEl) nameEl.textContent = name;
      if (subEl) subEl.textContent = '@' + u.username + (u.isAdmin ? chatzT(' · 管理员') : '');
    }

    toast(chatzT('用户名已更新'));
  } catch (e) {
    toast(e.message || chatzT('保存失败'));
  } finally {
    btn.disabled = false;
  }
}

async function saveEmail() {
  const input = document.getElementById('emailInput');
  if (!input) return;
  const email = input.value.trim();
  const btn = document.getElementById('saveEmailBtn');
  btn.disabled = true;
  try {
    const res = await api('/user/email', {
      method: 'PATCH',
      body: JSON.stringify({ email }),
    });
    if (state.currentUser) state.currentUser.email = res.user.email;
    toast(email ? chatzT('邮箱已更新') : chatzT('邮箱已清空'));
  } catch (e) {
    toast(e.message || chatzT('保存失败'));
  } finally {
    btn.disabled = false;
  }
}

// ============ 用户头像 ============

function updateAvatarDisplay(avatarUrl, letter) {
  const img = document.getElementById('userAvatarImg');
  const span = document.getElementById('userAvatarLetter');
  const removeBtn = document.getElementById('userAvatarRemove');
  if (!img || !span) return;
  if (avatarUrl) {
    img.src = avatarUrl;
    img.style.display = 'block';
    span.style.display = 'none';
    img.onerror = () => {
      img.style.display = 'none';
      span.style.display = 'block';
    };
    if (removeBtn) removeBtn.classList.remove('hidden');
  } else {
    img.style.display = 'none';
    img.removeAttribute('src');
    span.style.display = 'block';
    span.textContent = letter;
    if (removeBtn) removeBtn.classList.add('hidden');
  }
}

async function uploadUserAvatar() {
  const file = document.getElementById('userAvatarFile')?.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast(chatzT('图片太大（限 5MB）')); return; }

  try {
    const res = await fetch('/user/avatar', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${state.token}`,
        'Content-Type': file.type || 'image/jpeg',
      },
      body: file,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || chatzT('上传失败'));
    }
    const data = await res.json();

    if (state.currentUser) state.currentUser.avatar = data.avatar;

    const name = state.currentUser?.displayName || state.currentUser?.username || '?';
    updateAvatarDisplay(data.avatar, name.charAt(0).toUpperCase());
    updateUserMini();

    const inp = document.getElementById('userAvatarFile');
    if (inp) inp.value = '';
    const nameEl = document.getElementById('userAvatarFile-name');
    if (nameEl) {
      nameEl.textContent = chatzT('未选择');
      nameEl.classList.remove('has-file');
    }

    toast(chatzT('头像已更新'));
  } catch (e) {
    toast(e.message || chatzT('上传失败'));
  }
}

async function removeUserAvatar() {
  if (!confirm(chatzT('移除头像？'))) return;
  try {
    await api('/user/avatar', { method: 'DELETE' });
    if (state.currentUser) state.currentUser.avatar = null;
    const name = state.currentUser?.displayName || state.currentUser?.username || '?';
    updateAvatarDisplay(null, name.charAt(0).toUpperCase());
    updateUserMini();
    toast(chatzT('头像已移除'));
  } catch (e) {
    toast(e.message || chatzT('操作失败'));
  }
}

// ============ 自定义背景 ============

// ------------------------------------------------------------
// 动态主题色（M3 的思路：从背景图里取一个 seed color 当主题色）
// ------------------------------------------------------------

const ACCENT_FROM_BG_KEY = 'chatz_accent_from_bg';

function accentFromBgEnabled() {
  return localStorage.getItem(ACCENT_FROM_BG_KEY) !== '0';
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0, s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

/**
 * 从背景图里挑主色调（色相 + 该色域的真实饱和 / 亮度）
 *
 * ⚠️ 下面两个坑都实测踩过，别改回去：
 *
 *  1. **不要按 RGB 分桶。** 同一片色域的深浅变化会被拆进不同桶，谁都凑不够面积，
 *     结果被一小块高饱和区域、或者一片高光抢走主色。实测一张粉紫背景图，
 *     RGB 桶选中的是 `#e9d3d7` 这种高光浅粉，占比才 12.8%，根本不是主调。
 *     改成按**色相**聚类（每 15° 一档），同一片色域会归拢到一起，
 *     选出来的才是画面真正的主调（那张图是 232° 蓝紫，占 11.2%）。
 *
 *  2. **不要只回传色相然后套死饱和/亮度。** 那样柔和浅色的图会被硬提成艳丽高饱和 ——
 *     同一张图的浅粉 `#e9d3d7` 就是这么变成玫红 `#b85161` 的。
 *     这里把该色域的**实际**饱和/亮度一并返回，由 buildAccentPalette 做轻度收束。
 *
 * 近黑 / 近白 / 灰色像素一律跳过，否则深色背景取到一团黑、浅色背景取到一片白。
 */
function extractDominantColor(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        // 缩到 64x64 再采样：几千像素足够统计，也不卡主线程
        const size = 64;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;

        const HUE_BUCKETS = 24; // 每 15° 一档
        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          if (max < 24 || max > 246 || max - min < 14) continue;

          const [h, s, l] = rgbToHsl(r, g, b);
          if (l < 0.12 || l > 0.94) continue; // 极端明暗对"主色调"没有代表性

          const key = Math.floor(h * HUE_BUCKETS) % HUE_BUCKETS;
          let acc = buckets.get(key);
          if (!acc) { acc = { n: 0, sat: 0, light: 0 }; buckets.set(key, acc); }
          acc.n++;
          acc.sat += s;
          acc.light += l;
        }

        if (buckets.size === 0) { reject(new Error(chatzT('这张图没有明显的彩色像素'))); return; }

        let best = null, bestKey = 0;
        for (const [k, acc] of buckets) {
          if (!best || acc.n > best.n) { best = acc; bestKey = k; }
        }
        resolve({
          hue: (bestKey + 0.5) / HUE_BUCKETS, // 取桶中心，避免落在分档边界上
          sat: best.sat / best.n,
          light: best.light / best.n,
        });
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error(chatzT('背景图加载失败')));
    img.src = url;
  });
}

/**
 * 由主色调生成一套 accent
 *
 * 关键：**沿用源色域的实际饱和 / 亮度**，只做上下限收束 —— 这是让主题色"像背景"的原因。
 * 上下限只兜极端情况：太灰的图不至于取出一团灰、太亮的图不至于白字压不住。
 * 亮度再按主题平移一档（暗底要更亮才看得清）。
 */
function buildAccentPalette(src) {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const hue = Math.round(src.hue * 360);
  const sat = Math.round(Math.min(0.72, Math.max(src.sat, 0.28)) * 100);

  const srcLight = src.light * 100;
  const light = isDark
    ? Math.round(Math.min(74, Math.max(srcLight, 62)))
    : Math.round(Math.min(62, Math.max(srcLight, 50)));

  return {
    accent: `hsl(${hue}, ${sat}%, ${light}%)`,
    accentHover: `hsl(${hue}, ${sat}%, ${light - 8}%)`,
    accentSoft: `hsla(${hue}, ${sat}%, ${light}%, 0.12)`,
  };
}

function setAccentVars(p) {
  const s = document.documentElement.style;
  s.setProperty('--accent', p.accent);
  s.setProperty('--accent-hover', p.accentHover);
  s.setProperty('--accent-soft', p.accentSoft);
}

/** 清掉内联变量，回落到 style.css 里定义的默认色 */
function clearAccentVars() {
  const s = document.documentElement.style;
  s.removeProperty('--accent');
  s.removeProperty('--accent-hover');
  s.removeProperty('--accent-soft');
}

// 正在计算中的缓存 key：见 applyAccentFromBackground 里的去重说明
let accentPendingKey = null;

async function applyAccentFromBackground(url) {
  if (!accentFromBgEnabled() || !url) { clearAccentVars(); return; }

  // 缓存：像素遍历不便宜，同一张图 + 同一个主题只算一次。
  // key 里带算法版本号：取色算法改过之后，旧缓存必须失效，
  // 否则老用户不换背景图就永远看不到新结果。
  const theme = document.documentElement.getAttribute('data-theme') || 'light';
  const cacheKey = `chatz_accent:v2:${theme}:${url}`;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) { setAccentVars(JSON.parse(cached)); return; }
  } catch {}

  // 换背景时会被连着触发两次（uploadBackground 自己调一次，
  // 紧接着 loadBackgroundStatus 又调一次）。同一个 key 正在算就跳过，
  // 否则 8MB 的大图要白白解码两遍。
  if (accentPendingKey === cacheKey) return;
  accentPendingKey = cacheKey;

  try {
    const src = await extractDominantColor(url);
    const palette = buildAccentPalette(src);
    setAccentVars(palette);
    try { localStorage.setItem(cacheKey, JSON.stringify(palette)); } catch {}
  } catch (e) {
    console.warn(chatzT('[主题色] 取色失败，沿用默认色：'), e.message);
    clearAccentVars();
  } finally {
    if (accentPendingKey === cacheKey) accentPendingKey = null;
  }
}

function applyBackgroundSettings() {
  const blur = parseInt(localStorage.getItem('chatz_bg_blur') || '0', 10);
  const dim = parseInt(localStorage.getItem('chatz_bg_dim') || '20', 10);

  document.documentElement.style.setProperty('--bg-blur', blur + 'px');
  document.documentElement.style.setProperty('--bg-dim', (dim / 100).toString());

  if ($('#bgBlur')) {
    $('#bgBlur').value = blur;
    $('#bgBlurVal').textContent = blur + 'px';
  }
  if ($('#bgDim')) {
    $('#bgDim').value = dim;
    $('#bgDimVal').textContent = dim + '%';
  }
}

async function loadBackgroundStatus() {
  try {
    const s = await api('/background');
    const el = $('#bgStatus');
    if (s.enabled) {
      el.textContent = chatzT('已设置 · ') + new Date(s.uploadedAt).toLocaleString();
      applyBackground(s.url);
    } else {
      el.textContent = chatzT('未设置（使用默认光斑背景）');
      applyBackground(null);
    }
  } catch {
    const el = $('#bgStatus');
    if (el) el.textContent = chatzT('加载失败');
  }
}

// 已经铺过的背景 URL（见 applyBackground 里的去重说明）
let appliedBgUrl = null;

function applyBackground(url) {
  // 同一个 URL 会被连续应用两次：start() 先用本地缓存铺上，
  // loadBackgroundStatus 紧接着又拿服务端结果调一次。
  // 内容完全一样，没必要重复设背景变量、重复起解码探针、重复取色。
  if (url && url === appliedBgUrl) return;
  appliedBgUrl = url;

  if (url) {
    try { localStorage.setItem('chatz_bg_url', url); } catch {}

    // ⚠️ 毛玻璃状态**立刻生效**，不等图片解码。
    //
    // 之前是先解码、铺完背景再启用毛玻璃，结果"启用"这个动作本身
    // 就让卡片底色从 0.92 跳到 0.68（外加模糊），用户看到的就是一次深浅变化。
    // 只要存在启用时刻就躲不掉，所以改成就让它从第一帧起就是毛玻璃。
    // 代价：图片没解码完的那会儿会模糊到默认光斑层 —— 通常只有一两帧，
    // 而且光斑也是浅色渐变，观感很接近，几乎察觉不到。
    document.body.classList.add('has-bg-image');

    // 图片解码好再铺，这样背景是一次到位出现的，不会先空白后补图
    const probe = new Image();
    const commit = async () => {
      // 确保图片真的可绘制了再往下走（onload 之后 decode 通常直接返回）
      try { await probe.decode(); } catch {}

      // 这一次不要任何淡入过渡（.bg-layer 和 ::before 两层都掐掉，见 style.css），
      // 否则背景会分两次到位
      document.body.classList.add('bg-no-fade');
      document.documentElement.style.setProperty('--bg-image', `url("${url}")`);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.body.classList.remove('bg-no-fade');
      }));
    };
    probe.onload = commit;
    probe.onerror = commit;
    probe.src = url;

    applyAccentFromBackground(url);
  } else {
    document.documentElement.style.removeProperty('--bg-image');
    document.body.classList.remove('has-bg-image');
    document.body.classList.remove('bg-no-fade');
    try { localStorage.removeItem('chatz_bg_url'); } catch {}
    clearAccentVars();
  }
}

async function uploadBackground() {
  const file = $('#bgFile')?.files[0];
  if (!file) { toast(chatzT('请先选择图片')); return; }
  if (file.size > 8 * 1024 * 1024) { toast(chatzT('图片太大（限 8MB）')); return; }

  try {
    const res = await fetch('/background', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${state.token}`,
        'Content-Type': file.type || 'image/jpeg',
      },
      body: file,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || chatzT('上传失败'));
    }
    const data = await res.json();
    $('#bgFile').value = '';
    applyBackground(data.url);
    await loadBackgroundStatus();
    toast(chatzT('背景已更新'));
  } catch (e) {
    toast(e.message || chatzT('上传失败'));
  }
}

async function deleteBackground() {
  if (!confirm(chatzT('移除背景图？'))) return;
  try {
    await api('/background', { method: 'DELETE' });
    applyBackground(null);
    await loadBackgroundStatus();
    toast(chatzT('背景已移除'));
  } catch {
    toast(chatzT('操作失败'));
  }
}

function bindBackgroundSliders() {
  const blurEl = $('#bgBlur');
  const dimEl = $('#bgDim');

  if (blurEl) {
    blurEl.addEventListener('input', () => {
      const v = parseInt(blurEl.value, 10);
      $('#bgBlurVal').textContent = v + 'px';
      document.documentElement.style.setProperty('--bg-blur', v + 'px');
    });
    blurEl.addEventListener('change', () => {
      localStorage.setItem('chatz_bg_blur', blurEl.value);
    });
  }

  if (dimEl) {
    dimEl.addEventListener('input', () => {
      const v = parseInt(dimEl.value, 10);
      $('#bgDimVal').textContent = v + '%';
      document.documentElement.style.setProperty('--bg-dim', (v / 100).toString());
    });
    dimEl.addEventListener('change', () => {
      localStorage.setItem('chatz_bg_dim', dimEl.value);
    });
  }

  bindAccentToggle();
  bindImageBottomToggle();
}

/** 主题色开关：关掉就回落到 style.css 里的默认色 */
function bindAccentToggle() {
  const el = $('#bgAccentEnabled');
  if (!el) return;
  el.checked = accentFromBgEnabled();
  el.addEventListener('change', () => {
    localStorage.setItem(ACCENT_FROM_BG_KEY, el.checked ? '1' : '0');
    if (el.checked) applyAccentFromBackground(localStorage.getItem('chatz_bg_url'));
    else clearAccentVars();
  });
}

// 图片置底 —— 与客户端的 image_as_background 同名，**默认关闭**
const IMAGE_BOTTOM_KEY = 'chatz_image_bottom';

function imageBottomEnabled() {
  return localStorage.getItem(IMAGE_BOTTOM_KEY) === '1';
}

/**
 * 图片置底开关
 *
 * ⚠️ 置底是在**渲染卡片时**决定的（renderCard 里摘图），所以改完开关
 *    必须重新渲染一遍消息列表才看得见效果，光改 localStorage 没用。
 */
function bindImageBottomToggle() {
  const el = $('#imageBottomEnabled');
  if (!el) return;
  el.checked = imageBottomEnabled();
  el.addEventListener('change', () => {
    localStorage.setItem(IMAGE_BOTTOM_KEY, el.checked ? '1' : '0');
    toast(el.checked ? chatzT('已开启图片置底') : chatzT('已关闭图片置底'));
    renderMessages();
  });
}


// ============ 文件选择器通用绑定 ============

function bindFileInput(id) {
  const input = document.getElementById(id);
  if (!input) return;
  const nameEl = document.getElementById(id + '-name');
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (nameEl) {
      nameEl.textContent = file ? file.name : chatzT('未选择');
      nameEl.classList.toggle('has-file', !!file);
    }
  });
}

function bindAllFileInputs() {
  ['chIconFile', 'appIconFile', 'certCrtFile', 'certKeyFile', 'bgFile', 'userAvatarFile'].forEach(bindFileInput);
}

document.addEventListener('DOMContentLoaded', () => {
  applyTheme();

  $$('.auth-tab').forEach(t => t.onclick = () => switchAuthTab(t.dataset.tab));
  $('#loginBtn').onclick = doLogin;
  $('#tokenLoginBtn').onclick = doTokenLogin;
  $('#registerBtn').onclick = doRegister;

  $('#loginPassword').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('#loginToken').addEventListener('keydown', e => { if (e.key === 'Enter') doTokenLogin(); });
  $('#regPassword2').addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });

  $('#setupBtn').onclick = doSetup;
  $('#setupPassword2').addEventListener('keydown', e => { if (e.key === 'Enter') doSetup(); });
  $('#setupToLoginBtn').onclick = () => {
    $('#setupView').classList.add('hidden');
    $('#setupError').textContent = '';
    showLogin();
  };

  $('#forgotLinkBtn').onclick = showForgot;
  $('#forgotSubmitBtn').onclick = doForgotPassword;
  $('#forgotBackBtn').onclick = showLogin;
  $('#forgotEmail')?.addEventListener('keydown', e => { if (e.key === 'Enter') doForgotPassword(); });
  $('#resetBtn').onclick = doResetPassword;
  $('#resetToLoginBtn').onclick = showLogin;
  $('#resetPassword2')?.addEventListener('keydown', e => { if (e.key === 'Enter') doResetPassword(); });

  $('#themeToggle').onclick = toggleTheme;
  $('#userMini').onclick = openUserModal;
  $('#settingsBack').onclick = () => showSettingsPage(null);
  document.querySelectorAll('#settingsHome .settings-item').forEach(btn => {
    btn.onclick = () => showSettingsPage(btn.dataset.page);
  });
  $('#logoutBtn').onclick = doLogout;
  $('#addDeviceBtn').onclick = addDevice;
  $('#changePwdBtn').onclick = changePassword;
  $('#saveEmailBtn').onclick = saveEmail;
  $('#saveUsernameBtn').onclick = saveUsername;
  $('#accountUsernameInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') saveUsername(); });
  $('#pwdNew2')?.addEventListener('keydown', e => { if (e.key === 'Enter') changePassword(); });
  const userNameEl = document.getElementById('userName');
  if (userNameEl) userNameEl.addEventListener('click', startEditUserName);
  $('#userAvatarFile').addEventListener('change', uploadUserAvatar);

  const userAvatarEl = document.getElementById('userAvatar');
  if (userAvatarEl) {
    userAvatarEl.addEventListener('click', (e) => {
      // 点移除按钮时不触发
      if (e.target.closest('#userAvatarRemove')) return;
      document.getElementById('userAvatarFile')?.click();
    });
  }

  const removeBtn = document.getElementById('userAvatarRemove');
  if (removeBtn) {
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeUserAvatar();
    });
  }
  $('#certUploadBtn').onclick = uploadCert;
  $('#bgUploadBtn').onclick = uploadBackground;
  $('#bgDeleteBtn').onclick = deleteBackground;
  bindBackgroundSliders();
  applyBackgroundSettings();
  $('#certDeleteBtn').onclick = deleteCert;

  $('#sendBtn').onclick = openSendModal;
  $('#newChannelBtn').onclick = openChannelModal;
  $('#hamburgerBtn').onclick = toggleSidebar;
  $('#sidebarOverlay').onclick = closeSidebar;
  $('#discoverBtn').onclick = openDiscoverModal;
  // 发现频道搜索：按名字/ID，防抖 300ms
  let discoverSearchTimer = null;
  $('#discoverSearch').oninput = (e) => {
    clearTimeout(discoverSearchTimer);
    discoverSearchTimer = setTimeout(() => loadDiscoverList(e.target.value), 300);
  };
  $('#appsBtn').onclick = openAppManageModal;
  $('#adminBtn').onclick = openAdminModal;
  document.querySelectorAll('#adminTabs .admin-tab').forEach(b => {
    b.onclick = () => loadAdminList(b.dataset.tab);
  });
  $('#newAppBtn').onclick = () => openAppEditor(null);
  $('#appSaveBtn').onclick = saveApp;
  $('#rulesBtn').onclick = openRouteModal;
  $('#newRouteBtn').onclick = () => openRouteEditor(null);
  $('#templateBtn').onclick = openTemplateModal;
  $('#addConditionBtn').onclick = () => {
    editingConditions.push({ key: 'priority_gte', value: 8 });
    renderRuleRows('#rtConditions', editingConditions, CONDITION_TYPES, 'condition');
  };
  $('#addActionBtn').onclick = () => {
    editingActions.push({ key: 'add_tag', value: 'urgent' });
    renderRuleRows('#rtActions', editingActions, ACTION_TYPES, 'action');
  };
  $('#rtSaveBtn').onclick = saveRoute;
  $('#markAllReadBtn').onclick = markAllRead;

  $$('.close-modal').forEach(b => {
    b.onclick = () => closeModalAnimated(b.closest('.modal'));
  });

  $('#sendSubmit').onclick = submitSend;
  $('#chSubmit').onclick = submitChannel;

  $('#chIconFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    const preview = $('#chIconPreview');
    if (!file) { preview.innerHTML = ''; return; }
    preview.innerHTML = `<img src="${URL.createObjectURL(file)}" alt=""><span>${escapeHtml(file.name)}</span>`;
  });

  // 「管理频道」弹窗（右键菜单 → 管理频道）
  $('#chEditSubmit').onclick = submitChannelEdit;
  $('#chEditPwdClear').onclick = markChannelPwdClear;
  bindChannelEditIcon();

  // 受保护频道的订阅密码框
  $('#passwordSubmit').onclick = submitPasswordSubscribe;

  $$('.tab').forEach(t => t.onclick = () => switchView(t.dataset.view));
  // 点遮罩关闭：用 mousedown/mouseup 配对，不能用 click
  // （click 会把「在输入框按下、拖到遮罩上松开」误判成点遮罩，详见函数注释）
  $$('.modal').forEach(m => bindModalBackdropClose(m));

  document.addEventListener('click', closeCtxMenu);
  document.addEventListener('scroll', closeCtxMenu, true);

  bindSearch();
  bindKeyboardShortcuts();

  if (state.token) {
    start().catch(() => showLogin());
  } else {
    // 带 ?token= 进来的 = 从「忘记密码」的重置链接点进来，优先显示重置页
    const urlToken = new URLSearchParams(location.search).get('token');
    if (urlToken) { showReset(urlToken); return; }
    // 全新安装要先走首次引导，其它情况回登录页
    checkSetupOrLogin();
  }
});

// 切语言后重画：i18n.js 只负责静态 HTML 与属性；侧栏 / 消息列表 / 弹窗内容
// 是 JS 拼出来的，得重新渲染才会跟着变。
window.addEventListener('chatz:langchange', () => {
  const rerender = [
    'renderChannels', 'renderTagBanner', 'renderMessages',
    'updateUserMini', 'updateEmptyState', 'refreshUserMgmtVisibility'
  ];
  for (const name of rerender) {
    const fn = window[name];
    if (typeof fn === 'function') {
      try { fn(); } catch (e) { /* 单个画失败不该连累其它 */ }
    }
  }

  // 设置弹窗：静态部分由 i18n 翻，但设备列表 / 证书状态 / 用户列表 / 背景状态
  // 都是 JS 渲染的，得把当前子页重开一次才会跟着变。
  const modal = document.getElementById('userModal');
  if (modal && !modal.classList.contains('hidden')) {
    try { showSettingsPage(state.settingsPage); } catch (e) {}
  }
});
