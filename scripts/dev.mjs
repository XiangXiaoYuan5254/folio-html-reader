import { createServer, build } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { build as bundle } from 'esbuild';
await bundle({
  entryPoints: ['src/reader/runtime.ts'],
  outfile: 'dist/reader.js',
  bundle: true,
  format: 'iife',
  target: 'chrome130',
});
const server = await createServer({ server: { host: '127.0.0.1', port: 5173, strictPort: true } });
await server.listen();
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, FOLIO_DEV_URL: 'http://127.0.0.1:5173', ELECTRON_RUN_AS_NODE: '' },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code || 0);
});
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
