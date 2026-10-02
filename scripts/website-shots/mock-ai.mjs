// 官网截图用的本地 AI 服务：OpenAI 兼容接口，按请求的类型返回写好的回答，
// 让助手、划重点、划词、白板和精读笔记在截图里有真实的界面和像样的内容。
// 不联网，不需要真实的 API Key。
import http from 'node:http';

export const KEY = 'mock-key-for-website-shots';
export const MODELS = ['deepseek-chat', 'deepseek-reasoner'];

// 主图：在伴读笔记里问的问题和回答。引用必须和原文逐字一致。
export const QUESTION = 'Transformer 为什么比 RNN 训练得快？';
const ANSWER = [
  '关键在于**去掉了循环结构**，可以从两方面看：',
  '',
  '1. **能并行计算。** RNN 要等上一步算完才能算下一步，<cite>序列内部没法并行</cite>。Transformer 用注意力一次处理整句，<cite>去掉了 RNN 的循环结构，让序列建模可以高度并行</cite>。',
  '2. **信息传得更直接。** 句首和句尾的词不用一步步传话，<cite>自注意力让任意两个位置直接相连，最长路径只有 O(1)。</cite>',
  '',
  '效果也很直观：<cite>训练只用了 8 张 GPU、3.5 天</cite>，翻译质量还超过了当时最好的模型。',
].join('\n');
const REASONING =
  '用户问训练速度。笔记第 01 节对比了 RNN 和自注意力，一句话总结里有训练成本，按“并行”和“路径长度”两点回答，各附原文。';

// AI 划重点：论文第 2 页。
const HIGHLIGHTS = [
  {
    quote:
      'This inherently sequential nature precludes parallelization within training examples',
    note: 'RNN 的根本瓶颈：一步接一步，没法并行',
    kind: '观点',
  },
  {
    quote:
      'Self-attention, sometimes called intra-attention is an attention mechanism relating different positions of a single sequence',
    note: '自注意力：同一句话内部的词互相关联',
    kind: '定义',
  },
  {
    quote: 'after being trained for as little as twelve hours on eight P100 GPUs',
    note: '8 张 P100，12 小时就达到新高',
    kind: '数据',
  },
  {
    quote: 'the Transformer is the first transduction model relying entirely on self-attention',
    note: '第一个完全靠自注意力的转换模型',
    kind: '结论',
  },
];

const EXPLAIN = [
  '这句话在解释公式里为什么要除以 √dₖ。',
  '',
  'Q 和 K 的点积是 dₖ 个乘积相加，维度越高，加出来的数波动越大。分数之间差得太多时，softmax 会把几乎全部权重给最大的那一个，其余接近 0——这就是“梯度极小的区域”：权重几乎不随输入变化，模型很难学下去。',
  '',
  '除以 √dₖ 相当于把分数的尺度拉回到 1 左右，softmax 的输出更平滑，训练也就稳定了。',
].join('\n');
// 翻译：论文第 2 页的一句。
export const TRANSLATE_SOURCE =
  'Attention mechanisms have become an integral part of compelling sequence modeling and transduc-tion models in various tasks, allowing modeling of dependencies without regard to their distance in the input or output sequences';
const TRANSLATE =
  '注意力机制已经成为各类任务中优秀的序列建模与转换（transduction）模型不可或缺的一部分：它让模型在刻画依赖关系时，不必在意两个位置在输入或输出序列中相隔多远。';

