/** Local, reproducible QA media generator. No network requests. */
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
const here=dirname(fileURLToPath(import.meta.url));
const directory=resolve(process.argv.slice(2).find(value=>!value.startsWith('--'))??'/tmp/avid-real-speech/LibriSpeech/dev-clean-2/174/168635');
const recording='174-168635-0002';
const transcript=readFileSync(resolve(directory,'174-168635.trans.txt'),'utf8').split('\n').find(line=>line.startsWith(recording+' '))?.slice(recording.length+1);
const paragraphs=["His sister and his sister's children had left him only a vague and far-off memory, which had finally almost completely vanished.","He had made every effort to find them and, not having been able to find them, he had forgotten them."];
const normalize=text=>text.toUpperCase().replace(/[^A-Z0-9']/g,' ').replace(/\s+/g,' ').trim();
if(!transcript||normalize(paragraphs.join(' '))!==normalize(transcript))throw new Error('The selected corpus transcript changed.');
if(!process.argv.includes('--existing-wav'))execFileSync('ffmpeg',['-y','-v','error','-i',resolve(directory,recording+'.flac'),'-map_metadata','-1','-ac','1','-ar','16000','-c:a','pcm_s16le','-fflags','+bitexact',resolve(here,'preparation-speech.wav')]);
const wav=readFileSync(resolve(here,'preparation-speech.wav'));
let offset=12,samples=0,rate=0;
while(offset+8<=wav.length){const size=wav.readUInt32LE(offset+4),kind=wav.toString('ascii',offset,offset+4);if(kind==='fmt ')rate=wav.readUInt32LE(offset+16);if(kind==='data')samples=size;offset+=8+size+(size%2);}
if(!samples||!rate)throw new Error('Expected PCM WAV data and byte rate.');
const durationMs=samples/rate*1000,sha=createHash('sha256').update(wav).digest('hex');
const escape=text=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const files={
  mimetype:strToU8('application/epub+zip'),
  'META-INF/container.xml':strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
  'book.opf':strToU8('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">avid-librispeech-174-168635-0002-v1</dc:identifier><dc:title>Les Misérables · real speech preparation check</dc:title><dc:creator>Victor Hugo / LibriSpeech</dc:creator><dc:language>en</dc:language><dc:rights>LibriSpeech excerpt: CC BY 4.0, https://www.openslr.org/31/; punctuation and paragraph formatting added for Avid QA.</dc:rights><meta property="dcterms:modified">2026-10-18T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>'),
  'nav.xhtml':strToU8('<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">The remembered family</a></li></ol></nav></body></html>'),
  'chapter.xhtml':strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>The remembered family</title><style>body { font: 18px/1.6 Georgia, serif; } p { margin: 1em 0; }</style></head><body>${paragraphs.map(text=>`<p>${escape(text)}</p>`).join('')}</body></html>`),
};
writeFileSync(resolve(here,'preparation-text.epub'),zipSync(files,{level:0,mtime:new Date('2026-10-18T00:00:00Z')}));
writeFileSync(resolve(here,'preparation-manifest.json'),JSON.stringify({schema:'bookorbit.audiobook-manifest',schemaVersion:2,revision:'librispeech-174-168635-0002-pcm16-'+sha.slice(0,16),totalDurationMs:durationMs,chapters:[],assets:[{assetId:recording,fileId:41835,sequence:0,format:'wav',durationMs,sizeBytes:wav.length,etag:sha}]},null,2)+'\n');
console.log(JSON.stringify({recording,durationMs,bytes:wav.length,sha256:sha}));
