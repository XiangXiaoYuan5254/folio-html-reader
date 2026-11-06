#!/usr/bin/env node
// 检查 community-plugins.json：格式、id 不重复、链接能看懂；加 --remote 时再读每个插件仓库里的
// folio-plugin.json，用和页间一样的规则检查，并核对 id。CI 在每个 Pull Request 上运行。
//
//   node scripts/check-directory.cjs [--remote] [--only id1,id2]
//
// --remote 访问 GitHub API 时会用环境变量 GITHUB_TOKEN（有的话），避免触发频率限制。
const fs = require('node:fs');
const path = require('node:path');
const { validateManifest, idPattern } = require('../cli/lib/manifest.cjs');

const file = path.join(__dirname, '..', 'community-plugins.json');
const args = process.argv.slice(2);
const remote = args.includes('--remote');
const onlyAt = args.indexOf('--only');
const only =
  onlyAt >= 0
    ? new Set(
        String(args[onlyAt + 1] || '')
          .split(',')
          .filter(Boolean),
      )
    : null;
const errors = [];
const problem = (where, message) => errors.push(`${where}：${message}`);

// The same links Folio understands: a repository, or a folder in it (…/tree/<branch>/<folder>).
function parseRepo(input) {
  const u = new URL(String(input));
  const host = u.hostname.replace(/^www\./, '');
  if (u.protocol !== 'https:' || (host !== 'github.com' && host !== 'gitee.com'))
    throw Error('只支持 https://github.com 或 https://gitee.com 的链接');
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2) throw Error('链接里要有仓库');
  const [owner, repo] = parts;
  let ref = '';
  let dir = '';
  if (parts[2] === 'tree') {
    ref = parts[3] || '';
    dir = parts.slice(4).join('/');
  } else if (parts.length > 2) throw Error('请用仓库首页或 …/tree/<分支>/<文件夹> 的链接');
  return { host, owner, repo: repo.replace(/\.git$/, ''), ref, dir };
}

async function remoteManifest(source) {
  const rel = `${source.dir ? `${source.dir}/` : ''}folio-plugin.json`;
  const headers = { 'User-Agent': 'folio-plugins-ci' };
  let url;
  if (source.host === 'github.com') {
    url = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.ref || 'HEAD'}/${rel}`;
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  } else {
    let ref = source.ref;
    if (!ref) {
      const info = await fetch(`https://gitee.com/api/v5/repos/${source.owner}/${source.repo}`, {
        headers,
      });
      if (!info.ok) throw Error(`Gitee 返回了 ${info.status}`);
      ref = (await info.json()).default_branch;
    }
    url = `https://gitee.com/${source.owner}/${source.repo}/raw/${ref}/${rel}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw Error(`读不到 ${rel}（${res.status}）`);
  return JSON.parse(await res.text());
}

async function main() {
  let directory;
  try {
    directory = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`community-plugins.json 不是有效的 JSON：${e.message}`);
    process.exit(1);
  }
  if (directory.version !== 1 || !Array.isArray(directory.plugins))
    problem('community-plugins.json', '要有 "version": 1 和 "plugins": [...]');
  const seen = new Set();
  for (const [i, p] of (directory.plugins || []).entries()) {
    const where = `第 ${i + 1} 项（${p?.id || '没有 id'}）`;
    if (!p || typeof p !== 'object') {
      problem(where, '不是一个对象');
      continue;
    }
    const allowed = ['id', 'name', 'author', 'description', 'repo', 'tags'];
    for (const key of Object.keys(p))
      if (!allowed.includes(key)) problem(where, `不认识的字段 ${key}`);
    if (!idPattern.test(String(p.id || '')))
      problem(where, 'id 只能用小写字母、数字和 -，2–40 个字符');
    if (seen.has(p.id)) problem(where, `id ${p.id} 重复了`);
    seen.add(p.id);
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 40)
      problem(where, 'name 要有，最多 40 个字');
    if (p.author !== undefined && (typeof p.author !== 'string' || p.author.length > 60))
      problem(where, 'author 最多 60 个字');
    if (typeof p.description !== 'string' || !p.description.trim() || p.description.length > 300)
      problem(where, 'description 要有，最多 300 个字');
    if (
      p.tags !== undefined &&
      (!Array.isArray(p.tags) ||
        p.tags.length > 5 ||
        p.tags.some((t) => typeof t !== 'string' || !t.trim() || t.length > 16))
    )
      problem(where, 'tags 最多 5 个，每个最多 16 个字');
    let source;
    try {
      source = parseRepo(p.repo);
    } catch (e) {
      problem(where, `repo：${e.message}`);
      continue;
    }
    if (!remote || (only && !only.has(p.id))) continue;
    try {
      const manifest = validateManifest(await remoteManifest(source));
      if (manifest.id !== p.id)
        problem(where, `仓库里插件的 id 是 ${manifest.id}，和目录里的不一样`);
      else console.log(`✓ ${p.id}：${manifest.name} ${manifest.version}`);
    } catch (e) {
      problem(where, e.message);
    }
  }
  if (errors.length) {
    for (const e of errors) console.error(`✗ ${e}`);
    process.exit(1);
  }
  console.log(`✓ community-plugins.json：${directory.plugins.length} 个插件`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
