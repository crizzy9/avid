/** KOReader/BookOrbit compatibility fingerprint. Partial MD5 is not an integrity or security hash. */
export interface KoreaderFingerprint { algorithm: 'koreader-partial-md5'; value: string; sizeBytes: number }
/** At most twelve 1 KiB reads; offsets match KOReader util.partialMD5, including its first zero offset. */
export async function computeKoreaderFingerprint(source: Pick<Blob, 'size' | 'slice'>): Promise<KoreaderFingerprint> {
  if (!Number.isSafeInteger(source.size) || source.size < 0) throw new Error('A finite file size is required for KOReader fingerprinting.');
  const samples: Uint8Array[] = [];
  let length = 0;
  for (let index = -1; index <= 10; index++) {
    const start = index === -1 ? 0 : 1024 * 4 ** index;
    if (start >= source.size) break;
    const sample = new Uint8Array(await source.slice(start, Math.min(start + 1024, source.size)).arrayBuffer());
    if (sample.length !== Math.min(1024, source.size - start)) throw new Error('The file changed or a fingerprint sample could not be read.');
    samples.push(sample); length += sample.length;
  }
  const sampled = new Uint8Array(length);
  let offset = 0;
  for (const sample of samples) { sampled.set(sample, offset); offset += sample.length; }
  return { algorithm: 'koreader-partial-md5', value: md5(sampled), sizeBytes: source.size };
}

/** Independent RFC 1321 digest implementation for the bounded compatibility samples above. */
function md5(input: Uint8Array): string {
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input); padded[input.length] = 0x80;
  const data = new DataView(padded.buffer);
  data.setUint32(padded.length - 8, input.length * 8, true);
  data.setUint32(padded.length - 4, Math.floor(input.length / 0x20000000), true);
  const initial = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const shifts = [[7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21]];
  const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0);
  for (let offset = 0; offset < padded.length; offset += 64) {
    let [a, b, c, d] = initial as [number, number, number, number];
    for (let index = 0; index < 64; index++) {
      const round = Math.floor(index / 16);
      const f = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c) : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const word = round === 0 ? index : round === 1 ? (5 * index + 1) % 16 : round === 2 ? (3 * index + 5) % 16 : (7 * index) % 16;
      const sum = (a + f + constants[index]! + data.getUint32(offset + word * 4, true)) | 0;
      const shift = shifts[round]![index % 4]!;
      const next = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
      a = d; d = c; c = b; b = next;
    }
    [a, b, c, d].forEach((word, index) => { initial[index] = (initial[index]! + word) >>> 0; });
  }
  return initial.flatMap(word => [0, 8, 16, 24].map(shift => ((word >>> shift) & 255).toString(16).padStart(2, '0'))).join('');
}
