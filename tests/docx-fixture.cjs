const JSZip = require('jszip');

// A small Word document, styled the way Chinese Word saves one: its styles have numeric ids
// ("1", "a3") and English names ("heading 1", "Title").
const ns = 'http://schemas.openxmlformats.org';
const p = (text, { style, align, bold } = {}) =>
  `<w:p>${style || align ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${align ? `<w:jc w:val="${align}"/>` : ''}</w:pPr>` : ''}<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const cell = (text) => `<w:tc>${p(text)}</w:tc>`;

async function makeDocx() {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  zip.file(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${ns}/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="a3"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style></w:styles>`,
  );
  const body = [
    p('年度报告', { style: 'a3', align: 'center' }),
    p('一、背景', { style: '1' }),
    `<w:p><w:r><w:t xml:space="preserve">今年的</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>重点</w:t></w:r><w:r><w:t>是阅读。</w:t></w:r></w:p>`,
    `<w:tbl><w:tr>${cell('项目')}${cell('进度')}</w:tr><w:tr>${cell('页间')}${cell('80%')}</w:tr></w:tbl>`,
    p('2026 年 11 月', { align: 'right' }),
  ].join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${ns}/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

module.exports = { makeDocx };
