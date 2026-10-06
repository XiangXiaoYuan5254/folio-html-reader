// ============================================================
// 发布配置 —— 每次发版或部署时只改这里
// ============================================================

const RELEASE = {
  version: '0.16.0',
  date: '2026.10.06',
};

// 各平台安装包的下载地址和大小。安装包放在 website/downloads/，随官网一起部署到自己的服务器。
// url 留空时，对应的下载按钮显示为“即将开放下载”且不可点击，不会给访客死链。
const DOWNLOADS = {
  mac: { url: 'downloads/Folio-0.16.0-mac-arm64.dmg', size: '130 MB' },
  win: { url: 'downloads/Folio-0.16.0-win-x64-setup.exe', size: '116 MB' },
};

// 页脚的“意见反馈”邮箱。留空则不显示。
const FEEDBACK_EMAIL = '';

// 备案通过后填写，例如 '沪ICP备2026000000号-1'、'沪公网安备31000000000000号'。留空则不显示。
const ICP_NUMBER = '';
const POLICE_NUMBER = '';

// ============================================================

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// 版本信息
for (const el of $$('[data-release]')) {
  const value = RELEASE[el.dataset.release];
  if (value) el.textContent = value;
}
$('[data-year]').textContent = new Date().getFullYear();

// 访客的系统：Mac、Windows，或者都不是（手机、Linux 等）
const ua = navigator.userAgent;
const isMac =
  /Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad|iPod/.test(ua) && navigator.maxTouchPoints < 2;
const isWindows = /Windows/.test(ua);
const visitor = isWindows ? 'win' : isMac ? 'mac' : null;
const platformName = { mac: 'macOS', win: 'Windows' };
const firstOpen = { mac: '#first-open', win: '#first-open-win' };
if (!visitor) $('[data-platform-hint]').hidden = false;

// 首屏按钮下载访客所用系统的版本，并提示另一个版本
if (visitor === 'win') {
  const hero = $('[data-download-auto]');
  hero.dataset.download = 'win';
  $('[data-download-label]', hero).textContent = '下载 Windows 版';
}
if (visitor) {
  const other = visitor === 'win' ? 'mac' : 'win';
  const hint = $('[data-other-download]');
  $('a', hint).textContent = `也有 ${platformName[other]} 版`;
  hint.hidden = false;
  // 下载区把访客的系统排在前面，另一个用次要样式
  const options = $('[data-download-options]');
  options.prepend($(`[data-platform="${visitor}"]`, options));
  $(`[data-platform="${other}"] .btn`, options).classList.replace('btn-light', 'btn-dim');
}

// 安装包大小
for (const [platform, info] of Object.entries(DOWNLOADS)) {
  for (const el of $$(`[data-size="${platform}"]`)) el.textContent = info.size;
}

// 下载按钮
for (const btn of $$('[data-download]')) {
  const platform = btn.dataset.download;
  const { url } = DOWNLOADS[platform];
  if (url) {
    btn.href = url;
    const fileName = decodeURIComponent(url.split('/').pop().split('?')[0]);
    if (fileName) btn.setAttribute('download', fileName);
    btn.addEventListener('click', () =>
      toast('下载已开始。第一次打开遇到系统提示？', firstOpen[platform], '查看说明'),
    );
  } else {
    btn.classList.add('is-disabled');
    btn.setAttribute('aria-disabled', 'true');
    btn.removeAttribute('href');
    const label = $('[data-download-label]', btn);
    if (label) label.textContent = `${platformName[platform]} 版即将开放`;
  }
}

// 安装说明：按系统切换
const osTabs = $$('[data-os-tab]');
function showInstall(platform) {
  for (const tab of osTabs) {
    const selected = tab.dataset.osTab === platform;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of $$('[data-os-panel]')) panel.hidden = panel.dataset.osPanel !== platform;
}
for (const tab of osTabs) {
  tab.addEventListener('click', () => showInstall(tab.dataset.osTab));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = osTabs[(osTabs.indexOf(tab) + 1) % osTabs.length];
    showInstall(next.dataset.osTab);
    next.focus();
  });
}
showInstall(visitor || 'mac');

