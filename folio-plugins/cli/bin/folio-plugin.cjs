#!/usr/bin/env node
// folio-plugin：写页间（Folio）插件用的命令行工具。
//
//   folio-plugin init [文件夹] [--project] [--script]   新建一个插件
//   folio-plugin validate [文件夹] [--app-version x.y.z] [--json]
//                                                     按页间的规则检查插件
//   folio-plugin pack [文件夹] [-o 输出.zip]           检查后打成 .zip，可以拖进页间安装
//
// 检查规则和页间用的是同一份代码（lib/manifest.cjs），这里能通过，页间就能装。
const fs = require('node:fs/promises');
const path = require('node:path');
const { readPluginDir, MANIFEST, BUILTIN_VARS } = require('../lib/manifest.cjs');
const { writeZip } = require('../lib/zip.cjs');

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = (s) => paint(31, s);
const green = (s) => paint(32, s);
const yellow = (s) => paint(33, s);
const dim = (s) => paint(2, s);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--project' || a === '--script' || a === '--help' || a === '-h')
      args[a.replace(/^-+/, '')] = true;
    else if (a === '--app-version') args.appVersion = argv[++i];
    else if (a === '-o' || a === '--out') args.out = argv[++i];
    else args._.push(a);
  }
  return args;
}

const help = `folio-plugin：写页间（Folio）插件用的工具

用法：
  folio-plugin init [文件夹] [--project] [--script]
      新建一个插件。默认在自己的文件夹里工作（run.where = "folder"）；
      --project 改成在打开的项目里工作；--script 带一个脚本，演示怎样给 AI 加工具。
  folio-plugin validate [文件夹] [--app-version 0.30.0] [--json]
      按页间的规则检查插件：清单、文件、权限和大小。有错误时退出码为 1。
  folio-plugin pack [文件夹] [-o 输出.zip]
      检查通过后打成 .zip（只包含 files 里列出的文件），可以拖进页间安装。

文档：https://github.com/XiangXiaoYuan5254/folio-plugins`;

async function validate(dir, args) {
  try {
    const result = await readPluginDir(dir, { appVersion: args.appVersion });
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            id: result.manifest.id,
            version: result.manifest.version,
            files: result.files,
            warnings: result.warnings,
          },
          null,
          2,
        ),
      );
    } else {
      const size = result.files.reduce((n, f) => n + f.size, result.raw.length);
      console.log(
        `${green('✓')} ${result.manifest.name}（${result.manifest.id} ${result.manifest.version}）可以安装 ${dim(`${result.files.length + 1} 个文件，${Math.max(1, Math.round(size / 1024))} KB`)}`,
      );
      for (const w of result.warnings) console.log(`  ${yellow('!')} ${w}`);
    }
    return result;
  } catch (e) {
    if (args.json) console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
    else console.error(`${red('✗')} ${path.resolve(dir)}：${e.message}`);
    process.exitCode = 1;
    return null;
  }
}

async function pack(dir, args) {
  const result = await validate(dir, { ...args, json: false });
  if (!result) return;
  const { manifest, raw } = result;
  const files = [{ name: `${manifest.id}/${MANIFEST}`, data: raw }];
  for (const f of manifest.files)
    files.push({
      name: `${manifest.id}/${f}`,
      data: await fs.readFile(path.join(result.dir, f)),
    });
  const out = path.resolve(args.out || `${manifest.id}-${manifest.version}.zip`);
  await fs.writeFile(out, writeZip(files));
  console.log(`${green('✓')} 已打包：${out}`);
}