// 白板：讲伴读笔记里“为什么要除以 √dk”这一段。
const LESSON = String.raw`say 这段在回答一个问题：公式里为什么要除以根号 d k。
title t0 | 为什么要除以 √dₖ
math m1 | \mathrm{Attention}=\mathrm{softmax}\left(\frac{[[qk:QK^\top]]}{[[dk:\sqrt{d_k}]]}\right)V
say 先看分子，Q 和 K 的点积，是 d k 个乘积加起来。
circle qk blue
text t1 | $q\cdot k = q_1k_1 + q_2k_2 + \cdots + q_{d_k}k_{d_k}$
say 每一项的方差差不多是 1，加了 d k 项，方差就变成 d k。
note t1 | 方差 ≈ dₖ
say 分数差得这么大，softmax 会怎样？画出来看看。
figure g1 | 600 250
draw g1 | <text x="150" y="26" text-anchor="middle" font-size="17">不缩放</text><line x1="40" y1="200" x2="260" y2="200"/>
draw g1 | <rect id="big" x="58" y="48" width="30" height="152" stroke="red" fill="red" fill-opacity="0.18"/><rect x="104" y="192" width="30" height="8" stroke="red"/><rect x="150" y="195" width="30" height="5" stroke="red"/><rect x="196" y="197" width="30" height="3" stroke="red"/>
say 几乎全部权重都压到一个词上，别的词接近 0，梯度也跟着接近 0。
circle big red
draw g1 | <text x="450" y="26" text-anchor="middle" font-size="17">除以 √dₖ</text><line x1="340" y1="200" x2="560" y2="200"/>
say 除以根号 d k 之后，分数回到正常范围，权重分得更开。
draw g1 | <arrow x1="276" y1="118" x2="326" y2="118" stroke="orange"/><text x="301" y="104" text-anchor="middle" fill="orange" font-size="15">÷√dₖ</text>
draw g1 | <rect x="358" y="104" width="30" height="96" stroke="blue" fill="blue" fill-opacity="0.18"/><rect x="404" y="128" width="30" height="72" stroke="blue" fill="blue" fill-opacity="0.18"/><rect x="450" y="150" width="30" height="50" stroke="blue" fill="blue" fill-opacity="0.18"/><rect id="small" x="496" y="166" width="30" height="34" stroke="blue" fill="blue" fill-opacity="0.18"/>
say 所以除以根号 d k，就是把方差拉回 1，让 softmax 别饱和。
circle dk orange
text t2 | 除以 $\sqrt{d_k}$：方差 $d_k \to 1$，softmax 不饱和，梯度不消失
box t2 green
say 这里还有哪一步不清楚？可以直接在白板上圈出来问我。`;

// 精读笔记：页间会把它放进自己的模板，并把 LaTeX 转成 MathML。
const COMPANION = String.raw`<header class="hero"><p class="kicker">精读笔记</p><h1>注意力就是你所需要的一切</h1><p class="original">Attention Is All You Need</p><p class="meta">Vaswani 等 · 2017 · NeurIPS</p><p class="tldr">用一个只靠注意力的架构 Transformer 替换掉 RNN 和 CNN，训练更快、翻译更好，后来成了几乎所有大模型的地基。</p></header>
<section class="card"><h2>前置铺垫</h2><p>这篇论文默认你知道“序列到序列”的翻译模型长什么样。下面两个概念先讲清，后面会反复用到。</p><aside class="term"><b>编码器-解码器（encoder-decoder）</b>编码器把输入句子读成一串向量，解码器再根据这串向量一个词一个词地生成译文。</aside><aside class="term"><b>注意力（attention）</b>生成某个词时，按相关程度给输入里的每个位置打分，再按分数把它们的信息加权求和。分数越高，这个位置对结果的影响越大。</aside></section>
<section class="card"><h2>阅读地图</h2><table><thead><tr><th>原文章节</th><th>分级</th><th>一句话</th></tr></thead><tbody><tr><td>1 Introduction</td><td><span class="level must">必读</span></td><td>RNN 必须按顺序计算，这是全文要解决的问题</td></tr><tr><td>2 Background</td><td><span class="level skim">略读</span></td><td>卷积方案也想并行，但远距离依赖仍然难学</td></tr><tr><td>3 Model Architecture</td><td><span class="level must">必读</span></td><td>编码器、解码器、注意力公式与多头注意力</td></tr><tr><td>4 Why Self-Attention</td><td><span class="level must">必读</span></td><td>从复杂度、并行度、路径长度三方面比较</td></tr><tr><td>5 Training</td><td><span class="level skim">略读</span></td><td>数据、硬件、优化器和正则化的设置</td></tr><tr><td>6 Results</td><td><span class="level must">必读</span></td><td>翻译新纪录，以及各组件的消融实验</td></tr></tbody></table></section>
<section class="card"><h2><span class="level must">必读</span>1 引言</h2><p>这一节只讲一件事：<strong>循环网络慢，是因为它天生要排队。</strong>第 t 步要等第 t−1 步算完，一句话再长也只能一个词一个词地算。</p><blockquote class="quote"><p>This inherently sequential nature precludes parallelization within training examples.</p><footer><a class="page" data-page="2">第 2 页</a> · 这种固有的顺序性，让训练样本内部无法并行。</footer></blockquote><div class="callout">作者的思路：既然注意力本来就能直接连接任意两个位置，干脆只用注意力，把循环整个拿掉。</div></section>
<section class="card"><h2><span class="level must">必读</span>3.2 缩放点积注意力</h2><p>先一句话说清它在算什么：<strong>每个词拿自己的“查询”去和所有词的“键”比相似度，再按相似度把它们的“值”加权平均。</strong></p><div class="formula">\[ \mathrm{Attention}(Q,K,V)=\mathrm{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}\right)V \]</div><ul class="symbols"><li>\(Q\)：查询矩阵，每行是一个词“在找什么”</li><li>\(K\)：键矩阵，每行是一个词“能被什么找到”</li><li>\(V\)：值矩阵，每行是一个词被找到后交出的内容</li><li>\(d_k\)：键向量的维度，论文里是 64</li></ul><ol class="steps"><li>\(QK^\top\) 算出每对词之间的相似度分数。</li><li>除以 \(\sqrt{d_k}\)，把分数的尺度拉回正常范围。</li><li>softmax 把每一行分数变成加起来等于 1 的权重。</li><li>用权重对 \(V\) 加权求和，得到每个词的新表示。</li></ol></section>`;

