# AI 请求诊断

从包含此修复的版本启动应用后，每次 AI 请求会在应用数据目录的 `logs/ai.jsonl` 写入诊断。旧对话不会补写日志。

- macOS：`~/Library/Application Support/页间/logs/ai.jsonl`
- Windows：`%APPDATA%\页间\logs\ai.jsonl`
- 开发或测试设置了 `FOLIO_USER_DATA` 时：该目录下的 `logs/ai.jsonl`

每行是一个 JSON 对象，时间 `time` 使用 UTC。日志超过 2 MB 时轮换到 `ai.jsonl.1`，只保留一份旧日志。日志写入失败不会影响回答。

## 请求和尝试

`request-end` 是一次应用请求的最终结果，`request` 对应本机请求 ID，`service`、`model`、`version` 标明服务、模型和应用版本。`end` 为 `complete`、`error` 或 `aborted`。`complete` 表示协议调用完成；正文是否被长度上限截断还要看 `finishReason`。

OpenAI 兼容服务（智谱、DeepSeek、千问、本机模型等）的每次 HTTP 尝试另有一条 `stream-end`。自动重试、参数兼容回退、联网搜索的后续请求共用 `request`，每次 HTTP 尝试的 `attempt` 不同。并行重发的日志可能交错，按 `request` 关联即可。Claude、Codex 和 Kimi Code 记录请求的最终结果，不包含这套 SSE 细节。

| 字段                                            | 含义                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `status`                                        | HTTP 状态；建立连接前失败时没有此字段                                          |
| `serverRequestId`                               | 响应头 `x-request-id` 或 `request-id`，可用于向服务商查询                      |
| `responseId` / `responseRequestId`              | 服务端事件中的 `id` / `request_id`                                             |
| `finishReason`                                  | `stream-end` 中为服务原始结束原因；`request-end` 中长度上限统一为 `max_tokens` |
| `done`                                          | 是否读到了 `[DONE]`                                                            |
| `eof`                                           | 是否读到了响应流结束；收到 `[DONE]` 后会停止读取，所以正常回答也可能为 `false` |
| `maxTokens`                                     | 此次真正发送的 `max_tokens`；`null` 表示交给服务默认值决定                     |
| `effort`                                        | 此次发送的 `reasoning_effort`，没有设置时为空                                  |
| `textChars` / `reasoningChars`                  | 已接收的正文和思考字符数（JavaScript 字符串长度），不是 Token 数               |
| `inputTokens` / `outputTokens` / `cachedTokens` | 服务提供的 Token 统计；缺失表示未收到，不代表零消耗                            |
| `events` / `invalidEvents` / `bytes`            | SSE 数据事件数、无法解析的事件数和收到的字节数                                 |
| `elapsedMs`                                     | 此次尝试或请求的耗时                                                           |
| `code` / `errorName` / `providerCode`           | 本机错误码、错误类型、服务端流式错误码；不记录错误正文                         |

## 怎样判断回答截断

| 日志表现                                               | 判断与后续检查                                                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `finishReason: "length"`                               | 服务明确报告达到输出长度上限；结合 `maxTokens` 和用量检查设置                                                    |
| `end: "incomplete"`，`done: false`，`finishReason: ""` | 响应流已经结束，但没有完成信号；App 保留半截正文并显示中断。可能是服务或中间网络提前关流，仅此日志不能确定责任方 |
| `end: "stream_error"` / `"network_error"`              | 读取或连接失败，查看错误码与服务端请求标识                                                                       |
| `end: "idle_timeout"`                                  | 超过等待时间未收到流数据                                                                                         |
| `end: "invalid_data"`                                  | 有无法解析的数据事件；不能确认正文完整，App 提示重试                                                             |
| `end: "provider_error"`                                | 服务端流式错误，或服务明确返回 `network_error` 结束原因                                                          |
| `end: "http_error"`                                    | HTTP 请求失败，结合 `status` 排查                                                                                |
| `end: "fallback"`                                      | 服务拒绝可选参数，App 使用兼容参数继续请求；查看同一 `request` 的下一次尝试                                      |
| `end: "aborted"`                                       | 请求被取消，包括用户停止、应用关闭或并行重发中另一份请求先完成                                                   |
| `finishReason: "stop"` 且正文仍是半句话                | 服务声称已完成；用服务端请求标识核查生成结果。协议完成不能保证语义完整                                           |
| `done: true` 且 `finishReason: ""`                     | 服务只给了完成标记，App 为兼容这类接口接受回答，但无法得知具体结束原因                                           |

App 接受 `finish_reason` 或 `[DONE]` 任一明确完成信号。两者都缺失时不会再把回答标为已完成。已经显示正文后不会自动重发同一请求，避免重复回答；可以重试或在下一轮让模型接着写。

日志只包含列出的诊断元数据，不保存正文、思考内容、文档、工具参数、API Key、URL、完整响应头或原始 SSE 数据。向服务商反馈时，可提供异常时间、模型、状态码和服务端请求标识。
