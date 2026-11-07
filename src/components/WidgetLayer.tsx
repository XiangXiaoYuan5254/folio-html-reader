import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { X } from 'lucide-react';
import { invoke } from '../api';
import type { Assistant } from '../ai/assistant';
import { pluginLog } from '../plugins/log';
import { isOfficial, usePlugins } from '../plugins/store';
import type { PluginInfo, PluginWidget } from '../plugins/types';
import { useAiState, useReading, useWidgetTheme } from '../plugins/widget-events';
import type { DocumentState } from '../plugins/widget-events';

// Widgets (a plugin's widget, folio: 2): each in a sandboxed frame of its own at
// app://widget/<id>/ (electron/plugins.cjs), on top of the AI assistant's question box or in a
// corner. They hear what Folio is doing (src/plugins/widget-events.ts) and nothing else; Folio
// draws the button that puts one away, so a widget can always be got out of the way.

// Put away until Folio starts again, and those stopped for not answering.
const putAway = new Set<string>();
const stopped = new Set<string>();

type Values = Record<string, unknown>;

export function WidgetLayer(p: {
  assistant: Assistant;
  document: DocumentState;
}) {
  const list = usePlugins();
  const [, redraw] = useState(0);
  const ai = useAiState(p.assistant);
  const reading = useReading(p.document.kind);
  const theme = useWidgetTheme();
  const widgets = (list?.plugins || []).filter(
    (w) =>
      w.enabled &&
      w.manifest?.widget &&
      (list?.thirdParty || w.bundled || isOfficial(w)) &&
      !putAway.has(w.id) &&
      !stopped.has(w.id),
  );
  // Room in the question box for a widget sitting in its corner.
  const onBox = widgets.find((w) => w.manifest!.widget!.anchor === 'assistant');
  const room = onBox ? onBox.manifest!.widget!.size.width : 0;
  useEffect(() => {
    document.documentElement.style.setProperty('--composer-widget-room', `${room}px`);
  }, [room]);
  if (!widgets.length) return null;
  const values: Values = { ai: { state: ai }, reading, document: p.document, theme };
  return (
    <div className="widget-layer">
      {widgets.map((w) => (
        <WidgetBox
          key={w.id}
          plugin={w}
          widget={w.manifest!.widget!}
          values={values}
          onPutAway={() => {
            putAway.add(w.id);
            redraw((n) => n + 1);
          }}
          onStopped={() => {
            stopped.add(w.id);
            redraw((n) => n + 1);
          }}
        />
      ))}
    </div>
  );
}

// Where a widget sits: in the question box's top right corner, a quarter of it over the box's
// edge (the box keeps its text clear of it, see .assistant-composer textarea), or in a corner.
type Place = { left: number; top: number } | null;
export const composerOverlap = (height: number) => Math.min(28, Math.round(height / 4));
function usePlace(widget: PluginWidget): Place {
  const [place, setPlace] = useState<Place>(null);
  useEffect(() => {
    if (widget.anchor !== 'assistant') return;
    // The box moves with the side panel (sliding, resizing), so it is looked for and measured
    // a few times a second rather than watched.
    const measure = () => {
      const box = document.querySelector('.assistant-composer');
      const r = box?.getBoundingClientRect();
      const next =
        r && r.width > 0 && r.height > 0
          ? {
              left: Math.round(Math.max(r.left, r.right - widget.size.width - 6)),
              top: Math.round(r.top - widget.size.height + composerOverlap(widget.size.height)),
            }
          : null;
      setPlace((now) =>
        now?.left === next?.left && now?.top === next?.top ? now : next,
      );
    };
    measure();
    const timer = setInterval(measure, 250);
    addEventListener('resize', measure);
    return () => {
      clearInterval(timer);
      removeEventListener('resize', measure);
    };
  }, [widget]);
  return place;
}
const corners: Record<string, CSSProperties> = {
  'bottom-right': { right: 16, bottom: 43 },
  'bottom-left': { left: 16, bottom: 43 },
  'top-right': { right: 16, top: 52 },
  'top-left': { left: 16, top: 52 },
};

