// Writing down what the student says with a speech service they brought a key for, in the
// whiteboard's voice conversation (electron/hearing-worker.cjs): 通义百炼's Fun-ASR or 豆包's
// streaming recognition. One connection for each stretch of talk, so only talk is sent and
// charged. Each takes 16 kHz 16-bit mono samples and reports the whole text so far.
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const WebSocket = require('ws');
const { httpError, AiError } = require('./ai-providers.cjs');

// A connection that may be asked to send before it is open. `fail` is called once, when it
// ends without being closed here: with why, or with null when the service hung up.
function connect(url, headers, name, { open, message, fail }) {
  const ws = new WebSocket(url, { headers, handshakeTimeout: 10_000 });
  const waiting = [];
  let ended = false;
  const end = (error, status) => {
    if (ended) return;
    ended = true;
    fail(error, status);
  };
  ws.on('open', () => {
    open(ws);
    waiting.splice(0).forEach((data) => ws.send(data));
  });
  ws.on('message', (data, binary) => message(data, binary));
  ws.on('unexpected-response', (_, res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => {
      end(httpError(res.statusCode, body, name), res.statusCode);
      ws.terminate();
    });
  });
  ws.on('error', (e) =>
    end(new AiError(`无法连接到 ${name}，请检查网络（${e?.message || e}）`, { retry: true })),
  );
  ws.on('close', () => end(null));
  return {
    send(data) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
      else if (ws.readyState === WebSocket.CONNECTING) waiting.push(data);
    },
    close() {
      ended = true;
      ws.terminate();
    },
  };
}

// What finish() resolves with: the text once the service says it is done, or what it had
// said after a few seconds.
function ending(text) {
  let done = null;
  const promise = new Promise((resolve, reject) => (done = { resolve, reject }));
  let timer = null;
  return {
    promise,
    wait: (ms) => (timer = setTimeout(() => done.resolve(text()), ms)),
    resolve(value) {
      clearTimeout(timer);
      done.resolve(value);
    },
    reject(error) {
      clearTimeout(timer);
      done.reject(error);
    },
  };
}

// 通义百炼 Fun-ASR: JSON commands, the audio as binary frames, and each sentence's text so
// far in result-generated events.
function funAsr({ key, host, locale }, heard) {
  const task = crypto.randomUUID().replace(/-/g, '');
  const sentences = new Map();
  const text = () => [...sentences.values()].join('');
  const end = ending(text);
  let started = false;
  let finishing = false;
  let settled = false;
  const finish = () =>
    conn.send(
      JSON.stringify({
        header: { action: 'finish-task', task_id: task, streaming: 'duplex' },
        payload: { input: {} },
      }),
    );
  const audio = [];
  const conn = connect(
    `wss://${host || 'dashscope.aliyuncs.com'}/api-ws/v1/inference`,
    { Authorization: `Bearer ${key}` },
    '通义百炼',
    {
      open(ws) {
        ws.send(
          JSON.stringify({
            header: { action: 'run-task', task_id: task, streaming: 'duplex' },
            payload: {
              task_group: 'audio',
              task: 'asr',
              function: 'recognition',
              model: 'fun-asr-realtime',
              parameters: {
                format: 'pcm',
                sample_rate: 16000,
                language_hints: locale.startsWith('en') ? ['en'] : ['zh', 'en'],
              },
              input: {},
            },
          }),
        );
      },
      message(data, binary) {
        if (binary) return;
        let m;
        try {
          m = JSON.parse(String(data));
        } catch {
          return;
        }
        const event = m?.header?.event;
        if (event === 'task-started') {
          started = true;
          audio.splice(0).forEach((pcm) => conn.send(pcm));
          if (finishing) finish();
        } else if (event === 'result-generated') {
          const s = m.payload?.output?.sentence;
          if (!s || s.heartbeat || typeof s.text !== 'string') return;
          sentences.set(s.sentence_id ?? sentences.size, s.text);
          heard(text());
        } else if (event === 'task-finished') {
          settled = true;
          end.resolve(text());
          conn.close();
        } else if (event === 'task-failed') {
          settled = true;
          const code = String(m.header.error_code || '');
          const message = String(m.header.error_message || '').slice(0, 200);
          end.reject(
            /Arrearage|Overdue/i.test(code)
              ? new AiError(`账户欠费，请到阿里云百炼充值（${message}）`)
              : /AccessDenied|Unauthorized|InvalidApiKey/i.test(code)
                ? new AiError(`API Key 无效或没有开通语音识别（通义百炼：${message}）`, {
                    status: 401,
                  })
                : new AiError(`通义百炼识别失败（${code}：${message}）`),
          );
          conn.close();
        }
      },
      fail(error) {
        if (settled) return;
        settled = true;
        if (error) end.reject(error);
        else end.resolve(text());
      },
    },
  );
  return {
    feed(pcm) {
      if (started) conn.send(pcm);
      else audio.push(pcm);
    },
    finish() {
      if (!finishing) {
        finishing = true;
        if (started) finish();
        end.wait(5000);
      }
      return end.promise.finally(() => conn.close());
    },
    failed: end.promise.then(
      () => null,
      (e) => e,
    ),
    stop() {
      settled = true;
      end.resolve('');
      conn.close();
    },
  };
}

