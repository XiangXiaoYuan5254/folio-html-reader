// Copies this version's installers and update files from release/ into website/downloads/,
// which is uploaded with the website. 页间 looks for updates in latest-mac.yml (macOS) and
// latest.yml (Windows) there, so they must come with the files they list. Also writes
// release-notes.json, every release's notes, so the update card can show what changed in each
// version since the installed one: the .yml files carry only this version's.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
const files = [
  `Folio-${version}-mac-arm64.dmg`,
  `Folio-${version}-mac-arm64.zip`,
  `Folio-${version}-mac-arm64.zip.blockmap`,
  `Folio-${version}-win-x64-setup.exe`,
  `Folio-${version}-win-x64-setup.exe.blockmap`,
  'latest-mac.yml',
  'latest.yml',
  'SHA256SUMS.txt',
];
for (const file of files) {
  const text = await fs
    .readFile(path.join('release', file), file.endsWith('.yml') ? 'utf8' : undefined)
    .catch(() => {
      throw Error(`release/${file} is missing; run npm run dist:mac and npm run dist:win first.`);
    });
  if (file.endsWith('.yml') && !text.startsWith(`version: ${version}\n`))
    throw Error(`release/${file} is not for ${version}; run npm run dist:mac and dist:win again.`);
}
// Earlier versions' files stay: with their block maps, an update downloads only what changed.
await fs.mkdir('website/downloads', { recursive: true });
for (const file of files)
  await fs.copyFile(path.join('release', file), path.join('website/downloads', file));

// This version's notes from build/release-notes.md, earlier ones from their release tags, or as
// rewritten since in build/release-notes-rewritten.json (the card says nothing about membership).
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const rewritten = JSON.parse(await fs.readFile('build/release-notes-rewritten.json', 'utf8'));
const releases = [{ version, notes: await fs.readFile('build/release-notes.md', 'utf8') }];
for (const tag of git('tag', '--list', 'v*').split('\n')) {
  const tagged = tag.slice(1);
  if (!/^\d+\.\d+\.\d+$/.test(tagged) || !newer(version, tagged)) continue;
  try {
    releases.push({
      version: tagged,
      notes: rewritten[tagged] ?? git('show', `${tag}:build/release-notes.md`),
    });
  } catch {
    // Releases from before build/release-notes.md.
  }
}
releases.sort((a, b) => (newer(a.version, b.version) ? -1 : 1));
await fs.writeFile(
  'website/downloads/release-notes.json',
  JSON.stringify(releases.slice(0, 30), null, 2) + '\n',
);

console.log(`Copied ${version} to website/downloads/:\n  ${files.join('\n  ')}`);
console.log(`Wrote release-notes.json with ${Math.min(releases.length, 30)} releases.`);
console.log('Upload the installers first and the two .yml files last.');
