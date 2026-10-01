// Builds the macOS speech helper (native/speech) the whiteboard's voice uses, for both Mac
// architectures. Skipped when it is up to date, and on other systems.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';

const source = 'native/speech/main.swift';
const out = 'build/native/folio-speech';
const time = (file) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};
if (process.platform === 'darwin' && time(out) < time(source)) {
  mkdirSync('build/native', { recursive: true });
  const parts = ['arm64', 'x86_64'].map((arch) => {
    const file = `${out}-${arch}`;
    execFileSync(
      'xcrun',
      [
        'swiftc',
        '-O',
        '-swift-version',
        '5',
        '-target',
        `${arch}-apple-macos12.0`,
        source,
        '-o',
        file,
      ],
      { stdio: 'inherit' },
    );
    return file;
  });
  execFileSync('lipo', ['-create', '-output', out, ...parts], { stdio: 'inherit' });
  for (const file of parts) rmSync(file);
  console.log(`built ${out}`);
}
