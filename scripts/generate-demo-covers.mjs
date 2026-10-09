import { mkdir, writeFile } from 'node:fs/promises';

// Original vector illustrations for Avid's local demo library.
const books = [
  ['dracula',['Dracula'],'Bram Stoker','#9e344a','moon'],
  ['dorian',['The Picture of','Dorian Gray'],'Oscar Wilde','#286e62','mirror'],
  ['sherlock',['The Adventures of','Sherlock','Holmes'],'Arthur Conan Doyle','#d49b3f','glass'],
  ['alice',['Alice in','Wonderland'],'Lewis Carroll','#b86076','watch'],
  ['moby',['Moby-Dick'],'Herman Melville','#36658c','whale'],
  ['sleepy',['The Legend of','Sleepy Hollow'],'Washington Irving','#65537b','moon'],
  ['treasure',['Treasure','Island'],'Robert Louis Stevenson','#267682','map'],
  ['frankenstein',['Frankenstein'],'Mary Shelley','#697746','bolt'],
  ['twocities',['A Tale of','Two Cities'],'Charles Dickens','#b36043','city'],
  ['timemachine',['The Time','Machine'],'H. G. Wells','#635797','watch'],
  ['pride',['Pride and','Prejudice'],'Jane Austen','#7c8892','flower'],
  ['garden',['The Secret','Garden'],'Frances Hodgson Burnett','#6d826c','flower'],
];
const drawings = {
  moon:'<circle cx="160" cy="235" r="62" fill="#f8ebc8"/><path d="M67 233l57 16 23-23 13 22 14-22 20 23 59-16-28 64-37-15-28 31-28-31-37 15z" fill="#321d34"/>',
  mirror:'<ellipse cx="160" cy="250" rx="61" ry="80" fill="none" stroke="#f5dea0" stroke-width="8"/><ellipse cx="160" cy="250" rx="50" ry="68" fill="#8ac4a1"/><path d="M167 184l-18 53 24 15-28 65" fill="none" stroke="#286e62" stroke-width="5"/><path d="M132 338h57" stroke="#f5dea0" stroke-width="6"/>',
  glass:'<circle cx="150" cy="240" r="53" fill="#e7c66d" stroke="#324950" stroke-width="12"/><path d="M187 280l47 46" stroke="#324950" stroke-width="22"/><path d="M129 209q-20 12-22 31" stroke="#f9edbf" stroke-width="5" fill="none"/>',
  watch:'<circle cx="160" cy="194" r="14" stroke="#f9dfaa" stroke-width="5" fill="none"/><circle cx="160" cy="262" r="61" stroke="#f9dfaa" stroke-width="6" fill="none"/><path d="M160 262l-27-26m27 26 25-40M160 211v10m0 82v10m-51-51h10m82 0h10" stroke="#f9dfaa" stroke-width="4" stroke-linecap="round"/>',
  whale:'<circle cx="160" cy="254" r="73" fill="#72b9bb"/><path d="M84 243q53 40 94-1l43-9-9 29q-26 30-64 22-44-4-64-41" fill="#fff1cc"/><path d="M175 245l8-33 21 21 25-12-9 32" fill="#fff1cc"/><path d="M99 306h126m-116 10h104m-89 10h73" stroke="#f9e6bb" stroke-width="3"/>',
  map:'<path d="M87 209l48-21 50 19 48-20v135l-48 20-50-20-48 20z" fill="#ffe9aa"/><path d="M135 188v134m50-115v135" stroke="#d5b45b" stroke-width="2"/><path d="M111 305q-5-37 39-39t54-31" stroke="#d16c4d" stroke-width="4" fill="none" stroke-dasharray="4 9"/><path d="M194 220l23 24m-23 0 23-24" stroke="#d16c4d" stroke-width="6"/>',
  bolt:'<circle cx="160" cy="268" r="65" fill="none" stroke="#ecdda2" stroke-width="3"/><path d="M91 268h138m-69-65q-50 62 0 130m0-130q50 62 0 130" fill="none" stroke="#ecdda2" stroke-width="2"/><path d="M158 176h39l-34 70h31l-55 101 19-82h-33z" fill="#edb95e"/>',
  city:'<path d="M98 320V230l21-32 22 32v90m38 0V208l18-35 21 35v112" fill="#fff0c4"/><path d="M141 320v-87q19-36 38 0v87" fill="#733c35"/><path d="M88 325h140" stroke="#fff0c4" stroke-width="4"/><path d="M110 242h12m-12 20h12m-12 20h12m74-59h11m-11 22h11m-11 22h11" stroke="#b36043" stroke-width="7"/>',
  flower:'<path d="M161 327V234m0 48q-50-38-62-13 21 39 62 22m0-24q49-38 63-12-24 31-63 22" fill="none" stroke="#f4e5b7" stroke-width="4"/><g fill="#f4e5b7"><ellipse cx="160" cy="214" rx="16" ry="32"/><ellipse cx="160" cy="214" rx="16" ry="32" transform="rotate(60 160 214)"/><ellipse cx="160" cy="214" rx="16" ry="32" transform="rotate(120 160 214)"/></g><circle cx="160" cy="214" r="12" fill="#ba8750"/>',
};
await mkdir('apps/web/public/covers',{recursive:true});
for (const [slug,lines,author,color,shape] of books) {
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 460"><defs><linearGradient id="spine"><stop stop-color="#000" stop-opacity=".16"/><stop offset=".16" stop-color="#fff" stop-opacity=".22"/><stop offset=".2" stop-color="#000" stop-opacity=".1"/><stop offset=".28" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><rect width="320" height="460" rx="4" fill="${color}"/><rect width="320" height="460" fill="url(#spine)"/><path d="M23 0v460" stroke="#fff" opacity=".13"/><g text-anchor="middle" fill="#fff5d9" font-family="Georgia,serif" font-weight="bold">${lines.map((line,i)=>`<text x="169" y="${68+i*33}" font-size="${line.length>18?22:30}">${line}</text>`).join('')}</g>${drawings[shape]}<path d="M142 379h36" stroke="#fff0cb" opacity=".6"/><text x="168" y="407" text-anchor="middle" font-family="Georgia,serif" font-size="15" fill="#fff0cb">${author}</text><text x="168" y="430" text-anchor="middle" font-family="Arial,sans-serif" font-size="8" letter-spacing="4" fill="#fff0cb" opacity=".65">AVID CLASSICS</text></svg>`;
  await writeFile(`apps/web/public/covers/${slug}.svg`,svg);
}
