export type AiKind = 'openai' | 'anthropic' | 'codex' | 'kimi';
export type AiPreset = {
  id: string;
  name: string;
  kind: AiKind;
  baseUrl: string;
  model: string;
  models: string[];
  context: number;
  thinking: string;
  // Reasoning levels to pick from, empty when the service has none, and the one used until
  // another is picked.
  efforts: string[];
  effort?: string;
  // Where the service's models differ: [pattern, levels, default] by model name, first match.
  levels?: [string, string[], string][];
  keyUrl?: string;
  noKey?: boolean;
  // The key can ask what's left on the account.
  balance?: boolean;
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
  // Models known to take images or not, learned from sending them some.
  vision?: Record<string, boolean>;
  // The models picked to show in the model menu; none shows the service's whole list.
  picks?: string[];
};
export type AiPrefs = {
  consented?: string[];
  disabledRoots?: string[];
  language?: 'auto' | 'zh' | 'en';
  // The reader in their own words, for pitching 精读笔记 at the right depth.
  profile?: string;
  // The reader's own writing for 精读笔记 in place of Folio's (src/ai/companion.ts); empty
  // uses Folio's. The format is always Folio's.
  companionPrompt?: string;
};
// The parts of the app that ask the AI. Chat uses the active service; the others can each
// have their own service, model and reasoning level, and follow chat when they don't. Each
// plugin is one too, as plugin:<its id>.
export type AiUse = 'chat' | 'explain' | 'translate' | 'board' | 'edit' | PluginUse;
export type PluginUse = `plugin:${string}`;
export type AiUseChoice = { provider: string; model: string; effort: string };
export type AiConfig = {
  providers: AiProvider[];
  active: string;
  uses: Partial<Record<AiUse, AiUseChoice>>;
  prefs: AiPrefs;
  presets: AiPreset[];
  speech?: SpeechService[];
  // The paper libraries' keys; only OpenAlex takes one.
  papers?: { openalex: { hasKey: boolean; keyHint: string } };
};
// An online speech service whose voices the whiteboard teacher can read its script in.
// `named`: it has a name to introduce itself by (芊悦), not only a description (温柔学姐).
export type CloudVoice = { id: string; name: string; about: string; named?: boolean };
export type SpeechService = {
  id: string;
  name: string;
  about: string;
  keyUrl?: string;
  // An online service that needs no user key. This is not an offline system voice.
  free?: boolean;
  voices: CloudVoice[];
  // It can also write down what the student says in a voice conversation.
  hears?: boolean;
  // The key can ask what's left on the account.
  balance?: boolean;
  hasKey: boolean;
  keyHint: string;
  // The AI service whose key it uses, when it has none of its own.
  shared: string;
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
// How much of a plan's allowance (a ChatGPT plan's Codex, a Kimi membership) is used in the
// current window.
export type Quota = { usedPercent: number; windowMins: number; resetsAt: number };
export type CodexStatus = {
  found: boolean;
  path?: string;
  account?: { type: string; plan: string; email: string } | null;
  // The plan's usage windows: five hours, then a week.
  windows?: Quota[];
  error?: string;
};
// The Kimi Code CLI on this computer: found? signed in to a Kimi account? how much of the
// membership is used? `error` also says when the account has no membership.
export type KimiStatus = {
  found: boolean;
  path?: string;
  signedIn?: boolean;
  // The account's nickname and membership level, e.g. Moderato.
  account?: { name: string; level: string };
  windows?: Quota[];
  error?: string;
};
// What's left on a service: money for the services whose key can ask (`amount` is null when
// the service only tells what's used), with the resource packages some services give, or how
// much of each of a plan's usage windows (ChatGPT's, a Kimi membership's) is used.
export type Balance =
  | {
      kind: 'money';
      amount: number | null;
      currency: 'CNY' | 'USD';
      detail: string;
      empty: boolean;
      packs?: ResourcePack[];
    }
  | { kind: 'plan'; windows: Quota[] };
// A package of tokens or calls a service gave or sold; `fits` the service's model.
export type ResourcePack = { name: string; left: string; until: number; fits: boolean };
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

// The fields search_papers can narrow to, as FIELDS in electron/papers.cjs names them.
export const PAPER_FIELDS = [
  'computer_science',
  'mathematics',
  'physics',
  'engineering',
  'materials',
  'chemistry',
  'earth_environment',
  'biology',
  'medicine',
  'neuroscience',
  'psychology',
  'economics',
  'business',
  'social_sciences',
  'humanities',
];

// A paper found by search_papers (electron/papers.cjs).
export type Paper = {
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  citations?: number;
  doi?: string;
  arxiv?: string;
  pmid?: string;
  url: string;
  pdf: string[];
  abstract: string;
  // The libraries it came from: "OpenAlex", or "OpenAlex、arXiv" when both had it.
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
// A figure or table cut out of a PDF page, found by its caption ("Figure 2:", "Table 1.").
export type PdfFigure = {
  kind: 'figure' | 'table';
  // As the caption numbers it: "2", "A.1", "IV".
  number: string;
  page: number;
  // How far down the page it starts, 0 at the top.
  top: number;
  // The original caption, for when the translation has none.
  caption: string;
  // A data: URL, and its size on the page in CSS pixels.
  src: string;
  width: number;
  height: number;
  // A table's cells as read off the page, row by row, for the model to retype it.
  rows?: string[][];
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
  // With two documents open, the one the selection is from (its file name).
  selectionFrom?: string;
  // The selection is a passage of an earlier reply, picked in the chat, not of a document.
  fromReply?: boolean;
  // Pictures sent with a question (pasted, dropped, or a region of the page), as data: URLs.
  images?: string[];
  reasoning?: string;
  // What a long piece (a 精读笔记 page) has written so far, shown while it works; not saved.
  draft?: string;
  // What the model is told this reply was, where that isn't the text shown: a task's result
  // (the 精读笔记 page it wrote), or how far an unfinished one got.
  said?: string;
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
  // A reply finished while another conversation was open; cleared once this one is opened.
  unseen?: boolean;
  // The earlier part of a long conversation, summarized to make room: the summary, and the
  // last message it covers. The model gets the summary and what came after.
  summary?: { text: string; upTo: string };
};
// A document's conversations with another read beside it, for its history list.
export type PairThreads = {
  key: string;
  // The other document's path.
  other: string;
  threads: { id: string; title: string; updatedAt: number }[];
};
export type ChatHistory = { version: 1; active?: string; threads: ChatThread[] };
