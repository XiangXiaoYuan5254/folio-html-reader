import { useMemo } from 'react';
import { diffLines, diffStats, hunks } from '../ai/diff';

// Changed lines with a little context, for reviewing AI edits before they're applied.
export function DiffView({
  before,
  after,
  maxHeight = 320,
}: {
  before: string;
  after: string;
  maxHeight?: number;
}) {
  const { groups, stats } = useMemo(() => {
    const lines = diffLines(before, after);
    return { groups: hunks(lines, 2), stats: diffStats(lines) };
  }, [before, after]);
  return (
    <div className="diff-view">
      <div className="diff-stats">
        <span className="diff-added">+{stats.added}</span>
        <span className="diff-removed">−{stats.removed}</span>
        <span>行</span>
      </div>
      <div className="diff-lines" style={{ maxHeight }}>
        {groups.length ? (
          groups.map((g, i) => (
            <div key={i}>
              {g.skippedBefore ? (
                <div className="diff-skip">⋯ {g.skippedBefore} 行未改动</div>
              ) : null}
              {g.lines.map((l, j) => (
                <div key={j} className={`diff-line diff-${l.type}`}>
                  <span className="diff-sign">
                    {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}
                  </span>
                  <span className="diff-text">{l.text || ' '}</span>
                </div>
              ))}
            </div>
          ))
        ) : (
          <div className="diff-skip">没有改动</div>
        )}
      </div>
    </div>
  );
}
