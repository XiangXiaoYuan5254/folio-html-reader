import { useEffect, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { invoke } from '../api';

// 设置 › 项目存储: what Folio keeps in the open project (electron/workspace.cjs storage()),
// by kind, and clearing what grows without bound: whiteboards, and old backups.
type Kind = 'backups' | 'boards' | 'noteImages' | 'ai' | 'documents' | 'other';
type Storage = {
  total: number;
  kinds: Record<Kind, number>;
  boards: { id: string; title: string; source: string; updatedAt: number; size: number }[];
  backups: { count: number; free: Record<'0' | '1' | '7', number> };
  unused: Record<Leftover, { count: number; size: number }>;
};
// Data no document uses any more (electron/workspace.cjs unused()).
type Leftover = 'documents' | 'ai' | 'backups' | 'noteImages';
const leftovers: { id: Leftover; name: string; unit: string }[] = [
  { id: 'documents', name: '批注与笔记', unit: '份' },
  { id: 'ai', name: 'AI 对话记录', unit: '份' },
  { id: 'backups', name: '历史版本备份', unit: '篇文档' },
  { id: 'noteImages', name: '笔记图片', unit: '张' },
];
const kinds: { id: Kind; name: string; about: string }[] = [
  {
    id: 'backups',
    name: '历史版本备份',
    about: '编辑 HTML 时自动留下的旧版本，用来在「历史版本」里恢复。超过 30 天的会自动删除。',
  },
  { id: 'boards', name: '白板', about: '白板讲解的内容、图片和朗读的语音。不会自动删除。' },
  { id: 'noteImages', name: '笔记图片', about: '贴进笔记里的图片。' },
  { id: 'ai', name: 'AI 对话记录', about: '和 AI 助手的对话，以及 AI 修改源码的对话。' },
  { id: 'documents', name: '批注与笔记', about: '高亮、批注、便签和笔记文字。' },
  { id: 'other', name: '其他', about: '项目索引、升级时留下的备份等。' },
];
const keeps = [
  { days: '7', label: '只保留最近 7 天的' },
  { days: '1', label: '只保留最近 1 天的' },
  { days: '0', label: '每篇文档只保留最新一份' },
] as const;
const DAY = 86_400_000;

function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
function ago(time: number) {
  const days = Math.floor((Date.now() - time) / DAY);
  if (!Number.isFinite(days) || days < 1) return '今天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

export function StorageSettings(p: {
  projectName?: string;
  onBoardDeleted: (id: string) => void;
  onNotify: (message: string) => void;
}) {
  const [data, setData] = useState<Storage | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [keep, setKeep] = useState<(typeof keeps)[number]['days']>('7');
  // Deleting asks once more on the same button, as the board list does.
  const [confirm, setConfirm] = useState<'' | 'unused' | 'boards' | 'backups'>('');
  async function load() {
    setError('');
    try {
      const next = await invoke<Storage>('storage');
      setData(next);
      setPicked((s) => new Set([...s].filter((id) => next.boards.some((b) => b.id === id))));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function run(task: () => Promise<string>) {
    setBusy(true);
    setConfirm('');
    try {
      p.onNotify(await task());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await load();
      setBusy(false);
    }
  }
  if (!data)
    return error ? (
      <p className="settings-footnote" role="alert">
        {error}
      </p>
    ) : (
      <p className="settings-footnote">
        <LoaderCircle className="spin" size={13} /> 正在统计…
      </p>
    );
  const boards = [...data.boards].sort((a, b) => b.size - a.size);
  const chosen = boards.filter((b) => picked.has(b.id));
  const chosenSize = chosen.reduce((sum, b) => sum + b.size, 0);
  const stale = boards.filter((b) => Date.now() - b.updatedAt > 90 * DAY);
  const freeable = data.backups.free[keep];
  const left = leftovers.filter((l) => data.unused[l.id].count);
  const leftSize = left.reduce((sum, l) => sum + data.unused[l.id].size, 0);
  // Biggest first, in the bar and the list alike.
  const sorted = [...kinds].sort((a, b) => data.kinds[b.id] - data.kinds[a.id]);
  const shown = sorted.filter((k) => data.kinds[k.id] > 0);
  return (
    <div className="settings-storage">
      <section className="settings-group">
        <div className="settings-storage-head">
          <div>
            <h4>{p.projectName ? `「${p.projectName}」里页间的数据` : '当前项目里页间的数据'}</h4>
            <p>
              共 <strong>{bytes(data.total)}</strong>
              。存在项目文件夹里的 .html-reader 中，你的文档本身不算在内。
            </p>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void load()}
          >
            <RefreshCw size={13} />
            重新统计
          </button>
        </div>
        {data.total ? (
          <div className="settings-storage-bar" aria-hidden="true">
            {shown.map((k) => (
              <span key={k.id} className={`kind-${k.id}`} style={{ flexGrow: data.kinds[k.id] }} />
            ))}
          </div>
        ) : null}
        <ul className="settings-storage-kinds" aria-label="按类别的占用">
          {sorted.map((k) => (
            <li key={k.id}>
              <i className={`kind-${k.id}`} />
              <span>
                <strong>{k.name}</strong>
                <small>{k.about}</small>
              </span>
              <output>{bytes(data.kinds[k.id])}</output>
            </li>
          ))}
        </ul>
      </section>

      <section className="settings-group">
        <h4>无用数据</h4>
        <p className="settings-storage-note">
          已经删掉、或在页间外移走的文件留下的批注、AI
          对话和历史备份，以及不再被任何笔记用到的图片。在页间外改了名但内容没变的文件不算在内，重新打开时批注会自动找回。清理后，即使把文件从废纸篓放回来，原来的批注和对话也找不回了。
        </p>
        {left.length ? (
          <ul className="settings-storage-left" aria-label="无用数据">
            {left.map((l) => (
              <li key={l.id}>
                <span>
                  {l.name}
                  <small>
                    {data.unused[l.id].count} {l.unit}
                  </small>
                </span>
                <output>{bytes(data.unused[l.id].size)}</output>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="settings-storage-actions">
          <button
            type="button"
            className={confirm === 'unused' ? 'ai-danger' : 'secondary-button'}
            disabled={busy || !left.length}
            onClick={() => {
              if (confirm !== 'unused') return setConfirm('unused');
              void run(async () => {
                const { freed } = await invoke<{ freed: number }>('clear-unused');
                return `已清理无用数据，释放 ${bytes(freed)}`;
              });
            }}
          >
            {confirm === 'unused'
              ? `确认清理？会释放 ${bytes(leftSize)}`
              : left.length
                ? `一键清理，可释放 ${bytes(leftSize)}`
                : '没有无用数据'}
          </button>
        </div>
      </section>

      <section className="settings-group">
        <h4>白板</h4>
        {boards.length ? (
          <>
            <div className="settings-storage-tools">
              <span>{boards.length} 块，按大小排列。删除后无法恢复，白板的语音也会一起删除。</span>
              {stale.length ? (
                <button
                  type="button"
                  className="settings-link"
                  onClick={() => setPicked(new Set(stale.map((b) => b.id)))}
                >
                  选中 3 个月没改过的（{stale.length}）
                </button>
              ) : null}
              <button
                type="button"
                className="settings-link"
                onClick={() =>
                  setPicked(
                    chosen.length === boards.length ? new Set() : new Set(boards.map((b) => b.id)),
                  )
                }
              >
                {chosen.length === boards.length ? '全不选' : '全选'}
              </button>
            </div>
            <div className="settings-storage-boards" role="group" aria-label="项目里的白板">
              {boards.map((b) => (
                <label key={b.id}>
                  <input
                    type="checkbox"
                    checked={picked.has(b.id)}
                    onChange={() => {
                      setConfirm('');
                      setPicked((s) => {
                        const next = new Set(s);
                        if (next.has(b.id)) next.delete(b.id);
                        else next.add(b.id);
                        return next;
                      });
                    }}
                  />
                  <span>
                    <strong>{b.title || '未命名白板'}</strong>
                    <small>
                      {b.source ? `${b.source.split('/').at(-1)} · ` : ''}
                      {ago(b.updatedAt)}修改
                    </small>
                  </span>
                  <output>{bytes(b.size)}</output>
                </label>
              ))}
            </div>
            <div className="settings-storage-actions">
              <button
                type="button"
                className={confirm === 'boards' ? 'ai-danger' : 'secondary-button'}
                disabled={busy || !chosen.length}
                onClick={() => {
                  if (confirm !== 'boards') return setConfirm('boards');
                  void run(async () => {
                    for (const b of chosen) {
                      await invoke('delete-board', { id: b.id });
                      p.onBoardDeleted(b.id);
                    }
                    setPicked(new Set());
                    return `已删除 ${chosen.length} 块白板，释放 ${bytes(chosenSize)}`;
                  });
                }}
              >
                {confirm === 'boards'
                  ? `确认删除这 ${chosen.length} 块白板？`
                  : chosen.length
                    ? `删除选中的 ${chosen.length} 块（${bytes(chosenSize)}）`
                    : '删除选中的白板'}
              </button>
            </div>
          </>
        ) : (
          <p className="settings-footnote">这个项目里还没有白板。</p>
        )}
      </section>

      <section className="settings-group">
        <h4>旧备份</h4>
        <div className="settings-row">
          <span>
            <strong>清理历史版本备份</strong>
            <small>
              {data.backups.count
                ? `除每篇文档最新的一份外，还有 ${data.backups.count} 份旧备份。清理后就不能恢复到那些时间点的版本。`
                : '除每篇文档最新的一份外，没有更早的备份。'}
            </small>
          </span>
          <select
            aria-label="保留哪些备份"
            value={keep}
            disabled={!data.backups.count}
            onChange={(e) => {
              setConfirm('');
              setKeep(e.target.value as typeof keep);
            }}
          >
            {keeps.map((k) => (
              <option key={k.days} value={k.days}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-storage-actions">
          <button
            type="button"
            className={confirm === 'backups' ? 'ai-danger' : 'secondary-button'}
            disabled={busy || !freeable}
            onClick={() => {
              if (confirm !== 'backups') return setConfirm('backups');
              void run(async () => {
                const { freed } = await invoke<{ freed: number }>('clear-backups', {
                  days: Number(keep),
                });
                return `已清理旧备份，释放 ${bytes(freed)}`;
              });
            }}
          >
            {confirm === 'backups'
              ? `确认清理？会释放 ${bytes(freeable)}`
              : freeable
                ? `清理，可释放 ${bytes(freeable)}`
                : '没有可清理的备份'}
          </button>
        </div>
      </section>
      {error ? (
        <p className="settings-footnote settings-storage-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
