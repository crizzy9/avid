export interface AlignedSegment {
  id: string;
  textFileId: string;
  textLocator: string;
  audioFileId: string;
  start: number;
  end: number;
}

export interface AlignmentMap {
  version: string;
  source: 'epub-media-overlay' | 'server-bridge' | 'generated';
  textFileId: string;
  audioFileId: string;
  segments: AlignedSegment[];
}

/** Reject invented percentage links and malformed timing before enabling linked mode. */
export function validateAlignment(map: AlignmentMap): void {
  if (!map.version || !map.textFileId || !map.audioFileId || !map.segments.length ||
    !['epub-media-overlay', 'server-bridge', 'generated'].includes(map.source)) throw new Error('Verified text and audio alignment is required.');
  let end = -1;
  const ids = new Set<string>();
  for (const segment of map.segments) {
    if (!segment.id || ids.has(segment.id) || !segment.textLocator || segment.audioFileId !== map.audioFileId ||
      segment.textFileId !== map.textFileId || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
      segment.start < 0 || segment.end <= segment.start || segment.start < end) {
      throw new Error('Alignment has invalid file identities, duplicate IDs, or overlapping audio ranges.');
    }
    ids.add(segment.id);
    end = segment.end;
  }
}

/** Binary search on validated source timestamps; gaps deliberately return null. */
export function textAtAudioTime(map: AlignmentMap, seconds: number): AlignedSegment | null {
  if (!Number.isFinite(seconds)) return null;
  let low = 0;
  let high = map.segments.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const segment = map.segments[mid]!;
    if (seconds < segment.start) high = mid - 1;
    else if (seconds >= segment.end) low = mid + 1;
    else return segment;
  }
  return null;
}

export function audioAtTextLocator(map: AlignmentMap, textFileId: string, locator: string): AlignedSegment | null {
  if (textFileId !== map.textFileId) return null;
  return map.segments.find(segment => segment.textLocator === locator) ?? null;
}

/** Duration sanity check only. Real locators/timing and matching edition identities are still required. */
export function canBridgeAudio(overlayDuration: number, audiobookDuration: number): boolean {
  return Number.isFinite(overlayDuration) && Number.isFinite(audiobookDuration) && overlayDuration > 0 && audiobookDuration > 0 &&
    Math.abs(overlayDuration - audiobookDuration) <= Math.min(overlayDuration * 0.05, 300);
}
