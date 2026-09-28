// Copies this version's installers and update files from release/ into website/downloads/,
// which is uploaded with the website. 页间 looks for updates in latest-mac.yml (macOS) and
// latest.yml (Windows) there, so they must come with the files they list.
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
console.log(`Copied ${version} to website/downloads/:\n  ${files.join('\n  ')}`);
console.log('Upload the installers first and the two .yml files last.');
