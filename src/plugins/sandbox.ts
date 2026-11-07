import type { ToolOutcome } from '../ai/agent-tools';
import { errorText } from '../ai/client';
import type { ToolDef } from '../ai/types';
import { pluginFetch } from './web-tools';

// A plugin's script, run for the length of one plugin run in a page of its own:
// app://plugin/<id> is an iframe with sandbox="allow-scripts" (no same-origin rights): it can't
// see Folio's interface, the reader's files or API keys. It may reach any website itself, but
// loads no code from anywhere (electron/plugins.cjs, tests/plugin-sandbox.e2e.mjs). It talks to
// the app only through postMessage: it says which tools it has, runs them when the model calls
// them, asks the app to fetch pages from the sites its folio-plugin.json names (free of the
// browser's cross-origin rules), and writes to its run log (folio.log / warn / error, and what it
// throws).
export type ScriptSandbox = {
  tools: ToolDef[];
  call: (name: string, input: unknown) => Promise<ToolOutcome>;
  close: () => void;
};
const toolName = /^[a-z][a-z0-9_]{1,39}$/;
export type SandboxLevel = 'info' | 'warn' | 'error';
export function openSandbox(
  pluginId: string,
  reserved: Set<string>,
  log: (text: string, level: SandboxLevel) => void = () => {},
): Promise<ScriptSandbox> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
    frame.src = `app://plugin/${encodeURIComponent(pluginId)}?t=${Date.now()}`;
    const calls = new Map<number, (outcome: ToolOutcome) => void>();
    let seq = 0;
    let fetches = 0;
    let closed = false;
    const post = (message: object) =>
      frame.contentWindow?.postMessage({ folioPlugin: 1, ...message }, '*');
    const close = () => {
      if (closed) return;
      closed = true;
      removeEventListener('message', onMessage);
      frame.remove();
      for (const done of calls.values()) done({ content: '插件脚本已关闭。', isError: true });
      calls.clear();
    };
    // The page waits up to 8 seconds for a script's own setup (electron/plugins.cjs).
    const ready = setTimeout(() => {
      close();
      reject(Error('插件脚本没有在 15 秒内准备好，看看运行日志里有没有出错'));
    }, 15_000);
    function onMessage(e: MessageEvent) {
      if (e.source !== frame.contentWindow || e.data?.folioPlugin !== 1) return;
      const m = e.data;
      if (m.type === 'ready') {
        clearTimeout(ready);
        const tools: ToolDef[] = [];
        if (Array.isArray(m.tools) && m.tools.length > 12)
          log(`插件脚本注册了 ${m.tools.length} 个工具，只用前 12 个`, 'warn');
        for (const t of Array.isArray(m.tools) ? m.tools.slice(0, 12) : []) {
          const name = String(t?.name || '');
          if (!toolName.test(name) || reserved.has(name)) {
            log(
              `跳过了插件脚本里的工具 ${name.slice(0, 40)}：名字只能用小写字母、数字和 _（2–40 个字符），也不能和页间的工具重名`,
              'warn',
            );
            continue;
          }
          let parameters = t.parameters;
          try {
            if (JSON.stringify(parameters).length > 20_000) throw Error();
          } catch {
            parameters = { type: 'object', properties: {} };
          }
          tools.push({ name, description: String(t.description || '').slice(0, 1000), parameters });
        }
        resolve({
          tools,
          close,
          call: (name, input) =>
            new Promise<ToolOutcome>((done) => {
              if (closed) return done({ content: '插件脚本已关闭。', isError: true });
              const id = ++seq;
              const timer = setTimeout(() => {
                calls.delete(id);
                done({ content: '插件的工具 90 秒没有结果。', isError: true });
              }, 90_000);
              calls.set(id, (outcome) => {
                clearTimeout(timer);
                done(outcome);
              });
              post({ type: 'call', id, name, input });
            }),
        });
      } else if (m.type === 'done') {
        const done = calls.get(m.id);
        calls.delete(m.id);
        done?.(
          m.error
            ? { content: `出错：${String(m.error).slice(0, 2000)}`, isError: true }
            : { content: String(m.content ?? '').slice(0, 60_000) },
        );
      } else if (m.type === 'fetch') {
        // Fetches go through the app, which checks the site against the plugin's list.
        if (++fetches > 80)
          return post({ type: 'reply', id: m.id, error: '这次运行联网次数太多了' });
        pluginFetch(pluginId, String(m.payload?.url || ''), String(m.payload?.accept || ''))
          .then((value) => post({ type: 'reply', id: m.id, value }))
          .catch((err) => post({ type: 'reply', id: m.id, error: errorText(err).slice(0, 500) }));
      } else if (m.type === 'log')
        log(
          String(m.text || '').slice(0, 500),
          m.level === 'error' || m.level === 'warn' ? m.level : 'info',
        );
    }
    addEventListener('message', onMessage);
    document.body.appendChild(frame);
  });
}
