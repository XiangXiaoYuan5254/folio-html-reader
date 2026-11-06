// 读 .zip：只为装插件用，够用就好。支持“不压缩”和 deflate 两种方式（访达、资源管理器、
// GitHub 的“Download ZIP”和 `folio-plugin pack` 打的包都是这两种）；不支持加密和 ZIP64
// （插件最多 2 MB，用不到）。每个文件读出来时检查大小和 CRC，超过上限就停。
const zlib = require('node:zlib');

class ZipError extends Error {}
const fail = (message) => {
  throw new ZipError(message);
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readZip(buf, { maxEntries = 4000 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) fail('这不是一个有效的 .zip 文件');
  // The end of the central directory: the last 22 bytes, or before a comment of up to 64 KB.
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) fail('这不是一个有效的 .zip 文件');
  const count = buf.readUInt16LE(end + 10);
  const size = buf.readUInt32LE(end + 12);
  const start = buf.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff)
    fail('不支持这种压缩包（ZIP64），请重新压缩');
  if (count > maxEntries) fail('压缩包里的文件太多');
  if (start + size > end) fail('压缩包已损坏');
  const entries = [];
  let at = start;
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) fail('压缩包已损坏');
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const packed = buf.readUInt32LE(at + 20);
    const unpacked = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf
      .subarray(at + 46, at + 46 + nameLength)
      .toString('utf8')
      .replace(/\\/g, '/');
    at += 46 + nameLength + extraLength + commentLength;
    const entry = {
      name,
      size: unpacked,
      isDir: name.endsWith('/'),
      // The file's contents, refused past `limit` bytes.
      read(limit = Infinity) {
        if (flags & 1) fail(`${name} 加了密码，页间打不开`);
        if (unpacked > limit) fail(`${name} 太大`);
        if (offset + 30 > buf.length || buf.readUInt32LE(offset) !== 0x04034b50)
          fail('压缩包已损坏');
        const from = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
        if (from + packed > buf.length) fail('压缩包已损坏');
        const data = buf.subarray(from, from + packed);
        let out;
        if (method === 0) out = Buffer.from(data);
        else if (method === 8) {
          try {
            out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, unpacked) });
          } catch {
            fail(`${name} 解压失败`);
          }
        } else fail(`${name} 用了页间不支持的压缩方式，请用访达或资源管理器重新压缩`);
        if (out.length !== unpacked || crc32(out) !== crc) fail(`${name} 已损坏`);
        return out;
      },
    };
    entries.push(entry);
  }
  return entries;
}

module.exports = { readZip, crc32, ZipError };
