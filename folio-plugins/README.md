# 页间插件 · folio-plugins

[页间（Folio）](https://github.com/XiangXiaoYuan5254/folio-html-reader) 的插件让 AI 按一份写好的说明定时或一键干活：每天收集某个领域的新进展写成日报，给项目里的文档划重点，把一批网页整理成笔记……结果是一篇普通的 HTML，可以在页间里照常阅读和批注。

这个仓库是页间插件生态的公开部分：

| 目录 | 是什么 |
| --- | --- |
| [`docs/`](docs/) | 插件的完整说明：[清单字段](docs/manifest.md)、[脚本 API](docs/script-api.md)、[发布与收录](docs/publishing.md)、[收录审核标准](docs/review.md) |
| [`template/`](template/) | 起步模板，复制一份就能改成你自己的插件 |
| [`examples/`](examples/) | 示例插件：[AI 前沿日报](examples/ai-daily/)（官网可选下载，不随安装包分发）、[Hacker News 摘要](examples/hn-digest/)（带脚本）、[待读划重点](examples/reading-highlights/)（在项目里工作） |
| [`schema/`](schema/folio-plugin.schema.json) | `folio-plugin.json` 的 JSON Schema，编辑器里有补全和提示 |
| [`types/`](types/folio.d.ts) | 插件脚本里 `folio` 对象的类型定义 |
| [`cli/`](cli/) | 命令行工具 `folio-plugin`：新建、检查、打包插件 |
| [`community-plugins.json`](community-plugins.json) | 插件目录：页间「设置 › 插件 › 浏览插件目录」读的就是它 |

页间本身也以 MIT 许可证[开源](https://github.com/XiangXiaoYuan5254/folio-html-reader)；这个仓库里的文档、模板、示例和工具同样以 [MIT 许可证](LICENSE) 开源。

## 五分钟写一个插件

插件就是一个文件夹，最少两个文件：

```
my-plugin/
├── folio-plugin.json   清单：叫什么、什么时候运行、能用哪些工具、能访问哪些网站、能往哪里写
└── prompt.md           任务说明：用自然语言告诉 AI 要做什么
```

**1. 新建**（需要 Node.js 18 或更新的版本；npm 随 Node.js 提供，不需要 npm 账号）：

```bash
git clone https://github.com/XiangXiaoYuan5254/folio-plugins.git
cd folio-plugins
npm install -g ./cli
folio-plugin init my-plugin
```

要给 AI 加自己的工具，加上 `--script`；要在用户打开的项目里工作（读写项目里的文档），加上 `--project`。也可以直接复制 [`template/`](template/)。

**2. 写清单**，例如一个每天读某个 RSS、写一篇摘要的插件：

```json
{
  "$schema": "https://raw.githubusercontent.com/XiangXiaoYuan5254/folio-plugins/main/schema/folio-plugin.schema.json",
  "folio": 1,
  "id": "my-plugin",
  "name": "我的插件",
  "version": "0.1.0",
  "description": "每天读一遍某某博客，写一篇中文摘要。",
  "files": ["prompt.md"],
  "run": {
    "prompt": "prompt.md",
    "tools": ["list_files", "read_feed", "create_html"],
    "where": "folder"
  },
  "triggers": [{ "type": "daily", "time": "08:00" }, { "type": "button", "label": "现在写一篇" }],
  "permissions": { "network": ["blog.example.com"], "write": ["{{output}}"] },
  "settings": [{ "key": "output", "type": "folder", "label": "放在哪个文件夹", "default": "博客摘要" }]
}
```

**3. 写任务说明** `prompt.md`：像给一个能干的助手写工作说明一样写清楚读什么、怎么挑、写成什么样。可以用 `{{today}}`、`{{weekday}}` 和设置项 `{{output}}` 这样的变量。

**4. 在页间里试**：打开「设置 › 插件」，打开「外部插件」，点 **从文件夹加载…** 选你的插件文件夹（也可以直接把文件夹拖进去）。从文件夹加载的是开发版：页间每次运行都直接读这个文件夹，**改完保存就生效**，不用重新安装。插件卡片上的 **运行日志** 会列出每次运行调用的工具、结果和脚本输出，写错的地方会在卡片上提示。

**5. 检查和发布**：

```bash
folio-plugin validate my-plugin   # 用和页间一样的规则检查
folio-plugin pack my-plugin       # 打成 .zip，可以直接拖进页间安装
```

推到 GitHub 或 Gitee 的公开仓库，别人粘贴链接就能安装；想出现在页间的插件目录里，看 [发布与收录](docs/publishing.md)。

## 插件能做什么、不能做什么

- **能做**：用页间提供的工具读写文档（列文档、读正文、读批注、划重点、写笔记、新建和修改 HTML、查论文、下载 PDF），读清单里写明的网站和 RSS，用模型自带的联网搜索；带脚本的插件还能给 AI 增加自己的工具。
- **触发方式**：每天定时（用户可以改时间或关掉），或者点按钮。
- **权限是写死的**：运行时只能用清单里列出的工具；联网只能访问列出的网站（https，跳转到别的网站也不行）；只能在列出的文件夹里写文件。网页里藏着的“让 AI 去改别的文件”之类的话不会生效。
- **脚本在沙箱里**：不能自己联网、读写文件或访问页间界面，拿不到 API Key。
- **暂时不能**：加界面、菜单或快捷键，在打开文档等事件发生时自动运行。插件是“AI 自动化任务”，不是界面扩展。

## 用户怎么安装插件

在页间「设置 › 插件」里打开「外部插件」后，有五种方式：

1. **官网推荐**：默认展示「AI 前沿日报」，点击「下载」才从官网下载，确认权限后安装，再手动开启。也可在[官网插件页](https://helloxxy.com/works/folio/plugins/)下载 ZIP。
2. **插件目录**：点「浏览插件目录」，搜索后点「安装」。
3. **链接**：粘贴 GitHub / Gitee 仓库首页，或仓库里插件文件夹的链接（`https://github.com/作者/仓库/tree/main/某个文件夹`）。装的是当时那个 commit，作者之后的修改要点「检查更新」才会装，新版本多要的权限会单独标出。
4. **.zip**：点「安装 .zip…」，或把压缩包拖进去。GitHub 上的「Download ZIP」也可以。
5. **本地文件夹**：点「从文件夹加载…」，给写插件的人用。

每种方式在安装前都会列出插件的来源、文件和它要的权限。

## 参与

- 发现文档写错了、想要新的工具或能力：[提 issue](https://github.com/XiangXiaoYuan5254/folio-plugins/issues)。
- 页间本身的问题：[folio-html-reader](https://github.com/XiangXiaoYuan5254/folio-html-reader/issues)。
- 提交插件到目录：见 [CONTRIBUTING.md](CONTRIBUTING.md)。
