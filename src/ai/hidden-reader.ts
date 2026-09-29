// Loads a document that isn't on screen in an offscreen reader, so the AI can read it and
// place highlights with exactly the code the visible reader uses. One document at a time.
let queue: Promise<unknown> = Promise.resolve();

export function withHiddenReader<T>(
  url: string,
  kind: 'html' | 'pdf',
  work: (request: <R>(type: string, payload?: Record<string, unknown>) => Promise<R>) => Promise<T>,
): Promise<T> {
  const run = queue.then(() => load(url, kind, work));
  queue = run.catch(() => {});
  return run;
}

async function load<T>(
  url: string,
  kind: 'html' | 'pdf',
  work: (request: <R>(type: string, payload?: Record<string, unknown>) => Promise<R>) => Promise<T>,
) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.sandbox.add('allow-scripts');
  if (kind === 'pdf') frame.sandbox.add('allow-same-origin');
  frame.style.cssText =
    'position:fixed;left:-12000px;top:0;width:1100px;height:900px;border:0;visibility:hidden;pointer-events:none';
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let ready: () => void;
  const isReady = new Promise<void>((resolve) => (ready = resolve));
  const target = new URL(url, location.href).href;
  const listener = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow || e.data?.channel !== 'folio-reader-v1') return;
    if (e.data.type === 'ready' && e.data.url === target) ready();
    if (e.data.type === 'reply') {
      const waiting = pending.get(e.data.replyTo);
      pending.delete(e.data.replyTo);
      if (e.data.error) waiting?.reject(Error(e.data.error));
      else waiting?.resolve(e.data.result);
    }
  };
  window.addEventListener('message', listener);
  const post = (type: string, payload: Record<string, unknown> = {}) =>
    frame.contentWindow?.postMessage({ channel: 'folio-reader-v1', type, ...payload }, '*');
  frame.addEventListener('load', () => post('request-ready'));
  frame.src = url;
  document.body.append(frame);
  const timeout = (ms: number, message: string) =>
    new Promise<never>((_, reject) => setTimeout(() => reject(Error(message)), ms));
  try {
    await Promise.race([isReady, timeout(30_000, '文档加载超时')]);
    const request = <R>(type: string, payload: Record<string, unknown> = {}) => {
      const replyTo = crypto.randomUUID();
      const reply = new Promise<R>((resolve, reject) => pending.set(replyTo, { resolve, reject }));
      post(type, { ...payload, replyTo });
      return Promise.race([reply, timeout(90_000, '读取文档超时')]);
    };
    return await work(request);
  } finally {
    window.removeEventListener('message', listener);
    frame.remove();
  }
}
