// ============================================================
// 发布配置 —— 每次发版或部署时只改这里
// ============================================================

const RELEASE = {
  version: '0.11.0',
  date: '2026.10.01',
};

// 各平台安装包的下载地址和大小。安装包放在 website/downloads/，随官网一起部署到自己的服务器。
// url 留空时，对应的下载按钮显示为“即将开放下载”且不可点击，不会给访客死链。
const DOWNLOADS = {
  mac: { url: 'downloads/Folio-0.11.0-mac-arm64.dmg', size: '130 MB' },
  win: { url: 'downloads/Folio-0.11.0-win-x64-setup.exe', size: '110 MB' },
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
