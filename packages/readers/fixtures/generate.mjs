// Original synthetic files used by the manual reader smoke-test harness.
import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { zipSync } from 'fflate';

const root = path.dirname(new URL(import.meta.url).pathname);
function crc32(bytes) { let c = -1; for (const byte of bytes) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ -1) >>> 0; }
function chunk(type, data) { const label = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([label, data]))); return Buffer.concat([length, label, data, crc]); }
function png(red, green, blue) {
  const w = 320, h = 480, pixels = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const index = y * (w * 3 + 1) + x * 3 + 1; const ink = x > 40 && x < 280 && y > 90 && y < 390 && y % 40 < 3; pixels[index] = ink ? 40 : red; pixels[index + 1] = ink ? 40 : green; pixels[index + 2] = ink ? 40 : blue; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const images = { 'page1.png': png(245,229,195), 'page2.png': png(193,211,219), 'page3.png': png(188,206,179) };
await fs.writeFile(path.join(root, 'sample.cbz'), zipSync(images));
for (const [name, bytes] of Object.entries(images)) await fs.writeFile(path.join(root, name), bytes);
// Create sample.cb7 from these PNGs with 7-Zip; see README.md.
const text = ['Avid PDF fixture: a remembered sentence.', 'Second page: anchors survive moving backward.'];
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'];
text.forEach((line, index) => { const stream = `BT /F1 20 Tf 55 700 Td (${line}) Tj ET`; objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${index * 2 + 4} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`); });
objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
let pdf = '%PDF-1.4\n'; const offsets = [0]; objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
await fs.writeFile(path.join(root, 'sample.pdf'), pdf);

// Minimal uncompressed RAR4 fixture: original images, standard file headers.
function rarHeader(type, flags, data = Buffer.alloc(0)) {
  const head = Buffer.alloc(7); head[2] = type; head.writeUInt16LE(flags, 3); head.writeUInt16LE(7 + data.length, 5);
  const bytes = Buffer.concat([head, data]); bytes.writeUInt16LE(crc32(bytes.subarray(2)) & 0xffff); return bytes;
}
const rarParts = [Buffer.from([82,97,114,33,26,7,0]), rarHeader(0x73, 0, Buffer.alloc(6))];
for (const [name, bytes] of Object.entries(images)) {
  const fileName = Buffer.from(name); const fields = Buffer.alloc(25 + fileName.length);
  fields.writeUInt32LE(bytes.length, 0); fields.writeUInt32LE(bytes.length, 4); fields[8] = 2;
  fields.writeUInt32LE(crc32(bytes), 9); fields[17] = 20; fields[18] = 0x30; fields.writeUInt16LE(fileName.length, 19); fields.writeUInt32LE(0x20, 21); fileName.copy(fields, 25);
  rarParts.push(rarHeader(0x74, 0x8000, fields), bytes);
}
rarParts.push(rarHeader(0x7b, 0));
await fs.writeFile(path.join(root, 'sample.cbr'), Buffer.concat(rarParts));