// 豆包 streaming recognition: a binary protocol of a 4-byte header, a size and a payload.
const doubaoFrame = (type, flags, json, payload) => {
  const head = Buffer.from([0x11, (type << 4) | flags, json ? 0x10 : 0x00, 0x00]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  return Buffer.concat([head, size, payload]);
};
// { last, text } of a reply, or { error } of an error frame.
function doubaoReply(b) {
  const at0 = (b[0] & 0x0f) * 4;
  const type = b[1] >> 4;
  const flags = b[1] & 0x0f;
  if (type === 0b1111) {
    const code = b.readUInt32BE(at0);
    const size = b.readUInt32BE(at0 + 4);
    return { error: { code, message: b.subarray(at0 + 8, at0 + 8 + size).toString('utf8') } };
  }
  if (type !== 0b1001) return {};
  let at = at0 + (flags & 0b0001 ? 4 : 0);
  const size = b.readUInt32BE(at);
  let payload = b.subarray(at + 4, at + 4 + size);
  if ((b[2] & 0x0f) === 1) payload = zlib.gunzipSync(payload);
  const value = payload.length ? JSON.parse(payload.toString('utf8')) : {};
  return { last: !!(flags & 0b0010), text: value?.result?.text };
}
// The 2.0 model where the key may use it, else 1.0; what worked is remembered.
const doubaoModels = ['volc.seedasr.sauc.duration', 'volc.bigasr.sauc.duration'];
let doubaoModel = 0;
function doubao({ key }, heard) {
  let said = '';
  const end = ending(() => said);
  let finishing = false;
  let settled = false;
  let conn = null;
  let tried = doubaoModel;
  // Kept until a connection is open, for the older model to be sent it all again.
  let audio = [];
  const open = () => {
    let opened = false;
    conn = connect(
      'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
      {
        'X-Api-Key': key,
        'X-Api-Resource-Id': doubaoModels[tried],
        'X-Api-Connect-Id': crypto.randomUUID(),
      },
      '豆包语音',
      {
        open(ws) {
          doubaoModel = tried;
          ws.send(
            doubaoFrame(
              0b0001,
              0,
              true,
              Buffer.from(
                JSON.stringify({
                  user: { uid: 'folio' },
                  audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
                  request: {
                    model_name: 'bigmodel',
                    enable_itn: true,
                    enable_punc: true,
                    result_type: 'full',
                  },
                }),
              ),
            ),
          );
          opened = true;
          audio = null;
        },
        message(data) {
          let reply;
          try {
            reply = doubaoReply(Buffer.from(data));
          } catch {
            return;
          }
          if (reply.error) {
            settled = true;
            const { code, message } = reply.error;
            end.reject(new AiError(`豆包语音识别失败（${code}：${message.slice(0, 200)}）`));
            conn.close();
            return;
          }
          if (typeof reply.text === 'string' && reply.text !== said) {
            said = reply.text;
            heard(said);
          }
          if (reply.last) {
            settled = true;
            end.resolve(said);
            conn.close();
          }
        },
        fail(error, status) {
          if (settled) return;
          // The key can't use this model: the older one, once.
          if (status === 403 && !opened && tried + 1 < doubaoModels.length) {
            tried++;
            return open();
          }
          settled = true;
          if (!error) return end.resolve(said);
          end.reject(
            status === 401 || status === 403
              ? new AiError(
                  `豆包语音不让用语音识别：请检查 API Key，并在豆包语音控制台开通「流式语音识别大模型」（${error.message}）`,
                  { status },
                )
              : error,
          );
        },
      },
    );
    audio.forEach((pcm) => conn.send(doubaoFrame(0b0010, 0, false, pcm)));
    if (finishing) conn.send(doubaoFrame(0b0010, 0b0010, false, Buffer.alloc(0)));
  };
  open();
  return {
    feed(pcm) {
      audio?.push(pcm);
      conn.send(doubaoFrame(0b0010, 0, false, pcm));
    },
    finish() {
      if (!finishing) {
        finishing = true;
        conn.send(doubaoFrame(0b0010, 0b0010, false, Buffer.alloc(0)));
        end.wait(5000);
      }
      return end.promise.finally(() => conn.close());
    },
    failed: end.promise.then(
      () => null,
      (e) => e,
    ),
    stop() {
      settled = true;
      end.resolve('');
      conn.close();
    },
  };
}

const services = { qwen: funAsr, doubao };
// Starts writing down a stretch of talk; `heard` gets the whole text each time it changes.
function cloudEars(service, options, heard) {
  const open = services[service];
  if (!open) throw new AiError('这个语音服务不能识别语音');
  return open(options, heard);
}

module.exports = { cloudEars, doubaoFrame, doubaoReply };
