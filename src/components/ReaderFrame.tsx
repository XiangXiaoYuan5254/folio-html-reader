import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
} from 'react';
import type { Annotation, EraserMode, FrameEvent, Tool } from '../types';
import type { NoteSize } from '../reader/note-size';
export type ReaderHandle = { send: (type: string, payload?: Record<string, unknown>) => void };
export type ReaderProps = {
  url: string;
  kind?: 'html' | 'pdf';
  annotations: Annotation[];
  selected: string | null;
  tool: Tool;
  color: string;
  strokeWidth: number;
  eraserSize: number;
  eraserMode: EraserMode;
  stickySize: NoteSize;
  textWidth: number;
  // Source mode: pick an element in the page to locate its code.
  inspect?: boolean;
  zoom: number;
  zoomable?: boolean;
  linkedScroll?: boolean;
  scroll: number;
  onEvent: (e: FrameEvent) => void;
};
export const ReaderFrame = forwardRef<ReaderHandle, ReaderProps>(function ReaderFrame(p, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const actualScale = useRef(1);
  const [width, setWidth] = useState(800);
  const [pdf, setPdf] = useState({ page: 1, total: 0, width: 0, hasText: null as boolean | null });
  const [pageInput, setPageInput] = useState('1');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const live = useRef(p);
  live.current = p;
  function send(type: string, payload: Record<string, unknown> = {}) {
    frame.current?.contentWindow?.postMessage(
      {
        channel: 'folio-reader-v1',
        type,
        ...payload,
        ...(['zoom-state', 'linked-scroll'].includes(type) ? { scale: actualScale.current } : {}),
      },
      '*',
    );
  }
  useImperativeHandle(ref, () => ({ send }), []);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => setWidth(paper.current?.clientWidth || 800));
    if (paper.current) {
      setWidth(paper.current.clientWidth);
      observer.observe(paper.current);
    }
    return () => observer.disconnect();
  }, []);
  useEffect(() => setPageInput(String(pdf.page)), [pdf.page]);
  useLayoutEffect(() => {
    setReady(false);
    setError(false);
    setPdf({ page: 1, total: 0, width: 0, hasText: null });
    let initialized = false;
    const timeout = setTimeout(() => setError(true), 20000);
    function message(e: MessageEvent) {
      if (e.source !== frame.current?.contentWindow || e.data?.channel !== 'folio-reader-v1')
        return;
      if (e.data.type === 'pdf-state') {
        if (e.data.url !== new URL(live.current.url, window.location.href).href) return;
        if (Number.isFinite(e.data.width) && Number.isFinite(e.data.total))
          setPdf({
            page: e.data.page,
            total: e.data.total,
            width: e.data.width,
            hasText: e.data.hasText,
          });
        return;
      }
      if (e.data.type === 'ready') {
        // During preview navigation, the old document can still reply through
        // the same WindowProxy. Only initialize the document requested here.
        if (e.data.url !== new URL(live.current.url, window.location.href).href) return;
        if (initialized) return;
        initialized = true;
        clearTimeout(timeout);
        setReady(true);
        setError(false);
        send('sync', {
          annotations: live.current.annotations,
          selected: live.current.selected,
          tool: live.current.tool,
          color: live.current.color,
          strokeWidth: live.current.strokeWidth,
          eraserSize: live.current.eraserSize,
          eraserMode: live.current.eraserMode,
          stickySize: live.current.stickySize,
          textWidth: live.current.textWidth,
          inspect: !!live.current.inspect,
        });
        send('restore', { scroll: live.current.scroll });
        send('scroll-link-state', { enabled: !!live.current.linkedScroll });
      }
      live.current.onEvent(
        e.data.type === 'zoom-wheel' ? { ...e.data, scale: actualScale.current } : e.data,
      );
    }
    window.addEventListener('message', message);
    // A cached document can initialize before a passive React effect runs.
    // Ask for its state as well as listening for the initial announcement.
    send('request-ready');
    return () => {
      clearTimeout(timeout);
      window.removeEventListener('message', message);
    };
  }, [p.url]);
  const scale =
    p.zoom || (p.kind === 'pdf' && pdf.width ? Math.max(0.1, width / (pdf.width + 64)) : 1);
  actualScale.current = scale;
  useLayoutEffect(() => {
    if (ready) send('zoom-state', { scale: p.zoom || 1, enabled: p.zoomable !== false });
  }, [ready, scale, p.zoomable, p.url]);
  useEffect(() => {
    if (ready) send('scroll-link-state', { enabled: !!p.linkedScroll });
  }, [ready, p.linkedScroll]);
  useEffect(() => {
    if (ready)
      send('sync', {
        annotations: p.annotations,
        selected: p.selected,
        tool: p.tool,
        color: p.color,
        strokeWidth: p.strokeWidth,
        eraserSize: p.eraserSize,
        eraserMode: p.eraserMode,
        stickySize: p.stickySize,
        textWidth: p.textWidth,
        inspect: !!p.inspect,
      });
  }, [
    ready,
    p.annotations,
    p.selected,
    p.tool,
    p.color,
    p.strokeWidth,
    p.eraserSize,
    p.eraserMode,
    p.stickySize,
    p.textWidth,
    p.inspect,
  ]);
  // Give the HTML the whole reading viewport, including its own margins.
  // Percentage zoom behaves like a browser: the page reflows at the new scale.
  const goPage = () => {
    const page = Number(pageInput);
    if (Number.isInteger(page) && page >= 1 && page <= pdf.total) send('pdf-page', { page });
    else setPageInput(String(pdf.page));
  };
  return (
    <div className={`reader-surface tool-${p.tool}${p.kind === 'pdf' ? ' pdf-surface' : ''}`}>
      {p.kind === 'pdf' ? (
        <div
          className="pdf-pagebar"
          role="group"
          aria-label="PDF 翻页"
          onPointerDown={() => live.current.onEvent({ type: 'activate' })}
        >
          <button
            aria-label="PDF 上一页"
            title="上一页"
            disabled={!pdf.total || pdf.page <= 1}
            onClick={() => send('pdf-page', { page: pdf.page - 1 })}
          >
            ‹
          </button>
          <input
            aria-label="PDF 页码"
            title="输入页码后按回车跳转"
            inputMode="numeric"
            value={pageInput}
            disabled={!pdf.total}
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={goPage}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                goPage();
                e.currentTarget.blur();
              }
            }}
          />
          <span>/ {pdf.total || '—'}</span>
          <button
            aria-label="PDF 下一页"
            title="下一页"
            disabled={!pdf.total || pdf.page >= pdf.total}
            onClick={() => send('pdf-page', { page: pdf.page + 1 })}
          >
            ›
          </button>
          {pdf.hasText === false ? (
            <span
              className="pdf-page-hint"
              title="此页无可选文字，可画线或贴便签"
              aria-label="此页无可选文字，可画线或贴便签"
            >
              ⓘ
            </span>
          ) : null}
        </div>
      ) : null}
      {!ready && p.kind !== 'pdf' ? (
        <div className="reader-loading">
          {error ? '文档加载较慢，请尝试重新载入文件' : '正在展开文档…'}
        </div>
      ) : null}
      <div ref={paper} className="paper-container">
        <iframe
          ref={frame}
          className="document-frame"
          title={p.kind === 'pdf' ? 'PDF 阅读区' : 'HTML 阅读区'}
          // Only our fixed PDF viewer gets an origin for its decoding worker.
          // It remains cross-origin from app://ui and has no filesystem bridge.
          // Arbitrary HTML keeps its opaque-origin script sandbox.
          sandbox={p.kind === 'pdf' ? 'allow-scripts allow-same-origin' : 'allow-scripts'}
          onFocus={() => live.current.onEvent({ type: 'activate' })}
          onLoad={() => send('request-ready')}
          src={p.url}
          style={{
            width: `${100 / scale}%`,
            height: `${100 / scale}%`,
            transform: `scale(${scale})`,
          }}
        />
      </div>
    </div>
  );
});