// 源码 AI 修改：让伴读笔记开头的“一句话总结”更醒目。
const SOURCE_EDIT = [
  '给“一句话总结”换成浅色渐变底，左侧加一条主色竖线，和正文拉开层次。',
  '<<<<<<< SEARCH',
  '.tldr{position:relative;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px 26px 20px;box-shadow:0 1px 2px rgba(20,30,60,.04)}',
  '=======',
  '.tldr{position:relative;background:linear-gradient(135deg,var(--accent-soft),var(--warm-soft));border:1px solid #d9e0ef;border-left:4px solid var(--accent);border-radius:6px 14px 14px 6px;padding:22px 26px 20px;box-shadow:0 8px 24px -10px rgba(52,80,143,.3)}',
  '>>>>>>> REPLACE',
].join('\n');

function stream(res, { reasoning = '', text = '' }, pace = 12) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunks = [];
  if (reasoning) chunks.push({ choices: [{ delta: { reasoning_content: reasoning } }] });
  for (let i = 0; i < text.length; i += 24)
    chunks.push({ choices: [{ delta: { content: text.slice(i, i + 24) } }] });
  chunks.push({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3200, completion_tokens: 420 },
  });
  let i = 0;
  const next = () => {
    if (i < chunks.length) {
      res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`);
      setTimeout(next, pace);
    } else res.end('data: [DONE]\n\n');
  };
  next();
}

export async function startMockAi() {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
    }
    const system = body.messages?.find((m) => m.role === 'system')?.content || '';
    const last = [...(body.messages || [])].reverse().find((m) => m.role === 'user')?.content;
    const user = typeof last === 'string' ? last : JSON.stringify(last || '');
    if (user.includes('连接测试')) return stream(res, { text: 'OK' });
    if (system.includes('专业译者')) return stream(res, { text: TRANSLATE });
    if (system.includes('解释用户选中的文字')) return stream(res, { text: EXPLAIN });
    if (system.includes('HTML 编辑助手')) return stream(res, { text: SOURCE_EDIT });
    if (system.includes('白板老师')) return stream(res, { text: LESSON }, 4);
    if (system.includes('精读伴读笔记')) return stream(res, { text: COMPANION }, 4);
    if (user.includes('"highlights"'))
      return stream(res, { text: JSON.stringify({ highlights: HIGHLIGHTS }) });
    return stream(res, { reasoning: REASONING, text: ANSWER });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}
