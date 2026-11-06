# folio-plugin

[页间（Folio）](https://github.com/XiangXiaoYuan5254/folio-plugins) 插件的命令行工具。目前通过源码仓库分发，不需要 npm 账号。先克隆本仓库，在仓库根目录执行 `npm install -g ./cli`，之后可在任意文件夹使用：

```bash
folio-plugin init my-plugin            # 新建插件（在自己的文件夹里工作）
folio-plugin init my-plugin --project  # 新建插件（在打开的项目里工作）
folio-plugin init my-plugin --script   # 带一个脚本，演示怎样给 AI 加工具

folio-plugin validate my-plugin        # 按页间的规则检查；有错误时退出码为 1
folio-plugin validate my-plugin --app-version 0.30.0   # 同时检查 engines.folio
folio-plugin validate my-plugin --json # 输出 JSON，给 CI 用

folio-plugin pack my-plugin            # 打成 my-plugin-<版本>.zip，可以拖进页间安装
folio-plugin pack my-plugin -o out.zip
```

检查规则和页间用的是同一份代码（`lib/manifest.cjs`）：这里能通过，页间就能装。

也可以在自己的代码里用：

```js
const { readPluginDir, validateManifest } = require('folio-plugin');
const { manifest, files, warnings } = await readPluginDir('./my-plugin');
```

插件脚本里 `folio` 对象的类型定义在 `folio-plugin/types/folio.d.ts`。

完整文档：<https://github.com/XiangXiaoYuan5254/folio-plugins>
