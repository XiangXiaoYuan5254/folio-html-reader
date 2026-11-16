# 挂件插件（设计稿）

> 状态：第一期已实现（2026-11-06）。2026-11-05 初稿；2026-11-06 改为挂件可以自己联网，并去掉大部分限制。
> 写挂件的说明见 [folio-plugins/docs/widget-api.md](../folio-plugins/docs/widget-api.md)；下面是设计和取舍。

## 第一期做到了什么

- 清单：`"folio": 2` 加 `widget`（`entry`、`size`、`anchor`、`events`、`art`）；只有挂件的插件可以不写 `run`，没有运行按钮和定时（`electron/plugin-manifest.cjs`）。
- 页面：`app://widget/<id>/`，引导脚本插在 `<head>` 最前面（`widgetPage`）；内容安全策略按哈希放行内联脚本（`widgetCspFor`，见下文）。
- 位置：`anchor: "assistant"` 放在 AI 助手输入框的右上角，挂件高度的四分之一（最多 28px）压在输入框边上，输入框的文字给它让出位置；也可以放在窗口的四个角。拖动换位置还没做。
- 事件：`ai`、`reading`、`document`、`theme`、`visible`（`src/plugins/widget-events.ts`）。`voice`、`selection` 没做。
- 接口：`folio.settings`、`theme`、`on`、`storage`（5 MB，存在用户数据目录的 `plugin-data/<id>.json`）、`log/warn/error`。`bubble`、`openAssistant` 没做。
- 隔离与看门狗：每个沙箱页面一个进程；每 4 秒 ping 一次，12 秒没回就关掉。
- 设置：只有挂件的插件不显示运行按钮和“用哪个 AI”；「它能做什么」如实列出挂件的位置、能知道什么、能联网、美术署名。
- 测试：`tests/plugins.test.cjs`（清单、权限变化、哈希策略）、`tests/widget.e2e.mjs`、`tests/plugin-sandbox.e2e.mjs`。
- 第一个挂件：[深深](../../folio-shenshen-widget)，独立的插件文件夹，代码 MIT，美术 CC BY-NC-SA 4.0，不在本仓库里。
> 相关代码：`electron/plugin-manifest.cjs`、`electron/plugins.cjs`、`src/plugins/sandbox.ts`、`src/ai/assistant.ts`。

## 要解决什么

现在的插件只是“AI 自动化任务”：按说明定时或点按钮跑一次，结果写成 HTML（[folio-plugins/README.md](../folio-plugins/README.md) 写明“暂时不能加界面”）。这份设计给插件加一种新能力：**在窗口里常驻挂件**，比如陪读的小角色。它会跟着页间的状态变化：AI 在想时歪头，朗读时张嘴，长时间不动就睡着。

## 设计原则

社区插件是用户自己选择装的代码，由用户自己判断，页间不替用户把关。这和 Obsidian、DeepSeek Harness 的做法一样。页间只做四件事：

1. **社区插件默认关闭**，打开时提示一次风险（已有）；
2. **说实话**：安装卡片如实列出插件能做什么，比如能联网、能看到什么；
3. **不交出 API Key**：插件用 AI 都经过页间，用不着 Key，这一条不影响插件能做什么；
4. **一个挂件出问题，不拖垮页间**：卡死了能关掉它。

页间**自己的插件目录**只收维护者看过的插件（[收录标准](../folio-plugins/docs/review.md)）。这是“我们不提供危险的插件”，不是限制别人能装什么。

## 第一版的范围

这些是第一版还没做，不是不准做：

- 挂件不能加菜单、快捷键、工具栏按钮；
- Live2D 这类运行时可以由作者自己打包进挂件，页间不内置（Cubism SDK 的授权由作者自己负责）；
- 挂件不能直接调用 AI，只能通过 `openAssistant()` 打开 AI 面板。

## 清单怎么写

`folio-plugin.json` 加一个顶层字段 `widget`。用到 `widget` 的插件要写 `"folio": 2`：旧版页间看到 2 会直接提示“不支持的插件格式，请更新页间”。

```json
{
  "folio": 2,
  "id": "desk-cat",
  "name": "桌边小猫",
  "version": "0.1.0",
  "description": "在窗口角落陪你读书：AI 在想的时候它歪头，朗读的时候它张嘴，久了不动它就睡觉。",
  "engines": { "folio": ">=0.31.0" },
  "files": ["widget.html", "widget.js", "cat.svg", "cat-sleep.webp"],
  "widget": {
    "entry": "widget.html",
    "size": { "width": 140, "height": 160 },
    "corner": "bottom-right",
    "events": ["ai", "voice", "reading", "document"],
    "art": { "author": "某某", "license": "CC BY-NC 4.0" }
  }
}
```

| 字段 | 规则 |
| --- | --- |
| `widget.entry` | `files` 里的一个 `.html`。 |
| `widget.size` | 挂件的宽高，各 24–1200 像素，默认 160×160。用户缩放还没做。 |
| `widget.corner` | 默认放在哪个角。用户拖动后以用户的为准。 |
| `widget.events` | 要订阅的事件（见下节），安装时列给用户看。 |
| `widget.art` | 可选：美术素材的作者和许可证，写了就显示在安装卡片上。 |