// Windows 访客看到的快捷键与说法
if (isWindows) {
  const keys = { '⌘': 'Ctrl', '⇧': 'Shift' };
  for (const kbd of $$('kbd')) if (keys[kbd.textContent]) kbd.textContent = keys[kbd.textContent];
  for (const el of $$('[data-win-text]')) el.textContent = el.dataset.winText;
}

// 页脚：反馈与备案
if (FEEDBACK_EMAIL) {
  const a = $('[data-feedback]');
  a.href = `mailto:${FEEDBACK_EMAIL}`;
  a.hidden = false;
}
if (ICP_NUMBER) {
  const a = $('[data-icp]');
  a.textContent = ICP_NUMBER;
  a.hidden = false;
}
if (POLICE_NUMBER) {
  const a = $('[data-police]');
  a.textContent = POLICE_NUMBER;
  a.hidden = false;
}

// 跳到安装说明时切到对应系统并展开它
function openDetails(id) {
  const d = document.getElementById(id);
  if (!d || d.tagName !== 'DETAILS') return;
  const panel = d.closest('[data-os-panel]');
  if (panel) showInstall(panel.dataset.osPanel);
  d.open = true;
}
for (const a of $$('[data-open-details]')) {
  a.addEventListener('click', () => openDetails(a.dataset.openDetails));
}
if (location.hash === '#first-open' || location.hash === '#first-open-win')
  openDetails(location.hash.slice(1));

// 主图上的手写批注：截图加载好、开始倾斜展开时再画出来
const heroWindow = $('.hero-window');
const heroImg = $('img', heroWindow);
const ink = () => setTimeout(() => heroWindow.classList.add('is-inked'), 900);
if (heroImg.complete) ink();
else heroImg.addEventListener('load', ink, { once: true });

// 宣传片：点了才加载、才出声；首屏的“看宣传片”滚过来直接播放，播完回到封面
const film = $('[data-film]');
const filmVideo = $('video', film);
filmVideo.controls = false;
function playFilm() {
  film.classList.add('is-playing');
  filmVideo.controls = true;
  filmVideo.play();
}
$('[data-film-play]').addEventListener('click', playFilm);
$('[data-film-open]').addEventListener('click', (e) => {
  e.preventDefault();
  film.scrollIntoView({ block: 'center' });
  playFilm();
});
filmVideo.addEventListener('ended', () => {
  film.classList.remove('is-playing');
  filmVideo.controls = false;
  filmVideo.load();
});

