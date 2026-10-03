// Runs after `npm install -g @openai/codex` on a machine without other Codex installs (the
// Windows workflow): 页间 finds that Codex and its app server answers. No account is signed in.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const codex = createRequire(import.meta.url)('../electron/ai-codex.cjs');
try {
  const status = await codex.status('0.0.0');
  console.log(status);
  assert.equal(status.found, true, 'Codex found');
  assert.equal(status.error, undefined, 'app server answers');
  assert.equal(status.account, null, 'no account on the runner');
  console.log('PASS: Codex installed with npm is found and its app server answers');
} finally {
  codex.stop();
}
