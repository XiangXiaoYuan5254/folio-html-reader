# 任务：写今天（{{today}}）的报告

在这里用自然语言写清楚 AI 要做什么：读哪些资料、怎么挑选、写成什么样。

## 1. 先看以前写过什么

用 list_files 看看已经有哪些文件，避免重复。

## 2. 读取资料

用 fetch_url 读 https://example.com/ （只能访问 permissions.network 里写明的网站）。

也可以用插件脚本提供的 word_count 工具数一数字数。

## 3. 写成 HTML

用 create_html 新建 `{{today}} 报告.html`，照「输出模板」的结构和样式写。

写完后用一两句话告诉我文件名。

<!-- 可以用的变量：{{设置项}}，以及 {{today}}、{{yesterday}}、{{week_ago}}、{{now}}、{{weekday}}、{{project}}、{{folder}} -->
