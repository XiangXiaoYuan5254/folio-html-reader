# 插件脚本 API

大多数插件只要清单和任务说明就够了。需要页间没有的能力时，比如调用某个网站的接口、先把一大堆数据整理好再交给 AI、做一点计算，可以给插件加一个脚本，用它给 AI **增加工具**。

```json
"files": ["prompt.md", "tools.js"],
"run": { "prompt": "prompt.md", "script": "tools.js", "tools": ["create_html"] },
"permissions": { "network": ["hacker-news.firebaseio.com"], "write": ["{{output}}"] }
```

完整的例子见 [Hacker News 摘要](../examples/hn-digest/tools.js)。类型定义在 [`types/folio.d.ts`](../types/folio.d.ts)，用 `folio-plugin init --script` 新建的插件会自动带上。

## 运行环境

脚本在一个看不见的沙箱页面里运行：

- **普通脚本，不是 ES module**：不能 `import` / `export`。要用第三方库，先用 esbuild、Rollup 等打包成一个文件（总大小不超过 1 MB）。
- **不能自己联网**：`fetch`、`XMLHttpRequest`、`WebSocket`、加载图片都被禁止。只能用 `folio.fetch`，而且只能访问 `permissions.network` 里的网站。
- **拿不到**：`localStorage`、Cookie、页间的界面、用户的文件、API Key。
- **每次运行一个新沙箱**：运行开始时打开，结束时关掉，两次运行之间不保留任何状态。需要“记住”什么，让 AI 读之前写过的文件（比如用 `list_files` + `read_document` 看上一期）。
- 有 `setTimeout`、`Promise`、`JSON`、`URL`、`TextEncoder`、`crypto.getRandomValues` 等浏览器里的常用对象。

## `folio.registerTool(definition, handler)`

给 AI 增加一个工具。

```js
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
    const cjk = (text.match(/[一-鿿]/g) || []).length;
    return { cjk };
  },
);
```

- `name`：小写字母开头，只用小写字母、数字和 `_`，2–40 个字符；不能和页间自带的工具重名（`list_files`、`read_document`、`fetch_url`……），重名或名字无效的会被跳过，运行日志里会提示。
- `description`：告诉 AI 这个工具做什么、什么时候用。写清楚，AI 才会用对。
- `parameters`：参数的 JSON Schema，不写就是不带参数。
- `handler(input)`：可以是 async 函数。返回字符串，或能转成 JSON 的值。抛出的错误会作为“出错”交给 AI，并写进运行日志。
- 每个插件最多 12 个工具；每次调用最多 90 秒；返回的内容最多保留 60000 个字符，太长的话先在脚本里筛选、精简。

### 什么时候注册

在脚本顶层注册最简单。也可以先联网再注册（普通脚本不能在顶层用 `await`，要包在一个 async 函数里）：

```js
(async () => {
  const sources = JSON.parse((await folio.fetch('https://api.example.com/sources.json')).text);
  for (const s of sources)
    folio.registerTool({ name: `read_${s.id}`, description: `读取 ${s.name}` }, () => s.url);
})();
```

脚本跑完后，页间会等 `folio.fetch` 的请求都回来、注册的工具不再变化（最多 8 秒），再把工具交给 AI。用别的方式拖得更晚的注册（比如 `setTimeout` 之后）这次运行用不上，运行日志里会提示“注册得太晚”。

## `folio.fetch(url, options?)`

经页间读取一个网址。

```js
const res = await folio.fetch('https://hacker-news.firebaseio.com/v0/topstories.json', {
  accept: 'application/json',
});
// res: { url, status, ok, contentType, text, cut }
const ids = JSON.parse(res.text);
```

- 只能是 `https://`、默认端口、不带账号密码，网站必须在 `permissions.network` 里。跳转后的地址也要在名单里，最多跳 5 次。
- 只能 GET；不能读图片、音视频、PDF、压缩包这类文件。
- 返回原文（UTF-8），超过 3 MB 会截断（`cut: true`）。
- 每次运行最多 80 次；每次最多 25 秒。
- 不在名单里、连不上、超时都会抛出错误，错误信息会说明原因。

## `folio.settings`

插件设置的当前值，只读：

```js
const minPoints = Number(folio.settings.min_points) || 100;
```

值都是字符串（和清单里 `settings` 的 `key` 对应）。

## `folio.log(...)`、`folio.warn(...)`、`folio.error(...)`

写运行日志。用户和你都能在「设置 › 插件 › 插件卡片 › 运行日志」里看到，可以复制出来。对象会转成 JSON。

```js
folio.log('取了', ids.length, '条');
folio.warn('第 3 条没有链接，跳过');
folio.error('接口返回了', res.status);
```

脚本里没有处理的错误（包括出错的行号）也会自动写进运行日志。`folio.warn` 和 `folio.error` 需要页间 0.30.0 或更新的版本；要兼容更早的版本，只用 `folio.log`。

## 调试

1. 在页间里用「从文件夹加载…」加载你的插件，改完保存就生效。
2. 点插件卡片上的运行按钮。运行过程在右边「整个项目」里一步步显示。
3. 展开插件卡片上的「运行日志」：脚本提供了哪些工具、每次工具调用的参数和结果、`folio.log` 的输出、脚本出的错都在这里。
