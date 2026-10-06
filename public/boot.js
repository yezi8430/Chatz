// index.html 里原本是两段内联 <script>，为了让 CSP 能关掉 'unsafe-inline'
// （否则 CSP 对 XSS 基本等于没设防）把它们外置到这里。
//
// 加载位置固定在 <body> 开头、同步执行 —— 和原来的内联脚本时机一致：
// 背景必须赶在首屏渲染前设好，不然会闪一下白底。

// ---------- 明暗主题预置 ----------
// 和背景同理：data-theme 要是等 app.js 的 applyTheme() 才设，深色用户会先看到
// 一版浅色界面再「啪」地变暗。
//
// 这里读的是 localStorage 缓存。真正的真值在服务端（GET /user/settings），
// 登录后由 start() 里的 loadUserSettings 校正 —— 缓存只是为了让首屏不闪。
(function () {
  try {
    var theme = localStorage.getItem('chatz_theme');
    if (theme === 'dark' || theme === 'light') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } catch (e) {}
})();

// ---------- 背景预置（必须在 body 一开始就跑） ----------
(function () {
  try {
    var url = localStorage.getItem('chatz_bg_url');
    if (url) {
      var blur = localStorage.getItem('chatz_bg_blur') || '0';
      var dim = localStorage.getItem('chatz_bg_dim') || '20';
      document.documentElement.style.setProperty('--bg-image', 'url("' + url + '")');
      document.documentElement.style.setProperty('--bg-blur', blur + 'px');
      document.documentElement.style.setProperty('--bg-dim', (parseInt(dim, 10) / 100).toString());
      document.body.classList.add('has-bg-image');
    }
  } catch (e) {}
})();

// ---------- 首屏过渡 ----------
document.addEventListener('DOMContentLoaded', function () {
  document.body.classList.add('ready');
  // 延迟启用 backdrop-filter，等浏览器空闲后编译着色器
  setTimeout(function () {
    document.body.classList.add('blur-ready');
  }, 100);
});
