import { useRef, useState } from 'react';
import { invoke } from '../api';
import type { Annotation, DocumentData, OpenDocument } from '../types';
export function useDocuments(onError: (s: string) => void) {
  const [docs, setDocs] = useState<OpenDocument[]>([]);
  const docsRef = useRef(docs);
  const [active, setActive] = useState('');
  const [saving, setSaving] = useState(0);
  const queue = useRef(Promise.resolve());
  const failed = useRef<string | null>(null);
  const annotationGroups = useRef(new Map<string, string>());
  function commit(next: OpenDocument[]) {
    docsRef.current = next;
    setDocs(next);
  }
  function update(id: string, fn: (d: OpenDocument) => OpenDocument) {
    commit(docsRef.current.map((d) => (d.id === id ? fn(d) : d)));
  }
  function persist(id: string, data: DocumentData) {
    setSaving((n) => n + 1);
    queue.current = queue.current.then(async () => {
      try {
        await invoke('save-data', { id, data });
        failed.current = null;
      } catch (e) {
        failed.current = (e as Error).message;
        onError('保存失败：' + failed.current);
      } finally {
        setSaving((n) => n - 1);
      }
    });
  }
  function session(paths: string[], active: string) {
    queue.current = queue.current.then(async () => {
      try {
        await invoke('save-session', { paths, active });
      } catch (e) {
        onError('阅读会话保存失败：' + (e as Error).message);
      }
    });
  }
  async function flush() {
    await queue.current;
    if (failed.current) throw Error(failed.current);
  }
  async function open(path: string) {
    const existing = docsRef.current.find((d) => d.path === path);
    if (existing) {
      setActive(existing.id);
      return;
    }
    const raw = await invoke<OpenDocument>('document', { path });
    // Another click may have completed the same read while IPC was in flight.
    if (!docsRef.current.some((d) => d.id === raw.id))
      commit([
        ...docsRef.current,
        { ...raw, draft: raw.source, preview: 0, history: [], future: [] },
      ]);
    setActive(raw.id);
  }
  function data(id: string, patch: Partial<DocumentData>) {
    const d = docsRef.current.find((d) => d.id === id);
    if (!d) return;
    const next = { ...d.data, ...patch };
    update(id, (d) => ({ ...d, data: next }));
    persist(id, next);
  }
  function annotate(id: string, fn: (a: Annotation[]) => Annotation[], group?: string) {
    const d = docsRef.current.find((d) => d.id === id);
    if (!d) return;
    const next = fn(d.data.annotations);
    if (next === d.data.annotations) return;
    const grouped = !!group && annotationGroups.current.get(id) === group;
    annotationGroups.current.set(id, group || '');
    const nextData = { ...d.data, annotations: next };
    update(id, (d) => ({
      ...d,
      data: nextData,
      history: grouped ? d.history : [...d.history, d.data.annotations].slice(-60),
      future: [],
    }));
    persist(id, nextData);
  }
  function undo(id: string, redo = false) {
    annotationGroups.current.delete(id);
    const d = docsRef.current.find((d) => d.id === id);
    if (!d) return;
    const stack = redo ? d.future : d.history;
    if (!stack.length) return;
    const annotations = stack.at(-1)!;
    const nextData = { ...d.data, annotations };
    update(id, (d) => ({
      ...d,
      data: nextData,
      history: redo ? [...d.history, d.data.annotations] : d.history.slice(0, -1),
      future: redo ? d.future.slice(0, -1) : [...d.future, d.data.annotations],
    }));
    persist(id, nextData);
  }
  async function save(id: string) {
    const d = docsRef.current.find((d) => d.id === id);
    if (!d || d.source === d.draft) return;
    setSaving((n) => n + 1);
    try {
      const result = await invoke<{ version: string }>('save-source', {
        path: d.path,
        source: d.draft,
        version: d.version,
      });
      update(id, (current) => ({
        ...current,
        source: d.draft,
        version: result.version,
        preview: current.preview + 1,
      }));
    } finally {
      setSaving((n) => n - 1);
    }
  }
  async function reload(id: string) {
    const d = docsRef.current.find((d) => d.id === id);
    if (!d) return;
    await flush();
    const raw = await invoke<OpenDocument>('document', { path: d.path });
    update(id, (current) => ({
      ...raw,
      draft: raw.source,
      preview: current.preview + 1,
      history: [],
      future: [],
    }));
  }
  function close(id: string) {
    const next = docsRef.current.filter((d) => d.id !== id);
    commit(next);
    if (active === id) setActive(next.at(-1)?.id || '');
  }
  function clear() {
    commit([]);
    setActive('');
  }
  function move(from: string, to: string) {
    commit(
      docsRef.current.map((d) =>
        d.path === from || d.path.startsWith(from + '/')
          ? { ...d, path: to + d.path.slice(from.length), preview: d.preview + 1 }
          : d,
      ),
    );
  }
  return {
    session,
    docs,
    docsRef,
    active,
    setActive,
    open,
    update,
    data,
    annotate,
    undo,
    save,
    reload,
    close,
    clear,
    move,
    flush,
    saving: !!saving,
  };
}