挂件可以放图片、字体和音频（`.png .webp .gif .jpg .jpeg .avif .woff .woff2 .ttf .otf .mp3 .wav .ogg .m4a`），`.js` 文件不限个数。带 `widget` 的插件最多 200 个文件，每个不超过 20 MB，合计不超过 50 MB。WebAssembly 不行：能编译就能运行从网上下载的代码，和下面“代码只能来自插件包”冲突。

## 挂件能知道什么

| 事件 | 数据 | 说明 |
| --- | --- | --- |
| `ai` | `{ state: 'idle' \| 'thinking' \| 'writing' \| 'tool' \| 'done' \| 'error' }` | 来自 `Assistant.subscribe` 和 `state.running`（`src/ai/assistant.ts`），插件运行也算在内。 |
| `voice` | `{ speaking: boolean, level?: number }` | （没做）朗读开始和结束；`level` 是 0–1 的音量，用来对口型。 |
| `reading` | `{ state: 'reading' \| 'away', kind: 'html' \| 'pdf' \| 'board' \| 'none' }` | 是否在读、读的是哪一类；3 分钟没操作为 `away`。 |
| `document` | `{ title: string, kind: string }` | 当前文档的标题。安装卡片会写“能看到你在读的文档标题”。 |
| `selection` | `{ text: string }` | （没做）用户选中的文字（最多 2000 字）。安装卡片会写“能看到你选中的文字”。 |
| `theme` | `{ dark: boolean, accent: string, reducedMotion: boolean }` | 每个挂件都有，不用写。 |
| `visible` | `{ visible: boolean }` | 每个挂件都有，不用写。看不见时挂件最好停掉动画。 |

`document` 和 `selection` 让挂件能对你在读的东西做出反应，比如读到某个词时冒一句话。用户安装时就能看到这两项，自己决定装不装。

## 挂件能做什么

挂件页面里有一个 `folio` 对象，由页间注入，跑在挂件自己的代码之前：

```ts
interface FolioWidget {
  readonly settings: Readonly<Record<string, string>>;
  readonly theme: { dark: boolean; accent: string; reducedMotion: boolean };
  on(event: string, listener: (data: any) => void): void;
  // 页间在挂件旁边画一个对话气泡（用页间的样式，悬停显示插件名）。
  bubble(text: string, options?: { seconds?: number }): void;
  // 打开右侧 AI 面板。
  openAssistant(): void;
  // 挂件自己的存储，JSON，最多 5 MB，卸载时删除。
  storage: { get(): Promise<unknown>; set(value: unknown): Promise<void> };
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
```

挂件自己联网就直接用 `fetch`、`WebSocket` 和图片。可以同时显示多个挂件，各自放在不同位置。

## 怎么实现

### 页面

挂件放在一个 `sandbox="allow-scripts"` 的 iframe 里，只用 postMessage 和页间说话，做法和插件脚本一样。这一层隔离不是为了限制挂件，而是让它碰不到 API Key 和页间的界面。

`electron/main.cjs` 的 `app` 协议加一个 `widget` 主机：`app://widget/<id>/` 返回 `entry`，页间的引导脚本插在最前面；`app://widget/<id>/<file>` 返回清单里列出的文件。插件关掉或「社区插件」关掉时全部返回 403。

内容安全策略放开网络，只要求代码来自插件包：

```
default-src 'none';
script-src app://widget/<id>/ 'sha256-<引导脚本>' 'sha256-<页面里每段内联脚本>';
style-src 'unsafe-inline' app://widget/<id>/ https:;
img-src app://widget/<id>/ http: https: data: blob:;
media-src app://widget/<id>/ http: https: data: blob:;
font-src app://widget/<id>/ https: data:;
connect-src app://widget/<id>/ http: https: ws: wss: data: blob:;
base-uri 'none'; form-action 'none'
```

实现时发现，`script-src 'unsafe-inline'` 挡不住“下载一段代码、塞进一个新建的 `<script>` 里运行”，插件脚本的沙箱也有这个问题。所以两边都改成按 SHA-256 放行页间送出的那几段内联脚本：运行时再拼出来的 `<script>`、`eval`、`new Function`、内联事件都被挡住（`inlineScriptHashes`）。不能用 nonce，因为脚本读得到 `document.currentScript.nonce`。也不允许 `worker-src blob:` 和 `'wasm-unsafe-eval'`，否则同样能把下载来的代码跑起来。

代码只能来自插件包，这是唯一保留的限制（2026-11-06 确认保留）。作者照样可以打包任何库，影响很小。它的作用是让目录里收录的插件“审的就是跑的”，作者不能在收录后从服务器换成别的代码。

`script-src` 对自定义协议按路径匹配已经验证可用（`tests/widget.e2e.mjs`：挂件自己的 `widget.js` 能加载，别的网站的脚本加载不了）。

### 不拖垮页间

