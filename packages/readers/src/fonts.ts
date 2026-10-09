import { ReaderError } from './readerI18n';
interface StoredFont { name: string; data: string }
const storageKey = (scope: string) => `avid.reader.fonts.v1.${encodeURIComponent(scope)}`;
export function storedFonts(scope = 'local'): StoredFont[] {
  try { return JSON.parse(localStorage.getItem(storageKey(scope)) || '[]'); } catch { return []; }
}
export function fontRules(scope = 'local') { return storedFonts(scope).map(font => `@font-face { font-family: "${font.name}"; src: url("${font.data}"); font-display: swap; }`).join('\n'); }
export async function importFont(file: File, scope = 'local'): Promise<string> {
  if (!/\.(woff2?|ttf|otf)$/i.test(file.name)) throw new ReaderError('fontFormat');
  if (file.size > 1024 * 1024) throw new ReaderError('fontSizeLimit');
  const name = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 50) || 'Imported font';
  const buffer = await file.arrayBuffer();
  const face = new FontFace(name, buffer);
  await face.load(); // Reject malformed fonts before persistence or use.
  const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
  const fonts = storedFonts(scope).filter(font => font.name !== name);
  if (fonts.length >= 3) fonts.shift();
  try { localStorage.setItem(storageKey(scope), JSON.stringify([...fonts, { name, data }])); } catch { throw new ReaderError('fontStorage'); }
  document.fonts.add(face);
  return name;
}
