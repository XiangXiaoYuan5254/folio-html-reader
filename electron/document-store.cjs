const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const emptyData = () => ({ version: 1, annotations: [], note: '', scroll: 0, zoom: 0 });
const validEntry = (e) =>
  e &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(e.id) &&
  /^[0-9a-f]{64}$/i.test(e.hash);
const indexPath = (dir) => path.join(dir, '.html-reader', 'workspace.json');
const dataPath = (dir, id) => path.join(dir, '.html-reader', 'documents', `${id}.json`);
async function readIndex(dir, workspace) {
  if (dir === workspace.root) return workspace.index;
  try {
    const value = JSON.parse(await fs.readFile(indexPath(dir), 'utf8'));
    if (value.version !== 1 || !value.files || !Object.values(value.files).every(validEntry))
      throw Error('Invalid index');
    return value;
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, files: {} };
    throw Error(`项目索引无法读取，已保留原文件：${indexPath(dir)}`);
  }
}
async function readData(dir, id) {
  try {
    const raw = await fs.readFile(dataPath(dir, id), 'utf8');
    const data = JSON.parse(raw);
    if (data.version !== 1 || !Array.isArray(data.annotations) || typeof data.note !== 'string')
      throw Error('Invalid annotations');
    return { data: { ...emptyData(), ...data }, raw };
  } catch (e) {
    if (e.code === 'ENOENT') return { data: emptyData(), raw: null };
    throw Error(`批注文件损坏，已保留原文件：${dataPath(dir, id)}`);
  }
}
// Migration is additive. Divergent edits with the same annotation id are kept as
// separate annotations, rather than silently discarding either user's version.
function mergeData(base, extra) {
  const annotations = [...base.annotations];
  const byId = new Map(annotations.map((a) => [a.id, a]));
  for (const a of extra.annotations) {
    const old = byId.get(a.id);
    if (!old) {
      annotations.push(a);
      byId.set(a.id, a);
    } else if (JSON.stringify(old) !== JSON.stringify(a)) {
      const digest = crypto.createHash('sha256').update(JSON.stringify(a)).digest('hex');
      const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
      if (!byId.has(id)) {
        const recovered = { ...a, id };
        annotations.push(recovered);
        byId.set(id, recovered);
      }
    }
  }
  const notes = [...new Set([base.note, extra.note].filter((n) => n.trim()))];
  return { ...base, annotations, note: notes.join('\n\n---\n\n') };
}
async function backup(file, atomicWrite) {
  try {
    const original = await fs.readFile(file);
    const dir = path.join(path.dirname(file), 'migration-backups');
    await atomicWrite(
      path.join(
        dir,
        `${path.basename(file)}.${crypto.createHash('sha256').update(original).digest('hex').slice(0, 16)}.bak`,
      ),
      original,
    );
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}
async function writeIndex(dir, index, atomicWrite) {
  await atomicWrite(indexPath(dir), JSON.stringify(index, null, 2));
}
// The document's immediate directory owns its data; workspace roots only keep
// aliases/session state. Legacy ancestor records are imported exactly once.
async function locate(workspace, full, version, atomicWrite) {
  const dir = path.dirname(full),
    name = path.basename(full);
  const local = await readIndex(dir, workspace);
  let entry = local.files[name];
  if (!entry) {
    for (const [old, candidate] of Object.entries(local.files)) {
      if (
        path.basename(old) === old &&
        candidate.hash === version &&
        !(await fs.stat(path.join(dir, old)).catch(() => null))
      ) {
        entry = candidate;
        delete local.files[old];
        break;
      }
    }
  }
  const sources = [];
  for (let ancestor = dir; ; ancestor = path.dirname(ancestor)) {
    const index = ancestor === dir ? local : await readIndex(ancestor, workspace);
    // Index keys always use "/" separators, also on Windows.
    const candidate = index.files[path.relative(ancestor, full).split(path.sep).join('/')];
    if (candidate && candidate.storage !== 'adjacent' && !(ancestor === dir && candidate === entry))
      sources.push({ dir: ancestor, entry: candidate });
    if (path.dirname(ancestor) === ancestor) break;
  }
  entry ||= { id: sources[0]?.entry.id || crypto.randomUUID(), hash: version };
  let stored = await readData(dir, entry.id);
  const imported = new Set(entry.imported || []);
  let changed = false;
  for (const source of sources) {
    const key = `${source.dir}\0${source.entry.id}`;
    if (imported.has(key)) continue;
    const other = await readData(source.dir, source.entry.id);
    if (other.raw !== null) {
      stored = {
        data: stored.raw === null ? other.data : mergeData(stored.data, other.data),
        raw: other.raw,
      };
      changed = true;
    }
    imported.add(key);
  }
  // Read all sources successfully before writing anything. Keep legacy data and
  // content-addressed snapshots so an interrupted migration remains recoverable.
  if (changed) {
    await backup(dataPath(dir, entry.id), atomicWrite);
    await atomicWrite(dataPath(dir, entry.id), JSON.stringify(stored.data, null, 2));
  }
  const canonical = { ...entry, storage: 'adjacent', imported: [...imported] };
  if (JSON.stringify(local.files[name]) !== JSON.stringify(canonical)) {
    await backup(indexPath(dir), atomicWrite);
    local.files[name] = canonical;
    await writeIndex(dir, local, atomicWrite);
  }
  return { dir, entry: canonical, data: stored.data };
}
async function relocate(workspace, src, dst, store, atomicWrite) {
  const oldDir = path.dirname(src),
    newDir = path.dirname(dst);
  const oldIndex = await readIndex(oldDir, workspace);
  const newIndex = oldDir === newDir ? oldIndex : await readIndex(newDir, workspace);
  const oldNext = { ...oldIndex, files: { ...oldIndex.files } };
  const newNext = oldDir === newDir ? oldNext : { ...newIndex, files: { ...newIndex.files } };
  delete oldNext.files[path.basename(src)];
  newNext.files[path.basename(dst)] = store.entry;
  if (oldDir !== newDir) {
    const stored = await readData(oldDir, store.entry.id);
    if (stored.raw !== null) await atomicWrite(dataPath(newDir, store.entry.id), stored.raw);
  }
  // Prepare the note copy before moving the original; on an index write failure
  // restore both the file location and its original index entries.
  await fs.rename(src, dst);
  try {
    await writeIndex(newDir, newNext, atomicWrite);
    if (oldDir !== newDir) await writeIndex(oldDir, oldNext, atomicWrite);
  } catch (error) {
    await fs.rename(dst, src);
    await writeIndex(newDir, newIndex, atomicWrite);
    if (oldDir !== newDir) await writeIndex(oldDir, oldIndex, atomicWrite);
    throw error;
  }
  if (workspace.root === oldDir) workspace.index = oldNext;
  if (workspace.root === newDir) workspace.index = newNext;
}
module.exports = { locate, relocate, dataPath, backup };
