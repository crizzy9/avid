import type { AudioChapter, AudioTrack } from './types';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

export function trackStart(tracks: AudioTrack[], index: number): number {
  return tracks.slice(0, index).reduce((sum, track) => sum + (track.duration ?? 0), 0);
}

export function trackAtTime(tracks: AudioTrack[], seconds: number): { index: number; offset: number } {
  const time = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  let start = 0;
  for (let index = 0; index < tracks.length; index++) {
    const duration = tracks[index]!.duration;
    if (duration == null || time < start + duration || index === tracks.length - 1) {
      return { index, offset: clamp(time - start, 0, duration ?? Infinity) };
    }
    start += duration;
  }
  return { index: 0, offset: 0 };
}

export function chapterAtTime(chapters: AudioChapter[], seconds: number): number {
  return chapters.findIndex(chapter => seconds >= chapter.start && seconds < chapter.start + chapter.duration);
}

export function validateTimeline(tracks: AudioTrack[], chapters: AudioChapter[]): void {
  if (!tracks.length) throw new Error('This audiobook has no playable audio file.');
  if (new Set(tracks.map(track => track.id)).size !== tracks.length) throw new Error('Audio track IDs must be unique.');
  tracks.forEach((track, index) => {
    if (!track.id || !track.url) throw new Error('Audio tracks require stable IDs and playable URLs.');
    if ((index < tracks.length - 1 && track.duration == null) ||
      (track.duration != null && (!Number.isFinite(track.duration) || track.duration <= 0))) {
      throw new Error('Track durations are required to safely seek across a multi-track audiobook.');
    }
  });
  if (new Set(chapters.map(chapter => chapter.id)).size !== chapters.length) throw new Error('Chapter IDs must be unique.');
  chapters.forEach((chapter, index) => {
    if (!chapter.id || !Number.isFinite(chapter.start) || !Number.isFinite(chapter.duration) ||
      chapter.start < 0 || chapter.duration <= 0 || (index > 0 && chapter.start < chapters[index - 1]!.start + chapters[index - 1]!.duration)) {
      throw new Error('Audio chapters must have finite, ordered, non-overlapping source timestamps.');
    }
  });
}
