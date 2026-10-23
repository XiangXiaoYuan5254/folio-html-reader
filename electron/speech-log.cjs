const fs = require('node:fs/promises');
const path = require('node:path');

// A bounded, local diagnostic log. Only explicit fields are kept: never request bodies,
// API keys, audio, or the text being read. textHash matches the board's sound filenames.
function createSpeechLog(file, maxBytes = 2 * 1024 * 1024) {
  let pending = Promise.resolve();
  return (entry) => {
    const record = { time: new Date().toISOString() };
    for (const field of [
      'event',
      'request',
      'board',
      'sentence',
      'textHash',
      'spokenHash',
      'chars',
      'service',
      'voice',
      'attempt',
      'elapsedMs',
      'retryMs',
      'stage',
      'status',
      'code',
      'closeCode',
      'bytes',
      'durationMs',
      'message',
    ]) {
      const value = entry[field];
      if (typeof value === 'string') record[field] = value.slice(0, 500);
      else if (typeof value === 'number' && Number.isFinite(value)) record[field] = value;
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
        // Logging must never turn successful speech into a failed request.
        console.error('Speech diagnostic log could not be written:', error.code || error.name);
      });
    return pending;
  };
}

module.exports = { createSpeechLog };