// 界面主题：点一下换截图，整块背景跟着变；没人操作时在视野里自动轮换
const THEMES = {
  default: { bg: '#edf2f1', text: '青岚 · 默认主题，清爽的白底配青绿。' },
  paper: { bg: '#efe7da', text: '宣纸 · 暖白纸色配朱砂红，标题用宋体，侧栏带一点纸纹。' },
  sky: { bg: '#e7edf8', text: '晴空 · 冷调天蓝，按钮用蓝紫渐变。' },
  blossom: { bg: '#f6e9ec', text: '桃夭 · 柔和的樱粉与奶白，温润不刺眼。' },
  night: { bg: '#12161c', text: '夜读 · 深蓝灰的夜间界面，青绿点缀。' },
  ink: { bg: '#12100d', text: '墨金 · 墨色底配鎏金按钮，标题用宋体。' },
  brutal: { bg: '#fff3d1', text: '新粗野 · 粗黑描边、硬投影、黄粉青撞色，按钮按下去会“压下”。' },
  editorial: { bg: '#ebe6da', text: '报刊 · 新闻纸底色，整个界面用宋体，黑色细线配朱红。' },
  terminal: { bg: '#050905', text: '终端 · 黑底荧光绿等宽字，扫描线和闪烁光标。' },
  aurora: { bg: '#0d0b20', text: '极光 · 极光渐变背景上，悬浮着半透明的玻璃面板。' },
};
const themesSection = $('[data-themes]');
const themeButtons = $$('[data-theme-id]');
const themeShot = $('[data-theme-shot]');
const themeCaption = $('[data-theme-caption]');
const themeLayer = document.createElement('img');
themeLayer.className = 'next';
themeLayer.alt = '';
themeLayer.setAttribute('aria-hidden', 'true');
themeShot.after(themeLayer);
const themeSrc = (id) => `assets/themes/${id}.webp`;
const preloaded = new Map();
function preloadTheme(id) {
  if (!preloaded.has(id)) {
    const img = new Image();
    img.src = themeSrc(id);
    preloaded.set(id, img.decode().catch(() => {}));
  }
  return preloaded.get(id);
}
let activeTheme = 'night';
function showTheme(id) {
  activeTheme = id;
  const button = $(`[data-theme-id="${id}"]`);
  for (const b of themeButtons) {
    b.setAttribute('aria-selected', String(b === button));
    b.tabIndex = b === button ? 0 : -1;
  }
  const { bg, text } = THEMES[id];
  themesSection.style.setProperty('--t-bg', bg);
  themesSection.style.setProperty('--t-a', button.style.getPropertyValue('--a'));
  themesSection.dataset.tone = button.dataset.tone;
  themeCaption.textContent = text;
  const alt = `${$('b', button).textContent}主题下的页间：${text.split(' · ')[1]}`;
  preloadTheme(id).then(() => {
    if (activeTheme !== id || themeShot.getAttribute('src') === themeSrc(id)) return;
    themeLayer.src = themeSrc(id);
    themeLayer.classList.add('on');
    setTimeout(() => {
      if (activeTheme !== id) return;
      themeShot.src = themeSrc(id);
      themeShot.alt = alt;
      themeLayer.classList.remove('on');
    }, 470);
  });
}
let autoplay = !matchMedia('(prefers-reduced-motion: reduce)').matches;
let autoTimer;
function stopAutoplay() {
  autoplay = false;
  clearInterval(autoTimer);
}
for (const button of themeButtons) {
  button.addEventListener('click', () => {
    stopAutoplay();
    showTheme(button.dataset.themeId);
  });
  button.addEventListener('pointerenter', () => preloadTheme(button.dataset.themeId), {
    passive: true,
  });
  button.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    stopAutoplay();
    const i = themeButtons.indexOf(button);
    const next = themeButtons[(i + step + themeButtons.length) % themeButtons.length];
    showTheme(next.dataset.themeId);
    next.focus();
  });
}
showTheme('night');
$('.theme-picker').classList.add('is-ready');
if ('IntersectionObserver' in window) {
  new IntersectionObserver(
    ([entry]) => {
      clearInterval(autoTimer);
      if (!entry.isIntersecting || !autoplay) return;
      autoTimer = setInterval(() => {
        if (document.hidden) return;
        const i = themeButtons.findIndex((b) => b.dataset.themeId === activeTheme);
        const next = themeButtons[(i + 1) % themeButtons.length].dataset.themeId;
        preloadTheme(themeButtons[(i + 2) % themeButtons.length].dataset.themeId);
        showTheme(next);
      }, 4200);
    },
    { threshold: 0.45 },
  ).observe($('.theme-stage'));
}

// 阅读功能的分页
const readingTabs = $$('[data-tab]');
function showPanel(name) {
  for (const tab of readingTabs) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of $$('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
}
for (const tab of readingTabs) {
  tab.addEventListener('click', () => showPanel(tab.dataset.tab));
  tab.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    const i = readingTabs.indexOf(tab);
    const next = readingTabs[(i + step + readingTabs.length) % readingTabs.length];
    showPanel(next.dataset.tab);
    next.focus();
  });
}
showPanel('annotate');

// 提示条
const toastEl = $('[data-toast]');
let toastTimer;
function toast(text, href, linkText) {
  toastEl.replaceChildren(text);
  if (href) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = linkText + ' →';
    a.addEventListener('click', () => {
      openDetails(href.slice(1));
      toastEl.classList.remove('is-on');
    });
    toastEl.append(a);
  }
  toastEl.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), href ? 7000 : 2200);
}

// 导航栏滚动后加底色
const nav = $('[data-nav]');
const onScroll = () => nav.classList.toggle('is-scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// 滚动渐显；同一行的元素依次出现
const reveals = $$('.reveal');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(
    (entries) => {
      const shown = entries.filter((e) => e.isIntersecting);
      shown.forEach((e, i) => {
        e.target.style.setProperty('--d', `${Math.min(i, 4) * 0.08}s`);
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
  );
  reveals.forEach((el) => io.observe(el));
} else {
  reveals.forEach((el) => el.classList.add('in'));
}
