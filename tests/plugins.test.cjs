const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const {
  createPlugins,
  validateManifest,
  parseSource,
  allowedUrl,
  satisfies,
  newPermissions,
  sandboxPage,
} = require('../electron/plugins.cjs');
const { atomicWrite } = require('../electron/workspace.cjs');

function load(entry) {
  const out = buildSync({
    entryPoints: [path.join(__dirname, '..', entry)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    // The runner's helpers only; the app modules it imports aren't called here.
    external: ['react', 'react-dom'],
  }).outputFiles[0].text;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', out)(module, module.exports, require);
  return module.exports;
}

const bundled = require('../plugins/ai-daily/folio-plugin.json');
const base = () => JSON.parse(JSON.stringify(bundled));

test('the optional AI 前沿日报 plugin is valid', () => {
  const m = validateManifest(base(), { appVersion: '0.30.0' });
  assert.equal(m.id, 'ai-daily');
  assert.deepEqual(m.permissions.write, ['{{output}}']);
  // It works in a folder of its own, whichever project is open.
  assert.equal(m.run.where, 'folder');
  assert.ok(m.triggers.some((t) => t.type === 'daily' && t.time === '08:30'));
  assert.ok(m.run.tools.includes('fetch_url'));
});

test('manifests that ask for too much or are malformed are turned down', () => {
  const bad = (change, message) => {
    const raw = base();
    change(raw);
    assert.throws(() => validateManifest(raw, { appVersion: '0.30.0' }), message);
  };
  bad((m) => (m.id = 'Bad Id'), /id/);
  bad((m) => (m.folio = 2), /格式/);
  bad((m) => (m.engines.folio = '>=9.0.0'), /需要页间/);
  bad((m) => m.files.push('../escape.md'), /文件名无效/);
  bad((m) => m.files.push('tool.exe'), /不能有这种文件/);
  bad((m) => m.files.push('extra.js'), /多了脚本/);
  bad((m) => m.run.tools.push('run_shell'), /不认识的工具/);
  bad((m) => (m.permissions.network = []), /permissions\.network/);
  bad((m) => (m.permissions.write = []), /permissions\.write/);
  bad((m) => (m.permissions.write = ['../outside']), /写入文件夹无效/);
  bad((m) => (m.permissions.write = ['{{nothing}}']), /不存在的设置/);
  bad((m) => (m.permissions.network = ['http://x.com']), /网站写法/);
  bad((m) => (m.triggers = [{ type: 'daily', time: '25:00' }]), /定时/);
  bad((m) => (m.settings[0].key = 'today'), /不能叫/);
  // A plugin with a folder of its own: only the tools that work there, one folder setting.
  bad((m) => m.run.tools.push('edit_html'), /不能用 edit_html/);
  bad((m) => m.run.tools.push('add_highlights'), /不能用 add_highlights/);
  bad((m) => (m.permissions.write = ['AI日报']), /文件夹设置/);
  bad((m) => (m.permissions.write = ['{{topics}}']), /文件夹设置/);
  bad((m) => (m.run.where = 'anywhere'), /run\.where/);
});

test('a manifest without a button gets one; unknown fields are dropped', () => {
  const raw = base();
  raw.triggers = [{ type: 'daily', time: '07:05' }];
  raw.surprise = true;
  const m = validateManifest(raw, { appVersion: '0.30.0' });
  assert.ok(m.triggers.some((t) => t.type === 'button'));
  assert.equal(m.surprise, undefined);
});

test('engine ranges', () => {
  assert.ok(satisfies('0.28.0', '>=0.28.0'));
  assert.ok(satisfies('0.29.1', '>=0.28.0 <1.0.0'));
  assert.ok(!satisfies('1.0.0', '>=0.28.0 <1.0.0'));
  assert.ok(satisfies('0.28.0', '*'));
  assert.ok(!satisfies('0.28.0', '^0.28.0'));
});

test('GitHub and Gitee links', () => {
  assert.deepEqual(parseSource('https://github.com/a/b'), {
    type: 'github',
    owner: 'a',
    repo: 'b',
    ref: '',
    path: '',
    url: 'https://github.com/a/b',
  });
  const sub = parseSource('github.com/a/b/tree/dev/plugins/daily/');
  assert.equal(sub.ref, 'dev');
  assert.equal(sub.path, 'plugins/daily');
  assert.equal(parseSource('a/b.git').repo, 'b');
  assert.equal(parseSource('https://gitee.com/x/y').type, 'gitee');
  assert.equal(parseSource('https://github.com/a/b/blob/main/p/folio-plugin.json').path, 'p');
  assert.throws(() => parseSource('https://gitlab.com/a/b'), /GitHub/);
  assert.throws(() => parseSource('https://github.com/a'), /仓库/);
  assert.throws(() => parseSource('https://github.com/a/b/issues/1'), /看不懂/);
});

test('only the sites a plugin names, over https', () => {
  const sites = ['export.arxiv.org', '*.example.com'];
  assert.ok(allowedUrl('https://export.arxiv.org/api/query?x=1', sites));
  assert.ok(allowedUrl('https://news.example.com/feed', sites));
  assert.ok(allowedUrl('https://example.com/', sites));
  assert.ok(!allowedUrl('http://export.arxiv.org/', sites));
  assert.ok(!allowedUrl('https://arxiv.org/', sites));
  assert.ok(!allowedUrl('https://export.arxiv.org.evil.com/', sites));
  assert.ok(!allowedUrl('https://user:pw@export.arxiv.org/', sites));
  assert.ok(!allowedUrl('https://export.arxiv.org:8443/', sites));
  assert.ok(!allowedUrl('https://badexample.com/', sites));
});

test('an update that asks for more is noticed', () => {
  const before = validateManifest(base(), { appVersion: '0.30.0' });
  const raw = base();
  raw.permissions.network.push('evil.example.com');
  raw.run.tools.push('search_papers');
  const after = validateManifest(raw, { appVersion: '0.30.0' });
  assert.deepEqual(newPermissions(before, after).network, ['evil.example.com']);
  assert.deepEqual(newPermissions(before, after).tools, ['search_papers']);
  assert.equal(newPermissions(before, before), null);
});

test('the sandbox page cannot be broken out of with </script>', () => {
  const html = sandboxPage({
    code: 'folio.log("</script><img src=x>")',
    settings: { a: '</script>' },
    name: 'x',
  });
  assert.equal(html.match(/<\/script>/g).length, 3);
});

// A GitHub that serves one repository from memory.
function fakeGitHub(files, { commit = 'a'.repeat(40), rawDown = false } = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const reply = (status, body = '') => ({
      ok: status < 300,
      status,
      headers: new Map([['content-length', String(Buffer.byteLength(body))]]),
      arrayBuffer: async () => Buffer.from(body),
    });
    if (u.hostname === 'api.github.com' && u.pathname.startsWith('/repos/me/plug/commits/'))
      return reply(200, commit);
    if (u.hostname === 'raw.githubusercontent.com') {
      if (rawDown) throw Error('ECONNRESET');
      const name = u.pathname.replace(`/me/plug/${commit}/`, '');
      return name in files ? reply(200, files[name]) : reply(404);
    }
    if (u.hostname === 'api.github.com' && u.pathname.startsWith('/repos/me/plug/contents/')) {
      const name = decodeURIComponent(u.pathname.replace('/repos/me/plug/contents/', ''));
      return name in files ? reply(200, files[name]) : reply(404);
    }
    return reply(404);
  };
  return { fetch, calls };
}
async function tempPlugins(fetch, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-plugins-'));
  const bundledDir = path.join(dir, 'bundled');
  await fs.cp(path.join(__dirname, '..', 'plugins'), bundledDir, { recursive: true });
  return {
    dir,
    plugins: createPlugins({
      bundledDir,
      userDir: path.join(dir, 'user'),
      fetch,
      atomicWrite,
      appVersion: '0.30.0',
      documentsDir: path.join(dir, 'Documents'),
      ...options,
    }),
  };
}
const thirdManifest = {
  folio: 1,
  id: 'paper-digest',
  name: '论文摘要',
  version: '0.1.0',
  files: ['prompt.md', 'main.js'],
  run: { prompt: 'prompt.md', script: 'main.js', tools: ['create_html'] },
  permissions: { network: ['api.example.com'], write: ['摘要'] },
};

