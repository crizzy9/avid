import { z } from 'zod';

/** Paths are archive-relative, never a URL or a request to a different origin. */
export function mediaOverlayPath(path: string): string {
  if (!path || path.startsWith('/') || /[\\%?#\u0000-\u001f]/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path) ||
    path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid EPUB resource path.');
  return path;
}
const path = z.string().transform(mediaOverlayPath);
const time = z.number().finite().nonnegative();
export const mediaOverlayPlaylistSchema = z.object({
  bookId: z.number().int().positive(), fileId: z.number().int().positive().nullable(), durationSeconds: time.nullable(),
  items: z.array(z.object({
    index: z.number().int().nonnegative(), sectionIndex: z.number().int().nonnegative(),
    smilHref: path, textHref: path, textFragment: z.string().nullable(), audioHref: path, audioMimeType: z.string(),
    clipBeginSeconds: time, clipEndSeconds: time.nullable(), durationSeconds: time.nullable(), label: z.string().nullable(),
  })),
  sections: z.array(z.object({ index: z.number().int().nonnegative(), href: path, label: z.string().nullable(), smilHref: path, startSeconds: time, durationSeconds: time.nullable() })),
  resources: z.array(z.object({ href: path, mediaType: z.string(), size: z.number().int().nonnegative() })),
});
export type MediaOverlayPlaylist = z.infer<typeof mediaOverlayPlaylistSchema>;
