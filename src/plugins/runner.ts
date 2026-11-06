import { useSyncExternalStore } from 'react';
import { invoke } from '../api';
import { agentTools } from '../ai/agent-tools';
import type { Assistant, PluginOutcome } from '../ai/assistant';
import { errorText } from '../ai/client';
import { openSandbox } from './sandbox';
import type { ScriptSandbox } from './sandbox';
import { loadPlugins, pluginRan } from './store';
import type { PluginLoaded } from './types';
import { prepareWebTool, webTools } from './web-tools';
import { folderTools, prepareFolderTool } from './folder-tools';
import { inputSummary, pluginLog } from './log';
import { duePlugins, pluginSystem, timeVars, writableFolders, writableIn } from './schedule';
export { duePlugins, fill, lastSlot, timeVars, writableFolders, writableIn } from './schedule';

// What a plugin run needs from the app (App.tsx).
export type PluginHost = {
  assistant: Assistant;
  root(): string | undefined;
  projectName(): string;
  notify(text: string, error?: boolean, action?: { label: string; run: () => void }): void;
  open(path: string): Promise<void>;
  // Shows a run's conversation in 整个项目, where its steps come in as it works. A plugin with
  // a folder of its own (`home`) runs in that folder's project, which is opened for it.
  show(threadId: string, home?: string): void;
  // Opens a file a folder plugin wrote, in its folder's project.
  openIn(home: string, file: string): void;
};

// Plugins running now, the conversation each one is working in (empty until it starts), and
// for a plugin with a folder of its own, that folder (its project).
type Run = { threadId: string; home?: string };
let running = new Map<string, Run>();
const watchers = new Set<() => void>();
function setRunning(id: string, run: Run | null) {
  running = new Map(running);
  if (run === null) running.delete(id);
  else running.set(id, run);
  watchers.forEach((w) => w());
}
export const pluginRunning = (id: string) => running.has(id);
// The conversation a running plugin works in (threadId '' just before it starts).
export const runningThread = (id: string) => running.get(id);
export function usePluginRuns() {
  return useSyncExternalStore(
    (w) => {
      watchers.add(w);
      return () => watchers.delete(w);
    },
    () => running,
  );
}
// The way to a running plugin's progress, for its button and the notices about it.
export const viewProgress = (host: PluginHost, id: string) => {
  const run = running.get(id);
  return run?.threadId
    ? { label: '查看进度', run: () => host.show(run.threadId, run.home) }
    : undefined;
};