- **进程隔离**：`IsolateSandboxedIframes:grouping/per-document`，每个沙箱页面一个进程。默认按站点分组时，所有 `app://widget` 的挂件会挤在同一个进程里，一个卡死会连带别的挂件（测试里就出过这个问题）。测试用 `webFrameMain.osProcessId` 检查挂件和主窗口、和别的挂件都不在同一个进程。
- **看门狗**：页间每 4 秒发一次 ping，12 秒没回就移除这个挂件，在运行日志里写明，下次打开页间再加载。窗口在后台时不判断。
- **看不见时节流**：窗口最小化或挂件被隐藏时，把 iframe 设成 `visibility: hidden`，Chromium 会自动节流。

如果进程隔离做不到，备选方案是把挂件放进透明的 `WebContentsView`，代价是弹窗打开时要先把挂件藏起来。

### 界面上怎么放

- **图层**：`src/components/WidgetLayer.tsx` 挂在 `App.tsx` 最外层，`position: fixed`，`z-index: 15`。这样它在阅读内容之上，在项目选择器（20）、提示条（30）、更新卡片（40）、菜单（100/200）和弹窗（10000）之下。
- **透明背景**：iframe 和挂件页面都透明，看起来就是一个角色站在窗口里。
- **页间自己的把手**：鼠标移进挂件时，页间在挂件上沿显示一个小把手：拖动、隐藏到下次启动、挂件设置。这样用户总能把挂件挪走或关掉。
- **设置 › 插件**：每个挂件一个开关，加上大小设置和“恢复默认位置”。

## 安装时用户看到什么

如实列出挂件能做什么：

> 这个插件会在窗口里显示一个挂件。它能知道：AI 是否在工作、是否在朗读、你是否在阅读；你在读的文档标题；你选中的文字。它可以自己访问任何网站。
> 美术素材：某某，CC BY-NC 4.0。

其中“文档标题”“选中的文字”这两行只在挂件订阅了 `document`、`selection` 时出现。更新时，新多出来的事件像现在新多出来的权限一样单独标出来。

## 页间插件目录的收录标准（新增一条）

只管页间自己的目录收什么，不限制用户自己装什么。加到 [folio-plugins/docs/review.md](../folio-plugins/docs/review.md)：

- 挂件不冒充页间或系统，问用户要密码或 API Key。

## 要改的文件

| 文件 | 改什么 |
| --- | --- |
| `electron/plugin-manifest.cjs` | 接受 `folio: 2`；校验 `widget`；有 `widget` 时 `run` 可以不写；挂件文件不限类型、放宽大小。改完跑 `node scripts/sync-plugin-kit.mjs`。 |
| `electron/plugins.cjs` | 生成挂件页面和内容安全策略；返回挂件文件；挂件存储；看门狗状态。 |
| `electron/main.cjs` | `app://widget/…` 路由；`IsolateSandboxedIframes`。 |
| `src/plugins/widget.ts`（新） | 创建 iframe、给挂件发事件、处理挂件的消息、ping。 |
| `src/plugins/widget-events.ts`（新） | 从 Assistant、朗读、阅读状态、当前文档、选区、主题算出事件。 |
| `src/components/WidgetLayer.tsx`（新） | 图层、把手、拖动、气泡。 |
| `src/components/PluginSettings.tsx` | 挂件开关和设置；安装卡片上的挂件说明。 |
| `src/plugins/types.ts` | `PluginManifest.widget`、`PluginAdded` 里的挂件字段。 |
| `folio-plugins/` | `schema/`、`types/`、`docs/widget-api.md`（新）、`docs/review.md`、README；`cli` 的 `init --widget`；示例 `examples/desk-cat`（原创 SVG 角色，素材 CC0）。 |

## 分两期

**第一期（已做）**：清单；挂件页面；进程隔离和看门狗；`ai`、`reading`、`document`、`theme`、`visible` 事件；`storage`；图层和收起按钮；安装说明；文档；第一个挂件（深深）。

**第二期**：拖动换位置、用户缩放；`voice`（含口型）、`selection` 事件；`bubble`；`openAssistant`；插件卡片上列出挂件连过的网站。

## 怎么验证

- `tests/plugins.test.cjs`：`folio: 2` 和 `widget` 的清单校验；两份 `plugin-manifest.cjs` 保持一致。
- `tests/widget.e2e.mjs`（`npm run test:widget`）：
  - 挂件在 AI 助手输入框的右上角，输入框给它让出位置；
  - 一次 AI 回答里依次收到 `thinking → writing → done → idle`；收到文档标题、阅读状态、主题、是否看得见；
  - 能联网，有自己的存储；自己的内联脚本能运行，运行时塞进去的脚本、`eval`、别的网站的脚本都不行；碰不到页间页面；
  - 和主窗口、和别的挂件都不在同一个进程；
  - 写了死循环的测试挂件被看门狗关掉，页间界面还能操作；
  - 收起按钮能用。

## 待定

1. 页间要不要自带一个官方挂件？要的话，需要一个原创的角色形象。（深深是社区形象，美术不能商用，不适合内置。）
