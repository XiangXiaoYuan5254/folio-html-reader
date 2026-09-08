import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
const files = (await fs.readdir('release'))
  .filter((name) => name.startsWith(`Folio-${version}-mac-arm64.`) && /\.(dmg|zip)$/.test(name))
  .sort();
if (files.length !== 2) throw Error('Expected arm64 DMG and ZIP; run npm run dist:mac first.');
const lines = [];
for (const file of files) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join('release', file))) hash.update(chunk);
  lines.push(`${hash.digest('hex')}  ${file}`);
}
await fs.writeFile('release/SHA256SUMS.txt', lines.join('\n') + '\n');
console.log(`Wrote SHA256SUMS.txt for ${files.length} installers.`);
