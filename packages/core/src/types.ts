export type BookFormat = 'EPUB' | 'MOBI' | 'PDF' | 'CBZ' | 'CBR' | 'CB7' | 'AUDIO';
export type BookStatus = 'unread' | 'reading' | 'finished';
export interface BookFile { id: string; name: string; format: BookFormat; url?: string; size?: number }
export interface AudioChapter { id: string; title: string; start: number; duration: number; url?: string }
export interface Book {
  id: string; title: string; authors: string[]; description: string; format: BookFormat;
  coverUrl?: string; color: string; progress: number; status: BookStatus;
  series?: string; seriesIndex?: number; genres: string[]; addedAt: string;
  files: BookFile[]; chapters?: AudioChapter[];
}
export interface ServerProfile { id: string; name: string; url: string; username?: string; version?: string }
export interface Session { profile: ServerProfile; accessToken: string; refreshToken?: string; userId: string }
export interface ReadingAnchor { bookId: string; fileId: string; kind: 'epub' | 'pdf' | 'comic' | 'audio'; locator: string; progress: number; updatedAt: string }
export interface Annotation { id: string; bookId: string; fileId: string; kind: 'highlight' | 'note' | 'audio'; quote: string; text: string; color: string; locator: string; createdAt: string; updatedAt: string; deleted?: boolean }
export interface Collection { id: string; name: string; bookIds: string[] }
export interface ReadingSession { id: string; bookId: string; kind: 'reading' | 'listening' | 'speech'; startedAt: string; duration: number }
