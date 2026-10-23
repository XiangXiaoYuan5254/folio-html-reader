const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const vm = require('node:vm');

const source = buildSync({
  entryPoints: ['src/ai/board.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
}).outputFiles[0].text;
function setup(t) {
  const module = { exports: {} };
  let clockShift = 0;
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require,
    process,
    console,
    window: { addEventListener() {} },
    navigator: { platform: 'MacIntel', userAgent: '' },
    localStorage: {
      getItem() {
        return null;
      },
    },
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance: { now: () => performance.now() + clockShift },
  });
  const tutor = new module.exports.Tutor({ source: 'test.html' });
  t.after(() => tutor.dispose());
  const clips = new Map();
  const spoken = [];
  let fail = true;
  const speaker = {
    service: true,
    async prepare(id, text) {
      if (text === '第二句' && fail) throw Error('Edge TTS 连接中断');
      clips.set(id, text);
      return 1;
    },
    async say(id) {
      spoken.push(clips.get(id));
    },
    pause() {},
    resume() {},
    hush() {},
    speed() {},
  };
  tutor.setVoice('speak', speaker, 'edge');
  tutor.setSpeed(100);
  return {
    tutor,
    speaker,
    spoken,
    recover: () => {
      fail = false;
    },
    advance: (ms) => {
      clockShift += ms;
      tutor.wake();
    },
  };
}
async function waitFor(check) {
  const until = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > until) assert.fail('condition did not become true');
    await new Promise((r) => setTimeout(r, 5));
  }
}
function start(tutor) {
  for (const text of ['第一句', '第二句', '第三句']) tutor.push({ op: 'say', text }, `say ${text}`);
  return tutor.play(tutor.run);
}

test('a failed prefetched sentence holds captions and later audio; retry speaks that same sentence', async (t) => {
  const { tutor, spoken, recover } = setup(t);
  const playing = start(tutor);
  await waitFor(() => tutor.state.voiceError);
  assert.equal(tutor.state.paused, true);
  assert.match(tutor.state.voiceError, /连接中断/);
  assert.deepEqual(spoken, ['第一句']);
  assert.equal(tutor.state.transcript.length, 1);
  // Later audio was already prepared, but cannot overtake the failed sentence.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(tutor.state.transcript.length, 1);
  recover();
  tutor.resume();
  await playing;
  assert.deepEqual(spoken, ['第一句', '第二句', '第三句']);
  assert.deepEqual(
    Array.from(tutor.state.transcript, (l) => l.text),
    spoken,
  );
  assert.equal(tutor.state.voiceError, undefined);
  assert.equal(tutor.state.phase, 'idle');
});

test('interrupting a failed sentence cancels its hold and never plays later sentences', async (t) => {
  const { tutor, spoken } = setup(t);
  const playing = start(tutor);
  await waitFor(() => tutor.state.voiceError);
  tutor.interrupt();
  await playing;
  assert.deepEqual(spoken, ['第一句']);
  assert.equal(tutor.state.voiceError, undefined);
});

test('choosing another voice retries the held sentence and keeps its position', async (t) => {
  const { tutor, speaker, spoken, recover } = setup(t);
  const playing = start(tutor);
  await waitFor(() => tutor.state.voiceError);
  recover();
  tutor.setVoice('speak', { ...speaker }, 'another-voice');
  await playing;
  assert.deepEqual(spoken, ['第一句', '第二句', '第三句']);
});

test('explicitly turning voice off releases a failed sentence to captions', async (t) => {
  const { tutor, spoken } = setup(t);
  const playing = start(tutor);
  await waitFor(() => tutor.state.voiceError);
  tutor.setVoice('off', null);
  await playing;
  assert.deepEqual(spoken, ['第一句']);
  assert.deepEqual(
    Array.from(tutor.state.transcript, (l) => l.text),
    ['第一句', '第二句', '第三句'],
  );
});

test('a queued service retry is not abandoned by the former 60-second board timeout', async (t) => {
  const { tutor, advance } = setup(t);
  let finish;
  let settled = false;
  const pending = tutor
    .ready(tutor.run, {
      id: 'waiting',
      voice: tutor.voiced,
      ms: new Promise((r) => {
        finish = r;
      }),
    })
    .then((ms) => {
      settled = true;
      return ms;
    });
  advance(70_000);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false);
  assert.equal(tutor.state.voiceWait, true);
  finish(1200);
  assert.equal(await pending, 1200);
  assert.equal(tutor.state.voiceWait, false);
});

function queueLessonWithWriting(tutor) {
  for (const [index, text] of ['第一句', '第二句', '第三句'].entries()) {
    tutor.push({ op: 'say', text }, `say ${text}`);
    tutor.push(
      { op: 'text', id: `b${index + 1}`, text: `${text}的板书` },
      `text b${index + 1} | ${text}的板书`,
    );
    if (index === 1) tutor.push({ op: 'underline', target: 'b2', color: 'red' }, 'underline b2');
  }
  return tutor.play(tutor.run);
}

test('writing and highlighting after a failed sentence wait and resume in the original order', async (t) => {
  const { tutor, spoken, recover } = setup(t);
  const playing = queueLessonWithWriting(tutor);
  await waitFor(() => tutor.state.voiceError);
  assert.deepEqual(spoken, ['第一句']);
  assert.deepEqual(
    Array.from(tutor.state.blocks, (b) => b.id),
    ['b1'],
  );
  assert.equal(tutor.state.inks.length, 0);
  recover();
  tutor.resume();
  await playing;
  assert.deepEqual(spoken, ['第一句', '第二句', '第三句']);
  assert.deepEqual(
    Array.from(tutor.state.blocks, (b) => b.id),
    ['b1', 'b2', 'b3'],
  );
  assert.equal(tutor.state.inks.length, 1);
  assert.equal(tutor.state.inks[0].target, 'b2');
});

test('writing also waits while synthesis is still retrying, before a final error is shown', async (t) => {
  const { tutor, speaker, spoken, recover } = setup(t);
  recover();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const prepare = speaker.prepare;
  speaker.prepare = async (id, text) => {
    if (text === '第二句') await pending;
    return prepare(id, text);
  };
  const playing = queueLessonWithWriting(tutor);
  await waitFor(() => tutor.state.blocks.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(tutor.state.voiceError, undefined);
  assert.equal(tutor.state.blocks.length, 1);
  assert.equal(tutor.state.inks.length, 0);
  assert.equal(tutor.state.transcript.length, 1);
  assert.deepEqual(spoken, ['第一句']);
  release();
  await playing;
  assert.deepEqual(spoken, ['第一句', '第二句', '第三句']);
  assert.deepEqual(
    Array.from(tutor.state.blocks, (b) => b.id),
    ['b1', 'b2', 'b3'],
  );
  assert.equal(tutor.state.inks[0].target, 'b2');
});
