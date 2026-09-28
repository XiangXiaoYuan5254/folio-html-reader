import { Download, RefreshCw, X } from 'lucide-react';
import type { UpdateState } from '../types';
import { IconButton } from './IconButton';

type Available = Extract<UpdateState, { status: 'ready' | 'manual' }>;

// Release notes come from build/release-notes.md as plain text; each line becomes a list item.
const noteLines = (notes: string) =>
  notes
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 5);

export function UpdateCard({
  update,
  onRestart,
  onDownload,
  onLater,
}: {
  update: Available;
  onRestart: () => void;
  onDownload: () => void;
  onLater: () => void;
}) {
  const ready = update.status === 'ready';
  const lines = noteLines(update.notes);
  return (
    <section className="update-card" aria-labelledby="update-card-title">
      <div className="update-card-heading">
        {ready ? <RefreshCw size={16} /> : <Download size={16} />}
        <h2 id="update-card-title">
          页间 {update.version} {ready ? '已准备好' : '已发布'}
        </h2>
        <IconButton label="稍后再说" onClick={onLater}>
          <X size={15} />
        </IconButton>
      </div>
      {lines.length ? (
        <ul>
          {lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
      <p>
        {ready
          ? '重启页间即可使用新版本。选“稍后”的话，下次退出页间时会自动安装。'
          : '现在这份页间不能自动替换。请下载新版本，把它拖进“应用程序”文件夹，以后就会自动更新。'}
      </p>
      <div className="update-card-actions">
        <button type="button" className="secondary-button" onClick={onLater}>
          稍后
        </button>
        <button type="button" className="primary-button" onClick={ready ? onRestart : onDownload}>
          {ready ? '立即重启' : '去官网下载'}
        </button>
      </div>
    </section>
  );
}
