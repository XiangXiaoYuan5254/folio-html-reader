// Edge's online read-aloud protocol, following node-edge-tts (MIT; see
// licenses/node-edge-tts.txt). No Python, browser installation or user key is needed.
// This unofficial service can change; keep its protocol here, outside the other voices.
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { AiError } = require('./ai-providers.cjs');

const clientToken = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const version = '143.0.3650.75';
const format = 'audio-24khz-48kbitrate-mono-mp3';
function failure(message, details = {}) {
  return Object.assign(new AiError(message, { retry: true }), details);
}
const escape = (text) =>
  text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
    );

function connectionUrl() {
  const seconds = BigInt(Math.floor(Date.now() / 1000)) + 11644473600n;
  const ticks = (seconds - (seconds % 300n)) * 10000000n;
  const token = crypto
    .createHash('sha256')
    .update(`${ticks}${clientToken}`)
    .digest('hex')
    .toUpperCase();
  const url = new URL('wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1');
  url.searchParams.set('Ocp-Apim-Subscription-Key', clientToken);
  url.searchParams.set('Sec-MS-GEC', token);
  url.searchParams.set('Sec-MS-GEC-Version', `1-${version}`);
  url.searchParams.set('ConnectionId', crypto.randomBytes(16).toString('hex'));
  return url;
}

// Socket is injectable so failures and cancellation can be checked without the network.
function readAudio({ text, voice, signal, Socket = WebSocket }) {
  if (!/^zh-(?:CN|HK|TW)-(?:[a-z]+-)?[A-Za-z]+Neural$/.test(voice))
    return Promise.reject(new AiError('Edge TTS 没有这个声音'));
  if (!text.trim()) return Promise.reject(new AiError('没有需要朗读的文字'));
  if (signal?.aborted) return Promise.reject(new AiError('Edge TTS 合成已取消或超时'));
  return new Promise((resolve, reject) => {
    const ws = new Socket(connectionUrl(), {
      handshakeTimeout: 10_000,
      maxPayload: 1024 * 1024,
      headers: {
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    });
    const pieces = [];
    let bytes = 0;
    let finished = false;
    let stage = 'connect';
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) ws.terminate();
      else ws.close();
      if (error) reject(Object.assign(error, { stage, bytes }));
      else if (!bytes)
        reject(
          failure('Edge TTS 没有返回声音，请稍后重试或换一个声音', {
            stage,
            bytes,
            code: 'EMPTY_AUDIO',
          }),
        );
      else resolve(Buffer.concat(pieces));
    };
    const abort = () =>
      finish(
        failure('Edge TTS 合成已取消或超时，请稍后重试', {
          code: signal?.reason?.code || 'ABORTED',
        }),
      );
    const timer = setTimeout(
      () => finish(failure('Edge TTS 合成超时，请稍后重试', { code: 'ETIMEDOUT' })),
      30_000,
    );
    signal?.addEventListener('abort', abort, { once: true });
    ws.on('error', (error) =>
      finish(
        failure('无法连接到 Edge TTS，请检查网络或换一个语音服务', {
          code: error.code || (/timed out/i.test(error.message) ? 'ETIMEDOUT' : 'NETWORK_ERROR'),
        }),
      ),
    );
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      finish(
        failure(`Edge TTS 暂时不可用（${response.statusCode}），请稍后重试或换一个语音服务`, {
          status: response.statusCode,
          code: 'HTTP_ERROR',
          retry: [408, 429].includes(response.statusCode) || response.statusCode >= 500,
          retryAfterMs: retryAfter(response.headers?.['retry-after']),
        }),
      );
    });
    ws.on('close', (closeCode) =>
      finish(
        failure('Edge TTS 连接中断，声音没有生成完整，请重试', {
          code: 'CONNECTION_CLOSED',
          closeCode,
        }),
      ),
    );
    ws.on('open', () => {
      if (finished) return;
      stage = 'receive';
      const send = (data) =>
        ws.send(data, (error) => {
          if (error)
            finish(failure('Edge TTS 发送失败，请重试', { code: error.code || 'SEND_ERROR' }));
        });
      send(
        'Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: {
                    sentenceBoundaryEnabled: 'false',
                    wordBoundaryEnabled: 'false',
                  },
                  outputFormat: format,
                },
              },
            },
          }),
      );
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><voice name="${voice}"><prosody rate="+0%" pitch="+0Hz" volume="+0%">${escape(text)}</prosody></voice></speak>`;
      send(
        `X-RequestId:${crypto.randomBytes(16).toString('hex')}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`,
      );
    });
    ws.on('message', (data, binary) => {
      if (finished) return;
      const buffer = Buffer.from(data);
      if (!binary) {
        if (/(?:^|\r\n)Path:turn.end(?:\r\n|$)/.test(buffer.toString())) finish();
        return;
      }
      if (buffer.length < 2 || buffer.readUInt16BE(0) + 2 > buffer.length)
        return finish(
          failure('Edge TTS 返回的声音数据不完整，请重试', { code: 'INCOMPLETE_AUDIO' }),
        );
      const start = buffer.readUInt16BE(0) + 2;
      const headers = buffer.toString('utf8', 2, start);
      if (!/(?:^|\r\n)Path:audio(?:\r\n|$)/.test(headers))
        return finish(failure('Edge TTS 返回的声音格式不支持', { code: 'INVALID_FORMAT' }));
      const chunk = buffer.subarray(start);
      if (!chunk.length) return;
      if (!/(?:^|\r\n)Content-Type:audio\/mpeg(?:\r\n|$)/.test(headers))
        return finish(failure('Edge TTS 返回的声音格式不支持', { code: 'INVALID_FORMAT' }));
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024)
        return finish(new AiError('Edge TTS 返回的声音太长，请分段朗读'));
      pieces.push(chunk);
    });
  });
}

async function decodeAudio(audio) {
  const { MPEGDecoder } = await import('mpg123-decoder');
  const decoder = new MPEGDecoder();
  try {
    await decoder.ready;
    const { channelData, sampleRate, samplesDecoded, errors } = decoder.decode(audio);
    if (!samplesDecoded || errors.length || !sampleRate)
      throw failure('Edge TTS 返回的声音无法播放，请重试', {
        stage: 'decode',
        code: 'DECODE_ERROR',
      });
    const pcm = Buffer.alloc(samplesDecoded * 2);
    for (let i = 0; i < samplesDecoded; i++) {
      const value = Math.max(-1, Math.min(1, channelData[0][i]));
      pcm.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), i * 2);
    }
    return { pcm, rate: sampleRate };
  } finally {
    decoder.free();
  }
}

function retryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  return (
    Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()) || 0
  );
}

async function synthesize(options) {
  const audio = await readAudio(options);
  if (options.signal?.aborted) throw new AiError('Edge TTS 合成已取消或超时');
  return decodeAudio(audio);
}

module.exports = { synthesize, readAudio, decodeAudio };
