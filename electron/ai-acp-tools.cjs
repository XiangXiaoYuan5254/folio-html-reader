const http = require('node:http');

// 页间's tools for the sessions that have them, as an MCP server on this computer only. Each
// session has a path of its own, which only the CLI is told. A call is answered as an event
// stream that pings while the user decides, so the CLI doesn't give up on a slow answer.
function createToolServer() {
  let mcp = null;
  const routes = new Map();
  function mcpServer(version) {
    if (mcp) return mcp;
    mcp = new Promise((resolve, reject) => {
      const httpServer = http.createServer((req, res) => void serveMcp(req, res, version));
      httpServer.on('error', reject);
      httpServer.listen(0, '127.0.0.1', () =>
        resolve({ httpServer, url: `http://127.0.0.1:${httpServer.address().port}/mcp/` }),
      );
    });
    mcp.catch(() => (mcp = null));
    return mcp;
  }
  async function serveMcp(req, res, version) {
    const session = routes.get(String(req.url).replace(/^\/mcp\//, ''));
    if (!session) return void res.writeHead(404).end();
    if (req.method !== 'POST') return void res.writeHead(405).end();
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4_000_000) return void res.writeHead(413).end();
    }
    let m;
    try {
      m = JSON.parse(body);
    } catch {
      return void res.writeHead(400).end();
    }
    // Notifications, such as a call the CLI has stopped waiting for.
    if (m?.id === undefined) return void res.writeHead(202).end();
    const json = (message) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...message }));
    };
    switch (m.method) {
      case 'initialize':
        return json({
          result: {
            protocolVersion: m.params?.protocolVersion || '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'folio', title: '页间 Folio', version },
          },
        });
      case 'ping':
        return json({ result: {} });
      case 'tools/list':
        return json({
          result: {
            tools: session.tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.parameters,
            })),
          },
        });
      case 'tools/call': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        const respond = (r) => {
          clearInterval(ping);
          if (res.writableEnded) return;
          const result = { content: [{ type: 'text', text: r.content }], isError: !!r.isError };
          res.end(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`,
          );
        };
        res.on('close', () => clearInterval(ping));
        session.toolCall(
          { name: String(m.params?.name || ''), input: m.params?.arguments ?? {} },
          respond,
        );
        return;
      }
      default:
        return json({ error: { code: -32601, message: 'Method not found' } });
    }
  }

  return {
    async connect(session, version) {
      if (!session.tools.length) return [];
      const { url } = await mcpServer(version);
      routes.set(session.route, session);
      return [{ type: 'http', name: 'folio', url: url + session.route, headers: [] }];
    },
    disconnect: (route) => routes.delete(route),
    stop() {
      routes.clear();
      mcp?.then(({ httpServer }) => httpServer.close()).catch(() => {});
      mcp = null;
    },
  };
}

module.exports = { createToolServer };
