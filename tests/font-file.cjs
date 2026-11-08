// Font files for tests: just the header and a `name` table, which is all Folio reads.
// A font's `name` table from records of { id, value } on Windows (UTF-16), or raw bytes
// with a Mac platform/encoding/language.
function nameTable(records) {
  const encoded = records.map((r) =>
    r.bytes ? r.bytes : Buffer.from(r.value, 'utf16le').swap16(),
  );
  const head = Buffer.alloc(6 + 12 * records.length);
  head.writeUInt16BE(records.length, 2);
  head.writeUInt16BE(head.length, 4);
  let at = 0;
  records.forEach((r, i) => {
    const o = 6 + 12 * i;
    head.writeUInt16BE(r.platform ?? 3, o);
    head.writeUInt16BE(r.encoding ?? 1, o + 2);
    head.writeUInt16BE(r.lang ?? 0x409, o + 4);
    head.writeUInt16BE(r.id, o + 6);
    head.writeUInt16BE(encoded[i].length, o + 8);
    head.writeUInt16BE(at, o + 10);
    at += encoded[i].length;
  });
  return Buffer.concat([head, ...encoded]);
}
// One face with a `name` table, starting at `start` in its file.
function face(records, start = 0) {
  const name = nameTable(records);
  const head = Buffer.alloc(12 + 16);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt16BE(1, 4);
  head.write('name', 12, 'latin1');
  head.writeUInt32BE(start + head.length, 12 + 8);
  head.writeUInt32BE(name.length, 12 + 12);
  return Buffer.concat([head, name]);
}
function collection(faces) {
  const head = Buffer.alloc(12 + 4 * faces.length);
  head.write('ttcf', 0, 'latin1');
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt32BE(faces.length, 8);
  const parts = [head];
  let at = head.length;
  faces.forEach((records, i) => {
    head.writeUInt32BE(at, 12 + 4 * i);
    const bytes = face(records, at);
    parts.push(bytes);
    at += bytes.length;
  });
  return Buffer.concat(parts);
}
module.exports = { face, collection };
