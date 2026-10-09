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
// Two original passages, independently narrated with the installed eSpeak voice.
// Existing SMIL alignment is explicit. This is a decoder fixture, not a synthesized alignment feature.
try {
  const audio1 = await fs.readFile(path.join(root, 'audio1.wav'));
  const audio2 = await fs.readFile(path.join(root, 'audio2.wav'));
  const wavSeconds = buffer => { let offset = 12; while (offset + 8 < buffer.length) { const size = buffer.readUInt32LE(offset + 4); if (buffer.toString('ascii', offset, offset + 4) === 'data') return size / buffer.readUInt32LE(28); offset += 8 + size + (size % 2); } throw new Error('Missing WAV data'); };
  const entries = {
    mimetype: Buffer.from('application/epub+zip'),
    'META-INF/container.xml': Buffer.from('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'book.opf': Buffer.from('<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">avid-aligned-fixture</dc:identifier><dc:title>Avid aligned narration fixture</dc:title><dc:creator>Avid</dc:creator><dc:language>en</dc:language><meta property="media:active-class">avid-narration-active</meta></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml" media-overlay="s"/><item id="s" href="timing.smil" media-type="application/smil+xml"/><item id="a1" href="audio1.wav" media-type="audio/wav"/><item id="a2" href="audio2.wav" media-type="audio/wav"/></manifest><spine><itemref idref="c"/></spine></package>'),
    'chapter.xhtml': Buffer.from('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>A quiet hour</title></head><body><h1>A quiet hour</h1><p id="p1">The reading room was quiet. A book lay open on the table.</p><p id="p2">She turned the page and listened to the rain outside.</p><p>Original Avid test content with synthetic eSpeak narration and explicit SMIL timing.</p></body></html>'),
    'timing.smil': Buffer.from(`<smil xmlns="http://www.w3.org/ns/SMIL"><body><seq><par><text src="chapter.xhtml#p1"/><audio src="audio1.wav" clipBegin="0s" clipEnd="${wavSeconds(audio1)}s"/></par><par><text src="chapter.xhtml#p2"/><audio src="audio2.wav" clipBegin="0s" clipEnd="${wavSeconds(audio2)}s"/></par></seq></body></smil>`),
    'audio1.wav': audio1, 'audio2.wav': audio2,
  };
  await fs.writeFile(path.join(root, 'sample-aligned.epub'), zipSync(entries));
} catch (error) { if (error.code !== 'ENOENT') throw error; }
// Original, uncompressed MOBI6/PalmDB publication with real byte-offset navigation.
let mobiHtml = '<html><head><title>A Quiet Hour - Avid MOBI fixture</title><guide><reference type="toc" title="Contents" filepos="0000000000"/><reference type="text" title="Start reading" filepos="1111111111"/></guide></head><body><h1>Contents</h1><p><a filepos="1111111111">A place to begin</a></p><p><a filepos="2222222222">The long way home</a></p><mbp:pagebreak/><h1>A place to begin</h1><p>The reading room was quiet except for the small clock above the door. Outside, the evening gathered between the trees.</p><p>A book lay open on the table. Each page held a small discovery, waiting to be noticed.</p><mbp:pagebreak/><h1>The long way home</h1><p>Mara chose the path beside the river. It was longer, but the river had always made good company.</p><p>She carried a notebook with no particular purpose. Sometimes she wrote a sentence she wanted to remember.</p><p>Original Avid test content in a DRM-free MOBI6 file.</p></body></html>';
const offsetsByPlaceholder = [ ['0000000000', '<h1>Contents'], ['1111111111', '<h1>A place'], ['2222222222', '<h1>The long'] ];
const locations = offsetsByPlaceholder.map(([placeholder, marker]) => [placeholder, Buffer.byteLength(mobiHtml.slice(0, mobiHtml.indexOf(marker)))]);
for (const [placeholder, offset] of locations) mobiHtml = mobiHtml.replaceAll(placeholder, String(offset).padStart(10, '0'));
const mobiText = Buffer.from(mobiHtml);
const mobiTitle = Buffer.from('A Quiet Hour - Avid MOBI fixture');
const mobiRecord = Buffer.alloc(248 + mobiTitle.length);
mobiRecord.writeUInt16BE(1, 0); // Uncompressed PalmDOC.
mobiRecord.writeUInt32BE(mobiText.length, 4); mobiRecord.writeUInt16BE(1, 8); mobiRecord.writeUInt16BE(4096, 10);
mobiRecord.write('MOBI', 16); mobiRecord.writeUInt32BE(232, 20); mobiRecord.writeUInt32BE(2, 24); mobiRecord.writeUInt32BE(65001, 28);
mobiRecord.writeUInt32BE(123456, 32); mobiRecord.writeUInt32BE(6, 36); mobiRecord.writeUInt32BE(248, 84); mobiRecord.writeUInt32BE(mobiTitle.length, 88);
mobiRecord[95] = 9; mobiRecord.writeUInt32BE(2, 108); mobiRecord.writeUInt32BE(0xffffffff, 244); mobiTitle.copy(mobiRecord, 248);
const pdb = Buffer.alloc(96); pdb.write('Avid MOBI fixture', 0); pdb.write('BOOKMOBI', 60); pdb.writeUInt16BE(2, 76);
pdb.writeUInt32BE(96, 78); pdb.writeUInt32BE(96 + mobiRecord.length, 86);
await fs.writeFile(path.join(root, 'sample.mobi'), Buffer.concat([pdb, mobiRecord, mobiText]));
