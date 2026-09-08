const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { spawn } = require('node:child_process');
async function clipboardPaths(clipboard) {
  // Finder supplies its entire selection as a plist, including multiple files.
  const plist = clipboard.readBuffer('NSFilenamesPboardType');
  if (plist.length) {
    const json = await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-']);
      const out = [];
      child.stdout.on('data', (data) => out.push(data));
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve(Buffer.concat(out).toString())
          : reject(Error('无法读取访达复制的文件，请重新复制')),
      );
      child.stdin.on('error', () => {});
      child.stdin.end(plist);
    });
    const files = JSON.parse(json);
    if (Array.isArray(files) && files.every((p) => typeof p === 'string' && path.isAbsolute(p)))
      return files;
  }
  const urls = clipboard.readBuffer('public.file-url').toString('utf8').replace(/\0/g, '').trim();
  if (urls)
    return urls
      .split(/\r?\n/)
      .filter(Boolean)
      .map((url) => fileURLToPath(url));
  throw Error('剪贴板里没有文件，请先在访达中复制文件或文件夹');
}
async function rekeyCopiedMetadata(dir, ids = new Map()) {
  const meta = path.join(dir, '.html-reader');
  try {
    const index = JSON.parse(await fs.readFile(path.join(meta, 'workspace.json'), 'utf8'));
    for (const entry of Object.values(index.files || {})) {
      const old = entry.id;
      if (!/^[0-9a-f-]{36}$/i.test(old)) throw Error('复制的文件夹包含无效的批注索引');
      if (!ids.has(old)) ids.set(old, crypto.randomUUID());
      entry.id = ids.get(old);
      const data = path.join(meta, 'documents', `${old}.json`);
      await fs.rename(data, path.join(meta, 'documents', `${entry.id}.json`)).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
    await fs.writeFile(path.join(meta, 'workspace.json'), JSON.stringify(index, null, 2));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (item.isDirectory() && !item.name.startsWith('.'))
      await rekeyCopiedMetadata(path.join(dir, item.name), ids);
  }
}
async function copyInto(workspace, { paths, destination = '' }) {
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    paths.length > 500 ||
    !paths.every((p) => typeof p === 'string' && path.isAbsolute(p))
  )
    throw Error('无效的导入文件');
  const target = await workspace.resolve(destination);
  if (!(await fs.stat(target)).isDirectory()) throw Error('请选择目标文件夹');
  const sources = [...new Set(await Promise.all(paths.map((p) => fs.realpath(p))))];
  const prepared = [];
  for (const source of sources) {
    const stat = await fs.stat(source);
    const name = path.basename(source);
    if ((!stat.isDirectory() && !stat.isFile()) || name.startsWith('.'))
      throw Error('请选择普通文件或文件夹');
    if (stat.isDirectory() && (target === source || target.startsWith(source + path.sep)))
      throw Error('不能把文件夹复制到它自己或子文件夹中');
    prepared.push({ source, name, directory: stat.isDirectory() });
  }
  const copied = [];
  try {
    for (const item of prepared) {
      const ext = item.directory ? '' : path.extname(item.name);
      const stem = ext ? item.name.slice(0, -ext.length) : item.name;
      let output;
      for (let number = 0; ; number++) {
        const name = number
          ? `${stem}（副本${number === 1 ? '' : ` ${number}`}）${ext}`
          : item.name;
        output = path.join(target, name);
        try {
          // Reserve the destination exclusively; never overwrite an existing item.
          if (item.directory) await fs.mkdir(output);
          else await fs.copyFile(item.source, output, fs.constants.COPYFILE_EXCL);
          break;
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
        }
      }
      copied.push(output);
      if (item.directory) {
        for (const name of await fs.readdir(item.source)) {
          await fs.cp(path.join(item.source, name), path.join(output, name), {
            recursive: true,
            force: false,
            errorOnExist: true,
            filter: async (p) => !(await fs.lstat(p)).isSymbolicLink(),
          });
        }
        await rekeyCopiedMetadata(output);
      }
    }
  } catch (error) {
    // Only remove destinations created by this import, never Finder originals.
    await Promise.all(copied.map((p) => fs.rm(p, { recursive: true, force: true })));
    throw error;
  }
  return {
    workspace: await workspace.summary(),
    imported: copied.map((p) => path.relative(workspace.root, p)),
  };
}
module.exports = { clipboardPaths, copyInto };