// Runs a plugin once in the open project. `quiet`: a scheduled run nobody asked for just now,
// which asks nothing (consent) and opens nothing.
export async function runPluginNow(
  host: PluginHost,
  id: string,
  how: { quiet: boolean; label: string },
): Promise<PluginOutcome | null> {
  const list = await loadPlugins(true);
  const info = list?.plugins.find((p) => p.id === id);
  const name = info?.manifest?.name || id;
  if (!info?.manifest) {
    host.notify(`没有找到插件「${name}」`, true);
    return null;
  }
  if (!info.enabled) {
    if (!how.quiet) host.notify(`插件「${name}」没有开启`, true);
    return null;
  }
  // A folder plugin works in its own folder; any other in the open project.
  const own = info.manifest.run.where === 'folder';
  if (!own && !host.root()) {
    if (!how.quiet) host.notify('先打开一个项目，插件会在项目里运行', true);
    return null;
  }
  if (running.has(id)) {
    if (!how.quiet)
      host.notify(`「${name}」正在运行，完成后会告诉你`, false, viewProgress(host, id));
    return null;
  }
  setRunning(id, { threadId: '' });
  let sandbox: ScriptSandbox | undefined;
  const started = Date.now();
  pluginLog(id, 'run', `开始运行：${how.label}`);
  try {
    // Noted before it starts, so a schedule doesn't run it again if the app stops midway.
    await pluginRan({ id, at: Date.now() });
    const loaded = await invoke<PluginLoaded>('plugin-load', { id });
    const m = loaded.manifest;
    // Its folder, made now if it isn't there yet: its reports and its record of this run go
    // there, the folder being its project.
    const place = own
      ? await invoke<{ path: string; shown: string }>('plugin-folder', { id, action: 'ensure' })
      : null;
    const vars = {
      ...info.settings,
      ...timeVars(),
      project: host.projectName(),
      folder: place?.shown || '',
    };
    const folders = own ? [] : writableFolders(m, info.settings);
    const reserved = new Set([...agentTools, ...webTools].map((t) => t.name));
    if (loaded.hasScript)
      sandbox = await openSandbox(id, reserved, (text, level) =>
        pluginLog(id, level === 'info' ? 'script' : level, text),
      );
    const scriptTools = sandbox?.tools || [];
    if (loaded.hasScript)
      pluginLog(
        id,
        'run',
        scriptTools.length
          ? `脚本准备好了，提供的工具：${scriptTools.map((t) => t.name).join('、')}`
          : '脚本准备好了，但没有注册任何工具',
      );
    // Pages read in this run, so reading on (offset) doesn't download them again.
    const pages = new Map();
    const ours = new Set(scriptTools.map((t) => t.name));
    const outcome = await host.assistant.runPlugin({
      title: `${m.name} · ${vars.today}`,
      label: `${m.name} · ${how.label}`,
      system: pluginSystem(loaded, vars, folders),
      request: `${how.label}。请按插件说明完成这次任务。`,
      tools: [
        ...(own ? folderTools : []).filter((t) => m.run.tools.includes(t.name)),
        ...agentTools.filter(
          (t) =>
            m.run.tools.includes(t.name) && !(own && folderTools.some((f) => f.name === t.name)),
        ),
        ...webTools.filter((t) => m.run.tools.includes(t.name)),
        ...scriptTools,
      ],
      web: m.run.web,
      quiet: how.quiet,
      use: `plugin:${id}`,
      home: place?.path,
      pluginId: id,
      // A folder plugin's paths are checked against its folder in electron/plugins.cjs.
      writable: own ? () => true : writableIn(folders),
      onTool: ({ name, input, ok, detail, ms }) => {
        const what = inputSummary(input);
        pluginLog(
          id,
          ok ? 'tool' : 'error',
          `${name}${what ? ` ${what}` : ''} → ${ok ? '完成' : '出错'}（${(ms / 1000).toFixed(1)} 秒）${detail ? `：${detail.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`,
        );
      },
      extra: (tool, input, progress) =>
        ours.has(tool)
          ? { title: `${m.name}：${tool}`, run: () => sandbox!.call(tool, input) }
          : (own ? prepareFolderTool(id, tool, input, progress, vars.folder) : undefined) ||
            prepareWebTool(id, tool, input, progress, pages),
      onThread: (threadId) => {
        setRunning(id, { threadId, home: place?.path });
        // A folder plugin's progress is in its folder's project; here unless that's open.
        const there = own && host.root() === place?.path;
        host.notify(
          own && !there
            ? `「${m.name}」开始${how.quiet ? '定时' : ''}运行，日报和运行记录都在 ${vars.folder}`
            : how.quiet
              ? `「${m.name}」开始定时运行，几分钟后完成`
              : `「${m.name}」开始运行，每一步都显示在右边「整个项目」里`,
          false,
          viewProgress(host, id),
        );
      },
    });
    const file = outcome.written.at(-1) || '';
    const took = `用时 ${Math.round((Date.now() - started) / 1000)} 秒`;
    if (outcome.ok) pluginLog(id, 'run', `完成${file ? `，写了 ${file}` : ''}（${took}）`);
    else pluginLog(id, 'error', `没有完成：${outcome.message}（${took}）`);
    await pluginRan({
      id,
      result: { ok: outcome.ok, message: outcome.message, output: file },
    }).catch(() => {});
    // Where the result opens: in the open project, or, for a folder plugin, in its folder's
    // project (opened for it on asking, unless it's the one open).
    const there = !own || host.root() === place?.path;
    const open = there
      ? () => void host.open(file).catch((e) => host.notify(errorText(e), true))
      : () => host.openIn(place!.path, file);
    if (outcome.ok)
      host.notify(
        file
          ? `「${m.name}」完成了：${there ? '' : `${vars.folder}/`}${file}`
          : `「${m.name}」完成了`,
        false,
        file && (how.quiet || !there) ? { label: '打开', run: open } : undefined,
      );
    else if (outcome.message !== '已停止')
      host.notify(`「${m.name}」没有完成：${outcome.message}`, true);
    if (outcome.ok && file && !how.quiet && there) await host.open(file).catch(() => {});
    return outcome;
  } catch (e) {
    const message = errorText(e);
    pluginLog(id, 'error', `没有运行：${message}`);
    await pluginRan({ id, result: { ok: false, message } }).catch(() => {});
    host.notify(`「${name}」没有运行：${message}`, true);
    return null;
  } finally {
    sandbox?.close();
    setRunning(id, null);
  }
}

// Looked at every minute and when a project opens.
export async function checkSchedule(host: PluginHost) {
  const root = host.root();
  const list = await loadPlugins();
  if (!list) return;
  for (const due of duePlugins(list, root))
    if (!running.has(due.id))
      void runPluginNow(host, due.id, { quiet: true, label: `定时运行（每天 ${due.time}）` });
}
