export const audioCodecs = [
  { format: 'MP3', mime: 'audio/mpeg' },
  { format: 'M4A / M4B (AAC)', mime: 'audio/mp4; codecs="mp4a.40.2"' },
  { format: 'FLAC', mime: 'audio/flac' },
  { format: 'Ogg Vorbis', mime: 'audio/ogg; codecs="vorbis"' },
  { format: 'Ogg Opus', mime: 'audio/ogg; codecs="opus"' },
  { format: 'WAV (PCM)', mime: 'audio/wav; codecs="1"' },
] as const;

/** Engine-reported support is a preflight, not proof that a particular file decodes. */
export function getAudioCodecSupport(audio?: Pick<HTMLAudioElement, 'canPlayType'>) {
  const element = audio ?? (typeof Audio !== 'undefined' ? new Audio() : null);
  return audioCodecs.map(codec => ({ ...codec, support: element?.canPlayType(codec.mime) ?? '' }));
}

export function resolveAudioSource<T extends { url: string; mime: string }>(sources: T[], audio?: Pick<HTMLAudioElement, 'canPlayType'>): T | null {
  const element = audio ?? (typeof Audio !== 'undefined' ? new Audio() : null);
  if (!element) return null;
  return sources.find(source => element.canPlayType(source.mime) === 'probably') ??
    sources.find(source => element.canPlayType(source.mime) === 'maybe') ?? null;
}
