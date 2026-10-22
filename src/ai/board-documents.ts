import { readableText } from '../reader/readable-text';

export const maxDocuments = 4;
export const documentAccept = '.pdf,.txt,.md,.markdown,.html,.htm';
export const isBoardDocument = (file: File) => /\.(pdf|txt|md|markdown|html?)$/i.test(file.name);

export type BoardDocument = {
  name: string;
  text: string;
  pages?: number;
  notice: string;
  images: { page: number; src: string }[];
};

// Parse in a template's inert document, without executing scripts or loading resources.
export function htmlDocumentText(source: string) {
  const template = document.createElement('template');
  template.innerHTML = source;
  const title = template.content.querySelector('title')?.textContent?.trim();
  template.content.querySelectorAll('title,meta,link,base').forEach((el) => el.remove());
  const body = readableText(template.content, false);
  return [title ? `# ${title}` : '', body].filter(Boolean).join('\n\n');
}

function decodeText(bytes: ArrayBuffer) {
  const head = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gb18030', { fatal: true }).decode(bytes);
    } catch {
      throw Error('无法识别文件编码，请另存为 UTF-8 再添加');
    }
  }
}

export async function readBoardDocument(file: File): Promise<BoardDocument> {
  if (!isBoardDocument(file)) throw Error('支持 PDF、TXT、Markdown 和 HTML 文件');
  const pdf = /\.pdf$/i.test(file.name);
  const mb = pdf ? 20 : 2;
  if (file.size > mb * 1024 * 1024) throw Error(`文件超过 ${mb} MB，请拆分后添加`);
  if (!file.size) throw Error('文件是空的');
  if (pdf) return (await import('./board-pdf')).readBoardPDF(file);
  const source = decodeText(await file.arrayBuffer());
  if (source.includes('\0')) throw Error('文件不是可读取的文本，请另存为 UTF-8 再添加');
  const html = /\.html?$/i.test(file.name);
  const text = (html ? htmlDocumentText(source) : source).trim();
  if (!text) throw Error('没有读到正文，请检查文件内容');
  const notices = html ? ['已提取静态正文；网页图片和脚本生成的内容请另附截图'] : [];
  notices.unshift('正文已完整读取；长文会自动分段处理');
  return {
    name: file.name,
    text,
    notice: notices.join('；'),
    images: [],
  };
}
