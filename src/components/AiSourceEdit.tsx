import { useEffect, useRef, useState } from 'react';
import { CircleStop, CircleX, LoaderCircle, WandSparkles, X } from 'lucide-react';
import type { OpenDocument } from '../types';
import type { Assistant } from '../ai/assistant';
import { chat, errorText, isAbort } from '../ai/client';
import { documentBudget, estimateTokens } from '../ai/context';
import { applyReply } from '../ai/edits';
import { sourceEditPrompt, sourceEditSystem } from '../ai/prompts';
import { Markdown } from '../ai/Markdown';
import { DiffView } from './DiffView';
import { ModelMenu } from './ModelMenu';

type Proposal = {
  base: string;
  reply: string;
  source: string;
  failed: string[];
  explanation: string;
};
const examples = [
  '改成深色配色',
  '给表格加上斑马纹和表头底色',
  '把正文字号调大一些，行距更宽松',
  '在开头加一个目录',
];

// Source mode: describe a change, review the diff, then apply it to the editor.
export function AiSourceEdit(p: {
  doc: OpenDocument;
  store: Assistant;
  editorSelection: () => string;
  onPreview: (source: string | null) => void;
  onApply: (source: string) => void;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const [request, setRequest] = useState('');
  const [status, setStatus] = useState<'idle' | 'running' | 'error'>('idle');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    input.current?.focus();
    return () => {
      controller.current?.abort();
      p.onPreview(null);
    };
  }, []);
  useEffect(() => {
    p.onPreview(proposal && !showOriginal ? proposal.source : null);
  }, [proposal, showOriginal]);
  async function run() {
    const text = request.trim();
    if (!text || status === 'running') return;
    const base = p.doc.draft;
    setStatus('running');
    setError('');
    setProgress(0);
    setProposal(null);
    const c = new AbortController();
    controller.current = c;
    try {
      const { provider } = await p.store.provider('edit');
      const tokens = estimateTokens(base);
      if (tokens > documentBudget(provider, 0.6))
        throw Error(
          `这个文件约 ${tokens.toLocaleString()} tokens，超出了当前模型一次能处理的长度。可以换用上下文更长的模型，或只选中一部分代码后再试。`,
        );
      const selected = p.editorSelection();
      let length = 0;
      const result = await chat(
        {
          system: sourceEditSystem(),
          use: 'edit',
          messages: [
            {
              role: 'user',
              content: sourceEditPrompt(p.doc.path, base, text, selected || undefined),
            },
          ],
        },
        {
          signal: c.signal,
          onText: (d) => {
            length += d.length;
            setProgress(length);
          },
        },
      );
      const edit = applyReply(base, result.text);
      if (!edit.applied || edit.source === base) {
        setStatus('error');
        setError(
          edit.failed.length
            ? `生成的修改没能对上源码，请换个说法再试：\n${edit.failed.join('\n')}`
            : `没有生成修改。${edit.explanation.slice(0, 300)}`,
        );
        return;
      }
      setProposal({ base, reply: result.text, ...edit });
      setShowOriginal(false);
      setStatus('idle');
    } catch (e) {
      if (isAbort(e)) setStatus('idle');
      else {
        setStatus('error');
        setError(errorText(e));
      }
    } finally {
      controller.current = null;
    }
  }
  function apply() {
    if (!proposal) return;
    let next = proposal.source;
    // Edited meanwhile: re-apply the same edits to the current source.
    if (p.doc.draft !== proposal.base) {
      const again = applyReply(p.doc.draft, proposal.reply);
      if (!again.applied || again.failed.length) {
        setStatus('error');
        setError('生成修改之后源码又被改动过，修改已对不上。请重新生成。');
        setProposal(null);
        return;
      }
      next = again.source;
    }
    p.onApply(next);
    setProposal(null);
    setRequest('');
  }
  return (
    <div className="ai-source" role="region" aria-label="AI 修改 HTML">
      <div className="ai-source-head">
        <WandSparkles size={14} />
        <strong>AI 修改</strong>
        <span>描述想怎么改，确认改动后再写入源码</span>
        <ModelMenu use="edit" className="model-pick-mini" onOpenSettings={p.onOpenSettings} />
        <button className="icon-button" aria-label="关闭 AI 修改" onClick={p.onClose}>
          <X size={15} />
        </button>
      </div>
      {!proposal ? (
        <>
          <div className="ai-source-input">
            <textarea
              ref={input}
              rows={2}
              aria-label="修改要求"
              placeholder="例如：把配色改成深色；给所有图片加圆角和阴影。选中一段代码可以只改那一部分。"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void run();
                }
              }}
            />
            {status === 'running' ? (
              <button className="secondary-button" onClick={() => controller.current?.abort()}>
                <CircleStop size={14} />
                停止
              </button>
            ) : (
              <button
                className="primary-button"
                disabled={!request.trim()}
                onClick={() => void run()}
              >
                生成修改
              </button>
            )}
          </div>
          {status === 'running' ? (
            <div className="ai-source-status">
              <LoaderCircle className="spin" size={13} />
              正在生成修改{progress ? `（已写 ${progress.toLocaleString()} 字）` : '…'}
            </div>
          ) : status === 'error' ? (
            <div className="chat-error" role="alert">
              <CircleX size={14} />
              <span>{error}</span>
            </div>
          ) : !request ? (
            <div className="ai-source-examples">
              {examples.map((e) => (
                <button key={e} onClick={() => setRequest(e)}>
                  {e}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="ai-source-proposal">
          {proposal.explanation ? <Markdown text={proposal.explanation} /> : null}
          {proposal.failed.length ? (
            <div className="chat-error">
              <CircleX size={14} />
              <span>有 {proposal.failed.length} 处修改没能对上源码，已跳过。</span>
            </div>
          ) : null}
          <DiffView before={proposal.base} after={proposal.source} maxHeight={260} />
          <div className="ai-source-actions">
            <label>
              <input
                type="checkbox"
                checked={showOriginal}
                onChange={(e) => setShowOriginal(e.target.checked)}
              />
              预览修改前
            </label>
            <span className="toolbar-flex" />
            <button className="secondary-button" onClick={() => setProposal(null)}>
              放弃
            </button>
            <button className="primary-button" onClick={apply}>
              应用修改
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