async function init(dir, args) {
  const target = path.resolve(dir);
  const id =
    path
      .basename(target)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'my-plugin';
  const existing = await fs.readdir(target).catch(() => []);
  if (existing.includes(MANIFEST)) {
    console.error(`${red('✗')} ${target} 里已经有 ${MANIFEST}`);
    process.exitCode = 1;
    return;
  }
  const project = !!args.project;
  const script = !!args.script;
  const files = ['prompt.md', 'template.html'];
  if (script) files.push('tools.js');
  const manifest = {
    $schema:
      'https://raw.githubusercontent.com/XiangXiaoYuan5254/folio-plugins/main/schema/folio-plugin.schema.json',
    folio: 1,
    id: id.length >= 2 ? id : 'my-plugin',
    name: '我的插件',
    version: '0.1.0',
    author: '',
    description: '一句话说明它会做什么、结果放在哪里。',
    engines: { folio: '>=0.30.0' },
    files,
    run: {
      prompt: 'prompt.md',
      template: 'template.html',
      ...(script ? { script: 'tools.js' } : {}),
      tools: project
        ? ['list_files', 'read_document', 'create_html']
        : ['list_files', 'read_document', 'fetch_url', 'create_html'],
      ...(project ? {} : { where: 'folder' }),
    },
    triggers: [{ type: 'button', label: '立即运行' }],
    permissions: {
      // Reading the web, or a script (which reaches it through folio.fetch), names its sites.
      ...(!project || script ? { network: ['example.com'] } : {}),
      write: ['{{output}}'],
    },
    settings: [
      {
        key: 'output',
        type: 'folder',
        label: project ? '写到项目里的哪个文件夹' : '结果放在哪个文件夹',
        default: project ? '插件输出' : '我的插件',
      },
    ],
  };
  const prompt = `# 任务：${project ? '整理项目「{{project}}」' : '写今天（{{today}}）的报告'}

在这里用自然语言写清楚 AI 要做什么：读哪些资料、怎么挑选、写成什么样。

## 1. 先看以前写过什么

用 list_files 看看已经有哪些文件，避免重复。

## 2. 读取资料

${project ? '用 read_document 读需要的文档。' : '用 fetch_url 读 https://example.com/ （只能访问 permissions.network 里写明的网站）。'}${script ? '\n\n也可以用插件脚本提供的 word_count 工具数一数字数。' : ''}

## 3. 写成 HTML

用 create_html 新建 \`{{today}} 报告.html\`，照「输出模板」的结构和样式写。

写完后用一两句话告诉我文件名。

<!-- 可以用的变量：{{设置项}}，以及 ${BUILTIN_VARS.map((v) => `{{${v}}}`).join('、')} -->
`;
  const template = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>{{today}} 报告</title>
<style>
  body { max-width: 760px; margin: 48px auto; padding: 0 24px; font: 17px/1.8 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: #24303c; }
  h1 { font-size: 30px; margin-bottom: 4px; }
  .meta { color: #6b7785; font-size: 14px; }
  .item { border: 1px solid #e6ebf0; border-radius: 12px; padding: 14px 18px; margin: 12px 0; }
</style>
</head>
<body>
<h1>{{today}} 报告</h1>
<p class="meta">{{weekday}}</p>
<article class="item">
  <h3><a href="https://example.com">标题（链接到原文）</a></h3>
  <p>两三句话说明是什么、为什么值得看。</p>
</article>
</body>
</html>
`;
  const tools = `// 插件脚本：在一个看不见的沙箱里运行，不能自己联网、读写文件或访问页间界面。
// 用全局对象 folio 给 AI 增加工具；类型说明见
// https://github.com/XiangXiaoYuan5254/folio-plugins/blob/main/types/folio.d.ts
/// <reference path="./folio.d.ts" />

folio.registerTool(
  {
    name: 'word_count',
    description: '数一段文字有多少个字（中文按字，英文按词）。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要数的文字' } },
      required: ['text'],
    },
  },
  ({ text }) => {
    const cjk = (text.match(/[\\u4e00-\\u9fff]/g) || []).length;
    const words = text.replace(/[\\u4e00-\\u9fff]/g, ' ').trim().split(/\\s+/).filter(Boolean).length;
    folio.log('数了一段文字：', cjk, '个汉字，', words, '个词');
    return { cjk, words, total: cjk + words };
  },
);
`;
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(path.join(target, 'prompt.md'), prompt);
  await fs.writeFile(path.join(target, 'template.html'), template);
  if (script) {
    await fs.writeFile(path.join(target, 'tools.js'), tools);
    // Types for the folio object, so an editor checks the script (not part of the plugin).
    const types = await fs
      .readFile(path.join(__dirname, '../types/folio.d.ts'), 'utf8')
      .catch(() => fs.readFile(path.join(__dirname, '../../types/folio.d.ts'), 'utf8'))
      .catch(() => '');
    if (types) {
      await fs.writeFile(path.join(target, 'folio.d.ts'), types);
      await fs.writeFile(
        path.join(target, 'jsconfig.json'),
        JSON.stringify(
          {
            compilerOptions: { checkJs: true, target: 'ES2022', lib: ['ES2022', 'DOM'] },
            include: ['tools.js', 'folio.d.ts'],
          },
          null,
          2,
        ) + '\n',
      );
    }
  }
  console.log(`${green('✓')} 新建了插件 ${target}`);
  console.log(
    dim(
      '  下一步：改好 folio-plugin.json 和 prompt.md，然后在页间「设置 › 插件」里点「从文件夹加载…」选这个文件夹。',
    ),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, dir = '.'] = args._;
  if (!command || args.help || args.h) return console.log(help);
  if (command === 'validate' || command === 'check') return validate(dir, args);
  if (command === 'pack') return pack(dir, args);
  if (command === 'init') return init(dir, args);
  console.error(`不认识的命令：${command}\n\n${help}`);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(red(e.stack || e.message));
  process.exitCode = 1;
});
