# 任务：写今天（{{today}}）的 AI 前沿日报

这期日报有两部分：

- **速览**：AI 领域从上一期到现在新发生的、值得知道的事，每条两三句话，五分钟看完。关注方向：{{topics}}。
- **深度解读**：挑一篇最近最有分量的技术报告、论文或技术博客，读完全文，单独写成一篇解读笔记。读者看完笔记，不读原文也能弄懂它做了什么、怎么做的、意味着什么。

速览最要紧的是**只写新的、不重复**：

- **只写新的**：只写上一期日报之后新发布、新发生的事，最多往前看两天（还没有上一期，就看最近 24 小时）。看事情本身的时间，不看文章的时间：几天前的大事，今天又有文章在讨论、分析、回顾，不算新闻，不写。
- **不重复**：最近几期写过的不再写。同一个链接不写；同一件事（同一个人、同一家公司的同一次发布、表态或事件）换了来源、换了说法也不写。只有出现了实质性的新进展（新发布、新数据、官方回应、有了结果）才写，而且只写新进展：标题说新进展本身，正文用一句话带过背景，来源后面标「后续」。
- 这两条对「今日要点」同样适用。新内容不够就少写几条，不要拿旧闻凑数。

## 1. 先看最近写过什么

用 list_files 看文件夹里已有的文件，列表里有每篇的写成时间。

- 日报是直接放在文件夹里的「… AI 前沿日报.html」，最新一篇的时间就是「上一期」。用 read_document 读最近三篇（不到三篇就都读），记下每期写过的事和链接。
- 解读笔记在「深度解读/」里，文件名就是解读过的题目。全部记下，解读过的不再解读。

## 2. 读取来源

按顺序读下面的来源。某个来源读取失败（网站连不上、返回错误）就跳过，继续下一个，最后在日报末尾注明。每个地址读一次就够：数据接口内容很长时，只看第一段（不带 offset）里最新、最热的条目，不要一段段读完，也不要重复读同一个地址。网页返回 403 多半是网站拦了程序访问，不用重试，订阅里有这一条就用订阅的摘要。

读到的每一条先看时间：早于上一期的、最近几期写过的，不进速览（可以留作深度解读的候选，见第 4 步）。订阅给的时间已经是现在的时区；数据接口里的时间（created_at、publishedAt 等）是 UTC，先换算再比较。

- arXiv 最新论文：read_feed `https://export.arxiv.org/api/query?search_query=cat:cs.CL+OR+cat:cs.AI+OR+cat:cs.LG+OR+cat:cs.CV&sortBy=submittedDate&sortOrder=descending&max_results=50`，days 填 2
- Hugging Face 每日论文（社区投票选出的热门论文，按票数从多到少）：fetch_url `https://huggingface.co/api/daily_papers?date={{yesterday}}&limit=8`，length 填 30000。每篇有票数（upvotes）和机构（organization）。
- GitHub 新建、增长最快的 AI 项目：fetch_url `https://api.github.com/search/repositories?q=topic:llm+created:>{{week_ago}}&sort=stars&order=desc&per_page=40`。只看 created_at 在最近三天内的。同一个仓库名出现在好几个账号下、星标数也差不多的，是刷星的垃圾仓库，可能带恶意程序，一律不写。
- 主要模型团队的新仓库（新模型、技术报告常常先在这里发布）：fetch_url `https://api.github.com/search/repositories?q=org:deepseek-ai+org:MoonshotAI+org:QwenLM+org:zai-org+org:MiniMax-AI+org:ByteDance-Seed+org:google-deepmind+org:openai+org:anthropics+org:meta-llama+org:facebookresearch+created:>{{week_ago}}&sort=stars&order=desc&per_page=20`
- Hacker News 上热议的 AI 话题：fetch_url `https://hn.algolia.com/api/v1/search_by_date?query=LLM&tags=story&numericFilters=points%3E60&hitsPerPage=20`
- 官方博客（各 read_feed，days 填 2）：
  - OpenAI：`https://openai.com/news/rss.xml`
  - Google DeepMind：`https://deepmind.google/blog/rss.xml`
  - Google Research：`https://research.google/blog/rss/`
  - Hugging Face 博客：`https://huggingface.co/blog/feed.xml`
