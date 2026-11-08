const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFonts, fontDirs, readFontFile } = require('../electron/fonts.cjs');
const { face, collection } = require('./font-file.cjs');

const zh = 0x804;

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'folio-fonts-'));
}

test('字体文件里的中文名：英文家族名对上中文名，系统可能用的每个名字都认得', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'Roboto-Regular.ttf');
  await fs.writeFile(
    file,
    face([
      { id: 1, value: 'MCHNLTHXKS Light' },
      { id: 1, value: '每次和你聊天 细体', lang: zh },
      { id: 16, value: 'MCHNLTHXKS' },
      { id: 16, value: '每次和你聊天好像考试', lang: zh },
      { id: 4, value: 'MCHNLTHXKS Light 全名不算家族名' },
    ]),
  );
  assert.deepEqual(await readFontFile(file), [
    {
      family: 'MCHNLTHXKS',
      aliases: ['MCHNLTHXKS Light', '每次和你聊天 细体', 'MCHNLTHXKS', '每次和你聊天好像考试'],
      names: {
        'MCHNLTHXKS Light': '每次和你聊天 细体',
        '每次和你聊天 细体': '每次和你聊天 细体',
        MCHNLTHXKS: '每次和你聊天好像考试',
        每次和你聊天好像考试: '每次和你聊天好像考试',
      },
    },
  ]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('字体集 .ttc 的每个字形都读到；Mac 平台的 GBK 中文名也认得', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'Songti.ttc');
  await fs.writeFile(
    file,
    collection([
      [
        { id: 1, value: 'Songti SC' },
        // 宋体 in GBK, on the Mac platform (1), simplified Chinese (33).
        { id: 1, platform: 1, encoding: 25, lang: 33, bytes: Buffer.from('cbcecce5', 'hex') },
      ],
      [
        { id: 1, value: 'Songti TC' },
        { id: 1, value: '宋體-繁', lang: 0x404 },
      ],
    ]),
  );
  const faces = await readFontFile(file);
  assert.deepEqual(
    faces.map((f) => [f.family, f.names[f.family]]),
    [
      ['Songti SC', '宋体'],
      ['Songti TC', '宋體-繁'],
    ],
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('读装好的字体：坏文件跳过，新装的出现，改过的重读，删掉的不再列出', async () => {
  const dir = await tempDir();
  const fonts = createFonts(() => [dir, path.join(dir, '不存在')]);
  await fs.writeFile(path.join(dir, 'broken.ttf'), 'not a font');
  await fs.writeFile(path.join(dir, 'notes.txt'), 'ignored');
  await fs.mkdir(path.join(dir, 'Family'));
  await fs.writeFile(
    path.join(dir, 'Family', 'A-Regular.otf'),
    face([
      { id: 1, value: 'Alpha' },
      { id: 1, value: '阿尔法', lang: zh },
    ]),
  );
  // Another face of the same family: one family, its names together.
  await fs.writeFile(
    path.join(dir, 'Family', 'A-Bold.otf'),
    face([
      { id: 1, value: 'Alpha Bold' },
      { id: 16, value: 'Alpha' },
    ]),
  );
  let found = await fonts.installed();
  assert.deepEqual(
    found.families.map((f) => [f.family, f.aliases.sort()]),
    [['Alpha', ['Alpha', 'Alpha Bold', '阿尔法']]],
  );
  assert.deepEqual(found.names, { Alpha: '阿尔法', 阿尔法: '阿尔法' });

  // Installed meanwhile, with no Chinese name.
  await fs.writeFile(path.join(dir, 'Beta.ttf'), face([{ id: 1, value: 'Beta' }]));
  found = await fonts.installed();
  assert.deepEqual(found.families.map((f) => f.family).sort(), ['Alpha', 'Beta']);
  assert.equal(found.names.Beta, undefined);

  // Replaced by a version with a Chinese name, then removed.
  const beta = path.join(dir, 'Beta.ttf');
  await fs.writeFile(
    beta,
    face([
      { id: 1, value: 'Beta' },
      { id: 1, value: '贝塔字体', lang: zh },
    ]),
  );
  await fs.utimes(beta, new Date(), new Date(Date.now() + 5000));
  assert.equal((await fonts.installed()).names.Beta, '贝塔字体');
  await fs.rm(beta);
  found = await fonts.installed();
  assert.deepEqual(
    found.families.map((f) => f.family),
    ['Alpha'],
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('装字体的文件夹：Mac 和 Windows 各自的，用户自己的在前', () => {
  assert.deepEqual(fontDirs({}, 'darwin', '/Users/me'), [
    '/Users/me/Library/Fonts',
    '/Library/Fonts',
  ]);
  const windows = fontDirs(
    { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', WINDIR: 'C:\\Windows' },
    'win32',
    'C:\\Users\\me',
  );
  assert.equal(windows.length, 2);
  assert.match(windows[0], /AppData.Local.Microsoft.Windows.Fonts$/);
  assert.match(windows[1], /^C:\\Windows.Fonts$/);
  assert.deepEqual(
    fontDirs({ FOLIO_FONT_DIRS: ['/a', '/b'].join(path.delimiter) }, 'darwin', '/x'),
    ['/a', '/b'],
  );
});

test('给字体列表：系统列表里已有的（按任一名字、不分大小写）不再检查，其余只留显示得出的', async () => {
  const dir = await tempDir();
  await fs.writeFile(
    path.join(dir, 'a.ttf'),
    face([
      { id: 1, value: 'Alpha Light' },
      { id: 16, value: 'Alpha' },
      { id: 16, value: '阿尔法', lang: zh },
    ]),
  );
  await fs.writeFile(path.join(dir, 'b.ttf'), face([{ id: 1, value: 'Beta' }]));
  await fs.writeFile(path.join(dir, 'c.ttf'), face([{ id: 1, value: 'Gamma' }]));
  const fonts = createFonts(() => [dir]);
  const asked = [];
  const result = await fonts.forList(['alpha light', 'Helvetica'], async (families) => {
    asked.push(...families);
    return families.filter((f) => f === 'Gamma');
  });
  assert.deepEqual(asked.sort(), ['Beta', 'Gamma']);
  assert.deepEqual(result.added, ['Gamma']);
  assert.equal(result.names['Alpha Light'], '阿尔法');
  // Nothing to check: no page is opened; a failed check adds nothing.
  assert.deepEqual(
    (await fonts.forList(['Alpha', 'Beta', 'Gamma'], () => assert.fail('不该检查'))).added,
    [],
  );
  assert.deepEqual((await fonts.forList([], async () => Promise.reject(Error('x')))).added, []);
  await fs.rm(dir, { recursive: true, force: true });
});
