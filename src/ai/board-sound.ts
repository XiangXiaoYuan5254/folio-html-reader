import { invoke } from '../api';

// The teacher's sentences said in a speech service's voice, or recorded from a ChatGPT voice
// with what it said in its own words, kept with the board as Ogg Opus (about 3 KB a second),
// so the lesson can be watched again without asking for the voice again. A sentence is known
// by its words in the script.

export async function soundKey(text: string) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// 16-bit mono samples, compressed with the page's own Opus encoder. `said` goes in the
// file's tags.
async function opus(pcm: Uint8Array, rate: number, said?: string) {
  // Copied, as the bytes may not start on an even offset.
  const samples = new Int16Array(pcm.byteLength >> 1);
  new Uint8Array(samples.buffer).set(pcm.subarray(0, samples.length * 2));
  const packets: { data: Uint8Array; samples: number }[] = [];
  let head: Uint8Array | null = null;
  let failed: unknown = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      // Ogg counts in 48 kHz samples whatever the rate.
      packets.push({ data, samples: Math.round(((chunk.duration ?? 0) * 48_000) / 1e6) });
      const d = meta?.decoderConfig?.description;
      if (d && !head)
        head = ArrayBuffer.isView(d)
          ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice()
          : new Uint8Array(d).slice();
    },
    error: (e) => (failed = e),
  });
  encoder.configure({
    codec: 'opus',
    sampleRate: rate,
    numberOfChannels: 1,
    bitrate: 24_000,
    // Longer frames: fewer packets, so less of the file is Ogg's own bookkeeping.
    opus: { frameDuration: 60_000 },
  } as AudioEncoderConfig);
  encoder.encode(
    new AudioData({
      format: 's16',
      sampleRate: rate,
      numberOfFrames: samples.length,
      numberOfChannels: 1,
      timestamp: 0,
      data: samples,
    }),
  );
  await encoder.flush();
  encoder.close();
  if (failed) throw failed;
  const opusHead: Uint8Array = head || defaultHead(rate);
  const preSkip = opusHead[10] | (opusHead[11] << 8);
  const end = preSkip + Math.round((samples.length * 48_000) / rate);
  return ogg(opusHead, packets, preSkip, end, said === undefined ? [] : [`SAID=${said}`]);
}
function defaultHead(rate: number) {
  const h = new Uint8Array(19);
  const v = new DataView(h.buffer);
  h.set(new TextEncoder().encode('OpusHead'));
  h[8] = 1;
  h[9] = 1;
  v.setUint16(10, 312, true);
  v.setUint32(12, rate, true);
  return h;
}

// Ogg pages: the Opus head, empty tags, then the packets about a second to a page. The last
// page's position says where the sound ends, which drops the padding the encoder added.
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function ogg(
  head: Uint8Array,
  packets: { data: Uint8Array; samples: number }[],
  preSkip: number,
  end: number,
  comments: string[],
) {
  const serial = (Math.random() * 0xffffffff) >>> 0;
  const pages: Uint8Array[] = [];
  const page = (parts: Uint8Array[], granule: number, flags: number) => {
    const lacing: number[] = [];
    for (const p of parts) {
      for (let n = p.length; n >= 255; n -= 255) lacing.push(255);
      lacing.push(p.length % 255);
    }
    const size = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(27 + lacing.length + size);
    const v = new DataView(out.buffer);
    out.set([0x4f, 0x67, 0x67, 0x53]);
    out[5] = flags;
    v.setUint32(6, granule % 0x100000000, true);
    v.setUint32(10, Math.floor(granule / 0x100000000), true);
    v.setUint32(14, serial, true);
    v.setUint32(18, pages.length, true);
    out[26] = lacing.length;
    out.set(lacing, 27);
    let at = 27 + lacing.length;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    let crc = 0;
    for (const b of out) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ b) & 0xff]) >>> 0;
    v.setUint32(22, crc, true);
    pages.push(out);
  };
  const enc = new TextEncoder();
  const fields = [enc.encode('Folio'), ...comments.map((c) => enc.encode(c))];
  const tags = new Uint8Array(8 + 4 + fields.reduce((n, f) => n + 4 + f.length, 0));
  const t = new DataView(tags.buffer);
  tags.set(enc.encode('OpusTags'));
  let at = 8;
  fields.forEach((f, i) => {
    t.setUint32(at, f.length, true);
    tags.set(f, at + 4);
    at += 4 + f.length;
    // The number of comments, after the vendor.
    if (i === 0) {
      t.setUint32(at, comments.length, true);
      at += 4;
    }
  });
  page([head], 0, 2);
  page([tags], 0, 0);
  let granule = preSkip;
  let parts: Uint8Array[] = [];
  let segments = 0;
  packets.forEach((p, i) => {
    parts.push(p.data);
    segments += Math.floor(p.data.length / 255) + 1;
    granule += p.samples;
    const last = i === packets.length - 1;
    if (last || segments > 200 || parts.length >= 16) {
      page(parts, last ? Math.min(granule, end) : granule, last ? 4 : 0);
      parts = [];
      segments = 0;
    }
  });
  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of pages) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
// What was said, from the file's tags; empty when nothing was kept there.
function saidIn(file: Uint8Array) {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const tags = file.findIndex(
    (b, i) => b === 0x4f && new TextDecoder().decode(file.subarray(i, i + 8)) === 'OpusTags',
  );
  if (tags < 0) return '';
  let at = tags + 8;
  at += 4 + v.getUint32(at, true);
  const count = v.getUint32(at, true);
  at += 4;
  for (let i = 0; i < count; i++) {
    const n = v.getUint32(at, true);
    const field = new TextDecoder().decode(file.subarray(at + 4, at + 4 + n));
    if (field.startsWith('SAID=')) return field.slice(5);
    at += 4 + n;
  }
  return '';
}
// How long an Ogg Opus file plays, in ms: its last page's position less the pre-skip.
function length(file: Uint8Array) {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const preSkip = v.getUint16(28 + 10, true);
  for (let i = file.length - 27; i >= 0; i--)
    if (file[i] === 0x4f && file[i + 1] === 0x67 && file[i + 2] === 0x67 && file[i + 3] === 0x53) {
      const granule = v.getUint32(i + 6, true) + v.getUint32(i + 10, true) * 0x100000000;
      return Math.max(0, ((granule - preSkip) / 48_000) * 1000);
    }
  return 0;
}

export async function keepSound(
  board: string,
  text: string,
  pcm: Uint8Array,
  rate: number,
  said?: string,
) {
  const [key, data] = await Promise.all([soundKey(text), opus(pcm, rate, said)]);
  await invoke('save-board-sound', { id: board, key, data });
}
async function kept(board: string, text: string) {
  const data = await invoke<Uint8Array | null>('board-sound', {
    id: board,
    key: await soundKey(text),
  });
  return data?.length ? data : null;
}
// How long a kept sentence is and what was said, for the replay's progress bar.
export async function soundInfo(board: string, text: string) {
  const data = await kept(board, text);
  return data && { ms: length(data), said: saidIn(data) };
}
// A kept sentence, to play in the page: null when it wasn't kept (said in a system voice, or
// cleaned away).
export async function loadSound(board: string, text: string) {
  const data = await kept(board, text);
  if (!data) return null;
  return {
    url: URL.createObjectURL(new Blob([data as BlobPart], { type: 'audio/ogg' })),
    ms: length(data),
    said: saidIn(data),
  };
}
