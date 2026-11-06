// Real Electron navigation and persistence. All files and service responses are local fixtures.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-settings-'));
const project = path.join(temp, '阅读项目');
const evidence = process.env.FOLIO_QA_DIR || path.join(os.tmpdir(), 'folio-settings-qa');
await fs.mkdir(project);
await fs.mkdir(evidence, { recursive: true });
await fs.copyFile(
  path.join(
    root,
    'samples',
    (await fs.readdir(path.join(root, 'samples'))).find((s) => s.endsWith('.html')),
  ),
  path.join(project, '阅读示例.html'),
);
let published = Date.now();
let announcementGate = null;
const server = http.createServer(async (req, res) => {
  // The group's QR code, as the website serves it (any JPEG will do).
  if (req.url.startsWith('/qr.jpg')) {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    return res.end(await fs.readFile(path.join(root, 'website/community/qr.jpg')));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url.endsWith('/announcements')) {
    if (announcementGate) await announcementGate;
    return res.end(
      JSON.stringify({
        items: [
          {
            id: 'settings-test',
            vendor: 'DeepSeek',
            title: '本地测试公告',
            preset: 'deepseek',
            published,
            checked: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      }),
    );
  }
  res.end('{}');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app, page;
const errors = [];
// `fresh`: a first launch, with nothing saved yet.
async function start(fresh = false) {
  app = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      FOLIO_USER_DATA: path.join(temp, fresh ? 'fresh-data' : 'user-data'),
      FOLIO_WORKSPACE: project,
      FOLIO_LICENSE_SERVER: `http://127.0.0.1:${server.address().port}`,
      FOLIO_COMMUNITY_QR: `http://127.0.0.1:${server.address().port}/qr.jpg`,
    },
  });
  page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.document-frame').waitFor();
  await page.locator('.reader-loading').waitFor({ state: 'hidden' });
}
const dialog = () => page.getByRole('dialog', { name: '设置', exact: true });
const legacyAi = () => page.getByRole('dialog', { name: 'AI 设置', exact: true });
const nav = () => dialog().getByRole('navigation', { name: '设置分类', exact: true });
const gearDot = () => page.locator('.settings-button .announcement-dot');
const announcementDot = () =>
  nav().getByRole('button', { name: '公告', exact: true }).locator('.announcement-dot');
async function closeSettings() {
  await dialog().getByRole('button', { name: '关闭设置' }).click();
  await dialog().waitFor({ state: 'hidden' });
}
async function checkLegacyAi() {
  await legacyAi().getByRole('heading', { name: 'AI 设置', exact: true }).waitFor();
  const sidebar = legacyAi().getByRole('navigation', { name: '已添加的 AI 服务' });
  await sidebar.getByRole('button', { name: '语音服务', exact: true }).waitFor();
  await sidebar.getByRole('button', { name: '读者画像', exact: true }).waitFor();
  assert.equal(await dialog().count(), 0, 'legacy entries keep the original standalone window');
  assert.equal(await legacyAi().locator('.settings-subnav').count(), 0);
}
async function closeLegacyAi() {
  await legacyAi().getByRole('button', { name: '关闭 AI 设置' }).click();
  await legacyAi().waitFor({ state: 'hidden' });
}
async function menu(label) {
  await app.evaluate(({ Menu }, label) => {
    const menus = Menu.getApplicationMenu().items;
    const item = menus.flatMap((m) => m.submenu?.items || []).find((m) => m.label === label);
    if (!item) throw Error(`Missing menu item: ${label}`);
    item.click();
  }, label);
}
try {
  await start();
  await gearDot().waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await dialog().getByRole('heading', { name: '外观与阅读', exact: true }).waitFor();
  assert.equal(await nav().getByRole('button').count(), 8);
  await announcementDot().waitFor();
  await page.screenshot({ path: path.join(evidence, 'settings-overview.png') });
  await dialog().getByLabel('划词工具条位置', { exact: true }).selectOption('above');
  await dialog().getByRole('slider', { name: '高亮笔记字号' }).fill('20');
  await dialog().getByRole('switch', { name: '自动保存源码' }).uncheck();
  await page.screenshot({ path: path.join(evidence, 'settings-appearance.png') });
  await dialog()
    .getByRole('button', { name: /^夜读：/ })
    .click();
  await page.locator('html[data-theme="night"]').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'night');
  await page.screenshot({ path: path.join(evidence, 'settings-dark.png') });
  await closeSettings();
  // The original theme button and popover remain available and share the same preference.
  await page.getByRole('button', { name: '界面主题', exact: true }).click();
  const themes = page.getByRole('dialog', { name: '界面主题' });
  assert.equal(
    await themes.getByRole('button', { name: /^夜读：/ }).getAttribute('aria-pressed'),
    'true',
  );
  await themes.getByRole('button', { name: /^青岚：/ }).click();
  await page.locator('html[data-theme="default"]').waitFor();
  await page.keyboard.press('Escape');
  await themes.waitFor({ state: 'hidden' });
  // Focus containment and Escape return to the new gear button.
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.keyboard.press('Shift+Tab');
  assert.ok(await page.evaluate(() => !!document.activeElement.closest('.settings-dialog')));
  await page.keyboard.press('Tab');
  assert.equal(
    await nav()
      .getByRole('button', { name: '外观与阅读' })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '设置');
  assert.equal(
    await page
      .getByRole('button', { name: '设置', exact: true })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  // The original menu and shortcut still open the standalone AI settings.
  assert.equal(
    await app.evaluate(
      ({ Menu }) =>
        Menu.getApplicationMenu()
          .items.flatMap((m) => m.submenu?.items || [])
          .find((m) => m.label === 'AI 设置…').accelerator,
    ),
    process.platform === 'darwin' ? 'Cmd+,' : 'Ctrl+,',
  );
  await menu('AI 设置…');
  await checkLegacyAi();
  await menu('设置…');
  await dialog().getByRole('heading', { name: '外观与阅读', exact: true }).waitFor();
  await legacyAi().waitFor({ state: 'hidden' });
  await menu('AI 设置…');
  await checkLegacyAi();
  await closeLegacyAi();
  await showAssistant(page);
  await page
    .locator('.assistant-panel')
    .getByRole('button', { name: 'AI 设置', exact: true })
    .click();
  await checkLegacyAi();
  await page.screenshot({ path: path.join(evidence, 'legacy-ai-settings.png') });
  await closeLegacyAi();
  await page.getByRole('button', { name: '配置 AI 服务', exact: true }).click();
  await checkLegacyAi();
  await closeLegacyAi();
  // The new gear opens the independent unified window, where drafts survive category changes.
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await nav().getByRole('button', { name: 'AI', exact: true }).click();
  await dialog().getByRole('heading', { name: 'AI', exact: true }).waitFor();
  await dialog()
    .getByRole('button', { name: /^DeepSeek/ })
    .click();
  await dialog().getByLabel('名称', { exact: true }).fill('未保存的服务草稿');
  await dialog().getByLabel('API Key', { exact: true }).fill('mock-draft-key');
  await nav().getByRole('button', { name: '语音', exact: true }).click();
  assert.equal(
    await dialog()
      .getByRole('radio', { name: /^页老师出声/ })
      .getAttribute('aria-checked'),
    'true',
    'new profiles default to speaking without enabling voice conversation',
  );
  await nav().getByRole('button', { name: 'AI', exact: true }).click();
  assert.equal(await dialog().getByLabel('名称', { exact: true }).inputValue(), '未保存的服务草稿');
  assert.equal(
    await dialog().getByLabel('API Key', { exact: true }).inputValue(),
    'mock-draft-key',
  );
  await page.screenshot({ path: path.join(evidence, 'settings-ai.png') });
  await dialog().getByRole('button', { name: '读者画像' }).click();
  await dialog()
    .getByRole('textbox', { name: '读者画像' })
    .fill('软件开发者，喜欢用例子理解概念。');
  await dialog().getByRole('button', { name: '保存', exact: true }).click();
  await dialog().getByText('已保存', { exact: true }).waitFor();
  await nav().getByRole('button', { name: '语音', exact: true }).click();
  await dialog().getByLabel('页老师的声音').selectOption('cloud:edge:zh-CN-YunxiNeural');
  await page.screenshot({ path: path.join(evidence, 'settings-voice.png') });
  await dialog()
    .getByRole('radio', { name: /^静音讲解/ })
    .click();
  assert.equal(await nav().getByRole('button', { name: '会员', exact: true }).count(), 0);
  assert.equal(
    await page.getByRole('dialog').count(),
    1,
    'embedded pages do not create nested dialogs',
  );
  // 用户交流群: the QR code itself, read from the website, not a link out.
  await nav().getByRole('button', { name: '用户交流群', exact: true }).click();
  const qr = dialog().getByRole('img', { name: '页间用户交流群的微信二维码' });
  await qr.waitFor();
  assert.match(await qr.getAttribute('src'), /^data:image\/jpeg;base64,/);
  assert.ok(await qr.evaluate((img) => img.complete && img.naturalWidth > 0));
  await page.screenshot({ path: path.join(evidence, 'settings-community.png') });
  await nav().getByRole('button', { name: '关于', exact: true }).click();
  await dialog().getByText('常用快捷键', { exact: true }).waitFor();
  assert.equal(await dialog().locator('.settings-about').getByText('交流群').count(), 0);
  assert.equal(await dialog().locator('.announcements-page').count(), 0);
  await announcementDot().waitFor();
  await gearDot().waitFor();
  await page.screenshot({ path: path.join(evidence, 'settings-about.png') });
  await nav().getByRole('button', { name: '公告', exact: true }).click();
  await dialog().getByText('本地测试公告', { exact: true }).waitFor();
  await announcementDot().waitFor({ state: 'detached' });
  await gearDot().waitFor({ state: 'detached' });
  await page.screenshot({ path: path.join(evidence, 'settings-announcements.png') });
  await dialog().getByRole('button', { name: '去配置', exact: true }).click();
  await dialog().getByLabel('名称', { exact: true }).waitFor();
  assert.equal(
    await nav().getByRole('button', { name: 'AI', exact: true }).getAttribute('aria-current'),
    'page',
  );
  assert.equal(await dialog().getByLabel('名称', { exact: true }).inputValue(), 'DeepSeek');
  assert.equal(await dialog().locator('.settings-subnav .announcement-dot').count(), 0);
  // A refresh finishing after leaving the announcements page must not mark new items read.
  await nav().getByRole('button', { name: '公告', exact: true }).click();
  // Finish the page's initial load before publishing the new fixture and forcing a refresh.
  await dialog().getByRole('button', { name: '刷新', exact: true }).click({ trial: true });
  published += 1000;
  let releaseAnnouncements;
  announcementGate = new Promise((resolve) => {
    releaseAnnouncements = resolve;
  });
  await dialog().getByRole('button', { name: '刷新', exact: true }).click();
  await nav().getByRole('button', { name: '关于', exact: true }).click();
  await dialog().getByText('常用快捷键', { exact: true }).waitFor();
  releaseAnnouncements();
  announcementGate = null;
  await announcementDot().waitFor();
  await gearDot().waitFor();
  await nav().getByRole('button', { name: '公告', exact: true }).click();
  await announcementDot().waitFor({ state: 'detached' });
  await gearDot().waitFor({ state: 'detached' });
  // Short windows and dark themes should keep controls inside the dialog.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 620));
  await nav().getByRole('button', { name: '外观与阅读' }).click();
  await page.screenshot({ path: path.join(evidence, 'settings-narrow.png') });
  assert.ok(await dialog().evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
  await closeSettings();
  // Both old and new announcement entries share read state; a later publication lights them again.
  await menu('AI 设置…');
  await checkLegacyAi();
  assert.equal(await legacyAi().locator('.announcement-dot').count(), 0);
  await closeLegacyAi();
  published += 1000;
  await menu('AI 设置…');
  await legacyAi().locator('.announcement-dot').waitFor();
  // This narrow window hides the workspace; its gear still receives the unread state.
  await gearDot().waitFor({ state: 'attached' });
  await legacyAi().getByRole('button', { name: '公告', exact: true }).click();
  await legacyAi().getByText('本地测试公告', { exact: true }).waitFor();
  await legacyAi().locator('.announcement-dot').waitFor({ state: 'detached' });
  await gearDot().waitFor({ state: 'detached' });
  await closeLegacyAi();
  assert.equal(await page.locator('.member-chip').count(), 0, 'no membership button');
  await app.close();
  // Settings persist through a real restart, with no migration of the existing storage keys.
  await start();
  await menu('设置…');
  assert.equal(await announcementDot().count(), 0);
  assert.equal(await dialog().getByLabel('划词工具条位置', { exact: true }).inputValue(), 'above');
  assert.equal(await dialog().getByRole('slider', { name: '高亮笔记字号' }).inputValue(), '20');
  assert.equal(await dialog().getByRole('switch', { name: '自动保存源码' }).isChecked(), false);
  await nav().getByRole('button', { name: '语音', exact: true }).click();
  assert.equal(
    await dialog()
      .getByRole('radio', { name: /^静音讲解/ })
      .getAttribute('aria-checked'),
    'true',
    'an explicit voice choice survives restart instead of being replaced by the default',
  );
  assert.equal(
    await dialog().getByLabel('页老师的声音').inputValue(),
    'cloud:edge:zh-CN-YunxiNeural',
  );
  await nav().getByRole('button', { name: 'AI', exact: true }).click();
  await dialog().getByRole('button', { name: '读者画像' }).click();
  assert.equal(
    await dialog().getByRole('textbox', { name: '读者画像' }).inputValue(),
    '软件开发者，喜欢用例子理解概念。',
  );
  await closeSettings();
  await page.getByRole('button', { name: '新建空白白板', exact: true }).click();
  await page
    .getByRole('dialog', { name: '白板讲解' })
    .getByRole('button', { name: '未配置 AI 服务', exact: true })
    .click();
  await checkLegacyAi();
  await legacyAi().getByRole('button', { name: '读者画像', exact: true }).click();
  assert.equal(
    await legacyAi().getByRole('textbox', { name: '读者画像' }).inputValue(),
    '软件开发者，喜欢用例子理解概念。',
  );
  await closeLegacyAi();
  await page.locator('.wb-voice-button').click();
  assert.equal(
    await page.getByRole('dialog', { name: '讲解方式' }).getByLabel('页老师的声音').inputValue(),
    'cloud:edge:zh-CN-YunxiNeural',
  );
  await app.close();
  // A first launch: every theme is there to pick, with nothing to unlock.
  await start(true);
  await menu('设置…');
  await dialog()
    .getByRole('button', { name: /^夜读：/ })
    .click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'night');
  assert.equal(await page.getByRole('dialog').count(), 1, 'picking a theme opens nothing else');
  assert.equal(await dialog().locator('.theme-card-pro').count(), 0, 'no theme is marked Pro');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 680));
  await page.screenshot({ path: path.join(evidence, 'settings-narrow.png') });
  assert.ok(await dialog().evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
  assert.deepEqual(errors, []);
  console.log(
    `PASS: unified settings, old entries, focus, drafts, shared voice/theme state, restart persistence, narrow layout. Screenshots: ${evidence}`,
  );
} finally {
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function showAssistant(page) {
  const toggle = page.getByLabel('AI 助手与笔记', { exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.locator('.inspector-tabs').getByRole('button', { name: '助手', exact: true }).click();
}
