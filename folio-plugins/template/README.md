# 我的插件

页间（Folio）插件的起步模板。复制这个文件夹（或者用 `folio-plugin init my-plugin --script` 新建），然后：

1. 改 `folio-plugin.json`：`id`、`name`、`description`、要用的工具、能访问的网站。字段说明见 [清单文档](https://github.com/XiangXiaoYuan5254/folio-plugins/blob/main/docs/manifest.md)。
2. 改 `prompt.md`：用自然语言写清楚 AI 要做什么。
3. 改 `template.html`：结果的样子。不需要的话从 `files` 和 `run.template` 里去掉。
4. `tools.js` 是插件脚本，给 AI 增加工具。不需要的话删掉它，并从 `files` 和 `run.script` 里去掉。说明见 [脚本 API](https://github.com/XiangXiaoYuan5254/folio-plugins/blob/main/docs/script-api.md)。
5. 在页间「设置 › 插件」里点「从文件夹加载…」选这个文件夹，改完保存就生效；插件卡片上的「运行日志」能看到每一步。
6. `folio-plugin validate .` 检查，推到 GitHub 或 Gitee 发布。

`folio.d.ts` 和 `jsconfig.json` 只是给编辑器用的（脚本的类型提示），没有列在 `files` 里，不会被安装。这个 README 也一样。
