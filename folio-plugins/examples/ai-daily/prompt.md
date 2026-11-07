# 任务：写今天（{{today}}）的 AI 前沿日报

读者想每天花五分钟，知道 AI 领域昨天到今天发生了哪些值得关注的事。关注方向：{{topics}}。

## 1. 先看以前写过什么

用 list_files 看看你的文件夹里已有的日报。如果有，用 read_document 读最近的两篇，记下已经写过的条目，今天不要重复（除非有了重要的新进展）。

## 2. 读取来源

按顺序读下面的来源。某个来源读取失败（网站连不上、返回错误）就跳过，继续下一个，最后在日报末尾注明。每个地址读一次就够：数据接口内容很长时，只看第一段（不带 offset）里最新、最热的条目，不要一段段读完，也不要重复读同一个地址。

- arXiv 最新论文：read_feed `https://export.arxiv.org/api/query?search_query=cat:cs.CL+OR+cat:cs.AI+OR+cat:cs.LG+OR+cat:cs.CV&sortBy=submittedDate&sortOrder=descending&max_results=50`，days 填 3
- Hugging Face 每日论文（社区投票选出的热门论文）：fetch_url `https://huggingface.co/api/daily_papers`
- GitHub 最近一周新建、增长最快的 AI 项目：fetch_url `https://api.github.com/search/repositories?q=topic:llm+created:>{{week_ago}}&sort=stars&order=desc&per_page=15`
- Hacker News 上热议的 AI 话题：fetch_url `https://hn.algolia.com/api/v1/search_by_date?query=LLM&tags=story&numericFilters=points%3E60&hitsPerPage=20`
- 官方博客（各 read_feed，days 填 3）：
  - OpenAI：`https://openai.com/news/rss.xml`
  - Google DeepMind：`https://deepmind.google/blog/rss.xml`
  - Google Research：`https://research.google/blog/rss/`
  - Hugging Face 博客：`https://huggingface.co/blog/feed.xml`
- 中文资讯：read_feed `https://www.qbitai.com/feed`，days 填 2

如果你能联网搜索，可以再搜一次今天的重大 AI 新闻（新模型发布、重要开源），只采用有可靠来源的内容。

## 3. 挑选

从读到的内容里挑出大约 {{count}} 条最值得看的，优先关注方向里的内容：

- 重要的新模型、新产品、新版本
- 有新意或影响大的论文（Hugging Face 投票多的优先）
- 增长快、有用的开源项目
- 值得知道的行业动态

去掉重复的、纯营销的、和 AI 关系不大的。

挑出的条目只看标题和摘要弄不清是什么的（比如 Hacker News 上链接到别的网站的文章，或标题里有没见过的缩写），用 fetch_url 打开原文看一下再写。只打开需要弄清楚的那几篇，不要每条都打开。

## 4. 挑一篇值得深读的

从上面挑出的条目里，选 1 篇最值得花时间读原文的（最多 2 篇），给想真正弄懂的读者。必须同时满足：

- **有实质内容**：讲清楚了方法、设计或实现的论文、技术报告、工程博客，或者文档写得好的开源项目。新闻稿、产品宣传、融资和人事消息不选。
- **确实有人在用、在讨论**：同时出现在两个以上来源里的，Hugging Face 投票多的，GitHub 星标涨得快的，Hacker News 上讨论多的，或者来自主要实验室和知名团队的。只在一个角落出现、看不出有人关注的，不选；不要为了显得新而挑冷门的东西。
- 优先和关注方向相关的。

今天确实没有够格的，就写「今天没有特别值得深读的」，不要硬凑。

## 5. 写成 HTML

用 create_html 在你的文件夹里新建 `{{today}} AI 前沿日报.html`；如果已经有这个文件，改用 `{{today}} AI 前沿日报（2）.html`。

- 照「输出模板」的结构和样式写，用中文。每个分组保留模板里的 class（models、papers、repos、news），标签颜色靠它区分；值得深读有两篇时，每篇各用一个 `<article class="pick">`。
- 开头一行的「本期 N 条」写这期正文里实际的条数。
- 开头「今日要点」：三条，每条一句话，说今天最重要的三件事。
- 接着「值得深读」：标题（链接到原文：论文给 arXiv 页面，博客给原文地址）、来源、大约要读多久，然后分三句话写「为什么值得读」（它解决了什么问题、为什么现在重要）、「读完能弄懂什么」、「先了解什么更好读」（需要的背景知识，没有就不写）。
- 正文按「模型与产品」「论文」「开源项目」「行业动态」分组，没有内容的分组不写。
- 每一条：标题（链接到原文）、来源和日期、两三句话说明「是什么、为什么值得关注」。论文写清楚是哪个机构或团队、核心做法和结果。英文标题可以保留原文，再给一个中文译名。
- 末尾「今天读取的来源」：列出每个来源，标明读到了几条，或者读取失败。
- 只写这次真正读到的内容，不要凭记忆补充，也不要编造链接。

写完后用一两句话告诉我日报的文件名和今天最重要的一件事。
