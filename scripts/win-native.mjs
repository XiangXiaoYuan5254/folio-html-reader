// The Windows installer is cross-built on a Mac, where npm installs only the Mac build of
// sherpa-onnx, the native part of Windows voice conversation. This puts the Windows x64
// build, at the version and checksum package-lock.json pins, into node_modules so
// electron-builder packs it. On Windows npm has installed it already.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const name = 'sherpa-onnx-win-x64';
const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
const { version, integrity } = lock.packages[`node_modules/${name}`];
const dest = path.join('node_modules', name);
const installed = await fs
  .readFile(path.join(dest, 'package.json'), 'utf8')
  .then(JSON.parse, () => null);
if (installed?.version === version) {
  console.log(`${name} ${version} is in node_modules.`);
} else {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-win-native-'));
  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', `${name}@${version}`, '--json', '--pack-destination', tmp], {
      encoding: 'utf8',
    }),
  );
  if (packed.integrity !== integrity)
    throw Error(`${name} ${version} from npm does not match package-lock.json.`);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  execFileSync('tar', ['-xzf', path.join(tmp, packed.filename), '-C', dest, '--strip-components=1']);
  await fs.rm(tmp, { recursive: true, force: true });
  console.log(`Put ${name} ${version} into node_modules for the Windows build.`);
}
