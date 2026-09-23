import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { build as bundle } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Workspace } = require('./electron/workspace.cjs');
const { renderDocument, markSourceOffsets, mime } = require('./electron/render.cjs');
const { renderPDFDocument, pdfAssetPath } = require('./electron/pdf.cjs');
async function buildPDF(minify = false) {
  await bundle({
    entryPoints: ['src/pdf/pdf.ts'],
    outfile: 'dist/pdf/pdf.js',
    bundle: true,
    format: 'esm',
    target: 'chrome130',
    minify,
  });
  for (const name of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    const source = path.resolve('node_modules/pdfjs-dist', name);
    if (await fs.stat(source).catch(() => null))
      await fs.cp(source, path.resolve('dist/pdf', name), { recursive: true });
  }
  await fs.copyFile('node_modules/pdfjs-dist/build/pdf.worker.mjs', 'dist/pdf/pdf.worker.mjs');
  await fs.copyFile('node_modules/pdfjs-dist/LICENSE', 'dist/pdf/LICENSE.pdfjs');
}
export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      name: 'folio-reader',
      async closeBundle() {
        await buildPDF(true);
        await bundle({
          entryPoints: ['src/reader/runtime.ts'],
          outfile: 'dist/reader.js',
          bundle: true,
          format: 'iife',
          target: 'chrome130',
          minify: true,
        });
      },
      async configureServer(server) {
        await buildPDF();
        const w = new Workspace();
        await w.open(process.env.FOLIO_WORKSPACE || path.resolve('samples'));
        const previews = new Map();
        const runtime = async () => {
          const r = await bundle({
            entryPoints: ['src/reader/runtime.ts'],
            write: false,
            bundle: true,
            format: 'iife',
            target: 'chrome130',
          });
          return r.outputFiles[0].text;
        };
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          if (!url.pathname.startsWith('/__')) return next();
          try {
            if (url.pathname.startsWith('/__api/')) {
              if (req.method !== 'POST') throw Error('Only POST');
              const origin = req.headers.origin;
              if (origin && origin !== `http://${req.headers.host}`) throw Error('不允许跨站请求');
              const action = url.pathname.slice(7);
              let raw = '';
              for await (const b of req) {
                raw += b;
                if (raw.length > 30_000_000) throw Error('请求过大');
              }
              const p = JSON.parse(raw || '{}');
              if (
                !['workspace', 'choose-folder'].includes(action) &&
                req.headers['x-folio-token'] !== w.token
              )
                throw Error('项目已切换');
              let data;
              switch (action) {
                case 'workspace':
                case 'tree':
                  data = await w.summary();
                  break;
                case 'choose-folder':
                  throw Error('请在桌面应用中使用系统文件夹选择器');
                case 'document':
                  data = await w.document(p.path);
                  break;
                case 'save-data':
                  data = await w.saveData(p);
                  break;
                case 'save-session':
                  data = await w.saveSession(p);
                  break;
                case 'save-source':
                  data = await w.saveSource(p);
                  break;
                case 'create':
                  data = await w.create(p);
                  break;
                case 'move':
                  data = await w.move(p);
                  break;
                case 'preview': {
                  const id = crypto.randomUUID();
                  previews.set(id, p);
                  if (previews.size > 30) previews.delete(previews.keys().next().value);
                  data = `/__preview/${w.token}/${id}`;
                  break;
                }
                default:
                  throw Error('此操作请在桌面应用中使用');
              }
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(data));
              return;
            }
            const parts = url.pathname.split('/').filter(Boolean);
            const mode = parts.shift(),
              token = parts.shift();
            if (token !== w.token) throw Error('项目已切换');
            const relative = parts.map(decodeURIComponent).join('/');
            if (mode === '__pdfjs') {
              const file = pdfAssetPath(path.resolve('dist'), relative);
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', mime(file));
              res.end(await fs.readFile(file));
              return;
            }
            if (mode === '__asset') {
              const file = await w.asset(relative);
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', mime(file));
              res.end(await fs.readFile(file));
              return;
            }
            let source, docPath;
            if (mode === '__preview') {
              const p = previews.get(relative);
              if (!p) throw Error('预览过期');
              source = markSourceOffsets(p.source);
              docPath = p.path;
            } else {
              docPath = relative;
              if (/\.pdf$/i.test(relative)) {
                await w.asset(relative);
                const base = `http://${req.headers.host}`;
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.end(
                  renderPDFDocument(
                    `${base}/__asset/${w.token}/${relative.split('/').map(encodeURIComponent).join('/')}`,
                    `${base}/__pdfjs/${w.token}/`,
                    path.basename(relative),
                  ),
                );
                return;
              }
              source = await fs.readFile(await w.asset(relative), 'utf8');
            }
            const dir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/') + 1) : '';
            const base = `http://${req.headers.host}/__asset/${w.token}/${dir.split('/').map(encodeURIComponent).join('/')}`;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(renderDocument(source, base, await runtime()));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: (e as Error).message }));
          }
        });
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
