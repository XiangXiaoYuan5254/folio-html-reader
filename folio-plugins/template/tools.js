// 插件脚本：在一个看不见的沙箱里运行，不能自己联网、读写文件或访问页间界面。
// 用全局对象 folio 给 AI 增加工具；类型说明见
// https://github.com/XiangXiaoYuan5254/folio-plugins/blob/main/types/folio.d.ts
/// <reference path="./folio.d.ts" />

folio.registerTool(
  {
    name: 'word_count',
    description: '数一段文字有多少个字（中文按字，英文按词）。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要数的文字' } },
      required: ['text'],
    },
  },
  ({ text }) => {
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const words = text
      .replace(/[\u4e00-\u9fff]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    folio.log('数了一段文字：', cjk, '个汉字，', words, '个词');
    return { cjk, words, total: cjk + words };
  },
);