- 技术长文（各 read_feed，days 填 7，limit 填 5；更新不频繁，主要作深度解读的候选）：
  - Microsoft Research：`https://www.microsoft.com/en-us/research/feed/`
  - BAIR（伯克利 AI 研究院）：`https://bair.berkeley.edu/blog/feed.xml`
  - Sebastian Raschka：`https://magazine.sebastianraschka.com/feed`
  - Lilian Weng：`https://lilianweng.github.io/index.xml`
- 中文资讯：read_feed `https://www.qbitai.com/feed`，days 填 2，limit 填 30

如果你能联网搜索，可以再搜一次今天的 AI 新闻（新模型发布、重要开源、新的技术报告）。搜到的常常是这几天反复报道的大事：速览只采用发布时间在上一期之后、有可靠来源的报道，写过的事和上一期之前的事都不用。

## 3. 挑选速览

从读到的新内容里挑出大约 {{count}} 条最值得看的（不够就少写），优先关注方向里的内容：

- 重要的新模型、新产品、新版本
- 有新意或影响大的论文（Hugging Face 投票多的优先）
- 增长快、有用的开源项目
- 值得知道的行业动态

去掉最近几期写过的、纯营销的、和 AI 关系不大的。

挑出的条目只看标题和摘要弄不清是什么的（比如 Hacker News 上链接到别的网站的文章，或标题里有没见过的缩写），用 fetch_url 打开原文看一下再写。只打开需要弄清楚的那几篇，不要每条都打开。

## 4. 选今天的深度解读

从今天读到的所有内容里选 1 篇。和速览不同，深度解读看分量，不看新旧：最近七天内发布、还没解读过的都可以选。按这个顺序优先：

1. 主要模型团队发布新模型时的技术报告：DeepSeek、Kimi（月之暗面）、通义千问、智谱、MiniMax、字节 Seed、Google / DeepMind、OpenAI、Anthropic、Meta 等。
2. 方法上有新意、影响大的论文：Hugging Face 投票多的，知名机构或团队的，在两个以上来源里出现、或 Hacker News 上讨论多的。
3. 讲清楚了设计、原理或实现的技术长文和工程博客。

必须满足：

- **有实质内容**：讲清楚了方法、设计或实现。新闻稿、产品宣传、融资和人事消息、榜单不选。
- **读得到全文**：arXiv 论文先读 HTML 全文 `https://arxiv.org/html/编号`（不带版本号），没有 HTML 版就读 PDF `https://arxiv.org/pdf/编号`。只发了 PDF 的技术报告直接读 PDF 链接：GitHub 仓库里的用 `https://github.com/作者/仓库/raw/分支/文件名.pdf`，Hugging Face 上的用 `https://huggingface.co/作者/仓库/resolve/main/文件名.pdf`。博客读原文网页。都读不到全文（返回错误）就换下一篇候选，不要只凭摘要写。
- 「深度解读/」里没有解读过：同一篇论文、同一个模型的同一份报告，换了标题也算解读过。
- 关注方向里的优先，但分量更要紧：明显更重要的那篇不在关注方向里，也选它。

今天确实没有够格的，就不写深度解读，日报里写一句「今天没有够分量的，深度解读停一天」，不要硬凑。

## 5. 读全文，写解读笔记

用 fetch_url 把全文读完：length 填 30000，按返回里提示的 offset 一段段往下读，直到正文结束。参考文献不用读，附录扫一眼小节标题，用得上的再读。

写给这样的读者：认真，熟悉 AI 的大概，但不是这个方向的专家。目标是读完笔记，能把这篇讲给别人听。

- **先铺垫再深入**：原文依赖、但没讲清的前置概念，先讲明白机制，不假设读者懂。
- **术语现场解释**：术语、缩写第一次出现就地解释，附英文原词。
- **讲清为什么**：每个关键设计，说它要解决什么问题、换成常见做法会卡在哪。不要只罗列「用了 A、用了 B」。
- **数字要有对照**：结果写清和谁比、在什么基准上、差多少，再说这些数字说明了什么。
- **忠于原文**：不编原文没有的数据和结论；你补充的背景和你自己的判断要标明。
- **公式和图**：只写真正核心的公式（最多三个），用 MathML（`<math>`）写，先一句话说它在算什么，再说每个符号的含义。结构、流程、数据流这类用图比文字清楚的地方，画一张简单的内联 SVG 示意图；不画装饰图。
- 正文大约 3000 到 5000 字。是解读，不是把原文缩写或翻译一遍。

照下面「解读笔记模板」的结构和样式写，用中文，保留 `<style>`。然后用 create_html 新建 `深度解读/{{today}} 中文短标题.html`（短标题十个字左右，不带「/」等符号；文件已存在就在短标题后加「（2）」）。

