export type AiKind = 'openai' | 'anthropic' | 'codex';
export type AiPreset = {
  id: string;
  name: string;
  kind: AiKind;
  baseUrl: string;
  model: string;
  models: string[];
  context: number;
  thinking: string;
  // Reasoning levels to pick from; empty means the service has none to pick.
  efforts: string[];
  keyUrl?: string;
  noKey?: boolean;
  region: 'cn' | 'global' | 'local';
};
export type AiProvider = {
  id: string;
  preset: string;
  kind: AiKind;
  name: string;
  baseUrl: string;
  model: string;
  context: number;
  maxOutput: number;
  // The chosen reasoning level; empty leaves it to the service.
  effort: string;
  keyHint: string;
  hasKey: boolean;
};
export type AiPrefs = {
  consented?: string[];
  disabledRoots?: string[];
  language?: 'auto' | 'zh' | 'en';
  // The reader in their own words, for pitching 精读笔记 at the right depth.
  profile?: string;
};
// The parts of the app that ask the AI. Chat uses the active service; the others can each
// have their own service, model and reasoning level, and follow chat when they don't.
export type AiUse = 'chat' | 'explain' | 'translate' | 'board' | 'edit';
export type AiUseChoice = { provider: string; model: string; effort: string };
export type AiConfig = {
  providers: AiProvider[];
  active: string;
  uses: Partial<Record<AiUse, AiUseChoice>>;
  prefs: AiPrefs;
  presets: AiPreset[];
};

// A model a service offers, with the reasoning levels it supports and, when the service
// says so, whether it takes images.
export type ModelOption = {
  id: string;
  efforts: string[];
  defaultEffort: string;
  images?: boolean;
};

export type ToolCall = { id: string; name: string; input: any };
export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };
// The neutral message shape electron/ai-providers.cjs converts for each service.
export type WireMessage = {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  // User turns only: images as data: URLs (JPEG or PNG), shown to the model before the text.
  images?: string[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  isError?: boolean;
  reasoning?: string;
  raw?: unknown;
};
export type Usage = { input: number; output: number; cached: number };
// How much of a ChatGPT plan's Codex allowance is used in the current window.
export type Quota = { usedPercent: number; windowMins: number; resetsAt: number };
export type CodexStatus = {
  found: boolean;
  path?: string;
  account?: { type: string; plan: string; email: string } | null;
  quota?: Quota | null;
  error?: string;
};
export type ChatResult = {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  stopReason: string;
  usage?: Usage | null;
  raw?: unknown;
  provider: string;
  model: string;
  quota?: Quota | null;
};

// A paper found by search_papers (electron/papers.cjs).
export type Paper = {
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  citations?: number;
  doi?: string;
  arxiv?: string;
  url: string;
  pdf: string[];
  abstract: string;
  source: string;
};

// Text of a document as the AI sees it.
export type DocText = {
  path: string;
  kind: 'html' | 'pdf';
  title: string;
  text: string;
  pages?: string[];
};

export type AgentPreview =
  | {
      kind: 'highlights';
      path: string;
      items: { quote: string; note: string; color: string; found: boolean }[];
    }
  | { kind: 'note'; path: string; before: string; after: string }
  | { kind: 'source'; path: string; before: string; after: string }
  | { kind: 'create'; path: string; content: string }
  | { kind: 'download'; path: string; url: string; title: string };
export type AgentStep = {
  id: string;
  tool: string;
  title: string;
  status: 'running' | 'waiting' | 'done' | 'error' | 'skipped';
  detail?: string;
  preview?: AgentPreview;
};
export type MessagePart = { type: 'text'; text: string } | { type: 'step'; step: AgentStep };

export type CiteDoc = { id: string; path: string };
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  // User: what was asked. Assistant: the answer in Markdown.
  text: string;
  createdAt: number;
  // A quick action's name shown instead of its long prompt, e.g. “总结全文”.
  label?: string;
  selection?: string;
  // Pictures sent with a question (pasted, dropped, or a region of the page), as data: URLs.
  images?: string[];
  reasoning?: string;
  // What a long piece (a 精读笔记 page) has written so far, shown while it works; not saved.
  draft?: string;
  status?: 'streaming' | 'done' | 'error' | 'stopped';
  error?: string;
  model?: string;
  usage?: Usage | null;
  quota?: Quota | null;
  // Documents citations refer to: <cite doc="2"> is docs[1].
  docs?: CiteDoc[];
  // Whether each cited quote was found in its document.
  cites?: Record<string, boolean>;
  // Agent replies interleave text with tool steps.
  parts?: MessagePart[];
  // Web searches a reply about the document ran, shown above it.
  searches?: AgentStep[];
  // What the reply can be turned into, e.g. appended to the document note.
  canSaveNote?: boolean;
  // The document whose note this reply was appended to.
  savedNote?: string;
  partial?: boolean;
};
export type ChatThread = {
  id: string;
  mode: 'doc' | 'agent';
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};
export type ChatHistory = { version: 1; active?: string; threads: ChatThread[] };
