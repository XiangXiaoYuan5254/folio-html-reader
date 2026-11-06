// 页间（Folio）插件脚本里的全局对象 `folio`。
//
// 插件脚本（folio-plugin.json 里的 run.script）在一个看不见的沙箱页面里运行：
// - 是普通脚本，不是 ES module：不能 import / export，需要第三方库就先打包成一个文件；
// - 不能自己联网（fetch、XMLHttpRequest、WebSocket 都被禁止），只能用 folio.fetch，
//   而且只能访问 permissions.network 里写明的网站；
// - 拿不到 localStorage、Cookie、页间的界面和你的 API Key；
// - 每次运行开一个新沙箱，运行结束就关掉，两次运行之间不保留任何状态。
//
// 在编辑器里使用：把这个文件放在脚本旁边，脚本第一行写
//   /// <reference path="./folio.d.ts" />
// 或者用 `folio-plugin init --script` 新建插件，会自动带上。

/** JSON Schema（draft-07 的常用部分），描述工具的参数。 */
interface FolioJsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  description?: string;
  properties?: Record<string, FolioJsonSchema>;
  required?: string[];
  items?: FolioJsonSchema;
  enum?: (string | number | boolean | null)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  additionalProperties?: boolean | FolioJsonSchema;
  [key: string]: unknown;
}

interface FolioToolDefinition {
  /**
   * 工具名：小写字母开头，只用小写字母、数字和 _，2–40 个字符。
   * 不能和页间自带的工具重名（list_files、read_document、fetch_url……），重名的会被跳过。
   */
  name: string;
  /** 告诉 AI 这个工具做什么、什么时候用。写清楚，AI 才会用对。 */
  description: string;
  /** 参数的 JSON Schema。不写就是不带参数。整个定义不超过 20000 个字符。 */
  parameters?: FolioJsonSchema;
}

/**
 * 工具被调用时执行。收到 AI 给的参数，返回字符串，或者能转成 JSON 的值（会转成 JSON 交给 AI）。
 * 抛出的错误会作为“出错”交给 AI，并写进运行日志。每次调用最多 90 秒，结果最多保留 60000 个字符。
 */
type FolioToolHandler<Input = any> = (input: Input) => unknown | Promise<unknown>;

interface FolioFetchResult {
  /** 最后实际读取的地址（跟随跳转之后）。 */
  url: string;
  status: number;
  ok: boolean;
  contentType: string;
  /** 响应正文，按 UTF-8 解码。网页、JSON、XML、RSS 都是原文。 */
  text: string;
  /** 超过 3 MB 时被截断。 */
  cut: boolean;
}

interface FolioFetchOptions {
  /** 请求头 Accept，例如 'application/json'。 */
  accept?: string;
}

interface Folio {
  /**
   * 插件设置的当前值（folio-plugin.json 的 settings，用户在插件卡片上改过的话是改过的值）。
   * 只读。
   */
  readonly settings: Readonly<Record<string, string>>;

  /**
   * 给 AI 增加一个工具。在脚本顶层调用；也可以先 `await folio.fetch(...)` 再注册，页间会等
   * 这些请求回来、注册不再变化（最多 8 秒）。更晚注册的工具这次运行用不上，运行日志里会提示。
   * 每个插件最多 12 个工具。
   */
  registerTool<Input = any>(
    definition: FolioToolDefinition,
    handler: FolioToolHandler<Input>,
  ): void;

  /**
   * 经页间读取一个网址：只能是 https，默认端口，不带账号密码，而且网站必须在
   * permissions.network 里（*.example.com 表示 example.com 和它的所有子域名）。跳转后的地址也要
   * 在名单里。只能 GET，不能读图片、音视频、PDF、压缩包这类文件。每次运行最多 80 次。
   * 不在名单里、连不上、超时（25 秒）都会抛出错误。
   */
  fetch(url: string, options?: FolioFetchOptions): Promise<FolioFetchResult>;

  /** 写一条运行日志（设置 › 插件 › 插件卡片 › 运行日志）。对象会转成 JSON。 */
  log(...args: unknown[]): void;
  /** 写一条“提示”级别的运行日志。 */
  warn(...args: unknown[]): void;
  /** 写一条“出错”级别的运行日志。 */
  error(...args: unknown[]): void;
}

declare const folio: Folio;
