const fs = require('node:fs/promises');
const path = require('node:path');

// Metadata only. In particular, raw events, error messages, URLs, headers, tool arguments,
// prompts and answers must not be added here: any of them can contain private content.
const fields = [
  'event',
  'request',
  'attempt',
  'service',
  'model',
  'protocol',
  'version',
  'end',
  'finishReason',
  'done',
  'eof',
  'events',
  'invalidEvents',
  'bytes',
  'status',
  'serverRequestId',
  'responseId',
  'responseRequestId',
  'contentType',
  'errorName',
  'code',
  'providerCode',
  'elapsedMs',
  'maxTokens',
  'effort',
  'textChars',
  'reasoningChars',
  'inputTokens',
  'outputTokens',
  'cachedTokens',
];

function createAiLog(file, maxBytes = 2 * 1024 * 1024) {
  let pending = Promise.resolve();
  return (entry) => {
    const record = { time: new Date().toISOString() };
    for (const field of fields) {
      const value = entry[field];
      if (typeof value === 'string') record[field] = value.slice(0, 200);
      else if (typeof value === 'number' && Number.isFinite(value)) record[field] = value;
      else if (typeof value === 'boolean' || value === null) record[field] = value;
    }
    pending = pending
      .then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const size = await fs.stat(file).then(
          (s) => s.size,
          () => 0,
        );
        if (size >= maxBytes) {
          await fs.rm(`${file}.1`, { force: true });
          await fs.rename(file, `${file}.1`);
        }
        await fs.appendFile(file, JSON.stringify(record) + '\n', { mode: 0o600 });
      })
      .catch((error) => {
        // Diagnostics must never turn a successful answer into a failed request.
        console.error('AI diagnostic log could not be written:', error.code || error.name);
      });
    return pending;
  };
}

module.exports = { createAiLog };
