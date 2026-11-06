# 参与页间

谢谢你愿意帮页间变得更好。页间是一个个人业余项目，维护时间有限，回复可能会慢一些，但每个问题和 PR 都会看。

*English: issues and pull requests in English are welcome. The notes below cover reporting bugs, running from source, tests and code style.*

## 报告问题

在 [Issues](https://github.com/XiangXiaoYuan5254/folio-html-reader/issues) 里新建一个问题，最好写上：

- 页间的版本（点标题栏的“页间”或在「设置 › 关于」里看）和系统（macOS / Windows 版本）。
- 怎么操作会出现，期望是什么、实际是什么；有截图或录屏更好。
- 和某篇文档有关的话，尽量附一份能复现的最小 HTML / PDF。

**不要贴 API Key、私人文档或聊天记录。** 需要日志时先看一眼里面有没有不想公开的内容。

想要新功能的话，也欢迎开 Issue 说说你的使用场景，先聊清楚再动手，免得白写。

## 从源码运行

需要 Node.js 22.13 或更新的版本（项目里有 `.nvmrc`）。macOS 上，白板语音用的本机 helper 需要 Xcode Command Line Tools 编译。

```sh
npm ci
npm run dev
```

`FOLIO_WORKSPACE=/你的/HTML目录 npm run dev` 可以指定打开的文件夹。代码的组织方式见 README 的 [实现结构](README.md#实现结构)。

打包签名（`npm run pack`、`npm run dist:mac`）用的是维护者的证书。自己构建不签名的版本：

```sh
npm run build && node scripts/build-speech.mjs
npx electron-builder --mac dir -c.mac.identity=null -c.mac.notarize=false
```

## 提交 Pull Request

1. 一个 PR 只做一件事。改动较大时，先开 Issue 讨论方向。
2. 跑 `npm run build`，确认类型检查通过。
3. 跑和你改动有关的测试：`npm test` 是单元测试；端到端测试按功能拆开，比如 `npm run test:pdf`、`npm run test:ai`、`npm run test:settings`（完整列表见 `package.json` 的 `scripts`）。不用每次都跑全部。测试都用 `samples/` 和临时文件，不需要真实账号或 API Key。
4. 跑 `npm run format`，代码风格交给 Prettier。
5. 在 PR 里说明改了什么、为什么改、怎么验证的；界面上的改动附截图。

代码注释写“为什么”，不只是“做了什么”。界面文字用简体中文，跟现有的说法保持一致。

## 写插件

插件不用改页间本身。清单格式、脚本 API、起步模板和命令行工具都在 [folio-plugins](https://github.com/XiangXiaoYuan5254/folio-plugins)；写好的插件也可以在那里申请收录进插件目录。

## 许可

提交到这个仓库的代码，按项目的 [MIT 许可证](LICENSE) 发布。
