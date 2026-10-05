/* ============================================================================
 * Chatz 网页端中英切换
 * ==========================================================================
 *
 * 设计要点（改之前先看，别踩回去）：
 *
 * 1. **key 就是中文原文**。chatzT('保存') 在英文下查表得 'Save'，查不到就原样返回中文。
 *    好处：不用发明 key、不会漏、没翻的地方自然退化成中文，界面永远能用。
 *
 * 2. **JS 里能翻的都在 app.js 里显式包了 chatzT()**（脚本批量做的），
 *    这个文件只负责：
 *      · 静态 HTML（index.html 里的文本节点 / title / placeholder / aria-label）
 *      · 语言切换后重画的通知（chatz:langchange）
 *
 * 3. **绝不用 MutationObserver 去扫全文翻译**。
 *    消息列表里是**用户内容**（频道名、消息正文），运行时替换会把别人的消息改掉。
 *    实测过这条路，放弃。
 *
 * 4. PHRASES 是长尾兜底：只用于静态 HTML 里没进 EN 表的碎片，按长度降序替换。
 *
 * 5. 语言来源优先级：localStorage → navigator.language → 中文。
 *    用户浏览器是中文就还是中文，想看英文点侧栏那个「EN」。
 * ========================================================================== */
(function () {
  'use strict';

  var LS_KEY = 'chatz_lang';
  var HAN = /[\u4e00-\u9fff]/;

  // ── 精确匹配表 ────────────────────────────────────────────
  var EN = {
    // ---- 登录 / 注册 / 初始化 ----
    '登录': 'Sign in',
    '注册': 'Sign up',
    '或': 'or',
    '用户名': 'Username',
    '密码': 'Password',
    '粘贴 Token': 'Paste token',
    '用 Token 登录': 'Sign in with token',
    '忘记密码？': 'Forgot password?',
    '输入注册时填的邮箱。重置链接会写到服务日志里，管理员用': 'Enter the email you signed up with. The reset link is written to the server log; the admin can read it using',
    '查看。': '.',
    '邮箱': 'Email',
    '获取重置链接': 'Get reset link',
    '返回登录': 'Back to sign in',
    '用户名（2-32 位）': 'Username (2-32 chars)',
    '昵称（可选）': 'Nickname (optional)',
    '邮箱（可选）': 'Email (optional)',
    '密码（至少 6 位）': 'Password (at least 6 chars)',
    '确认密码': 'Confirm password',
    '初始化 Chatz': 'Initialize Chatz',
    '看起来是全新安装。给管理员账号设个用户名和密码，设置完就可以直接开始用。': 'This looks like a fresh install. Set a username and password for the admin account, then you are ready to go.',
    '这一步只会开放这一次。': 'This step is offered only once.',
    '邮箱（可选，用于找回密码）': 'Email (optional, used for password recovery)',
    '创建管理员': 'Create admin',
    '我已经拿到管理员 Token，直接登录': 'I already have an admin token, sign me in',
    '重置密码': 'Reset password',
    '新密码（6-128 位）': 'New password (6-128 chars)',
    '确认新密码': 'Confirm new password',
    '修改密码': 'Change password',
    '请填写用户名和密码': 'Enter username and password',
    '请输入用户名和密码': 'Enter username and password',
    '两次密码不一致': 'Passwords do not match',
    '密码至少 6 位': 'Password must be at least 6 chars',
    '正在创建…': 'Creating…',
    '正在提交…': 'Submitting…',
    '正在修改…': 'Saving…',
    '初始化失败': 'Initialization failed',
    '请输入邮箱': 'Enter your email',
    '已提交，请查看服务日志': 'Submitted. Check the server log',
    '请求失败：': 'Request failed: ',
    '链接已被使用过': 'This link has already been used',
    '链接已过期': 'This link has expired',
    '链接无效': 'This link is invalid',
    '，请重新申请': ', please request a new one',
    '请输入新密码': 'Enter a new password',
    '新密码至少 6 位': 'New password must be at least 6 chars',
    '两次输入的新密码不一致': 'The two new passwords do not match',
    '重置失败': 'Reset failed',
    '密码已修改，请重新登录': 'Password changed. Please sign in again',
    '登录失败': 'Sign-in failed',
    '请输入 Token': 'Enter a token',
    'Token 无效': 'Invalid token',
    'Token 无效或服务器不可达': 'Invalid token or server unreachable',
    '请填写完整': 'Please fill in everything',
    '注册失败': 'Sign-up failed',
    '登录状态已失效，请重新登录': 'Your session has expired. Please sign in again',
    '退出登录': 'Sign out',
    '退出登录？': 'Sign out?',

    // ---- 侧栏 / 顶栏 ----
    '切换主题': 'Toggle theme',
    '切换语言': 'Switch language',
    '菜单': 'Menu',
    '+ 新建频道': '+ New channel',
    '发现频道': 'Discover',
    '应用': 'Apps',
    '路由规则': 'Routing rules',
    '管理': 'Admin',
    '全部已读': 'Mark all read',
    '所有频道': 'All channels',
    '所有消息': 'All messages',
    '收件箱': 'Inbox',
    '未读': 'Unread',
    '收藏': 'Archived',
    '取消收藏': 'Unarchive',
    '搜索消息... ( / )': 'Search messages... ( / )',
    '发送消息': 'Send message',
    '连接中...': 'Connecting...',
    '已连接': 'Connected',
    '连接断开': 'Disconnected',
    '加载中...': 'Loading...',
    '加载失败': 'Load failed',
    '加载失败：': 'Load failed: ',
    '更多操作': 'More actions',
    '加载中': 'Loading',

    // ---- 消息卡片 ----
    '刚刚': 'just now',
    ' 分钟前': ' min ago',
    ' 小时前': ' hr ago',
    '展开全文': 'Expand',
    '收起': 'Collapse',
    '点击收起': 'Click to collapse',
    '点击展开合并的消息': 'Click to expand merged messages',
    '以下为已读消息': 'Everything below is read',
    '<div class="unread-divider">以下为已读消息</div>': '<div class="unread-divider">Everything below is read</div>',
    '无标题': 'Untitled',
    '标未读': 'Mark as unread',
    '标已读': 'Mark as read',
    '标为未读': 'Mark as unread',
    '标为已读': 'Mark as read',
    '删除': 'Delete',
    '确定删除这条消息？': 'Delete this message?',
    '已删除': 'Deleted',
    '删除失败': 'Delete failed',
    '操作失败': 'Operation failed',
    '内容不能为空': 'Content cannot be empty',
    '已发送': 'Sent',
    '发送失败': 'Send failed',
    '优先级': 'Priority',
    '优先级 ': 'Priority ',
    '<span class="msg-sender-admin">管理员</span>': '<span class="msg-sender-admin">Admin</span>',
    '<span class="msg-readonly" title="别人的频道，只能查看">只读</span>': '<span class="msg-readonly" title="Someone else\u2019s channel, view only">Read only</span>',
    '别人的频道，只能查看': 'Someone else\u2019s channel, view only',
    '只读': 'Read only',
    '筛选此标签': 'Filter by this tag',
    '<span class="msg-app-tag tag-clickable" data-tag="{0}" title="筛选此标签">#{1}</span>': '<span class="msg-app-tag tag-clickable" data-tag="{0}" title="Filter by this tag">#{1}</span>',
    '引用的消息': 'Quoted message',
    '复制内容': 'Copy content',
    '复制标题 + 内容': 'Copy title + content',
    '已复制': 'Copied',
    '<kbd>j</kbd><kbd>k</kbd> 导航 · <kbd>r</kbd> 已读 · <kbd>d</kbd> 删除 · <kbd>/</kbd> 搜索 · <kbd>n</kbd> 新消息': '<kbd>j</kbd><kbd>k</kbd> move · <kbd>r</kbd> read · <kbd>d</kbd> delete · <kbd>/</kbd> search · <kbd>n</kbd> new message',
    '已读 {0} 条': 'Marked {0} as read',
    '清除标签筛选': 'Clear tag filter',
    '标签筛选': 'Tag filter',
    '清除筛选': 'Clear filter',
    '没有未读消息': 'No unread messages',
    '没有收藏消息': 'No archived messages',
    '这个频道还没有消息': 'This channel has no messages yet',
    '还没有消息': 'No messages yet',
    '发送第一条消息': 'Send the first message',
    '搜索失败：': 'Search failed: ',
    '未知错误': 'Unknown error',
    '未知': 'Unknown',

    // ---- 频道 ----
    '新建频道': 'New channel',
    '管理频道': 'Manage channel',
    '删除频道': 'Delete channel',
    '删除频道「{0}」及其所有消息？': 'Delete channel \u201c{0}\u201d and all its messages?',
    '频道已删除': 'Channel deleted',
    '频道已创建': 'Channel created',
    '频道已更新': 'Channel updated',
    '名称': 'Name',
    '频道名称': 'Channel name',
    '名称不能为空': 'Name cannot be empty',
    '创建': 'Create',
    '创建失败': 'Create failed',
    '保存': 'Save',
    '保存失败': 'Save failed',
    '取消': 'Cancel',
    '发送': 'Send',
    '描述': 'Description',
    '描述（可选）': 'Description (optional)',
    '无描述': 'No description',
    '图标': 'Icon',
    '图标（上传本地图片）': 'Icon (upload a local image)',
    '图标（可选）': 'Icon (optional)',
    '选择图标': 'Choose icon',
    '点击更换图标': 'Click to change the icon',
    '换图标': 'Change icon',
    '移除图标': 'Remove icon',
    '图标已更新': 'Icon updated',
    '图标已移除': 'Icon removed',
    '图标上传失败': 'Icon upload failed',
    '上传失败': 'Upload failed',
    '图片太大（限 5MB）': 'Image too large (max 5MB)',
    '图片太大（限 8MB）': 'Image too large (max 8MB)',
    '移除「{0}」的图标？': 'Remove the icon of \u201c{0}\u201d?',
    '未选择': 'Nothing selected',
    '允许其他人订阅': 'Allow others to subscribe',
    '订阅': 'Subscribe',
    '已订阅': 'Subscribed',
    '取消订阅': 'Unsubscribe',
    '取消订阅「{0}」？': 'Unsubscribe from \u201c{0}\u201d?',
    '已取消订阅': 'Unsubscribed',
    '订阅失败': 'Subscribe failed',
    '静音': 'Mute',
    '取消静音': 'Unmute',
    '已静音': 'Muted',
    '已取消静音': 'Unmuted',
    '需要密码': 'Password required',
    '需密码': 'Password required',
    ' <span class="ch-id" title="订阅需要密码">需密码</span>': ' <span class="ch-id" title="Password required to subscribe">Password</span>',
    '订阅需要密码': 'Password required to subscribe',
    '输入密码才能订阅该频道': 'Enter the password to subscribe to this channel',
    '频道密码': 'Channel password',
    '请输入密码': 'Enter the password',
    '订阅密码（可选，设置后订阅需输入）': 'Subscription password (optional; required when subscribing)',
    '留空则不修改': 'Leave blank to keep it unchanged',
    '清除密码': 'Clear password',
    '已标记清除（点保存生效）': 'Marked for removal (takes effect after saving)',
    '频道密码需 4-64 位': 'Channel password must be 4-64 chars',
    '网络异常，请重试': 'Network error, please retry',
    '稍后再试（{0}s）': 'Try again in {0}s',
    '「{0}」设置了订阅密码，输入后才能订阅': '\u201c{0}\u201d is password protected. Enter the password to subscribe',
    '<div style="text-align:center;color:var(--text-muted);padding:20px;">没有公开频道</div>': '<div style="text-align:center;color:var(--text-muted);padding:20px;">No public channels</div>',

    // ---- 设置 ----
    '设置': 'Settings',
    '账户': 'Account',
    '外观': 'Appearance',
    '安全与登录': 'Security & sign-in',
    '用户管理': 'Users',
    'HTTPS 证书': 'HTTPS certificate',
    '返回': 'Back',
    '点击修改昵称': 'Click to edit the nickname',
    '昵称': 'Nickname',
    '点击更换头像': 'Click to change the avatar',
    '换头像': 'Change avatar',
    '移除头像': 'Remove avatar',
    '移除头像？': 'Remove the avatar?',
    '头像已更新': 'Avatar updated',
    '头像已移除': 'Avatar removed',
    '昵称已更新': 'Nickname updated',
    '用户名已更新': 'Username updated',
    '邮箱已更新': 'Email updated',
    '邮箱已清空': 'Email cleared',
    '密码已更新': 'Password updated',
    '密码已更新，{0} 台设备已下线': 'Password updated, {0} device(s) signed out',
    '修改失败': 'Change failed',
    '用户名长度需要 2-32 个字符': 'Username must be 2-32 chars',
    '用户名只能包含字母、数字和 _ - .': 'Username may only contain letters, digits and _ - .',
    '登录时用的名字，全局唯一，不能和别人重复。只能包含字母、数字和 _ - .，2-32 位。': 'The name you sign in with. Globally unique. Letters, digits and _ - . only, 2-32 chars.',
    '未设置邮箱': 'No email set',
    '请填写邮箱地址，在「忘记密码」时使用': 'Enter an email address; it is used for \u201cForgot password\u201d',
    '登出其他设备': 'Sign out other devices',
    '登录设备': 'Devices',
    '+ 新增设备': '+ Add device',
    '设备名称': 'Device name',
    '我的手机': 'My phone',
    '添加失败': 'Add failed',
    '删除该设备？该设备将无法再连接。': 'Delete this device? It will no longer be able to connect.',
    '设备已删除': 'Device deleted',
    '删除设备': 'Delete device',
    '更换这枚 Token（旧值立即失效）': 'Replace this token (the old one stops working immediately)',
    '<button class="icon-btn device-rotate" title="更换这枚 Token（旧值立即失效）">{0}</button>': '<button class="icon-btn device-rotate" title="Replace this token (the old one stops working immediately)">{0}</button>',
    '注销这台设备（等于删除它这枚 Token）': 'Sign out this device (deletes its token)',
    '<button class="icon-btn device-logout" title="注销这台设备（等于删除它这枚 Token）">{0}</button>': '<button class="icon-btn device-logout" title="Sign out this device (deletes its token)">{0}</button>',
    '<button class="icon-btn device-del" data-id="{0}" title="删除设备">{1}</button>': '<button class="icon-btn device-del" data-id="{0}" title="Delete device">{1}</button>',
    '更换这枚 Token？\n\n旧的值会立即失效，别的设备如果用着它会需要重新登录。': 'Replace this token?\n\nThe old value stops working right away; other devices using it will have to sign in again.',
    '更换失败：没拿到新 Token': 'Replace failed: no new token returned',
    '更换失败': 'Replace failed',
    'Token 已更换（旧值已失效）': 'Token replaced (old value no longer works)',
    '注销这台设备？\n\n这枚 Token 会立即失效并被删除，之后需要用别的凭据重新登录。': 'Sign out this device?\n\nIts token will be invalidated and deleted; you will need another credential to sign in again.',
    '主密钥': 'Master key',
    '<span class="tag-current">主密钥</span>': '<span class="tag-current">Master key</span>',
    // ⚠️ 这两条 key **带前导空格**（app.js 里就是 chatzT(' <span…>')）。
    //    差一个空格就查不到，别顺手 trim。
    ' <span class="tag-current">主密钥</span>': ' <span class="tag-current">Master key</span>',
    '主密钥，无法删除（要更换请换掉 AUTH_TOKEN 本身）': 'Master key, cannot be deleted (rotate AUTH_TOKEN itself to replace it)',
    // 旧文案（已改）：'主密钥，无法删除（要换请在 .env 里改 AUTH_TOKEN）'
    '主密钥，无法删除（要换请在 .env 里改 AUTH_TOKEN）': 'Master key, cannot be deleted (change AUTH_TOKEN in .env instead)',
    '当前': 'Current',
    '<span class="tag-current">当前</span>': '<span class="tag-current">Current</span>',
    ' <span class="tag-current">当前</span>': ' <span class="tag-current">Current</span>',
    '未命名': 'Unnamed',
    '「{0}」的': '\u201c{0}\u2019s ',
    '已复制{0}完整 Token': 'Copied {0}full token',
    '复制{0}Token 到设备上使用（当前为明文 HTTP，建议配好 HTTPS）：': 'Copy the {0}token to your device (currently plain HTTP; setting up HTTPS is recommended):',
    // ── 设备 Token 二次验证 ──
    // v1.2.1：完整值不再随设备列表下发（只主密钥那一行）
    // 2026-10-05：**每一行**都不下发了 —— 拿明文一律要验一次当前账号的密码
    '指纹 {0}…': 'Fingerprint {0}\u2026',
    '验证密码后复制': 'Verify your password to copy',
    '查看 Token': 'View token',
    '当前密码': 'Current password',
    '登录密码': 'Login password',
    '验证并复制': 'Verify and copy',
    '请输入当前密码': 'Enter your current password',
    '没拿到 Token': 'Token not returned',
    '验证失败': 'Verification failed',
    'Token 是长期凭据，复制后请妥善保管。请输入当前登录账号的密码以继续。':
      'A token is a long-lived credential \u2014 store it safely once copied. Enter the password of the account you are signed in with to continue.',
    '后台图、主题色、图片位置': 'Background image, accent color, image position',
    '背景图、主题色、图片位置': 'Background image, accent color, image position',
    '界面背景': 'Interface background',
    '上传背景图（png / jpg / webp，最大 8MB）': 'Upload a background image (png / jpg / webp, max 8MB)',
    '选择图片': 'Choose image',
    '请先选择图片': 'Choose an image first',
    '模糊': 'Blur',
    '暗度': 'Dim',
    '用背景图的颜色作为主题色': 'Use the background image\u2019s color as the accent',
    '上传背景': 'Upload background',
    '移除背景': 'Remove background',
    '移除背景图？': 'Remove the background image?',
    '背景已更新': 'Background updated',
    '背景已移除': 'Background removed',
    '背景图加载失败': 'Failed to load the background image',
    '这张图没有明显的彩色像素': 'This image has no obvious colored pixels',
    '[主题色] 取色失败，沿用默认色：': '[Accent] Failed to pick a color, using the default: ',
    '已设置 · ': 'Set · ',
    '未设置（使用默认光斑背景）': 'Not set (using the default gradient background)',
    '消息显示': 'Message display',
    '图片置底': 'Image at the bottom',
    '已开启图片置底': 'Image-at-bottom enabled',
    '已关闭图片置底': 'Image-at-bottom disabled',
    '提升 / 降级管理员': 'Promote / demote admins',
    '角色 0 = 普通用户 · 1 = 管理员（只管应用和路由规则，': 'Role 0 = User · 1 = Admin (manages own apps and routing rules, ',
    '看不到': 'cannot see',
    '未订阅的私有频道）· 2 = 超级管理员（全知 + 能提升他人）。': 'private channels they are not subscribed to) · 2 = Super admin (sees everything + can promote others).',
    '你不能改自己的角色；系统会保证至少留一个超级管理员。': 'You cannot change your own role; the system always keeps at least one super admin.',
    '不能修改自己的角色': 'You cannot change your own role',
    '把「{0}」的角色改成「{1}」？': 'Change the role of \u201c{0}\u201d to \u201c{1}\u201d?',
    '角色已更新': 'Role updated',
    ' · 管理员': ' · Admin',
    '普通用户': 'User',
    '管理员': 'Admin',
    '超级管理员': 'Super admin',

    // ---- 证书 ----
    '内置 HTTPS 与证书管理': 'Built-in HTTPS and certificate management',
    '证书': 'Certificate',
    '私钥': 'Private key',
    '证书文件 (fullchain.pem / .crt)': 'Certificate file (fullchain.pem / .crt)',
    '选择证书': 'Choose certificate',
    '私钥文件 (privkey.pem / .key)': 'Private key file (privkey.pem / .key)',
    '选择私钥': 'Choose private key',
    '上传证书': 'Upload certificate',
    '删除证书': 'Delete certificate',
    '请同时选择证书文件和私钥文件': 'Select both the certificate and the private key',
    '证书上传失败': 'Certificate upload failed',
    '私钥上传失败': 'Private key upload failed',
    '证书已上传并生效': 'Certificate uploaded and active',
    '证书已删除': 'Certificate deleted',
    '删除证书？删除后 HTTPS 将不可用（需重启容器完全生效）。': 'Delete the certificate? HTTPS will stop working (a container restart is needed for a full cleanup).',
    '已启用': 'Enabled',
    '已禁用': 'Disabled',
    '<span style="color:#22c55e;">已启用</span>': '<span style="color:#22c55e;">Enabled</span>',
    '访问地址 <a href="{0}" target="_blank" style="color:var(--accent);text-decoration:none;">{1}</a>': 'Address <a href="{0}" target="_blank" style="color:var(--accent);text-decoration:none;">{1}</a>',
    '有效期至 ': 'Valid until ',
    '<span style="color:#f59e0b;">证书链不完整（可能只有叶证书）</span>': '<span style="color:#f59e0b;">Incomplete certificate chain (maybe leaf only)</span>',
    '<span style="color:#f59e0b;">还缺 ': '<span style="color:#f59e0b;">Still missing ',
    ' 和 ': ' and ',
    '<span style="color:var(--text-muted);">未配置（仅 HTTP）</span>': '<span style="color:var(--text-muted);">Not configured (HTTP only)</span>',

    // ---- 管理（全站） ----
    '管理（全站）': 'Admin (all)',
    '搜索频道名或 ID': 'Search channel name or ID',
    '<div class="admin-empty">没有数据</div>': '<div class="admin-empty">No data</div>',
    '<div class="admin-empty">加载失败：{0}</div>': '<div class="admin-empty">Load failed: {0}</div>',
    '没有用户': 'No users',
    '归属：': 'Owner: ',
    '公开': 'Public',
    '私有': 'Private',
    ' · 有密码': ' · password protected',
    '· 频道': '· channel',
    '启用': 'Enabled',
    '停用': 'Disabled',
    '禁用': 'Disable',
    '· 优先级': '· priority',

    // ---- 路由规则 ----
    '+ 新建规则': '+ New rule',
    '新建规则': 'New rule',
    '编辑规则': 'Edit rule',
    '从模板创建': 'Create from template',
    '从模板创建规则': 'Create a rule from a template',
    '从模板创建：': 'Create from template: ',
    '规则名称，如：紧急升级': 'Rule name, e.g. urgent-escalation',
    '规则排序（越大越先执行，范围 0-100）': 'Sort order (higher runs first, 0-100)',
    // 注意：'启用' 上面「管理」段里已经有了，这里别再加（对象字面量重名键）
    '条件（全部满足才触发）': 'Conditions (all must match)',
    '+ 添加条件': '+ Add condition',
    '动作（按顺序执行）': 'Actions (run in order)',
    '+ 添加动作': '+ Add action',
    '规则按排序值从大到小依次执行。前面的规则改了消息内容，后面的规则会看到修改后的结果。': 'Rules run from the highest sort value down. If an earlier rule changes the message, later rules see the changed version.',
    '<div style="text-align:center;color:var(--text-muted);padding:20px;">还没有规则</div>': '<div style="text-align:center;color:var(--text-muted);padding:20px;">No rules yet</div>',
    '条件：': 'Conditions: ',
    '动作：': 'Actions: ',
    '编辑': 'Edit',
    '测试': 'Test',
    '删除规则「{0}」？': 'Delete rule \u201c{0}\u201d?',
    '输入测试消息内容：': 'Enter the test message content:',
    '输入优先级：': 'Enter a priority:',
    '服务器挂了': 'Server is down',
    '命中：{0}\n': 'Matched: {0}\n',
    '丢弃：{0}\n': 'Dropped: {0}\n',
    '静默：{0}\n': 'Silent: {0}\n',
    '最终优先级：{0}\n': 'Final priority: {0}\n',
    '最终标签：{0}': 'Final tags: {0}',
    '是': 'yes',
    '否': 'no',
    '无': 'none',
    '<code>无</code>': '<code>none</code>',
    '测试失败': 'Test failed',
    '已保存': 'Saved',
    '加载模板失败': 'Failed to load templates',
    '值': 'Value',
    '<input type="{0}" value="{1}" placeholder="值">': '<input type="{0}" value="{1}" placeholder="Value">',
    '优先级 ≥': 'Priority ≥',
    '优先级 ≤': 'Priority ≤',
    '优先级 =': 'Priority =',
    '内容匹配（正则）': 'Body matches (regex)',
    '标题匹配（正则）': 'Title matches (regex)',
    '频道名 =': 'Channel name =',
    '频道 ID =': 'Channel ID =',
    '来源应用 =': 'Source app =',
    '时间段': 'Time window',
    '包含标签': 'Contains tag',
    '设为优先级': 'Set priority',
    '加标签': 'Add tag',
    '移除标签': 'Remove tag',
    '静默': 'Silent',
    '转发到频道 ID': 'Forward to channel ID',
    '加前缀': 'Add prefix',
    '调用 Webhook': 'Call webhook',
    '丢弃消息': 'Drop message',

    // ---- 应用 ----
    '应用管理': 'Applications',
    '每个应用是一个消息来源身份，拥有独立的 Webhook Token。第三方（GitHub、Uptime Kuma 等）通过 Webhook URL 向 Chatz 推送消息。': 'Each app is a message source identity with its own webhook token. Third parties (GitHub, Uptime Kuma, …) push messages to Chatz through the webhook URL.',
    '+ 新建应用': '+ New app',
    '新建应用': 'New app',
    '编辑应用': 'Edit app',
    '如：GitHub': 'e.g. GitHub',
    '如：GitHub 通知': 'e.g. GitHub notifications',
    '默认发到频道': 'Default channel',
    '默认频道': 'Default channel',
    '<span class="tag-default">默认</span>': '<span class="tag-default">Default</span>',
    '· 发到': '· sends to',
    '复制': 'Copy',
    '<div style="text-align:center;color:var(--text-muted);padding:20px;">还没有应用</div>': '<div style="text-align:center;color:var(--text-muted);padding:20px;">No apps yet</div>',
    '<button class="app-delete danger">删除</button>': '<button class="app-delete danger">Delete</button>',
    '这个应用没有 Token，无法复制': 'This app has no token, nothing to copy',
    '已复制 Webhook URL': 'Webhook URL copied',
    '已创建': 'Created',
    '删除应用「{0}」及其所有消息？': 'Delete app \u201c{0}\u201d and all its messages?',
    '已删除（连带 {0} 条消息）': 'Deleted (along with {0} messages)',

    // ---- 发送弹窗 ----
    '频道': 'Channel',
    '标题（可选）': 'Title (optional)',
    '消息标题': 'Message title',
    '内容（支持 Markdown）': 'Content (Markdown supported)',
    '**加粗** *斜体*': '**bold** *italic*',
    '0 - 最低': '0 - Lowest',
    '3 - 低': '3 - Low',
    '5 - 普通': '5 - Normal',
    '8 - 高': '8 - High',
    '10 - 紧急': '10 - Urgent',
    '当前频道': 'this channel',
    '「{0}」中': 'in \u201c{0}\u201d',
    '{0}没有带 #{1} 标签的消息': '{0}has no messages tagged #{1}',
    '没有匹配「{0}」的消息': 'No messages matching \u201c{0}\u201d',

    // ---- 只出现在静态 HTML 里、且被 <b>/<br> 切成碎片的几段 ----
    // ⚠️ 这几条必须进精确表：DOM 遍历只认精确匹配（见 domExact 的说明），
    //    靠 phrases 兜底的话它们在英文模式下会保持中文。
    '修改密码、登录设备': 'Change password, signed-in devices',
    '未订阅的私有频道）·': 'private channels they are not subscribed to) \u00b7',
    '2 = 超级管理员（全知 + 能提升他人）。': '2 = super admin (sees everything + can promote others).'
  };

  // ── 长尾兜底：只用于静态 HTML 里没进 EN 表的碎片 ────────────
  // 按长度降序替换，避免短的先吃掉长的。
  var PHRASES = [
    ['输入注册时填的邮箱。', 'Enter the email you signed up with.'],
    ['重置链接会写到服务日志里，管理员用', 'The reset link is written to the server log; the admin can read it using'],
    ['管理员用', 'the admin can read it using'],
    ['只管应用和路由规则，', 'manages own apps and routing rules, '],
    ['未订阅的私有频道', 'private channels they are not subscribed to'],
    ['全知 + 能提升他人', 'sees everything + can promote others'],
    ['至少留一个超级管理员', 'always keeps at least one super admin'],
    ['登录设备', 'Devices'],
    ['新增设备', 'Add device'],
    ['登出其他设备', 'Sign out other devices'],
    ['修改密码', 'Change password'],
    ['搜索频道名或 ID', 'Search channel name or ID'],
    ['还没有规则', 'No rules yet'],
    ['还没有应用', 'No apps yet'],
    ['没有公开频道', 'No public channels'],
    ['加载中...', 'Loading...'],
    ['加载失败', 'Load failed'],
    ['更多操作', 'More actions'],
    ['所有频道', 'All channels'],
    ['全部已读', 'Mark all read'],
    ['发现频道', 'Discover'],
    ['路由规则', 'Routing rules'],
    ['发送消息', 'Send message'],
    ['收件箱', 'Inbox'],
    ['未读', 'Unread'],
    ['收藏', 'Archived'],
    ['需密码', 'Password required'],
    ['订阅', 'Subscribe'],
    ['已订阅', 'Subscribed'],
    ['主密钥', 'Master key'],
    ['当前', 'Current'],
    ['未命名', 'Unnamed'],
    ['无标题', 'Untitled'],
    ['无描述', 'No description'],
    ['未知', 'Unknown'],
    ['公开', 'Public'],
    ['私有', 'Private'],
    ['有密码', 'password protected'],
    ['归属：', 'Owner: '],
    ['条件：', 'Conditions: '],
    ['动作：', 'Actions: '],
    ['命中：', 'Matched: '],
    ['丢弃：', 'Dropped: '],
    ['静默：', 'Silent: '],
    ['最终优先级：', 'Final priority: '],
    ['最终标签：', 'Final tags: '],
    ['优先级', 'Priority'],
    ['频道', 'Channel'],
    ['编辑', 'Edit'],
    ['测试', 'Test'],
    ['启用', 'Enabled'],
    ['停用', 'Disabled'],
    ['禁用', 'Disable'],
    ['默认', 'Default'],
    ['换图标', 'Change icon'],
    ['换头像', 'Change avatar'],
    ['是', 'yes'],
    ['否', 'no']
  ];

  var LANG = 'zh';

  /** 按指定语言翻译（不依赖当前 LANG —— 回溯「上一次翻成了什么」要用） */
  function tTo(s, lang) {
    if (lang === 'zh') return s;
    return Object.prototype.hasOwnProperty.call(EN, s) ? EN[s] : phrases(s);
  }

  /**
   * 🔴 DOM 遍历专用：只认 EN 精确词条，不走 phrases 片段兜底。
   *
   * 为什么不能在这儿用 phrases：片段表里有一批 2 字通用词
   * （是→yes / 否→no / 频道→Channel / 未读→Unread ...），
   * 一旦拿去做子串替换，**用户的中文消息正文会被改写** ——
   * 「备份是否完成」会变成「备份yesno完成」。
   * 精确匹配只在整段文字恰好等于某个界面词条时才命中，误伤面小到可以接受。
   * （app.js 里显式写的 chatzT('...') 仍然走 phrases —— 那是开发者主动包的自家文案。）
   */
  function domExact(s, lang) {
    if (lang === 'zh' || !s) return s;
    return Object.prototype.hasOwnProperty.call(EN, s) ? EN[s] : s;
  }

  /** 文本节点的渲染：保留首尾空白，只翻中间那段 */
  function renderText(orig, lang) {
    var core = orig.trim();
    if (!core) return orig;
    return orig.replace(core, domExact(core, lang));
  }

  // 🔴 用户内容跳过区：标了 data-i18n-skip 的容器里全是用户数据
  //    （频道名 / 消息正文 / 用户名 / 设备名 / 标签 ...），一个字都不许翻。
  var SKIP_ATTR = 'data-i18n-skip';

  function inSkipZone(node) {
    var p = node.parentNode;
    while (p && p.nodeType === 1) {
      if (p.hasAttribute && p.hasAttribute(SKIP_ATTR)) return true;
      p = p.parentNode;
    }
    return false;
  }

  // 英→中反查表：应用就地改成的值如果是我们翻出去的英文，能反推回中文原文
  // （app.js 里所有文案都是 chatzT() 产出的，所以这一步命中率很高）
  var REV_EN = Object.create(null);
  (function () {
    for (var k in EN) {
      if (!Object.prototype.hasOwnProperty.call(EN, k)) continue;
      var v = EN[k];
      if (typeof v !== 'string' || !v) continue;
      if (HAN.test(v)) continue;            // 译文里还夹中文的不做反查
      if (REV_EN[v] === undefined) REV_EN[v] = k;   // 撞车取第一个
    }
  })();

  /**
   * 对账：memo 是上次记下的中文原文，cur 是节点里现在的值。
   * 返回「应该拿去当 key 的原文」。
   *   - cur 没变                     → 沿用 memo
   *   - cur 正是我们上次翻出去的样子 → 沿用 memo（正常往返）
   *   - 否则说明应用改了值           → 认新值当原文（能反查就反查成中文）
   */
  function reconcile(memoVal, cur, render) {
    if (memoVal === undefined) return cur;
    if (memoVal === cur) return memoVal;
    var other = (LANG === 'zh') ? 'en' : 'zh';
    if (render(memoVal, other) === cur) return memoVal;
    var back = REV_EN[cur];
    if (back && HAN.test(back)) return back;
    return cur;
  }

  function applyVars(s, vars) {
    if (!vars) return s;
    return String(s).replace(/\{(\w+)\}/g, function (m, k) {
      var v = Array.isArray(vars) ? vars[parseInt(k, 10)] : vars[k];
      return (v === undefined || v === null) ? m : String(v);
    });
  }

  function phrases(s) {
    for (var i = 0; i < PHRASES.length; i++) {
      if (s.indexOf(PHRASES[i][0]) >= 0) {
        s = s.split(PHRASES[i][0]).join(PHRASES[i][1]);
      }
    }
    return s;
  }

  /** 翻译入口：中文原文当 key，查不到就按片段替换，再不行原样返回中文 */
  function chatzT(s, vars) {
    if (s === null || s === undefined) return s;
    s = String(s);
    if (LANG === 'zh') return applyVars(s, vars);
    var out = tTo(s, 'en');
    return applyVars(out, vars);
  }

  var ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

  // 🔴 原文备忘录。
  //    翻译是**就地改写** DOM 的：中文 → 英文之后，节点里只剩英文。
  //    再用 chatzT() 去翻它是翻不回中文的（中文模式下 t(s) 直接返回 s）。
  //    所以第一次见到就记住中文原文，之后永远拿原文当 key —— 这样来回切才可逆，
  //    不用刷新页面（2026-10-05 实测：不记原文就「切英文实时、切回中文要刷新」）。
  var ORIG_TEXT = new WeakMap();   // 文本节点 → 原始 nodeValue
  var ORIG_ATTR = new WeakMap();   // 元素     → { attr名: 原始值 }

  function translateEl(el) {
    if (!el || el.nodeType !== 1) return;
    var memo = ORIG_ATTR.get(el);
    if (!memo) { memo = {}; ORIG_ATTR.set(el, memo); }
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!el.hasAttribute(a)) continue;
      var cur = el.getAttribute(a);
      // 🔴 不能「第一次见到就锁死」：应用之后可能就地改这个值
      //    （比如未读按钮从「标已读」变「标未读」），锁死就会把旧翻译写回去。
      //    所以每次都要跟当前值对一次账。
      memo[a] = reconcile(memo[a], cur, domExact);
      var src = memo[a];
      // 原文不是中文 → 多半是用户数据或代码后设的值，不碰
      if (!src || !HAN.test(src)) continue;
      var out = domExact(src, LANG);
      if (out !== cur) el.setAttribute(a, out);
    }
  }

  function translateTree(root) {
    if (!root) return;

    // ⚠️ 这里**不能**先筛「含中文的节点」：翻成英文后节点里就没中文了，
    //    下一轮（切回中文）会被筛掉，永远翻不回去。所以要遍历全部文本节点。
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var node, buf = [];
    while ((node = walker.nextNode())) buf.push(node);

    buf.forEach(function (n) {
      if (inSkipZone(n)) return;              // 用户内容，一律不碰
      // 同上：值可能已被应用改过，每次都要对账，不能锁死第一次见到的
      var src = reconcile(ORIG_TEXT.get(n), n.nodeValue, renderText);
      ORIG_TEXT.set(n, src);
      if (!src || !HAN.test(src)) return;        // 原文不含中文 = 用户数据，跳过
      var core = src.trim();
      if (!core) return;
      var target = src.replace(core, domExact(core, LANG));
      if (target !== n.nodeValue) n.nodeValue = target;
    });

    // 属性
    if (root.nodeType === 1 && !inSkipZone(root)) translateEl(root);
    if (root.querySelectorAll) {
      var els = root.querySelectorAll('*');
      for (var i = 0; i < els.length; i++) {
        if (!inSkipZone(els[i])) translateEl(els[i]);
      }
    }
  }

  function applyDom() {
    translateTree(document.body);
    updateToggle();
  }

  // 🔴 语言按钮不止一个：登录页 / 引导页 / 重置页 / 侧栏各有一个。
  //    以前只认 #langToggle，结果登录前（全新用户第一屏）根本切不了语言。
  var LANG_BTN_SEL = '.lang-toggle';

  function updateToggle() {
    var btns = document.querySelectorAll(LANG_BTN_SEL);
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      // 按钮上写的是「切过去的那一种语言」
      btn.textContent = (LANG === 'zh') ? 'EN' : '中';
      btn.title = (LANG === 'zh') ? 'Switch to English' : '切换为中文';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  function setLang(l, quiet) {
    l = (l === 'en') ? 'en' : 'zh';
    LANG = l;
    try { localStorage.setItem(LS_KEY, l); } catch (e) {}
    document.documentElement.lang = (l === 'en') ? 'en' : 'zh-CN';
    applyDom();
    if (!quiet) {
      // 让 app.js 重画 JS 拼出来的部分（侧栏 / 消息列表 / 弹窗）
      try { window.dispatchEvent(new CustomEvent('chatz:langchange', { detail: { lang: l } })); } catch (e) {}
    }
  }

  function detectLang() {
    var saved = null;
    try { saved = localStorage.getItem(LS_KEY); } catch (e) {}
    if (saved === 'en' || saved === 'zh') return saved;
    var nav = (navigator.language || navigator.userLanguage || 'zh').toLowerCase();
    return (/^en\b/.test(nav)) ? 'en' : 'zh';
  }

  function bindToggle() {
    var btns = document.querySelectorAll(LANG_BTN_SEL);
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        setLang(LANG === 'zh' ? 'en' : 'zh');
      });
    }
  }

  // ── 启动 ────────────────────────────────────────────────
  LANG = detectLang();
  document.documentElement.lang = (LANG === 'en') ? 'en' : 'zh-CN';

  window.chatzT = chatzT;
  window.chatzI18n = {
    t: chatzT,
    getLang: function () { return LANG; },
    setLang: setLang,
    applyDom: applyDom
  };

  function boot() {
    bindToggle();
    applyDom();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
