const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const vm = require('node:vm');
const load = (entry) => {
  const moduleContext = { exports: {} };
  vm.runInNewContext(
    buildSync({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs' })
      .outputFiles[0].text,
    { module: moduleContext, exports: moduleContext.exports },
  );
  return moduleContext.exports;
};
const { sectionAt } = load('src/note/reveal.ts');
const { answerNote } = load('src/ai/note-block.ts');

const answerA = '注意力机制让模型按相关程度给每个词加权。\n\n- 查询\n- 键';
const note = [
  '我自己的笔记。',
  '',
  '## 注意力是什么？（2026/10/7）',
  '',
  answerA,
  '',
  '## 位置编码有什么用？（2026/10/7）',
  '',
  '位置编码告诉模型每个词在第几个位置。',
].join('\n');

test('查看笔记 goes to the heading of the answer, wherever it is in the note', () => {
  assert.equal(sectionAt(note, answerA), note.indexOf('## 注意力是什么？'));
  assert.equal(
    sectionAt(note, '位置编码告诉模型每个词在第几个位置。'),
    note.indexOf('## 位置编码有什么用？'),
  );
});

test('an answer saved twice goes to the later copy', () => {
  const twice = `${note}\n\n## 注意力是什么？（2026/10/8）\n\n${answerA}`;
  assert.equal(sectionAt(twice, answerA), twice.lastIndexOf('## 注意力是什么？'));
});

test('an answer edited since is found by its first line', () => {
  const edited = note.replace('- 键', '- 键（我补充的）');
  assert.equal(sectionAt(edited, answerA), edited.indexOf('## 注意力是什么？'));
});

test('a board is found by its link, under its heading', () => {
  const board = `${note}\n\n## 白板：链表反转（2026/10/7）\n\n来自 a.html · [在白板中打开](folio-board:b1)\n\n![白板](note-image:board-1.png)`;
  assert.equal(sectionAt(board, '(folio-board:b1)'), board.indexOf('## 白板：链表反转'));
});

test('text with no heading above it goes to its own line', () => {
  const added = `${note}\n\n整理：三点要记住。`;
  assert.equal(sectionAt(added, '整理：三点要记住。'), added.indexOf('整理：三点要记住。'));
});

test('nothing to find, or gone from the note, is -1 (the note shows its top)', () => {
  assert.equal(sectionAt(note, ''), -1);
  assert.equal(sectionAt(note, '这段回答已经被删掉了，笔记里没有。'), -1);
  // A short first line could be anywhere, so an edited answer starting with one isn't guessed.
  assert.equal(sectionAt(note, '好的\n\n后面的内容被改过了。'), -1);
});

test('a saved answer keeps its question as the heading', () => {
  assert.equal(
    answerNote({ question: { text: '注意力是什么？' }, answer: '回答。', date: '2026/10/7' }),
    '## 注意力是什么？（2026/10/7）\n\n**AI 回答：**\n\n回答。',
  );
  // A quick action goes by its name, not its long prompt.
  assert.equal(
    answerNote({ question: { text: '请总结……（长提示）', label: '总结全文' }, answer: '要点。', date: 'd' }),
    '## 总结全文（d）\n\n**AI 回答：**\n\n要点。',
  );
  assert.equal(answerNote({ answer: '回答。', date: 'd' }), '## AI 回答（d）\n\n回答。');
});

test('a long question is shortened in the heading and kept whole below it', () => {
  const asked = '这一段讲的是 Transformer 里多头注意力为什么要把维度切开再拼回去，能不能举个例子？\n\n我没看懂第三段。';
  const block = answerNote({ question: { text: asked }, answer: '回答。', date: 'd' });
  const [heading, , q1, q2, q3] = block.split('\n');
  assert.equal(heading, `## ${asked.slice(0, 30)}…（d）`);
  assert.deepEqual([q1, q2, q3], [`> 问：${asked.split('\n')[0]}`, '>', '> 我没看懂第三段。']);
  assert.ok(block.endsWith('\n\n**AI 回答：**\n\n回答。'));
});

test('the passage asked about and the pictures go between the question and the answer', () => {
  const block = answerNote({
    question: { text: '这句话什么意思？', selection: '注意力即一切。' },
    pictures: ['ask-1.png', 'ask-2.jpg'],
    answer: '回答。',
    date: 'd',
  });
  assert.equal(
    block,
    [
      '## 这句话什么意思？（d）',
      '',
      '> 原文：注意力即一切。',
      '',
      '![提问附的图片](note-image:ask-1.png)',
      '',
      '![提问附的图片](note-image:ask-2.jpg)',
      '',
      '**AI 回答：**',
      '',
      '回答。',
    ].join('\n'),
  );
});

test('查看笔记 finds an answer saved with its question, quotes and pictures, by its heading', () => {
  const block = answerNote({
    question: { text: '一个很长很长很长很长很长很长很长很长很长很长很长的问题，超过三十个字了吧？', selection: '原文一句。' },
    pictures: ['ask-1.png'],
    answer: '这是回答的第一段。\n\n第二段。',
    date: 'd',
  });
  const doc = `${note}\n\n${block}\n\n后来写的笔记。`;
  assert.equal(sectionAt(doc, '这是回答的第一段。\n\n第二段。'), doc.indexOf('## 一个很长'));
});