test('installing from a link: off until third-party plugins are on, pinned to a commit', async () => {
  const gh = fakeGitHub(
    {
      'folio-plugin.json': JSON.stringify(thirdManifest),
      'prompt.md': '写摘要',
      'main.js': 'folio.registerTool({ name: "hello" }, () => "hi")',
    },
    { rawDown: true },
  );
  const { plugins, dir } = await tempPlugins(gh.fetch);
  try {
    let list = await plugins.list();
    assert.equal(list.thirdParty, false);
    assert.deepEqual(
      list.plugins.map((p) => [p.id, p.bundled, p.enabled]),
      [['ai-daily', true, false]],
    );
    await assert.rejects(plugins.inspect({ url: 'https://github.com/me/plug' }), /外部插件/);
    await plugins.setThirdParty({ on: true });
    const seen = await plugins.inspect({ url: 'https://github.com/me/plug' });
    assert.equal(seen.manifest.id, 'paper-digest');
    assert.equal(seen.source.commit, 'a'.repeat(40));
    assert.equal(seen.installed, null);
    // raw.githubusercontent.com was down, so the API served the files.
    assert.ok(gh.calls.some((u) => u.includes('/contents/main.js')));
    list = await plugins.install({ stage: seen.stage });
    const installed = list.plugins.find((p) => p.id === 'paper-digest');
    assert.equal(installed.bundled, false);
    assert.equal(installed.enabled, false);
    assert.equal(installed.source.commit, 'a'.repeat(40));
    await assert.rejects(plugins.install({ stage: seen.stage }), /过期/);
    // Switched on, then third-party plugins switched off: it no longer runs.
    await plugins.set({ id: 'paper-digest', enabled: true });
    assert.ok((await plugins.list()).plugins.find((p) => p.id === 'paper-digest').enabled);
    const page = await plugins.sandbox('paper-digest');
    assert.match(page.csp, /default-src 'none'/);
    assert.match(page.html, /registerTool/);
    await plugins.setThirdParty({ on: false });
    assert.ok(!(await plugins.list()).plugins.find((p) => p.id === 'paper-digest').enabled);
    await assert.rejects(plugins.load({ id: 'paper-digest' }), /已关闭/);
    await assert.rejects(plugins.sandbox('paper-digest'), /已关闭/);
    await plugins.setThirdParty({ on: true });
    // The same commit again is no update.
    const again = await plugins.inspect({ id: 'paper-digest' });
    assert.equal(again.sameCommit, true);
    await plugins.remove({ id: 'paper-digest' });
    assert.ok(!(await plugins.list()).plugins.some((p) => p.id === 'paper-digest'));
    await assert.rejects(plugins.remove({ id: 'ai-daily' }), /不能卸载/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a repository whose plugin clashes with a bundled one is turned down', async () => {
  const gh = fakeGitHub({
    'folio-plugin.json': JSON.stringify(base()),
    'prompt.md': 'x',
    'template.html': '<p>x</p>',
    'icon.svg': '<svg/>',
  });
  const { plugins, dir } = await tempPlugins(gh.fetch);
  try {
    await plugins.setThirdParty({ on: true });
    await assert.rejects(plugins.inspect({ url: 'me/plug' }), /重名/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a plugin fetches only its own sites, following redirects only within them', async () => {
  const seen = [];
  const fetch = async (url) => {
    seen.push(url);
    const u = new URL(url);
    if (u.pathname === '/moved')
      return { status: 302, headers: new Map([['location', 'https://evil.com/steal']]) };
    if (u.pathname === '/inside') return { status: 302, headers: new Map([['location', '/feed']]) };
    const body = '<rss><channel><title>t</title></channel></rss>';
    return {
      status: 200,
      ok: true,
      headers: new Map([['content-type', 'application/rss+xml']]),
      body: new Response(body).body,
    };
  };
  const { plugins, dir } = await tempPlugins(fetch);
  try {
    await assert.rejects(
      plugins.fetch({ id: 'ai-daily', url: 'https://export.arxiv.org/api' }),
      /没有开启/,
    );
    await plugins.set({ id: 'ai-daily', enabled: true, root: '/p' });
    const got = await plugins.fetch({ id: 'ai-daily', url: 'https://export.arxiv.org/inside' });
    assert.equal(got.url, 'https://export.arxiv.org/feed');
    assert.match(got.text, /<rss>/);
    await assert.rejects(
      plugins.fetch({ id: 'ai-daily', url: 'https://export.arxiv.org/moved' }),
      /不能访问 evil\.com/,
    );
    await assert.rejects(
      plugins.fetch({ id: 'ai-daily', url: 'https://example.org/' }),
      /不能访问 example\.org/,
    );
    assert.ok(!seen.some((u) => u.includes('evil.com') || u.includes('example.org')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('settings, project and runs are remembered', async () => {
  const { plugins, dir } = await tempPlugins(async () => ({}));
  try {
    await plugins.set({
      id: 'ai-daily',
      enabled: true,
      root: '/proj',
      settings: { output: '日报' },
    });
    await plugins.ran({ id: 'ai-daily', at: 1000 });
    await plugins.ran({
      id: 'ai-daily',
      result: { ok: true, message: '好', output: '日报/a.html' },
    });
    const again = createPlugins({
      bundledDir: path.join(dir, 'bundled'),
      userDir: path.join(dir, 'user'),
      fetch: async () => ({}),
      atomicWrite,
      appVersion: '0.30.0',
    });
    const p = (await again.list()).plugins.find((x) => x.id === 'ai-daily');
    assert.equal(p.settings.output, '日报');
    assert.equal(p.settings.topics, bundled.settings[1].default);
    assert.equal(p.root, '/proj');
    assert.equal(p.lastRun, 1000);
    assert.equal(p.lastResult.output, '日报/a.html');
    assert.ok(p.enabledAt > 0);
    const loaded = await again.load({ id: 'ai-daily' });
    assert.match(loaded.prompt, /\{\{today\}\}/);
    assert.match(loaded.template, /<style>/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the runner: schedule, placeholders and where a plugin may write', () => {
  const runner = load('src/plugins/schedule.ts');
  const at = new Date(2026, 10, 4, 9, 0);
  assert.equal(runner.lastSlot('08:30', at), new Date(2026, 10, 4, 8, 30).getTime());
  assert.equal(runner.lastSlot('10:00', at), new Date(2026, 10, 3, 10, 0).getTime());
  const plugin = (over) => ({
    id: 'ai-daily',
    enabled: true,
    root: '/p',
    lastRun: 0,
    enabledAt: new Date(2026, 10, 1).getTime(),
    manifest: validateManifest(base(), { appVersion: '0.30.0' }),
    ...over,
  });
  const inProject = validateManifest(
    { ...base(), run: { ...base().run, where: 'project' } },
    { appVersion: '0.30.0' },
  );
  const due = (over, now = at) =>
    runner
      .duePlugins({ plugins: [plugin({ manifest: inProject, ...over })] }, '/p', now)
      .map((d) => d.id);
  assert.deepEqual(due({}), ['ai-daily']);
  // A plugin with its own folder runs whichever project is open, or none.
  const ownDue = (root) =>
    runner.duePlugins({ plugins: [plugin({ root: '/p' })] }, root, at).map((d) => d.id);
  assert.deepEqual(ownDue('/other'), ['ai-daily']);
  assert.deepEqual(ownDue(undefined), ['ai-daily']);
  // The reader's own time, a schedule switched off, and a time changed after today's slot.
  const timed = (schedule) =>
    runner.duePlugins({ plugins: [plugin({ schedule })] }, '/p', at).map((d) => d.time);
  assert.deepEqual(timed({ time: '07:15', off: false, changedAt: 0 }), ['07:15']);
  assert.deepEqual(timed({ time: '09:30', off: false, changedAt: 0 }), ['09:30']);
  assert.deepEqual(timed({ time: '07:15', off: true, changedAt: 0 }), []);
  assert.deepEqual(
    timed({ time: '07:15', off: false, changedAt: new Date(2026, 10, 4, 8, 0).getTime() }),
    [],
  );
  // Ran after today's 08:30: not again until tomorrow.
  assert.deepEqual(due({ lastRun: new Date(2026, 10, 4, 8, 31).getTime() }), []);
  // Switched on after today's time: the first run is tomorrow's.
  assert.deepEqual(due({ enabledAt: new Date(2026, 10, 4, 8, 45).getTime() }), []);
  // Another project open, or switched off.
  assert.deepEqual(due({ root: '/other' }), []);
  assert.deepEqual(due({ enabled: false }), []);
  // Days missed while the app was closed: made up once.
  assert.deepEqual(due({ lastRun: new Date(2026, 9, 20).getTime() }), ['ai-daily']);

  assert.equal(
    runner.fill('{{output}}/{{today}}.html', { output: '日报', today: '2026-11-04' }),
    '日报/2026-11-04.html',
  );
  assert.equal(runner.fill('{{unknown}}', {}), '{{unknown}}');
  const vars = runner.timeVars(at);
  assert.equal(vars.today, '2026-11-04');
  assert.equal(vars.yesterday, '2026-11-03');
  assert.equal(vars.week_ago, '2026-10-28');
  assert.equal(vars.weekday, '星期三');
  const m = validateManifest(base(), { appVersion: '0.30.0' });
  assert.deepEqual(runner.writableFolders(m, { output: './AI日报/' }), ['AI日报']);
  assert.deepEqual(runner.writableFolders(m, { output: '../外面' }), []);
  const ok = runner.writableIn(['AI日报']);
  assert.equal(ok('AI日报/2026-11-04.html'), true);
  assert.match(ok('其他/a.html'), /只能在「AI日报\/」/);
  assert.match(ok('AI日报.html'), /只能在/);
  assert.match(ok('AI日报2/a.html'), /只能在/);
  assert.match(runner.writableIn([])('a.html'), /不能写入/);
  // The project folder itself: files right in it, none in its folders.
  assert.deepEqual(runner.writableFolders(m, { output: '.' }), ['.']);
  assert.deepEqual(runner.writableFolders(m, { output: './' }), ['.']);
  assert.deepEqual(runner.writableFolders(m, { output: '' }), []);
  const top = runner.writableIn(['.']);
  assert.equal(top('2026-11-04 AI 前沿日报.html'), true);
  assert.equal(top('./2026-11-04 AI 前沿日报.html'), true);
  assert.match(top('笔记/a.html'), /只能在项目文件夹本身里写文件/);
});

test('a plugin with its own folder sees and writes only that folder', async () => {
  const { plugins, dir } = await tempPlugins(async () => ({}));
  const own = path.join(dir, 'Documents', 'AI日报');
  try {
    await assert.rejects(plugins.folder({ id: 'ai-daily', action: 'list' }), /没有开启/);
    await plugins.set({ id: 'ai-daily', enabled: true });
    // The default, a bare name, is in Documents; it is made when first written.
    let listed = (await plugins.list()).plugins.find((p) => p.id === 'ai-daily');
    assert.equal(listed.folder.path, own);
    assert.deepEqual((await plugins.folder({ id: 'ai-daily', action: 'list' })).files, []);
    await plugins.folder({ id: 'ai-daily', action: 'create', path: 'a.html', content: '<p>A</p>' });
    await plugins.folder({
      id: 'ai-daily',
      action: 'create',
      path: '十一月/b.html',
      content: '<p>B</p>',
    });
    assert.equal(await fs.readFile(path.join(own, '十一月', 'b.html'), 'utf8'), '<p>B</p>');
    const files = (await plugins.folder({ id: 'ai-daily', action: 'list' })).files.map(
      (f) => f.path,
    );
    assert.deepEqual(files.sort(), ['a.html', '十一月/b.html']);
    assert.equal(
      (await plugins.folder({ id: 'ai-daily', action: 'read', path: 'a.html' })).text,
      '<p>A</p>',
    );
    // Nothing written over, nothing outside, no other kind of file.
    const nope = (p, message, action = 'create') =>
      assert.rejects(
        plugins.folder({ id: 'ai-daily', action, path: p, content: '<p>x</p>' }),
        message,
      );
    await nope('a.html', /已存在/);
    await nope('../escape.html', /路径无效/);
    await nope('/tmp/escape.html', /路径无效/);
    await nope('.hidden/x.html', /路径无效/);
    await nope('x.js', /\.html/);
    await nope('../../etc/passwd', /路径无效/, 'read');
    await nope('missing.html', /没有 missing\.html/, 'read');
    // A link inside the folder that points out of it.
    const outside = path.join(dir, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(own, 'link'));
    await nope('link/x.html', /跳出了插件的文件夹/);
    assert.deepEqual(await fs.readdir(outside), []);
    // An old project-relative value that would mean Documents itself, or outside it: the default.
    for (const odd of ['.', './', '../外面', '']) {
      await plugins.set({ id: 'ai-daily', settings: { output: odd } });
      listed = (await plugins.list()).plugins.find((p) => p.id === 'ai-daily');
      assert.equal(listed.folder.path, own, odd);
    }
    // Moved anywhere: an absolute folder picked in Finder.
    const picked = path.join(dir, '我的日报');
    await plugins.set({ id: 'ai-daily', settings: { output: picked } });
    listed = (await plugins.list()).plugins.find((p) => p.id === 'ai-daily');
    assert.equal(listed.folder.path, picked);
    // Made before a run; its path as Folio would have it as a project.
    const made = await plugins.folder({ id: 'ai-daily', action: 'ensure' });
    assert.equal(made.path, await fs.realpath(picked));
    assert.equal(
      (await plugins.list()).plugins.find((p) => p.id === 'ai-daily').folder.real,
      made.path,
    );
    await plugins.folder({ id: 'ai-daily', action: 'create', path: 'c.html', content: '<p>C</p>' });
    // ~ is the home folder.
    await plugins.set({ id: 'ai-daily', settings: { output: '~/某个日报' } });
    listed = (await plugins.list()).plugins.find((p) => p.id === 'ai-daily');
    assert.equal(listed.folder.path, path.join(os.homedir(), '某个日报'));
    assert.equal(listed.folder.shown, path.join('~', '某个日报'));
    await plugins.set({ id: 'ai-daily', settings: { output: picked } });
    // Switched off: no more work in its folder.
    await plugins.set({ id: 'ai-daily', enabled: false });
    await assert.rejects(plugins.folder({ id: 'ai-daily', action: 'list' }), /没有开启/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('its own daily time, or none; and the 插件 conversations kept with the app', async () => {
  const { plugins, dir } = await tempPlugins(async () => ({}));
  try {
    const daily = async () => (await plugins.list()).plugins.find((p) => p.id === 'ai-daily');
    assert.deepEqual((await daily()).schedule, { time: '08:30', off: false, changedAt: 0 });
    await plugins.set({ id: 'ai-daily', schedule: { time: '21:05' } });
    assert.equal((await daily()).schedule.time, '21:05');
    assert.ok((await daily()).schedule.changedAt > 0);
    await plugins.set({ id: 'ai-daily', schedule: { off: true } });
    assert.deepEqual(
      [(await daily()).schedule.time, (await daily()).schedule.off],
      ['21:05', true],
    );
    await assert.rejects(plugins.set({ id: 'ai-daily', schedule: { time: '25:00' } }), /时间写法/);
    await assert.rejects(plugins.set({ id: 'ai-daily', schedule: { time: '8:30' } }), /时间写法/);
    // A run's conversation goes into its folder's own project (整个项目 there), next to the
    // conversations that project already has, updated in place as the run goes.
    await plugins.set({ id: 'ai-daily', enabled: true });
    const { path: home } = await plugins.folder({ id: 'ai-daily', action: 'ensure' });
    const file = path.join(home, '.html-reader', 'ai', 'project.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        active: 'old',
        threads: [{ id: 'old', messages: [{ id: 'm' }] }],
      }),
    );
    const run = (status) => ({
      id: 'run1',
      mode: 'agent',
      title: 'AI 前沿日报 · 2026-11-04',
      messages: [{ id: 'a', role: 'assistant', text: '', status }],
    });
    await plugins.saveRun({ id: 'ai-daily', thread: run('streaming') });
    await plugins.saveRun({ id: 'ai-daily', thread: run('done') });
    const kept = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(kept.active, 'old');
    assert.deepEqual(
      kept.threads.map((t) => [t.id, t.messages[0].status || '']),
      [
        ['run1', 'done'],
        ['old', ''],
      ],
    );
    await assert.rejects(plugins.saveRun({ id: 'ai-daily', thread: { id: 'x' } }), /格式/);
    await plugins.set({ id: 'ai-daily', enabled: false });
    await assert.rejects(plugins.saveRun({ id: 'ai-daily', thread: run('done') }), /没有开启/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// —— Plugins from this computer, the run log, the directory, and the public kit ——
const { readZip } = require('../electron/zip.cjs');
const { writeZip } = require('../folio-plugins/cli/lib/zip.cjs');
const { lintPlugin, readPluginDir } = require('../electron/plugin-manifest.cjs');
const { cleanDirectory } = require('../electron/plugins.cjs');

const devManifest = {
  folio: 1,
  id: 'dev-plug',
  name: '开发中的插件',
  version: '0.1.0',
  description: '写着玩的',
  files: ['prompt.md', 'tools.js'],
  run: {
    prompt: 'prompt.md',
    script: 'tools.js',
    tools: ['list_files', 'create_html'],
    where: 'folder',
  },
  permissions: { network: ['api.example.com'], write: ['{{out}}'] },
  settings: [{ key: 'out', type: 'folder', label: '放在哪', default: '开发输出' }],
};
async function writePlugin(dir, manifest = devManifest, files = {}) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'folio-plugin.json'), JSON.stringify(manifest));
  const all = {
    'prompt.md': '今天是 {{today}}，写到 {{out}}。',
    'tools.js': 'folio.log(1)',
    ...files,
  };
  for (const [name, text] of Object.entries(all)) await fs.writeFile(path.join(dir, name), text);
}
const until = async (fn, label, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error(`Timeout: ${label}`);
};

test("the public kit shares the app's rules, types and optional example byte for byte", async () => {
  const { pluginKitCopies } = await import('../scripts/sync-plugin-kit.mjs');
  const root = path.join(__dirname, '..');
  for (const [from, to] of pluginKitCopies)
    assert.equal(
      await fs.readFile(path.join(root, to), 'utf8'),
      await fs.readFile(path.join(root, from), 'utf8'),
      `${to} differs from ${from}: run node scripts/sync-plugin-kit.mjs`,
    );
});

test('setting names that would clash with what the runner fills in are refused; slips are warned about', () => {
  const raw = base();
  raw.settings.push({ key: 'folder', type: 'text' });
  assert.throws(() => validateManifest(raw), /不能叫 folder/);
  const twice = base();
  twice.settings.push({ ...twice.settings[1] });
  assert.throws(() => validateManifest(twice), /重复/);
  const m = validateManifest(base());
  assert.deepEqual(lintPlugin(m, { prompt: '写 {{today}} 的 {{topics}}，放进 {{folder}}' }), []);
  const warned = lintPlugin(m, { prompt: '{{topic}} {{ today }}' });
  assert.equal(warned.length, 1);
  assert.match(warned[0], /\{\{topic\}\}/);
  assert.match(lintPlugin(m, { prompt: '  ' }).join(), /是空的/);
});

test('a plugin folder: every listed file there, real files only, inside it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-dev-'));
  try {
    const plug = path.join(dir, 'plug');
    await writePlugin(plug);
    const read = await readPluginDir(plug, { appVersion: '0.30.0' });
    assert.equal(read.manifest.id, 'dev-plug');
    assert.deepEqual(
      read.files.map((f) => f.name),
      ['prompt.md', 'tools.js'],
    );
    assert.deepEqual(read.warnings, []);
    // A listed file that's missing, or a link to something outside the folder.
    await fs.rm(path.join(plug, 'tools.js'));
    await assert.rejects(readPluginDir(plug), /tools\.js 不存在/);
    await fs.writeFile(path.join(dir, 'secret.txt'), 'private');
    await fs.symlink(path.join(dir, 'secret.txt'), path.join(plug, 'tools.js'));
    await assert.rejects(readPluginDir(plug), /不是普通文件/);
    await assert.rejects(readPluginDir(path.join(dir, 'nothing')), /找不到文件夹/);
    await assert.rejects(readPluginDir(dir), /没有 folio-plugin\.json/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('zips: written by the CLI, read back exactly; damage and tricks are refused', () => {
  const big = Buffer.from('页间'.repeat(5000));
  const zip = writeZip([
    { name: 'a/folio-plugin.json', data: '{"x":1}' },
    { name: 'a/big.md', data: big },
  ]);
  const entries = readZip(zip);
  assert.deepEqual(
    entries.map((e) => e.name),
    ['a/folio-plugin.json', 'a/big.md'],
  );
  assert.equal(entries[1].read().toString(), big.toString());
  assert.throws(() => entries[1].read(100), /太大/);
  // A byte inside big.md's compressed data (just after its name in its local header).
  const broken = Buffer.from(zip);
  broken[zip.indexOf(Buffer.from('a/big.md')) + 'a/big.md'.length + 4] ^= 0xff;
  assert.throws(() => readZip(broken).forEach((e) => e.read()), /损坏|解压失败/);
  assert.throws(() => readZip(Buffer.from('not a zip at all, really not')), /不是一个有效的/);
});

test("installing a .zip: Finder's and GitHub's layouts, one plugin at a time", async () => {
  const { plugins, dir } = await tempPlugins(async () => ({}));
  try {
    await plugins.setThirdParty({ on: true });
    const files = (prefix, manifest = devManifest) => [
      { name: `${prefix}folio-plugin.json`, data: JSON.stringify(manifest) },
      { name: `${prefix}prompt.md`, data: '写 {{today}}' },
      { name: `${prefix}tools.js`, data: 'folio.log(1)' },
      { name: `${prefix}README.md`, data: '不在 files 里，不会装' },
    ];
    // As Finder makes it: one folder, with __MACOSX and .DS_Store alongside.
    const finder = path.join(dir, 'finder.zip');
    await fs.writeFile(
      finder,
      writeZip([
        ...files('dev-plug/'),
        { name: '__MACOSX/dev-plug/._folio-plugin.json', data: 'junk' },
        { name: 'dev-plug/.DS_Store', data: 'junk' },
      ]),
    );
    const seen = await plugins.inspect({ local: finder });
    assert.equal(seen.manifest.id, 'dev-plug');
    assert.deepEqual(seen.source, { type: 'zip', name: 'finder.zip' });
    assert.deepEqual(
      seen.files.map((f) => f.name),
      ['folio-plugin.json', 'prompt.md', 'tools.js'],
    );
    let list = await plugins.install({ stage: seen.stage });
    const installed = list.plugins.find((p) => p.id === 'dev-plug');
    assert.deepEqual(installed.source, { type: 'zip', name: 'finder.zip' });
    const copied = path.join(dir, 'user', 'plugins', 'dev-plug');
    assert.deepEqual((await fs.readdir(copied)).sort(), [
      'folio-plugin.json',
      'prompt.md',
      'tools.js',
    ]);
    // A newer zip is an update, with what it asks for besides.
    const wider = {
      ...devManifest,
      version: '0.2.0',
      permissions: { ...devManifest.permissions, network: ['api.example.com', 'more.example.com'] },
    };
    const update = path.join(dir, 'update.zip');
    await fs.writeFile(update, writeZip(files('', wider)));
    const again = await plugins.inspect({ local: update });
    assert.equal(again.installed.version, '0.1.0');
    assert.deepEqual(again.added.network, ['more.example.com']);
    // GitHub's “Download ZIP” of a repository with several plugins: which one?
    const repo = path.join(dir, 'repo.zip');
    await fs.writeFile(
      repo,
      writeZip([
        ...files('repo-main/a/'),
        ...files('repo-main/b/', { ...devManifest, id: 'other' }),
      ]),
    );
    await assert.rejects(plugins.inspect({ local: repo }), /有 2 个插件/);
    const missing = path.join(dir, 'missing.zip');
    await fs.writeFile(missing, writeZip(files('x/').filter((f) => !f.name.endsWith('tools.js'))));
    await assert.rejects(plugins.inspect({ local: missing }), /没有 files 列出的 tools\.js/);
    await fs.writeFile(path.join(dir, 'x.txt'), 'x');
    await assert.rejects(plugins.inspect({ local: path.join(dir, 'x.txt') }), /\.zip/);
    // Third-party plugins off: nothing from this computer either.
    await plugins.setThirdParty({ on: false });
    await assert.rejects(plugins.inspect({ local: finder }), /外部插件/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a plugin loaded from its folder is read there, watched, and only forgotten when removed', async () => {
  let changes = 0;
  const { plugins, dir } = await tempPlugins(async () => ({}), {
    onChange: () => changes++,
    appVersion: '0.30.0',
  });
  try {
    const plug = path.join(dir, 'my-work', 'dev-plug');
    await writePlugin(plug, devManifest, { 'prompt.md': '用 {{nothing}}' });
    await plugins.setThirdParty({ on: true });
    const seen = await plugins.inspect({ local: plug });
    assert.equal(seen.source.type, 'folder');
    assert.equal(seen.source.path, await fs.realpath(plug));
    assert.match(seen.warnings.join(), /\{\{nothing\}\}/);
    let list = await plugins.install({ stage: seen.stage });
    let info = list.plugins.find((p) => p.id === 'dev-plug');
    assert.equal(info.source.type, 'folder');
    assert.match(info.warnings.join(), /\{\{nothing\}\}/);
    // Nothing was copied.
    assert.ok(!(await fs.stat(path.join(dir, 'user', 'plugins', 'dev-plug')).catch(() => null)));
    await plugins.set({ id: 'dev-plug', enabled: true });
    // Saved changes count at once: the next run reads the new instructions.
    await fs.writeFile(path.join(plug, 'prompt.md'), '新的说明 {{out}}');
    assert.equal((await plugins.load({ id: 'dev-plug' })).prompt, '新的说明 {{out}}');
    await until(() => changes > 0, 'the change noticed');
    await fs.writeFile(
      path.join(plug, 'folio-plugin.json'),
      JSON.stringify({ ...devManifest, version: '0.1.1' }),
    );
    list = await plugins.list();
    info = list.plugins.find((p) => p.id === 'dev-plug');
    assert.equal(info.manifest.version, '0.1.1');
    assert.deepEqual(info.warnings, []);
    assert.match((await plugins.sandbox('dev-plug')).html, /folio\.log\(1\)/);
    // Broken while being written: listed with why, and back when fixed.
    await fs.writeFile(path.join(plug, 'folio-plugin.json'), '{ oops');
    list = await plugins.list();
    assert.match(list.plugins.find((p) => p.id === 'dev-plug').error, /不是有效的 JSON/);
    await fs.writeFile(path.join(plug, 'folio-plugin.json'), JSON.stringify(devManifest));
    // The same id can't also be installed as a copy, and vice versa.
    const zip = path.join(dir, 'p.zip');
    await fs.writeFile(
      zip,
      writeZip([
        { name: 'folio-plugin.json', data: JSON.stringify(devManifest) },
        { name: 'prompt.md', data: 'x' },
        { name: 'tools.js', data: 'x' },
      ]),
    );
    await assert.rejects(plugins.inspect({ local: zip }), /加载了开发版/);
    // Loading the folder again is a reload.
    const reload = await plugins.inspect({ local: plug });
    assert.equal(reload.installed.version, '0.1.0');
    // Removing it forgets it; the author's folder stays.
    await plugins.remove({ id: 'dev-plug' });
    assert.ok(!(await plugins.list()).plugins.some((p) => p.id === 'dev-plug'));
    assert.ok(await fs.stat(path.join(plug, 'folio-plugin.json')));
    // Installed as a copy first, its folder can't be loaded over it.
    const copy = await plugins.inspect({ local: zip });
    await plugins.install({ stage: copy.stage });
    await assert.rejects(plugins.inspect({ local: plug }), /先在插件列表里卸载它/);
  } finally {
    plugins.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the run log: kept per plugin, the latest few hundred, cleared, gone with the plugin', async () => {
  const { plugins, dir } = await tempPlugins(async () => ({}));
  try {
    await assert.rejects(plugins.log({ id: '../x' }), /插件名无效/);
    assert.deepEqual(await plugins.log({ id: 'ai-daily' }), []);
    await plugins.log({
      id: 'ai-daily',
      add: [
        { at: 1, kind: 'run', text: '开始运行' },
        { at: 2, kind: 'bogus', text: 'x'.repeat(2000) },
      ],
    });
    const again = createPlugins({
      bundledDir: path.join(dir, 'bundled'),
      userDir: path.join(dir, 'user'),
      fetch: async () => ({}),
      atomicWrite,
      appVersion: '0.30.0',
    });
    const kept = await again.log({ id: 'ai-daily' });
    assert.equal(kept.length, 2);
    assert.equal(kept[1].kind, 'script');
    assert.equal(kept[1].text.length, 800);
    await plugins.log({
      id: 'ai-daily',
      add: Array.from({ length: 200 }, (_, i) => ({ at: i, kind: 'tool', text: `t${i}` })),
    });
    await plugins.log({
      id: 'ai-daily',
      add: Array.from({ length: 300 }, (_, i) => ({ at: i, kind: 'tool', text: `u${i}` })),
    });
    const capped = await plugins.log({ id: 'ai-daily' });
    // 200 at a time at most, 400 kept.
    assert.equal(capped.length, 400);
    assert.equal(capped.at(-1).text, 'u199');
    assert.deepEqual(await plugins.log({ id: 'ai-daily', clear: true }), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the plugin directory: read from the first address that answers, bad entries skipped', async () => {
  const body = {
    version: 1,
    plugins: [
      {
        id: 'good-one',
        name: '好插件',
        author: 'A',
        description: '做事',
        repo: 'https://github.com/a/b/tree/main/x',
        tags: ['日报', 1],
      },
      { id: 'good-one', name: '重复', repo: 'https://github.com/a/c' },
      { id: 'Bad Id', name: 'x', repo: 'https://github.com/a/b' },
      { id: 'elsewhere', name: 'x', repo: 'https://example.com/a/b' },
      { id: 'no-name', repo: 'https://github.com/a/b' },
      { id: 'on-gitee', name: '码云', repo: 'https://gitee.com/a/b' },
    ],
  };
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (url.includes('down')) throw Error('ECONNRESET');
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(JSON.stringify(body)) };
  };
  const { plugins, dir } = await tempPlugins(fetch, {
    directoryUrls: ['https://down.example/list.json', 'https://up.example/list.json'],
  });
  try {
    const got = await plugins.directory();
    assert.equal(got.from, 'up.example');
    assert.deepEqual(
      got.plugins.map((p) => p.id),
      ['good-one', 'on-gitee'],
    );
    assert.deepEqual(got.plugins[0].tags, ['日报']);
    assert.equal(got.plugins[0].repo, 'https://github.com/a/b/tree/main/x');
    // Kept for a while; read again when asked.
    await plugins.directory();
    assert.equal(calls.length, 2);
    await plugins.directory({ refresh: true });
    assert.equal(calls.length, 4);
    assert.throws(() => cleanDirectory({ plugins: [] }), /格式不对/);
    const { plugins: offline, dir: dir2 } = await tempPlugins(async () => {
      throw Error('offline');
    });
    await assert.rejects(offline.directory(), /读不到插件目录：offline/);
    await fs.rm(dir2, { recursive: true, force: true });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('installing from the directory: the repository must hold the plugin it lists', async () => {
  const gh = fakeGitHub({
    'folio-plugin.json': JSON.stringify(thirdManifest),
    'prompt.md': '写摘要',
    'main.js': 'folio.registerTool({ name: "hello" }, () => "hi")',
  });
  const { plugins, dir } = await tempPlugins(gh.fetch);
  try {
    await plugins.setThirdParty({ on: true });
    await assert.rejects(
      plugins.inspect({ url: 'https://github.com/me/plug', expect: 'something-else' }),
      /目录里写的是「something-else」/,
    );
    const seen = await plugins.inspect({
      url: 'https://github.com/me/plug',
      expect: 'paper-digest',
    });
    assert.equal(seen.manifest.id, 'paper-digest');
    assert.ok(Array.isArray(seen.warnings));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the sandbox page waits for a script's own setup and says which of its lines failed", () => {
  const html = sandboxPage({ code: 'one();\ntwo();', settings: {}, name: '名字\n换行' });
  const lines = html.split('\n');
  const at = lines.indexOf('one();') + 1;
  assert.ok(at > 1);
  assert.equal(Number(html.match(/e\.lineno > (\d+)/)[1]), at - 1);
  assert.match(html, /<title>名字 换行<\/title>/);
  assert.match(html, /!pending\.size && tools\.size === last/);
  assert.match(html, /注册得太晚/);
});
