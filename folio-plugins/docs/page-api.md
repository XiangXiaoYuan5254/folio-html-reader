# 页面 API

页面是插件自己的一整页 HTML，在页间的阅读区里开成一个标签页，入口在左边文件树下面（「文献库」那一栏）。它适合做仪表盘、看板、卡片盒这类“换一种方式看你的资料”的东西。官方插件「论文仪表盘」就是一个页面：把文献库画成进度环、书墙、阅读日历和各种分布。

页面可以读（清单里写明后也可以改）项目的**文献库**：项目里的论文，每篇的标题、作者、年份、出处、读没读过、标签、分类、总结，以及读者在它的文件里划的重点和写的笔记。

## 清单

在 `folio-plugin.json` 里写 `"folio": 2` 和一个 `page`。只有页面的插件可以不写 `run`：它不让 AI 干活，也就没有运行按钮和定时。一个插件可以既有页面、又有 AI 任务或挂件。

```json
{
  "folio": 2,
  "id": "reading-stats",
  "name": "阅读统计",
  "version": "0.1.0",
  "description": "按月统计读了几篇论文。",
  "engines": { "folio": ">=0.33.0" },
  "files": ["index.html", "page.js"],
  "page": {
    "entry": "index.html",
    "title": "阅读统计",
    "library": "read"
  }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `page.entry` | ✓ | 页面，`files` 里的一个 `.html`。 |
| `page.title` | | 标签页和侧栏里显示的名字，最多 24 个字；不写就用插件的名字。 |
| `page.library` | | 能不能用文献库：`"read"` 只读，`"write"` 还能增删论文、改信息和阅读状态。不写就用不了 `folio.library`。安装时会如实列给用户看。 |

带页面的插件可以放图片、字体和音频，`.js` 文件不限个数；最多 200 个文件，每个不超过 20 MB，合计不超过 50 MB（和带挂件的插件一样）。

## 运行环境

- 页面在一个 `sandbox="allow-scripts"` 的 iframe 里，占满阅读区。它看不到页间的界面、项目里的文件和 API Key，没有 `localStorage` 和 Cookie（自己的存储用 `folio.storage`）。
- **可以自己联网**：`fetch`、`WebSocket`、网上的图片、音频和字体都能用（受浏览器的跨域规则限制），和挂件一样，不用在 `permissions.network` 里写。安装时用户会看到“页面可以自己访问任何网站”；要了文献库的页面还会写明“可能把它看到的文献库和笔记发出去”。不需要联网的页面就别联网，在说明里写清楚，用户更放心。
- **代码只能来自插件包**：`<script src>` 只能指向插件里的文件；页面里写死的 `<script>` 可以运行，运行时再拼出来的 `<script>`、`eval`、`new Function`、`<div onclick="…">` 这种内联事件都不行。事件请用 `addEventListener`。
- 链接和 `window.open` 打不开新窗口：打开项目里的文档用 `folio.open`，打开网页用 `folio.openExternal`。
- 标签页切走时页面还开着（收到 `visible` 事件），关掉标签页才卸载；换项目会关掉所有页面。
- 开发时用「从文件夹加载…」加载插件，页面右下角有一个重新载入的小按钮，改完文件点一下。

## `folio` 对象

页间在页面最前面放了一个全局对象 `folio`：

```ts
interface FolioPage {
  /** 插件的设置项（清单里的 settings），用户改过的值。 */
  readonly settings: Readonly<Record<string, string>>;
  /** 当前主题。先订阅 'theme' 再读，订阅时会马上收到一次。 */
  readonly theme: { dark: boolean; accent: string; reducedMotion: boolean };
  /** 清单里的 page：标题和对文献库的权限。 */
  readonly page: { title: string; library: '' | 'read' | 'write' };
  /**
   * 订阅事件，返回取消订阅的函数。订阅时马上收到一次当前的值。
   * - 'theme'：页间换了主题；
   * - 'visible'：{ visible }，标签页是不是正在显示，看不见时最好停掉动画；
   * - 'library'：文献库变了（标了已读、加了论文……），该重新读一遍了。要有 page.library。
   */
  on(event: 'theme' | 'visible' | 'library', listener: (data: any) => void): () => void;
  /** 在阅读区打开项目里的一篇文档（项目内路径，如 "论文/attention.pdf"）。 */
  open(path: string): Promise<void>;
  /** 用系统浏览器打开一个 http(s) 网页。 */
  openExternal(url: string): Promise<void>;
  /** 打开的项目：{ name }。 */
  project(): Promise<{ name: string }>;
  /** 页面自己的存储：一个 JSON 值，最多 5 MB，卸载插件时删除。 */
  storage: { get(): Promise<unknown>; set(value: unknown): Promise<void> };
  /** 写进插件卡片上的运行日志。 */
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** 文献库。清单里写了 page.library 才有。 */
  library: {
    /** 所有论文和书单。 */
    list(): Promise<{ papers: FolioPaper[]; lists: FolioReadingList[] }>;
    /** 一篇论文，带上读者在它每个文件里划的重点、写的便签和文档笔记。 */
    get(id: string): Promise<FolioPaper & { documents: FolioPaperDocument[] }>;
    // 下面几个要 "library": "write"。
    /** 只改给出的字段。标为 done 时页间记下当天（也可以自己给 readAt）。 */
    update(id: string, patch: Partial<FolioPaper>): Promise<FolioPaper>;
    /** 新增一篇；已经有（DOI、arXiv 号或标题相同）就只补它空着的字段。 */
    add(paper: Partial<FolioPaper> & { title: string }): Promise<{ paper: FolioPaper; created: boolean }>;
    /** 移出文献库，文件不动。 */
    remove(id: string): Promise<number>;
    /** 新建或替换一个书单；papers 为空就删掉它。 */
    setList(list: { name: string; note?: string; papers: string[] }): Promise<number>;
  };
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
  tags: string[];
  /** 分类，层级用 "/" 分开；空着时可以按文件所在的文件夹算。 */
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

## 一个最小的页面

`index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <style>
      body { font: 15px/1.7 system-ui; margin: 40px; }
      [data-dark] body { background: #111; color: #eee; }
      li { cursor: pointer; }
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

完整的例子见官方插件 [论文仪表盘](https://github.com/XiangXiaoYuan5254/folio-html-reader/tree/main/plugins/paper-dashboard)。

## 调试

1. 在页间里打开「设置 › 插件」，用「从文件夹加载…」加载你的插件，打开它。
2. 左边文件树下面会出现你的页面，点开。改了文件，点页面右下角的重新载入。
3. 页面里的错误（带文件名和行号）和 `folio.log` 的输出在插件卡片的「运行日志」里。
