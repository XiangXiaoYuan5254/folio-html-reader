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
    quote: 'This inherently sequential nature precludes parallelization within training examples',
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

// 全文翻译：论文前三页的译文，按原文开头的几个词对上每一部分。后面几页只回一句说明。
const TRANSLATION_HEAD = String.raw`<h1 data-src="Attention Is All You Need">注意力就是你所需要的一切</h1><p class="authors">Ashish Vaswani、Noam Shazeer、Niki Parmar、Jakob Uszkoreit、Llion Jones、Aidan N. Gomez、Łukasz Kaiser、Illia Polosukhin</p>`;
const TRANSLATION_TERMS = [
  ['sequence transduction', '序列转换'],
  ['attention mechanism', '注意力机制'],
  ['self-attention', '自注意力'],
  ['multi-head attention', '多头注意力'],
  ['encoder', '编码器'],
  ['decoder', '解码器'],
  ['recurrent neural network', '循环神经网络'],
  ['convolutional neural network', '卷积神经网络'],
  ['long short-term memory', '长短期记忆'],
  ['residual connection', '残差连接'],
  ['layer normalization', '层归一化'],
  ['BLEU', 'BLEU'],
  ['Transformer', 'Transformer'],
];
const TRANSLATION = [
  ['h2', 'Abstract', '摘要'],
  [
    'p',
    'The dominant sequence transduction models are based',
    '主流的序列转换模型都建立在复杂的循环神经网络或卷积神经网络之上，由一个编码器和一个解码器组成。表现最好的模型还会通过注意力机制把编码器和解码器连接起来。我们提出一种新的简单网络架构——Transformer，它完全基于注意力机制，彻底抛弃了循环和卷积。在两个机器翻译任务上的实验表明，这种模型质量更好，更易于并行，训练时间也大大缩短。我们的模型在 WMT 2014 英德翻译任务上取得 28.4 BLEU，比包括集成模型在内的现有最好结果高出 2 BLEU 以上。在 WMT 2014 英法翻译任务上，我们的模型只用 8 张 GPU 训练 3.5 天，就创下 41.8 的单模型 BLEU 新纪录，训练成本只是文献中最好模型的一小部分。我们还把 Transformer 成功用于英语成分句法分析，无论训练数据多还是少都表现良好，说明它能很好地泛化到其他任务。',
  ],
  [
    'p class="footnote"',
    'Equal contribution. Listing order is random.',
    '∗ 同等贡献，排名不分先后。Jakob 提出用自注意力取代 RNN，并着手验证这一想法；Ashish 与 Illia 设计并实现了最早的 Transformer 模型，深度参与了这项工作的方方面面；Noam 提出了缩放点积注意力、多头注意力和无参数的位置表示。',
  ],
  ['h2', '1 Introduction', '1 引言'],
  [
    'p',
    'Recurrent neural networks, long short-term memory',
    '循环神经网络，尤其是长短期记忆 [13] 和门控循环 [7] 神经网络，已经牢牢确立为序列建模和转换问题（如语言建模和机器翻译 [35, 2, 5]）中最先进的方法。此后，大量工作继续推动着循环语言模型和编码器-解码器架构的边界 [38, 24, 15]。',
  ],
  [
    'p',
    'Recurrent models typically factor computation along the',
    String.raw`循环模型通常沿输入和输出序列的符号位置分解计算。它们把位置对齐到计算的时间步，根据前一个隐藏状态 \(h_{t-1}\) 和位置 \(t\) 的输入，生成一串隐藏状态 \(h_t\)。<strong>这种固有的顺序性，使训练样本内部无法并行</strong>；序列越长，这一点越关键，因为内存限制了跨样本的批处理。近来的工作通过分解技巧 [21] 和条件计算 [32] 显著提升了计算效率，后者还提升了模型性能。然而，顺序计算这一根本限制依然存在。`,
  ],
  [
    'p',
    'Attention mechanisms have become an integral part of',
    '注意力机制已经成为各类任务中优秀的序列建模与转换模型不可或缺的一部分：它让模型在刻画依赖关系时，不必在意两个位置在输入或输出序列中相隔多远 [2, 19]。不过除了少数情况 [27]，这类注意力机制都是和循环网络一起使用的。',
  ],
  [
    'p',
    'In this work we propose the Transformer',
    '在这项工作中，我们提出 Transformer：一种摒弃循环、完全依靠注意力机制来建立输入与输出之间全局依赖的模型架构。Transformer 的并行程度高得多，在 8 张 P100 GPU 上只训练 12 小时，翻译质量就能达到新的最高水平。',
  ],
  ['h2', '2 Background', '2 背景'],
  [
    'p',
    'The goal of reducing sequential computation also forms',
    '减少顺序计算这一目标，同样是 Extended Neural GPU [16]、ByteNet [18] 和 ConvS2S [9] 的基础。它们都以卷积神经网络为基本构件，对所有输入和输出位置并行计算隐藏表示。在这些模型中，关联任意两个输入或输出位置的信号所需的运算次数，会随两者的距离增长：ConvS2S 线性增长，ByteNet 对数增长。这使得学习远距离位置之间的依赖更加困难 [12]。在 Transformer 中，这被降为常数次运算，代价是对注意力加权的位置取平均，有效分辨率有所降低；我们用 3.2 节介绍的多头注意力来抵消这一影响。',
  ],
  [
    'p',
    'Self-attention, sometimes called intra-attention is an',
    '自注意力，有时也称内部注意力，是一种把同一序列中不同位置联系起来、以计算该序列表示的注意力机制。自注意力已经成功用于多种任务，包括阅读理解、生成式摘要、文本蕴含，以及学习与任务无关的句子表示 [4, 27, 28, 22]。',
  ],
  [
    'p',
    'End-to-end memory networks are based on a recurrent',
    '端到端记忆网络基于循环注意力机制，而不是与序列对齐的循环结构，在简单语言问答和语言建模任务上表现良好 [34]。',
  ],
  [
    'p',
    'To the best of our knowledge, however, the Transformer',
    '然而据我们所知，Transformer 是第一个完全依靠自注意力来计算输入和输出表示、不使用序列对齐 RNN 或卷积的转换模型。接下来几节，我们会描述 Transformer，说明采用自注意力的动机，并讨论它相对于 [17, 18] 和 [9] 等模型的优势。',
  ],
  ['h2', '3 Model Architecture', '3 模型架构'],
  [
    'p',
    'Most competitive neural sequence transduction models have',
    String.raw`大多数有竞争力的神经序列转换模型都采用编码器-解码器结构 [5, 2, 35]。编码器把符号表示的输入序列 \((x_1, \dots, x_n)\) 映射为连续表示的序列 \(\mathbf{z} = (z_1, \dots, z_n)\)。给定 \(\mathbf{z}\)，解码器再一次一个元素地生成符号输出序列 \((y_1, \dots, y_m)\)。每一步模型都是自回归的 [10]：生成下一个符号时，把之前生成的符号作为额外输入。`,
  ],
  [
    'p class="caption"',
    'Figure 1: The Transformer - model architecture.',
    '图 1：Transformer 的模型架构。',
  ],
  [
    'p',
    'The Transformer follows this overall architecture using',
    'Transformer 沿用这一整体架构，编码器和解码器都由堆叠的自注意力层和逐位置的全连接层组成，分别如图 1 的左半部分和右半部分所示。',
  ],
  ['h3', '3.1 Encoder and Decoder Stacks', '3.1 编码器和解码器堆栈'],
  [
    'p',
    'Encoder: The encoder is composed of a stack',
    String.raw`<strong>编码器：</strong>编码器由 \(N = 6\) 个相同的层堆叠而成。每层有两个子层：第一个是多头自注意力机制，第二个是简单的逐位置全连接前馈网络。每个子层外面都有一个残差连接 [11]，随后做层归一化 [1]。也就是说，每个子层的输出是 \(\mathrm{LayerNorm}(x + \mathrm{Sublayer}(x))\)，其中 \(\mathrm{Sublayer}(x)\) 是子层本身实现的函数。为了方便残差连接，模型中所有子层以及嵌入层的输出维度都是 \(d_{\text{model}} = 512\)。`,
  ],
  [
    'p',
    'Decoder: The decoder is also composed of',
    String.raw`<strong>解码器：</strong>解码器同样由 \(N = 6\) 个相同的层堆叠而成。除了编码器每层的两个子层，解码器还插入第三个子层，对编码器堆栈的输出做多头注意力。和编码器一样，每个子层外面都有残差连接，随后做层归一化。我们还修改了解码器中的自注意力子层，防止某个位置关注到它之后的位置。这种掩码，再加上输出嵌入偏移了一个位置，保证了位置 \(i\) 的预测只能依赖于位置小于 \(i\) 的已知输出。`,
  ],
];
// One part's reply: the blocks whose original starts in this part, in order, with their page.
function translatePart(prompt) {
  const source = prompt.slice(prompt.lastIndexOf('<source>'));
  const flat = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const text = flat(source);
  const pageAt = (words) => {
    const at = source.indexOf(words.split(' ')[0]);
    const marks = [...source.slice(0, at).matchAll(/\[第 (\d+) 页\]/g)];
    return marks.at(-1)?.[1] || '1';
  };
  const blocks = TRANSLATION.filter(([, src]) => text.includes(flat(src)))
    .sort((a, b) => text.indexOf(flat(a[1])) - text.indexOf(flat(b[1])))
    .map(([tag, src, zh]) => {
      const name = tag.split(' ')[0];
      return `<${tag} data-page="${pageAt(src)}" data-src="${src}">${zh}</${name}>`;
    });
  const first = prompt.includes('这一部分是文档的开头');
  if (!blocks.length) {
    const words = source
      .replace(/<source>|\[第 \d+ 页\]/g, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, 8);
    return `<p class="skipped" data-page="${pageAt(words[0])}" data-src="${words.join(' ')}">（示例译文只包含论文前三页。）</p>`;
  }
  const terms = TRANSLATION_TERMS.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('');
  return (
    (first ? TRANSLATION_HEAD : '') +
    blocks.join('') +
    (first ? `<dl class="terms">${terms}</dl>` : '')
  );
}

