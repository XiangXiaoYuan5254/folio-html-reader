import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

// Covers every installer of this version in release/, so building macOS and Windows one
// after the other yields a single SHA256SUMS.txt. The argument names the platform just built.
const expected = {
  mac: [/^Folio-.+-mac-arm64\.dmg$/, /^Folio-.+-mac-arm64\.zip$/],
  win: [/^Folio-.+-win-x64-setup\.exe$/, /^Folio-.+-win-x64\.zip$/],
};
const platform = process.argv[2] || 'mac';
if (!expected[platform]) throw Error(`Unknown platform ${platform}; use mac or win.`);
const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
const files = (await fs.readdir('release'))
  .filter(
    (name) =>
      name.startsWith(`Folio-${version}-`) &&
      Object.values(expected)
        .flat()
        .some((pattern) => pattern.test(name)),
  )
  .sort();
if (!expected[platform].every((pattern) => files.some((name) => pattern.test(name))))
  throw Error(
    `Expected ${platform} installers for ${version}; run npm run dist:${platform} first.`,
  );
const lines = [];
for (const file of files) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join('release', file))) hash.update(chunk);
  lines.push(`${hash.digest('hex')}  ${file}`);
}
await fs.writeFile('release/SHA256SUMS.txt', lines.join('\n') + '\n');
console.log(`Wrote SHA256SUMS.txt for ${files.length} installers.`);
