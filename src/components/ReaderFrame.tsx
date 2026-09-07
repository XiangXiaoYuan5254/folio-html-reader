import { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import type { Annotation, FrameEvent, Tool } from '../types';
import type { NoteSize } from '../reader/note-size';
export type ReaderHandle = { send: (type: string, payload?: Record<string, unknown>) => void };
export const ReaderFrame = forwardRef<
  ReaderHandle,
  {
    url: string;
    annotations: Annotation[];
    tool: Tool;
    color: string;
    strokeWidth: number;
    eraserSize: number;
    stickySize: NoteSize;
    zoom: number;
    scroll: number;
    onEvent: (e: FrameEvent) => void;
  }
>(function ReaderFrame(p, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const live = useRef(p);
  live.current = p;
  function send(type: string, payload: Record<string, unknown> = {}) {
    frame.current?.contentWindow?.postMessage(
      { channel: 'folio-reader-v1', type, ...payload },
      '*',
    );
  }
  useImperativeHandle(ref, () => ({ send }), []);
  useEffect(() => {
    setReady(false);
    setError(false);
    const timeout = setTimeout(() => setError(true), 20000);
    function message(e: MessageEvent) {
      if (e.source !== frame.current?.contentWindow || e.data?.channel !== 'folio-reader-v1')
        return;
      if (e.data.type === 'ready') {
        clearTimeout(timeout);
        setReady(true);
        setError(false);
        send('sync', {
          annotations: live.current.annotations,
          tool: live.current.tool,
          color: live.current.color,
          strokeWidth: live.current.strokeWidth,
          eraserSize: live.current.eraserSize,
          stickySize: live.current.stickySize,
        });
        send('restore', { scroll: live.current.scroll });
      }
      live.current.onEvent(e.data);
    }
    window.addEventListener('message', message);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener('message', message);
    };
  }, [p.url]);
  useEffect(() => {
    if (ready)
      send('sync', {
        annotations: p.annotations,
        tool: p.tool,
        color: p.color,
        strokeWidth: p.strokeWidth,
        eraserSize: p.eraserSize,
        stickySize: p.stickySize,
      });
  }, [ready, p.annotations, p.tool, p.color, p.strokeWidth, p.eraserSize, p.stickySize]);
  // Give the HTML the whole reading viewport, including its own margins.
  // Percentage zoom behaves like a browser: the page reflows at the new scale.
  const scale = p.zoom || 1;
  return (
    <div className={`reader-surface tool-${p.tool}`}>
      {!ready ? (
        <div className="reader-loading">
          {error ? '文档加载较慢，请尝试重新载入文件' : '正在展开文档…'}
        </div>
      ) : null}
      <div className="paper-container">
        <iframe
          ref={frame}
          className="document-frame"
          title="HTML 阅读区"
          sandbox="allow-scripts"
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