## 6. 写日报

用 create_html 在你的文件夹里新建 `{{today}} AI 前沿日报.html`；如果已经有这个文件，改用 `{{today}} AI 前沿日报（2）.html`。

- 照「输出模板」的结构和样式写，用中文。每个分组保留模板里的 class（models、papers、repos、news），标签颜色靠它区分。
- 开头一行的「本期 N 条」写这期速览里实际的条数。
- 开头「今日要点」：三条，每条一句话，说今天最重要的三件事。
- 接着「今日深度解读」：标题和「读解读笔记」按钮都链接到第 5 步的笔记，写相对路径（`深度解读/文件名.html`，空格写成 `%20`）；来源后面链接到原文；一两句话说它做了什么、为什么今天选它；三条「读完能弄懂什么」。今天没写深度解读，这一块只写一句 `<p class="none">今天没有够分量的，深度解读停一天。</p>`。
- 正文按「模型与产品」「论文」「开源项目」「行业动态」分组，没有内容的分组不写。深度解读的那篇不再放进速览。
- 每一条：标题（链接到原文）、来源和日期（事情发布或发生的日期）、两三句话说明「是什么、为什么值得关注」。论文写清楚是哪个机构或团队、核心做法和结果。英文标题可以保留原文，再给一个中文译名。
- 末尾「今天读取的来源」：列出每个来源，标明读到了几条，或者读取失败。
- 只写这次真正读到的内容，不要凭记忆补充，也不要编造链接。

写之前对照第 1 步记下的内容，把速览的每一条（包括今日要点）再查一遍：是上一期之后的事，最近几期没有写过。不符合的删掉。

写完后用一两句话告诉我日报的文件名、今天解读了哪一篇。

## 解读笔记模板

