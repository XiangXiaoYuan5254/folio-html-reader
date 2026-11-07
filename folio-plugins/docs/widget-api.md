# 挂件 API

挂件是一个常驻在页间窗口里的小页面，比如一个趴在 AI 助手输入框上的角色：AI 在想的时候她等着，回答时她忙起来，答完了跳一下。第一个挂件是社区形象“深深”（代码 MIT，美术按 CC BY-NC-SA 4.0，所以单独发布，不在这个仓库里）。

## 清单

在 `folio-plugin.json` 里写 `"folio": 2` 和一个 `widget`。只有挂件的插件可以不写 `run`：它不让 AI 干活，也就没有运行按钮和定时。

```json
{
  "folio": 2,
  "id": "desk-cat",
  "name": "桌边小猫",
  "version": "0.1.0",
  "description": "趴在 AI 输入框上的小猫，AI 在想的时候它歪头。",
  "files": ["widget.html", "widget.js", "cat.webp"],
  "widget": {
    "entry": "widget.html",
    "size": { "width": 84, "height": 91 },
    "anchor": "assistant",
    "events": ["ai", "reading"],
    "art": { "author": "某某", "license": "CC BY-NC-SA 4.0" }
  }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `widget.entry` | ✓ | 挂件的页面，`files` 里的一个 `.html`。 |
| `widget.size` | | 挂件的宽高（像素），各 24–1200，默认 160×160。 |
| `widget.anchor` | | 放在哪：`"assistant"`（AI 助手输入框的右上角，挂件下面四分之一压在输入框边上，输入框会给它让出位置），或窗口的一个角 `"bottom-right"`（默认）、`"bottom-left"`、`"top-right"`、`"top-left"`。 |
| `widget.events` | | 要订阅的事件：`"ai"`、`"reading"`、`"document"`，见下文。安装时会逐条列给用户看。 |
| `widget.art` | | 美术素材的作者和许可证（`author`、`license`），写了就显示在安装卡片上。 |

带挂件的插件可以放图片、字体和音频（`.png .webp .gif .jpg .jpeg .avif .woff .woff2 .ttf .otf .mp3 .wav .ogg .m4a`），`.js` 文件不限个数；最多 200 个文件，每个不超过 20 MB，合计不超过 50 MB。

## 运行环境

- 挂件在一个 `sandbox="allow-scripts"` 的 iframe 里，背景透明。它看不到页间的界面、用户的文件和 API Key，没有 `localStorage` 和 Cookie（自己的存储用 `folio.storage`）。
- **可以自己联网**：`fetch`、`WebSocket`、网上的图片、音频和字体都能用（受浏览器的跨域规则限制）。安装时用户会看到“挂件可以自己访问任何网站”。
- **代码只能来自插件包**：`<script src>` 只能指向插件里的文件；页面里写死的 `<script>` 可以运行，运行时再拼出来的 `<script>`、`eval`、`new Function`、`<div onclick="…">` 这种内联事件都不行，也不能加载 WebAssembly。这样收录时看到的就是运行的。
- 每个挂件在单独的进程里。挂件卡住（比如死循环）12 秒没有响应，页间会关掉它并在运行日志里写明，下次打开页间再加载。
- 鼠标移到挂件上，页间会在右上角显示一个收起按钮，用户随时可以把它收起来（下次打开页间再出现），在「设置 › 插件」里可以关掉。

## `folio` 对象

页间在挂件页面最前面放了一个全局对象 `folio`：

```ts
interface FolioWidget {
  /** 插件的设置项（清单里的 settings），用户改过的值。 */
  readonly settings: Readonly<Record<string, string>>;
  /** 当前主题。 */
  readonly theme: { dark: boolean; accent: string; reducedMotion: boolean };
  /** 订阅事件。订阅时马上收到一次当前的值，之后变了再收到。返回取消订阅的函数。 */
  on(event: 'ai' | 'reading' | 'document' | 'theme' | 'visible', listener: (data: any) => void): () => void;
  /** 挂件自己的存储：一个 JSON 值，最多 5 MB，卸载插件时删除。 */
  storage: { get(): Promise<unknown>; set(value: unknown): Promise<void> };
  /** 写进插件卡片上的运行日志。 */
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
```

挂件里没处理的错误也会写进运行日志，带文件名和行号。

## 事件

页间只告诉挂件“在干什么”，不告诉它“在读什么”；`document` 是唯一带用户内容的事件，只有文档标题。

| 事件 | 数据 | 要写进 `widget.events` |
| --- | --- | --- |
| `ai` | `{ state }`：`'idle'` 空闲、`'thinking'` 在想（还没出字）、`'writing'` 在写回答、`'tool'` 在用工具（读文档、搜索…）、`'done'` 刚答完、`'error'` 出错了。`done` 和 `error` 过 3 秒回到 `idle`。插件运行时的 AI 也算在内。 | ✓ |
| `reading` | `{ state: 'reading' \| 'away', kind: 'html' \| 'pdf' \| 'none' }`：用户 3 分钟没动、或窗口在后台超过 1 分钟，就是 `away`。 | ✓ |
| `document` | `{ title, kind }`：当前文档的标题（文件名，不带扩展名）。安装时用户会看到“能看到你正在读的文档标题”。 | ✓ |
| `theme` | `{ dark, accent, reducedMotion }`：深色主题、强调色、系统是否开了“减少动态效果”（开了就别做动画）。 | 不用写 |
| `visible` | `{ visible }`：挂件是否看得见（AI 助手没打开、窗口最小化时为 `false`）。看不见时请停掉动画，省电。 | 不用写 |

## 例子

```js
const pet = document.getElementById('pet');
const pose = { idle: 'idle', thinking: 'wait', writing: 'busy', tool: 'read', done: 'jump', error: 'sad' };
folio.on('ai', ({ state }) => (pet.dataset.pose = pose[state] || 'idle'));
folio.on('visible', ({ visible }) => pet.classList.toggle('paused', !visible));
folio.on('theme', ({ reducedMotion }) => pet.classList.toggle('still', reducedMotion));
pet.addEventListener('click', async () => {
  const saved = (await folio.storage.get()) || { pats: 0 };
  await folio.storage.set({ pats: saved.pats + 1 });
});
```

## 美术素材

用别人画的角色，先看清授权。很多社区形象按 CC BY-NC-SA 4.0 开放：要署名、不能商用、改编也要用同样的协议。代码可以用 MIT，美术单独写明许可，不要都放进 MIT。想进页间的插件目录，挂件不能冒充页间或系统问用户要密码或 API Key（[收录标准](review.md)）。