// 宣传视频录屏时放慢普通回答的输出，看得见逐字出现；白板和精读笔记传了自己的节奏，不受影响。
const pacing = { pace: 12, size: 24 };
function stream(res, { reasoning = '', text = '' }, pace = pacing.pace, size = pacing.size) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunks = [];
  if (reasoning) chunks.push({ choices: [{ delta: { reasoning_content: reasoning } }] });
  for (let i = 0; i < text.length; i += size)
    chunks.push({ choices: [{ delta: { content: text.slice(i, i + size) } }] });
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

export async function startMockAi({ pace = 12, size = 24 } = {}) {
  Object.assign(pacing, { pace, size });
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
    if (system.includes('学术翻译'))
      return user.includes('漏掉了一些原文')
        ? stream(res, { text: '' })
        : stream(res, { text: translatePart(user) }, 30, 6);
    if (system.includes('专业译者')) return stream(res, { text: TRANSLATE });
    if (system.includes('解释用户选中的文字')) return stream(res, { text: EXPLAIN });
    if (system.includes('HTML 编辑助手')) return stream(res, { text: SOURCE_EDIT });
    if (system.includes('白板老师')) return stream(res, { text: LESSON }, 4, 24);
    if (system.includes('精读伴读笔记')) return stream(res, { text: COMPANION }, 4, 24);
    if (user.includes('"highlights"'))
      return stream(res, { text: JSON.stringify({ highlights: HIGHLIGHTS }) });
    return stream(res, { reasoning: REASONING, text: ANSWER });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}