照这个模板的结构和样式写：保留 `<style>`，把示例内容换成真实内容。「为什么值得读」到「读完带走什么」这几部分都要有；「前置知识」不需要时不写；方法部分按原文的逻辑分成几个小标题。

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>深度解读：中文标题</title>
<style>
  :root { --ink: #1b2531; --text: #39444f; --muted: #7d8793; --line: #e8e4dc; --paper: #faf9f6; --accent: #2864d7; --warm: #985c08; --warm-bg: #fdf6e7; }
  html { background: var(--paper); }
  body { max-width: 780px; margin: 0 auto; padding: 0 28px 56px; font: 17px/1.85 -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif; color: var(--text); -webkit-font-smoothing: antialiased; }
  a { color: var(--accent); }
  p, li { text-wrap: pretty; }
  .hero { padding: 48px 0 26px; border-bottom: 3px double #d9d3c7; }
  .kicker { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: .16em; color: var(--warm); }
  h1 { margin: 10px 0 6px; font-size: 34px; line-height: 1.3; color: var(--ink); }
  .original { margin: 0; font-size: 15px; font-style: italic; color: var(--muted); }
  .meta { margin: 6px 0 0; font-size: 14px; color: var(--muted); }
  .tldr { margin: 20px 0 0; padding: 16px 20px; border-radius: 12px; background: var(--warm-bg); border: 1px solid #f0dfb6; color: var(--ink); font-weight: 500; }
  section { margin-top: 40px; }
  h2 { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; font-size: 22px; color: var(--ink); }
  h2::before { content: ""; width: 5px; height: 22px; border-radius: 3px; background: var(--warm); }
  h3 { margin: 24px 0 8px; font-size: 18px; color: var(--ink); }
  p { margin: 0 0 14px; }
  ul, ol { margin: 0 0 14px; padding-left: 1.4em; }
  li { margin: 5px 0; }
  strong { color: var(--ink); }
  .term { margin: 14px 0; padding: 10px 16px; border-radius: 10px; background: #f2f0ea; font-size: 15.5px; }
  .term b { margin-right: 8px; color: var(--ink); }
  .callout { margin: 16px 0; padding: 12px 18px; border-left: 4px solid var(--accent); border-radius: 0 10px 10px 0; background: #eef3fc; color: var(--ink); }
  ol.steps { counter-reset: s; list-style: none; padding: 0; }
  ol.steps > li { counter-increment: s; position: relative; margin: 10px 0; padding: 12px 16px 12px 52px; border-radius: 12px; background: #fff; border: 1px solid var(--line); }
  ol.steps > li::before { content: counter(s); position: absolute; left: 14px; top: 13px; width: 26px; height: 26px; border-radius: 50%; background: var(--warm); color: #fff; font-size: 14px; line-height: 26px; text-align: center; }
  .formula { margin: 14px 0 8px; padding: 14px 18px; border-radius: 10px; background: #fff; border: 1px solid var(--line); font-size: 19px; text-align: center; overflow-x: auto; }
  ul.symbols { font-size: 15.5px; color: var(--muted); }
  figure { margin: 18px 0; padding: 16px; border-radius: 12px; background: #fff; border: 1px solid var(--line); }
  figure svg { display: block; width: 100%; height: auto; }
  figcaption { margin-top: 8px; font-size: 14px; color: var(--muted); text-align: center; }
  table { width: 100%; margin: 12px 0 16px; border-collapse: collapse; font-size: 15px; font-variant-numeric: tabular-nums; }
  th, td { padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
  thead th { background: #f2f0ea; color: var(--ink); }
  .view { padding: 4px 22px 8px; border-radius: 14px; background: #fff; border: 1px solid var(--line); }
  details { margin: 10px 0; padding: 10px 16px; border-radius: 10px; border: 1px solid var(--line); background: #fff; }
  summary { cursor: pointer; font-weight: 600; color: var(--ink); }
  details p { margin: 8px 0 0; }
  footer { margin-top: 48px; text-align: center; font-size: 13px; color: #a4abb3; }
  @media (max-width: 600px) { body { padding: 0 18px 40px; font-size: 16px; } h1 { font-size: 28px; } .hero { padding-top: 32px; } }
</style>
</head>
<body>
<header class="hero">
  <p class="kicker">AI 前沿日报 · 深度解读</p>
  <h1>中文标题</h1>
  <p class="original">原文标题</p>
  <p class="meta">机构或团队 · 发布日期 · <a href="https://arxiv.org/abs/0000.00000">原文</a></p>
  <p class="tldr">一两句话说清：它做了什么，最重要的发现或结果是什么。</p>
</header>
<section>
  <h2>为什么值得读</h2>
  <p>它要解决什么问题，为什么现在重要；它是从哪里冒出来的（哪个团队、Hugging Face 多少票、哪些地方在讨论）。</p>
</section>
<section>
  <h2>前置知识</h2>
  <p>读懂后面需要的概念，讲清机制。</p>
  <aside class="term"><b>术语（English term）</b>解释。</aside>
</section>
<section>
  <h2>它是怎么做的</h2>
  <h3>第一个关键设计</h3>
  <p>先说这一步要解决什么，再说怎么做、为什么这样做。</p>
  <ol class="steps"><li>分步骤时用这个。</li></ol>
  <div class="formula"><math display="block"><mi>y</mi><mo>=</mo><mi>f</mi><mo>(</mo><mi>x</mi><mo>)</mo></math></div>
  <ul class="symbols"><li>y：含义</li></ul>
  <figure><svg viewBox="0 0 720 240" xmlns="http://www.w3.org/2000/svg"><!-- 示意图：文字 13～16 号，配色 #2864d7 #985c08 #0a7a6d #7447c8，浅底 #e9f0fd #fdf6e7 #e2f3ef，文字 #1b2531 --></svg><figcaption>图注</figcaption></figure>
  <div class="callout">一句话点出这一部分最关键的想法。</div>
</section>
<section>
  <h2>结果说明了什么</h2>
  <table>
    <thead><tr><th>基准</th><th>本文</th><th>对比的方法</th></tr></thead>
    <tbody><tr><td>名称</td><td>数字</td><td>数字</td></tr></tbody>
  </table>
  <p>这些数字说明了什么，哪些地方提升最大，哪里没有提升。</p>
</section>
<section class="view">
  <h2>我的看法</h2>
  <p>真正新的是什么，哪些只是在已有做法上的改进；局限、存疑或没说清的地方；和最近其他工作的关系，对之后意味着什么。</p>
</section>
<section>
  <h2>读完带走什么</h2>
  <ul><li>三到五条要点。</li></ul>
  <details><summary>一个值得想的问题</summary><p>参考思路。</p></details>
  <p>想读原文：先读哪几节，哪些可以跳过。延伸阅读：原文提到的、值得接着读的工作，写清为什么读。</p>
</section>
<footer>由页间插件「AI 前沿日报」整理 · {{now}} · <a href="../{{today}}%20AI%20前沿日报.html">回到今天的日报</a></footer>
</body>
</html>
```
