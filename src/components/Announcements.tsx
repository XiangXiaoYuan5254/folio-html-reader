import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react';
import { invoke } from '../api';
import { errorText } from '../ai/client';
import type { AiPreset } from '../ai/types';
import { loadAnnouncements, markAnnouncementsSeen } from '../announcements';
import type { AnnouncementFeed } from '../announcements';

const pad = (n: number) => String(n).padStart(2, '0');
// A date on this computer: 2026-11-30.
const day = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${day(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function Announcements({
  presets,
  onConfigure,
  active = true,
}: {
  presets: AiPreset[];
  // 去配置: opens this service in AI 设置.
  onConfigure: (preset: string) => void;
  // Settings keeps visited pages mounted; only a visible feed counts as read.
  active?: boolean;
}) {
  const [feed, setFeed] = useState<AnnouncementFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError('');
    try {
      const loaded = await loadAnnouncements(force);
      setFeed(loaded);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (active) void load();
  }, [load, active]);
  useEffect(() => {
    if (active && feed) markAnnouncementsSeen(feed);
  }, [active, feed]);
  const now = Date.now();
  // The server leaves expired ones out already; this covers a copy read from disk.
  const items = (feed?.items || []).filter((a) => !a.expires || a.expires > now);
  return (
    <div className="announcements-page">
      <p className="ai-settings-lead">
        厂商当前能领的免费额度、赠送和优惠活动，核实后发布；以官方页面为准。
      </p>
      <div className="announcements-toolbar">
        <span>{feed?.fetchedAt ? `更新于 ${stamp(feed.fetchedAt)}` : ''}</span>
        <span className="toolbar-flex" />
        <button
          type="button"
          className="secondary-button"
          disabled={loading}
          onClick={() => void load(true)}
        >
          {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
          刷新
        </button>
      </div>
      {feed?.offline ? (
        <p className="announcements-note">暂时连不上公告服务器，显示的是上次获取的内容。</p>
      ) : error && feed ? (
        <p className="announcements-note">{error}</p>
      ) : null}
      {loading && !feed ? (
        <p className="announcements-state">
          <LoaderCircle className="spin" size={16} />
          正在获取…
        </p>
      ) : error && !feed ? (
        <div className="announcements-state error">
          <p>{error}</p>
          <button type="button" className="secondary-button" onClick={() => void load(true)}>
            重试
          </button>
        </div>
      ) : items.length ? (
        items.map((a) => (
          <article className="announcement" key={a.id}>
            <div className="announcement-top">
              <span className="announcement-vendor">{a.vendor}</span>
              <span className="announcement-expiry">
                <CalendarClock size={12} />
                {a.expires ? `截止 ${day(a.expires)}` : '未标注截止'}
              </span>
            </div>
            <h3>{a.title}</h3>
            <div className="announcement-actions">
              <span className="announcement-checked">核实于 {day(a.checked)}</span>
              {a.url ? (
                <button
                  type="button"
                  className="ai-link"
                  onClick={() => void invoke('external', { url: a.url })}
                >
                  来源
                  <ExternalLink size={11} />
                </button>
              ) : null}
              {a.preset && presets.some((p) => p.id === a.preset) ? (
                <button type="button" className="ai-link" onClick={() => onConfigure(a.preset)}>
                  去配置
                </button>
              ) : null}
            </div>
            {a.benefit || a.conditions || a.evidence ? (
              <details className="announcement-evidence">
                <summary>详情</summary>
                {a.benefit ? <p>{a.benefit}</p> : null}
                {a.conditions ? <p>领取条件：{a.conditions}</p> : null}
                {a.evidence ? <p className="announcement-quote">{a.evidence}</p> : null}
              </details>
            ) : null}
          </article>
        ))
      ) : (
        <div className="announcements-empty">
          <p>现在没有正在进行的活动。</p>
          <span>过几天再来看看，新的活动会出现在这里。</span>
        </div>
      )}
    </div>
  );
}
