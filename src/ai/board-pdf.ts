import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import type { BoardDocument } from './board-documents';

// Reuse the reader's offline worker, fonts and CMaps in the desktop app and Vite dev.
const assets = new URL(location.protocol === 'app:' ? './pdf/' : '/dist/pdf/', document.baseURI)
  .href;
GlobalWorkerOptions.workerSrc = assets + 'pdf.worker.mjs';

export async function readBoardPDF(file: File): Promise<BoardDocument> {
  const task = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: assets + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: assets + 'standard_fonts/',
    wasmUrl: assets + 'wasm/',
    // JS decoders and outline fonts work under the main UI's content policy.
    useWasm: false,
    disableFontFace: true,
  });
  try {
    const pdf = await task.promise;
    const images: BoardDocument['images'] = [];
    const parts: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      try {
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
          .join('')
          .trim();
        if (text) {
          parts.push(`【第 ${n} 页】\n${text}`);
        } else {
          const original = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({
            scale: 1568 / Math.max(original.width, original.height),
          });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          try {
            await page.render({ canvas, viewport }).promise;
            images.push({ page: n, src: canvas.toDataURL('image/jpeg', 0.9) });
          } finally {
            canvas.width = canvas.height = 0;
          }
        }
      } finally {
        page.cleanup();
      }
    }
    const notices = ['全部页面已读取；长文会自动分段处理'];
    if (images.length) {
      notices.push(`${images.length} 个无文字页面已全部附为图片，需要能看图的模型`);
    }
    if (parts.length) notices.push('已提取文字；图表可另附截图');
    return {
      name: file.name,
      text: parts.join('\n\n'),
      pages: pdf.numPages,
      notice: notices.join('；'),
      images,
    };
  } catch (error) {
    if ((error as Error).name === 'PasswordException')
      throw Error('PDF 有密码，请先解锁并另存后添加');
    throw Error('PDF 读取失败，请检查文件是否完整或另存为 PDF 后重试');
  } finally {
    await task.destroy();
  }
}
