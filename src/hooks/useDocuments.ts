import { useRef, useState } from 'react';
import { invoke } from '../api';
import type { Annotation, DocumentData, OpenDocument, WorkspaceInfo } from '../types';
// Opening more tabs than this closes the least recently viewed ones.
export const maxOpenDocuments = 20;
// Restores the saved active/split documents plus the most recently opened tabs.
export function restorablePaths(session: NonNullable<WorkspaceInfo['session']>) {
  const { paths, active, split } = session;
  const keep = new Set(
    paths.filter((p) => p === active || p === split?.left || p === split?.right),
  );
  for (const p of [...paths].reverse()) if (keep.size < maxOpenDocuments) keep.add(p);
  return paths.filter((p) => keep.has(p));
}
export function useDocuments(onError: (s: string) => void) {
  const [docs, setDocs] = useState<OpenDocument[]>([]);
  const docsRef = useRef(docs);
  const [active, setActiveId] = useState('');
  // Document ids in the order they were last shown, most recent last.
  const viewed = useRef<string[]>([]);
  function setActive(id: string) {
    if (id) viewed.current = [...viewed.current.filter((v) => v !== id), id];
    setActiveId(id);
  }
  const [saving, setSaving] = useState(0);
  const queue = useRef(Promise.resolve());
  const failed = useRef<string | null>(null);
  const annotationGroups = useRef(new Map<string, string>());
  const pendingData = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Source saves run one at a time so each uses the version the previous one wrote.
  const sourceQueue = useRef(Promise.resolve());
  // A queued save that hasn't started yet; later edits share it, since it writes the latest draft.
  const queuedSource = useRef(new Map<string, Promise<void>>());
  function cancelPending(id: string) {
    const timer = pendingData.current.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    pendingData.current.delete(id);
    setSaving((n) => n - 1);
  }
  function commit(next: OpenDocument[]) {
    docsRef.current = next;
    setDocs(next);
  }
  function update(id: string, fn: (d: OpenDocument) => OpenDocument) {
    commit(docsRef.current.map((d) => (d.id === id ? fn(d) : d)));
  }
  function persist(id: string, data: DocumentData) {
    cancelPending(id);
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
  function session(paths: string[], active: string, split?: { left: string; right: string }) {
    queue.current = queue.current.then(async () => {
      try {
        await invoke('save-session', { paths, active, split });
      } catch (e) {
        onError('阅读会话保存失败：' + (e as Error).message);
      }
    });
  }
  // Tabs with unsaved source edits, the active tab and `keep` (visible panes) stay open.
  function evict(keep: (string | null)[]) {
    const excess = docsRef.current.length - maxOpenDocuments;
    if (excess <= 0) return;
    const pinned = new Set([...keep, viewed.current.at(-1)]);
    // Never-viewed tabs rank -1, so they go first, in tab order (sort is stable).
    const closing = new Set(
      docsRef.current
        .filter((d) => !pinned.has(d.id) && d.draft === d.source)
        .sort((a, b) => viewed.current.indexOf(a.id) - viewed.current.indexOf(b.id))
        .slice(0, excess)
        .map((d) => d.id),
    );
    for (const d of docsRef.current)
      if (closing.has(d.id) && pendingData.current.has(d.id)) persist(d.id, d.data);
    viewed.current = viewed.current.filter((id) => !closing.has(id));
    commit(docsRef.current.filter((d) => !closing.has(d.id)));
  }
  async function flush() {
    for (const id of pendingData.current.keys()) {
      const doc = docsRef.current.find((d) => d.id === id);
      if (doc) persist(id, doc.data);
      else cancelPending(id);
    }
    await queue.current;
    if (failed.current) throw Error(failed.current);
  }
  async function open(path: string, activate = true, keep: (string | null)[] = []) {
    const existing = docsRef.current.find((d) => d.path === path);
    if (existing) {
      if (activate) setActive(existing.id);
      return existing.id;
    }
    const raw = await invoke<OpenDocument>('document', { path });
    // Another click may have completed the same read while IPC was in flight.
    if (!docsRef.current.some((d) => d.id === raw.id)) {
      commit([
        ...docsRef.current,
        { ...raw, draft: raw.source, preview: 0, history: [], future: [] },
      ]);
      evict([raw.id, ...keep]);
    }
    if (activate) setActive(raw.id);
    return raw.id;
  }
  function data(id: string, patch: Partial<DocumentData>, defer = false) {
    const d = docsRef.current.find((d) => d.id === id);
    if (!d) return;
    const next = { ...d.data, ...patch };
    update(id, (d) => ({ ...d, data: next }));
    if (!defer) persist(id, next);
    else {
      // Wheel zoom updates the view on each frame, but writes once it settles.
      // flush() also drains these timers before closing a document/the app.
      const previous = pendingData.current.get(id);
      if (previous === undefined) setSaving((n) => n + 1);
      else clearTimeout(previous);
      pendingData.current.set(
        id,
        setTimeout(() => {
          const latest = docsRef.current.find((d) => d.id === id);
          if (latest) persist(id, latest.data);
          else cancelPending(id);
        }, 220),
      );
    }
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
  // With auto-save on, every edit is written straight away, like an IDE.
  function edit(id: string, draft: string, autosave: boolean) {
    update(id, (d) => ({ ...d, draft }));
    if (autosave && !docsRef.current.find((d) => d.id === id)?.autosavePaused)
      save(id).catch((e) => onError('自动保存失败：' + (e as Error).message));
  }
  function save(id: string) {
    const queued = queuedSource.current.get(id);
    if (queued) return queued;
    const run = sourceQueue.current.then(() => {
      queuedSource.current.delete(id);
      return writeSource(id);
    });
    queuedSource.current.set(id, run);
    sourceQueue.current = run.catch(() => {});
    return run;
  }
  // Saves pending source edits before closing; documents whose saves failed stay dirty.
  async function saveAll(ids: string[]) {
    const unpaused = ids.filter((id) => !docsRef.current.find((d) => d.id === id)?.autosavePaused);
    await Promise.allSettled(unpaused.map(save));
  }
  async function writeSource(id: string) {
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
        autosavePaused: false,
      }));
    } catch (e) {
      update(id, (current) => ({ ...current, autosavePaused: true }));
      throw e;
    } finally {
      setSaving((n) => n - 1);
    }
  }
  // Writes a backup back to the file. It queues behind pending saves so it checks the latest version.
  function restore(id: string, name: string) {
    const run = sourceQueue.current.then(async () => {
      const d = docsRef.current.find((d) => d.id === id);
      if (!d) return;
      const result = await invoke<{ source: string; version: string }>('restore-backup', {
        path: d.path,
        name,
        version: d.version,
      });
      update(id, (current) => ({
        ...current,
        source: result.source,
        draft: result.source,
        version: result.version,
        preview: current.preview + 1,
        autosavePaused: false,
      }));
    });
    sourceQueue.current = run.catch(() => {});
    return run;
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
    viewed.current = viewed.current.filter((v) => v !== id);
    if (active === id) setActive(next.at(-1)?.id || '');
  }
  function clear() {
    // A save that failed in the previous project says nothing about the next one.
    failed.current = null;
    commit([]);
    viewed.current = [];
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
    edit,
    save,
    saveAll,
    restore,
    reload,
    close,
    clear,
    move,
    flush,
    saving: !!saving,
  };
}
