import { invoke } from '../api';
import type { PreparedTool, ToolOutcome } from '../ai/agent-tools';
import type { ToolDef } from '../ai/types';
import { htmlToText } from './web-tools';

// The tools of a plugin that works in a folder of its own (run.where "folder"): the folder is
// all it sees and the only place it writes, whichever project is open. electron/plugins.cjs
// checks every path against the folder, links included.
export const folderTools: ToolDef[] = [
  {
    name: 'list_files',
    description: '列出你的文件夹里的文档（HTML、PDF、Markdown），按修改时间从新到旧。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_document',
    description:
      '读取你的文件夹里的一篇 HTML 或 Markdown 文档的正文。path 是 list_files 给出的路径；长文档分段读取：offset 是起始字符位置，length 是字数（默认 12000，最多 30000）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        length: { type: 'integer', minimum: 500, maximum: 30000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_html',
    description:
      '在你的文件夹里新建一个 HTML 文件。path 是相对你的文件夹的路径，以 .html 结尾，例如「2026-11-04 日报.html」，不能和已有的文件重名；content 是完整的 HTML。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
];

const fail = (content: string): ToolOutcome => ({ content, isError: true, detail: content });
const folderOp = <T>(id: string, payload: Record<string, unknown>) =>
  invoke<T>('plugin-folder', { id, ...payload });
const day = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function prepareFolderTool(
  pluginId: string,
  name: string,
  input: any,
  progress: (detail: string) => void,
  // The folder as shown (~/Documents/AI日报), for the steps.
  shown = '插件的文件夹',
): PreparedTool | undefined {
  const path = String(input?.path ?? '').trim();
  if (name === 'list_files')
    return {
      title: `查看 ${shown} 里的文档`,
      run: async () => {
        const { folder, files } = await folderOp<{
          folder: string;
          files: { path: string; size: number; modified: number }[];
        }>(pluginId, { action: 'list' });
        return {
          content: files.length
            ? `文件夹 ${folder} 里有 ${files.length} 篇文档（从新到旧）：\n${files.map((f) => `${f.path}（${day(f.modified)}）`).join('\n')}`
            : `文件夹 ${folder} 里还没有文档。`,
          detail: `${files.length} 篇文档`,
        };
      },
    };
  if (name === 'read_document')
    return {
      title: `阅读《${path.split('/').pop()}》`,
      run: async () => {
        progress('正在读取…');
        const got = await folderOp<{ path: string; text: string }>(pluginId, {
          action: 'read',
          path,
        });
        const page = /\.html?$/i.test(got.path)
          ? htmlToText(got.text, 'https://folder.invalid/')
          : { title: '', body: got.text };
        const body = page.body;
        const offset = Math.max(0, Number(input?.offset) || 0);
        const length = Math.min(30_000, Math.max(500, Number(input?.length) || 12_000));
        const end = Math.min(body.length, offset + length);
        return {
          content: `《${page.title || got.path}》共 ${body.length} 字，本次为第 ${offset}–${end} 字${end < body.length ? `，可用 offset=${end} 继续读取` : '（已到结尾）'}：\n\n${body.slice(offset, end)}`,
          detail: `${body.length.toLocaleString()} 字`,
        };
      },
    };
  if (name === 'create_html') {
    const content = typeof input?.content === 'string' ? input.content : '';
    const tool: PreparedTool = {
      title: `在 ${shown} 新建 ${path}`,
      // What it writes is shown with the step, as the project agent's changes are.
      preview: { kind: 'create', path, content },
      run: async () => {
        if (!content.trim()) return fail('内容为空。');
        const made = await folderOp<{ path: string }>(pluginId, {
          action: 'create',
          path,
          content,
        });
        return { content: `已新建 ${made.path}。`, detail: '已新建' };
      },
    };
    return tool;
  }
  return undefined;
}
