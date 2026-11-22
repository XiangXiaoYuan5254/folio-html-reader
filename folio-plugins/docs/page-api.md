# 页面和后台脚本 API

插件可以给页间加一整块功能，而不只是让 AI 干活。用到的有两样东西：

- **页面（page）**：插件自己的一整页 HTML，在阅读区里开成一个标签页，入口在左边文件树下面。适合做仪表盘、看板、卡片盒，或者一个完整的小应用。
- **后台脚本（background）**：一页看不见的 HTML，插件开着、打开了项目时一直在跑。它能在文件树上给文件加标记和右键菜单、在读者读到某处时发通知、实现给 AI 用的工具。

官方插件「文献库」就是这么做出来的，没有用任何页间内部的东西。它的页面是论文列表，后台脚本做这些事：

- 给文件树上的论文标已读、在读；
- 给右键菜单加「加入文献库…」；
- 读到结尾时问要不要标为已读；
- 实现 `list_library`、`get_paper`、`update_library` 三个工具，给 AI 助手和其他 AI 工具用。

源码在 [plugins/library](https://github.com/XiangXiaoYuan5254/folio-html-reader/tree/main/plugins/library)。

## 清单

```json
{
  "folio": 2,
  "id": "reading-stats",
  "name": "阅读统计",
  "version": "0.1.0",
  "description": "按月统计读了几篇论文，在文件树上标出本月读完的。",
  "engines": { "folio": ">=0.33.0" },
  "files": ["index.html", "page.js", "background.html", "background.js"],
  "page": { "entry": "index.html", "title": "阅读统计" },
  "background": "background.html",
  "permissions": {
    "library": "read",
    "documents": "read",
    "fileTree": true
  },
  "aiTools": [
    {
      "name": "reading_stats",
      "title": "阅读统计",
      "description": "按月统计读者读完了几篇论文。问“这个月读了多少”时用。",
      "parameters": {
        "type": "object",
        "properties": { "month": { "type": "string", "description": "如 2026-11，不写就是本月" } }
      },
      "mcp": true
    }
  ],
  "dependencies": ["library"]
}
```

| 字段 | 说明 |
| --- | --- |
| `page.entry` | 页面，`files` 里的一个 `.html`。 |
| `page.title` | 标签页和侧栏里显示的名字，最多 24 个字；不写就用插件的名字。 |
| `background` | 后台脚本，`files` 里的一个 `.html`（不能和页面是同一个）。 |
| `permissions.library` | 文献库：`"read"` 只读，`"write"` 还能增删论文、改信息和阅读状态。 |
| `permissions.documents` | `"read"`：读项目里的文档列表、文档的文字，以及读者在上面划的重点和笔记。 |
| `permissions.fileTree` | `true`：在文件树上给文件加标记和右键菜单。 |
| `aiTools` | 给 AI 的工具，由后台脚本实现，见下面「给 AI 的工具」。 |
| `dependencies` | 要和哪些插件一起用（插件 id）。安装时会写出来；用到它们的工具而它们没装、没开时，会提示先装上。 |

只有页面或后台脚本的插件可以不写 `run`。一个插件可以既有页面、后台脚本，又有 AI 任务或挂件。

`permissions` 里的这几项，安装前都会如实列给用户看。页面和后台脚本都能自己联网，所以要了文献库或文档的社区插件，用户会看到“可能把看到的文献库、文档和笔记发出去”。不需要联网的插件就别联网，在说明里写清楚，用户更放心。

带页面或后台脚本的插件可以放图片、字体和音频，`.js` 文件不限个数；最多 200 个文件，每个不超过 20 MB，合计不超过 50 MB。

### 设置项

`settings` 除了 `text`、`textarea`、`folder`，还可以是 `select`，从几个选项里选一个：

```json
{
  "key": "ranking",
  "type": "select",
  "label": "渠道分级",
  "options": [
    { "value": "none", "label": "不分级" },
    { "value": "ccf", "label": "CCF 等级（计算机方向）" }
  ],
  "default": "none"
}
```

页面和后台脚本从 `folio.settings` 读到用户选的值；用户改了设置，它们会重新载入。

## 运行环境

- 页面和后台脚本各在一个 `sandbox="allow-scripts"` 的 iframe 里，看不到页间的界面、项目里的文件和 API Key，没有 `localStorage` 和 Cookie（自己的存储用 `folio.storage`）。
- **可以自己联网**：`fetch`、`WebSocket`、网上的图片、音频和字体都能用（受浏览器的跨域规则限制）。
- **代码只能来自插件包**：`<script src>` 只能指向插件里的文件；页面里写死的 `<script>` 可以运行，运行时再拼出来的 `<script>`、`eval`、`new Function`、`<div onclick="…">` 这种内联事件都不行。事件请用 `addEventListener`。用 React、Vue 写的，打包成普通的 `.js`（不要用 `type="module"`）。
- **表单不会提交**：沙箱里 `<form>` 的提交会被拦下，`submit` 事件也不会触发。保存按钮请直接监听 `click`。
- 链接和 `window.open` 打不开新窗口：打开项目里的文档用 `folio.open`，打开网页用 `folio.openExternal`。
- 页面：标签页切走时还开着（收到 `visible` 事件），关掉标签页才卸载。后台脚本：换项目、改设置、关掉插件时重新载入或停下。
- 开发时用「从文件夹加载…」加载插件：页面右下角有重新载入的按钮；后台脚本在你保存文件后自动重新载入。

## `folio` 对象

页面和后台脚本里都有一个全局对象 `folio`。下面标着「页面」的只在页面里有，标着权限的要在清单里写了才有。

```ts
interface Folio {
  readonly settings: Readonly<Record<string, string>>;
  /** 当前主题。id 是主题名（default、night……），bold 是不是粗犷风格的主题。 */
  readonly theme: {
    dark: boolean;
    accent: string;
    reducedMotion: boolean;
    id: string;
    bold: boolean;
  };
  /** 清单里的页面（没有就是 null）。 */
  readonly page: { title: string } | null;
  readonly permissions: { library: '' | 'read' | 'write'; documents: boolean; fileTree: boolean };

  /** 订阅事件，返回取消订阅的函数。带状态的事件，订阅时会马上收到一次当前的值。 */
  on(event: string, listener: (data: any) => void): () => void;

  /** 在阅读区打开项目里的一篇文档（项目内路径，如 "论文/attention.pdf"）。 */
  open(path: string): Promise<void>;
  /** 用系统浏览器打开一个 http(s) 网页。 */
  openExternal(url: string): Promise<void>;
  /** 打开的项目：{ name }。 */
  project(): Promise<{ name: string }>;
  /** 在页间底部显示一条通知。给了 action 就带一个按钮，用户点了就 resolve 成 true。 */
  notify(text: string, options?: { action?: string }): Promise<boolean>;
  /** 打开「设置 › 插件」。 */
  openSettings(): Promise<void>;
  /** 打开（或切到）插件的页面；给了 data，页面会收到 request 事件。有页面的插件才有。 */
  showPage(data?: unknown): Promise<void>;
  /** 侧栏里页面入口旁边的小字，比如 "12/30"；'' 不显示。有页面的插件才有。 */
  setBadge(text: string): Promise<void>;

  /** 插件自己的存储：一个 JSON 值，最多 5 MB，页面和后台脚本共用，卸载插件时删除。 */
  storage: { get(): Promise<unknown>; set(value: unknown): Promise<void> };
  /** 写进插件卡片上的运行日志。 */
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;

  /** permissions.library */
  library: FolioLibrary;
  /** permissions.documents */
  documents: {
    /** 项目里的文档：路径和类型（pdf、html、markdown、image、word、code）。code 是代码和纯文本。 */
    list(): Promise<{ path: string; kind: string }[]>;
    /** 一篇文档的标题和文字（PDF 也行），最多 maxChars 个字（默认 20 万）。 */
    read(
      path: string,
      options?: { maxChars?: number },
    ): Promise<{ path: string; title: string; text: string }>;
    /** 读者在这篇文档里留下的：文档笔记、划的重点（和写在上面的批注）、便签上的字。 */
    annotations(path: string): Promise<{
      note: string;
      highlights: { text: string; note: string; by?: 'ai' }[];
      notes: string[];
    }>;
  };
  /** permissions.fileTree */
  tree: { set(decor: TreeDecor): Promise<void> };
  /** 后台脚本，清单里有 aiTools 时 */
  tools: { handle(name: string, handler: ToolHandler): void };
}
```

### 事件

| 事件 | 谁能收到 | 内容 |
| --- | --- | --- |
| `theme` | 都能 | 页间换了主题：`folio.theme` 的新值。 |
| `visible` | 页面 | `{ visible }`：标签页是不是正在显示，看不见时最好停掉动画。 |
| `document` | 都能 | `{ path, kind, title }`：阅读区里正在看的文档（没有时 path 是 ''）。 |
| `progress` | 都能 | `{ path, progress }`：正在看的文档读到了哪里，0–100。 |
| `created` | 都能 | `{ path, source, by }`：页间新做了一篇文档。by 是 `companion`（精读笔记）或 `translation`（全文翻译），source 是它的原文。 |
| `library` | 要了 library | `{ version }`：文献库变了，该重新读一遍了。 |
| `menu` | 要了 fileTree | `{ id, path, kind }`：用户在文件树上点了你加的菜单项。有后台脚本时发给后台脚本，否则发给页面。 |
| `request` | 页面 | `folio.showPage(data)` 传来的 data。 |

### 文件树：标记和右键菜单

`folio.tree.set` 每次给出完整的一份，替换上一次的：

```ts
interface TreeDecor {
  /** 文件或文件夹（项目内路径）右边的小标记。 */
  badges?: Record<
    string,
    {
      icon?: 'check' | 'half' | 'dot' | 'star' | 'flag' | 'bookmark';
      text?: string; // 最多 2 个字，代替图标
      color?: string; // #rrggbb，不写用主题色
      title?: string; // 鼠标移上去显示
    }
  >;
  /** 某个文件或文件夹的右键菜单项，排在页间自己的菜单项前面。 */
  menus?: Record<string, { id: string; label: string }[]>;
  /** menus 里没写到的文件都有的菜单项；kinds 限定文件类型，如 ['pdf', 'html', 'markdown']。 */
  fileMenu?: { id: string; label: string; kinds?: string[] }[];
  /** menus 里没写到的文件夹都有的菜单项。 */
  folderMenu?: { id: string; label: string }[];
}
```

每个文件最多显示两个标记（来自不同的插件）。每处最多 6 个菜单项，每项最多 24 个字。用户点了，你收到 `menu` 事件：

```js
folio.tree.set({
  badges: { '论文/attention.pdf': { icon: 'check', title: '已读' } },
  fileMenu: [{ id: 'star', label: '加星标', kinds: ['pdf'] }],
});
folio.on('menu', ({ id, path }) => {
  if (id === 'star') folio.notify(`已加星标：${path}`);
});
```

插件关掉或卸载时，它加的标记和菜单项都会消失。

### 给 AI 的工具

清单的 `aiTools` 里写明工具的名字、标题、说明和参数（JSON Schema）。页间把它们交给 AI 助手（「整个项目」），由后台脚本实现：

| 字段 | 说明 |
| --- | --- |
| `name` | 小写字母、数字和 `_`，3–40 个字符，不能和页间自己的工具同名。 |
| `title` | 显示给用户看的名字，最多 24 个字。 |
| `description` | 给 AI 看的说明：做什么、什么时候用。写清楚，AI 才会在对的时候用它。 |
| `parameters` | 参数，`type` 为 `"object"` 的 JSON Schema。 |
| `write` | `true`：会改东西。AI 助手调用前，先把你给的预览给用户看，用户点「应用」才执行。 |
| `mcp` | `true`：用户在「设置 › 插件」里允许后，电脑上的其他 AI 工具（Claude Code、Codex 等）也能通过 MCP 调用。 |

```ts
type ToolHandler =
  | ((input: any, how: { via: 'assistant' | 'mcp' }) => unknown)
  | {
      /** write 的工具：要改什么。返回 { title?, items: [{ label, detail? }] }，或一句话。 */
      preview?: (input: any) => unknown;
      run: (input: any, how: { via: 'assistant' | 'mcp' }) => unknown;
    };
```

返回值交给 AI：字符串原样给，其他的转成 JSON。抛出的错误会作为出错信息交给 AI。`how.via` 告诉你是谁在调用：页间的 AI 助手（或插件的 AI 任务），还是电脑上的其他 AI 工具。通过 MCP 调用时**没有预览、不经用户确认**，所以只把可以放心交给别的程序的工具标上 `mcp`，必要时按 `via` 少做一些。比如文献库不让其他 AI 工具改阅读状态。

```js
folio.tools.handle('reading_stats', async ({ month }) => {
  const { papers } = await folio.library.list();
  const m = month || new Date().toISOString().slice(0, 7);
  const done = papers.filter((p) => p.readAt.startsWith(m));
  return `${m} 读完了 ${done.length} 篇：\n` + done.map((p) => `- ${p.title}`).join('\n');
});
```

AI 任务插件（`run`）也能用其他插件的工具：把工具名写进 `run.tools`，把那个插件写进 `dependencies`。比如官方的「文献综述」写了 `"dependencies": ["library"]`，用 `list_library` 和 `get_paper` 读文献库。

### 文献库

```ts
interface FolioLibrary {
  /** 所有论文和书单。 */
  list(): Promise<{ papers: FolioPaper[]; lists: FolioReadingList[] }>;
  /** 一篇论文，带上读者在它每个文件里划的重点、写的便签和文档笔记。 */
  get(id: string): Promise<FolioPaper & { documents: FolioPaperDocument[] }>;
  /** 到 OpenAlex 和 arXiv 查一篇论文（按标题、DOI 或 arXiv 号），match 是和查询对得上的程度，0–1。 */
  lookup(query: {
    title?: string;
    doi?: string;
    arxiv?: string;
  }): Promise<{ papers: FolioCandidate[]; notes: string[] }>;
  // 下面几个要 "library": "write"。
  /** 只改给出的字段。标为 done 时页间记下当天（也可以自己给 readAt）。 */
  update(id: string, patch: Partial<FolioPaper>): Promise<FolioPaper>;
  /** 新增一篇；已经有（DOI、arXiv 号或标题相同）就只补它空着的字段。 */
  add(
    paper: Partial<FolioPaper> & { title: string },
  ): Promise<{ paper: FolioPaper; created: boolean }>;
  /** 一次加或改好几篇：带 id 的是改那一篇；overwrite 时改写已有的字段，否则只补空着的。 */
  addMany(
    papers: (Partial<FolioPaper> & { id?: string })[],
    options?: { overwrite?: boolean },
  ): Promise<{ papers: FolioPaper[]; created: number; updated: number }>;
  /** 移出文献库，文件不动。 */
  remove(ids: string | string[]): Promise<number>;
  /** 新建或替换一个书单；papers 为空就删掉它。 */
  setList(list: { name: string; note?: string; papers: string[] }): Promise<number>;
  /** 让用户选个地方保存 BibTeX（不给 ids 就是全部）；取消了是 false。 */
  exportBibtex(ids?: string[]): Promise<number | false>;
  /** 导入 BibTeX：给了文字就用它，否则让用户选文件；取消了是 false。 */
  importBibtex(text?: string): Promise<{ created: number; updated: number } | false>;
}

interface FolioPaper {
  id: string;
  title: string;
  /** 别名：中文译名或通用简称。 */
  alias: string;
  authors: string[];
  /** 0 表示不知道。 */
  year: number;
  venue: string;
  doi: string;
  arxiv: string;
  pmid: string;
  url: string;
  abstract: string;
  /** 读者（或 AI）写的几句话总结，和更长的笔记。 */
  summary: string;
  note: string;
  /** 标签：随手的记号，一篇可以有好几个。 */
  tags: string[];
  /** 分类：一篇只归一类，层级用 "/" 分开；空着时可以按文件所在的文件夹算。 */
  category: string;
  citations: number;
  status: 'unread' | 'reading' | 'done';
  /** 标为已读的那天（YYYY-MM-DD）；没读或日期不详是 ''。 */
  readAt: string;
  /** 加入文献库的时间（毫秒）。 */
  addedAt: number;
  /** 它在项目里的文件；gone 是其中已经不在了的。 */
  files: string[];
  gone: string[];
}
interface FolioReadingList {
  name: string;
  note: string;
  /** 论文的 id，按顺序。 */
  papers: string[];
}
interface FolioPaperDocument {
  path: string;
  kind: 'html' | 'pdf' | 'markdown';
  /** 文档笔记（Markdown）。读者没打开过这个文件时，下面这些都没有。 */
  note?: string;
  highlights?: { text: string; note: string; by?: 'ai' }[];
  /** 便签和文本注释上写的字。 */
  notes?: string[];
}
```

文献库的数据存在项目的 `.html-reader/library.json` 里，几个插件可以共用：一个管录入（官方的「文献库」），一个画仪表盘，一个写综述。

## 一个最小的页面

`index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <style>
      body {
        font: 15px/1.7 system-ui;
        margin: 40px;
      }
      [data-dark] body {
        background: #111;
        color: #eee;
      }
      li {
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <h1 id="count"></h1>
    <ul id="list"></ul>
    <script src="page.js"></script>
  </body>
</html>
```

`page.js`：

```js
async function draw() {
  const { papers } = await folio.library.list();
  const done = papers.filter((p) => p.status === 'done');
  document.getElementById('count').textContent = `读完 ${done.length} / ${papers.length} 篇`;
  const list = document.getElementById('list');
  list.textContent = '';
  for (const p of papers) {
    const li = document.createElement('li');
    li.textContent = `${p.status === 'done' ? '✓ ' : ''}${p.title}`;
    // 点一下，在阅读区打开它的第一个文件。
    if (p.files[0]) li.addEventListener('click', () => folio.open(p.files[0]));
    list.appendChild(li);
  }
}
folio.on('theme', (t) => document.documentElement.toggleAttribute('data-dark', t.dark));
folio.on('library', draw); // 订阅时马上收到一次，之后文献库一变就再收到
```

## 调试

1. 在页间里打开「设置 › 插件」，用「从文件夹加载…」加载你的插件，打开它。
2. 左边文件树下面会出现你的页面，点开。改了页面的文件，点页面右下角的重新载入；后台脚本保存后自动重新载入。
3. 页面和后台脚本里的错误（带文件名和行号）和 `folio.log` 的输出，在插件卡片的「运行日志」里。