function WidgetBox(p: {
  plugin: PluginInfo;
  widget: PluginWidget;
  values: Values;
  onPutAway: () => void;
  onStopped: () => void;
}) {
  const { plugin, widget } = p;
  const id = plugin.id;
  const frame = useRef<HTMLIFrameElement>(null);
  const listening = useRef(new Set<string>());
  const sent = useRef(new Map<string, string>());
  const place = usePlace(widget);
  const [pageHidden, setPageHidden] = useState(document.visibilityState === 'hidden');
  const shown = (widget.anchor !== 'assistant' || !!place) && !pageHidden;
  const allowed = new Set(['theme', 'visible', ...widget.events]);
  const values: Values = { ...p.values, visible: { visible: shown } };
  const latest = useRef(values);
  latest.current = values;

  const post = (message: object) =>
    frame.current?.contentWindow?.postMessage({ folioWidget: 1, ...message }, '*');
  // An event the widget listens to, when it is new to it.
  const tell = (event: string, force = false) => {
    if (!allowed.has(event) || !listening.current.has(event)) return;
    const data = latest.current[event];
    const key = JSON.stringify(data);
    if (!force && sent.current.get(event) === key) return;
    sent.current.set(event, key);
    post({ type: 'event', event, data });
  };

  useEffect(() => {
    const visibility = () => setPageHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);

  // What the widget says: it's there, what it listens to, its storage, its log, and that it is
  // still answering.
  const lastPong = useRef(Date.now());
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.data?.folioWidget !== 1) return;
      const m = e.data;
      lastPong.current = Date.now();
      if (m.type === 'ready') {
        listening.current.clear();
        sent.current.clear();
      } else if (m.type === 'listen' && typeof m.event === 'string') {
        listening.current.add(m.event);
        tell(m.event, true);
      } else if (m.type === 'storage-get' || m.type === 'storage-set') {
        invoke('plugin-widget-storage', { id, set: m.type === 'storage-set', value: m.value })
          .then((value) => post({ type: 'reply', id: m.id, value }))
          .catch((err) =>
            post({ type: 'reply', id: m.id, error: String(err?.message || err).slice(0, 300) }),
          );
      } else if (m.type === 'log') {
        const level = m.level === 'error' || m.level === 'warn' ? m.level : 'script';
        pluginLog(id, level, `挂件：${String(m.text || '').slice(0, 500)}`);
      }
    };
    addEventListener('message', onMessage);
    // A widget that stops answering (stuck in a loop) is taken away until Folio starts again.
    let n = 0;
    const ping = setInterval(() => {
      // In the background the window's timers are slowed down; nothing is judged then.
      if (document.visibilityState === 'hidden') return void (lastPong.current = Date.now());
      if (Date.now() - lastPong.current > 12_000) {
        pluginLog(id, 'error', '挂件 12 秒没有响应，已关闭；重新打开页间会再加载它');
        p.onStopped();
        return;
      }
      post({ type: 'ping', n: ++n });
    }, 4000);
    return () => {
      removeEventListener('message', onMessage);
      clearInterval(ping);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Tell it what changed.
  useEffect(() => {
    for (const event of allowed) tell(event);
  });

  const style: CSSProperties = {
    width: widget.size.width,
    height: widget.size.height,
    ...(widget.anchor === 'assistant'
      ? place
        ? { left: place.left, top: place.top }
        : { left: -9999, top: -9999 }
      : corners[widget.anchor]),
  };
  return (
    <div
      className={`widget-box${shown ? '' : ' away'}`}
      style={style}
      data-widget={id}
    >
      <iframe
        ref={frame}
        title={plugin.manifest?.name || id}
        sandbox="allow-scripts"
        src={`app://widget/${encodeURIComponent(id)}/`}
        onLoad={() => (lastPong.current = Date.now())}
      />
      <button
        type="button"
        className="widget-handle"
        aria-label={`收起「${plugin.manifest?.name || id}」，下次打开页间再出现`}
        title="收起挂件（下次打开页间再出现；在设置 › 插件里可以关掉）"
        onClick={p.onPutAway}
      >
        <X size={11} />
      </button>
    </div>
  );
}
