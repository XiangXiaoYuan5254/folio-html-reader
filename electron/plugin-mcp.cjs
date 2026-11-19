// 页间对外：这台电脑上的其他 AI 工具（OpenScience、Claude Code、Codex……）通过 MCP 调用页间里
// 插件提供的工具（清单 aiTools 里写了 "mcp": true 的）。比如「文献库」插件让它们读读者的文献库：
// 哪些论文读过、读者在上面划了什么、写了什么。工具由插件的后台脚本实现（src/plugins/runtime.ts），
// 所以只在页间开着、打开了项目时能用。
//
// 默认关闭。打开后只监听 127.0.0.1，地址里带一段随机口令（存在页间的设置里，重启不变，这样别的
// 工具里填一次就行）。用的是 MCP 的 Streamable HTTP：一个 POST 一问一答，不保持连接。
const http = require('node:http');
const crypto = require('node:crypto');

const FIRST_PORT = 47318;

// tools(): the tools offered now, [{ plugin, name, title, description, parameters }].
// call(plugin, name, input): what the tool answers, as text.
function createPluginMcp({ version, tools, call }) {
  let server = null;
  let port = 0;
  let token = '';

  // One tool for each name: the first plugin's, if two offer the same.
  async function offered() {
    const seen = new Set();
    return (await tools()).filter((t) => !seen.has(t.name) && seen.add(t.name));
  }

  async function serve(req, res) {
    const given = String(req.url || '').match(/^\/mcp\/([\w-]+)\/?$/)?.[1] || '';
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    // Only this computer's own name for itself: a web page elsewhere made to resolve here
    // (DNS rebinding) is refused, as is anyone without the address's secret part.
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (
      !['127.0.0.1', 'localhost'].includes(host) ||
      a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)
    )
      return void res.writeHead(404).end();
    if (req.method !== 'POST') return void res.writeHead(405, { Allow: 'POST' }).end();
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2_000_000) return void res.writeHead(413).end();
    }
    let m;
    try {
      m = JSON.parse(body);
    } catch {
      return void res.writeHead(400).end();
    }
    // Notifications need no answer.
    if (!m || typeof m !== 'object' || m.id === undefined) return void res.writeHead(202).end();
    const reply = (message) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...message }));
    };
    switch (m.method) {
      case 'initialize':
        return reply({
          result: {
            protocolVersion: m.params?.protocolVersion || '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'folio', title: '页间 Folio', version },
            instructions:
              'Tools of the plugins installed in Folio (页间), a reading app, working on the project open there: what the reader keeps, has read, highlighted and noted.',
          },
        });
      case 'ping':
        return reply({ result: {} });
      case 'tools/list':
        return reply({
          result: {
            tools: (await offered()).map((t) => ({
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: t.parameters,
            })),
          },
        });
      case 'tools/call':
        try {
          const tool = (await offered()).find((t) => t.name === m.params?.name);
          if (!tool) throw Error(`Unknown tool: ${m.params?.name}`);
          const text = await call(tool.plugin, tool.name, m.params?.arguments || {});
          return reply({ result: { content: [{ type: 'text', text }] } });
        } catch (e) {
          return reply({
            result: { content: [{ type: 'text', text: e?.message || String(e) }], isError: true },
          });
        }
    }
    return reply({ error: { code: -32601, message: `Method not found: ${m.method}` } });
  }

  // Listens with this secret: on the port asked for, or the first free one after it.
  async function start({ secret, preferred = FIRST_PORT }) {
    await stop();
    token = secret;
    for (let attempt = 0; attempt < 12; attempt++) {
      const candidate = preferred + attempt;
      const listening = http.createServer(
        (req, res) => void serve(req, res).catch(() => res.writeHead(500).end()),
      );
      const ok = await new Promise((resolve) => {
        listening.once('error', () => resolve(false));
        listening.listen(candidate, '127.0.0.1', () => resolve(true));
      });
      if (ok) {
        server = listening;
        port = candidate;
        return port;
      }
    }
    throw Error('没有找到可用的端口');
  }
  async function stop() {
    const closing = server;
    server = null;
    port = 0;
    if (closing) await new Promise((resolve) => closing.close(resolve));
  }
  return {
    start,
    stop,
    url: () => (server ? `http://127.0.0.1:${port}/mcp/${token}` : ''),
  };
}

module.exports = { createPluginMcp, FIRST_PORT };
