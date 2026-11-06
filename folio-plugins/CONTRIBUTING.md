# 参与

## 提交插件到目录

1. 先按 [发布与收录](docs/publishing.md) 把插件放到 GitHub 或 Gitee 的公开仓库，`folio-plugin validate` 通过，在页间里装上跑通一次。
2. Fork 这个仓库，在 [`community-plugins.json`](community-plugins.json) 的 `plugins` 末尾加一项（字段见 [发布与收录](docs/publishing.md#收录到插件目录)）。
3. 提交 Pull Request，按模板填写。CI 会读取你仓库里的清单并检查。
4. 维护者按 [收录审核标准](docs/review.md) 看过后合并。

更新插件不需要再提 PR：目录里存的是仓库链接，用户在页间里点「检查更新」就会读到你推送的新版本。只有插件改了名字、换了仓库或者要移出目录时，才需要改 `community-plugins.json`。

## 改文档、示例和工具

- 文档写错了、说得不清楚：直接提 PR。
- 想要页间增加新的工具、触发方式或脚本能力：先 [提 issue](https://github.com/XiangXiaoYuan5254/folio-plugins/issues) 说清楚想做什么插件、现在卡在哪里。
- `cli/lib/manifest.cjs` 是从页间同步过来的，和页间检查插件用的是同一份代码，请不要直接改它；规则有问题请提 issue。

## 行为准则

友善、就事论事。不接受骚扰、人身攻击和歧视性言论。
