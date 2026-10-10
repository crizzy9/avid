import { z } from 'zod';
import type { ReadingAnchor } from './types';
import type { KoreaderFingerprint } from './koreader-fingerprint';
export { computeKoreaderFingerprint, type KoreaderFingerprint } from './koreader-fingerprint';

type TextKind = Exclude<ReadingAnchor['kind'], 'audio'>;
export interface KoreaderFileIdentity { bookId: string; fileId: string; kind: TextKind; fingerprint?: KoreaderFingerprint }
export interface KoreaderBinding extends KoreaderFileIdentity { serverUrl: string; userId: string }
export class KoreaderContractError extends Error {
  constructor(public readonly reason: 'identity' | 'format' | 'response', message: string) { super(message); this.name = 'KoreaderContractError'; }
}
export interface KoreaderCheckpoint {
  version: 1;
  binding: KoreaderBinding;
  /** Raw CREngine XPointer or raw page string, never rewritten into a CFI on the client. */
  nativeLocator: string | null;
  readerAnchor: ReadingAnchor | null;
  progress: number;
  serverCfi: string | null;
  serverPage: number | null;
  translation: 'server-cfi' | 'server-page' | 'unavailable';
  /** File progress does not expose the server converter's exact/repaired status. */
  precision: 'unspecified' | 'page';
  eventTimeSource: 'canonical-koreader' | 'canonical-web' | 'file-progress' | 'unknown';
  reviewReason: 'file-modified' | 'native-time-unavailable' | 'locator-unavailable' | null;
}
export interface KoreaderReadingAnchor extends ReadingAnchor {
  /** Preserved only while this remains the same point; a subsequent reader move must not reuse it. */
  koreader?: KoreaderCheckpoint;
}
const id = z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)]).transform(String);
const time = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Invalid event time').nullish();
const progressSchema = z.object({
  percentage: z.number().finite().min(0).max(100),
  cfi: z.string().nullish(), pageNumber: z.number().int().min(1).max(2147483647).nullish(),
  koreaderProgress: z.string().nullish(), updatedAt: time, textUpdatedAt: time,
  currentFileId: id.optional(), bookFileId: id.optional(), userId: id.optional(),
}).passthrough();
const syncSchema = z.object({
  bookId: id, bookFileId: id, canonicalSource: z.enum(['koreader', 'web_reader']),
  canonicalUpdatedAt: z.string().refine(value => Number.isFinite(Date.parse(value))),
  canonicalPercentage: z.number().finite().min(0).max(100), fileModifiedSinceLastSync: z.boolean(),
}).passthrough();
const fingerprintSchema = z.object({ algorithm: z.literal('koreader-partial-md5'), value: z.string().regex(/^[0-9a-f]{32}$/), sizeBytes: z.number().int().nonnegative() });
export function assertKoreaderBinding(actual: KoreaderBinding, expected: KoreaderBinding): void {
  for (const key of ['serverUrl', 'userId', 'bookId', 'fileId', 'kind'] as const) {
    if (actual[key] !== expected[key]) throw new KoreaderContractError('identity', 'The KOReader checkpoint belongs to a different account, book or file.');
  }
  if (expected.fingerprint) {
    if (!fingerprintSchema.safeParse(expected.fingerprint).success || !fingerprintSchema.safeParse(actual.fingerprint).success
      || actual.fingerprint!.value !== expected.fingerprint.value || actual.fingerprint!.sizeBytes !== expected.fingerprint.sizeBytes) {
      throw new KoreaderContractError('identity', 'The KOReader document fingerprint changed. Review the file edition before restoring.');
    }
  }
}
/** Reads the verified file-progress contract; optional dashboard metadata dates native device updates. */
export function parseKoreaderCheckpoint(binding: KoreaderBinding, value: unknown, syncInfo?: unknown): KoreaderCheckpoint | null {
  if (value === null) return null;
  const parsed = progressSchema.safeParse(value);
  if (!parsed.success) throw new KoreaderContractError('response', 'Unexpected BookOrbit file progress response.');
  if (binding.fingerprint && !fingerprintSchema.safeParse(binding.fingerprint).success) throw new KoreaderContractError('identity', 'Invalid KOReader file fingerprint.');
  const row = parsed.data;
  if ((row.currentFileId && row.currentFileId !== binding.fileId) || (row.bookFileId && row.bookFileId !== binding.fileId)
    || (row.userId && row.userId !== binding.userId)) throw new KoreaderContractError('identity', 'The saved reading position belongs to a different source file or account.');
  const nativeLocator = row.koreaderProgress ?? null;
  let updatedAt = row.textUpdatedAt ?? row.updatedAt ?? '';
  let eventTimeSource: KoreaderCheckpoint['eventTimeSource'] = updatedAt ? 'file-progress' : 'unknown';
  let reviewReason: KoreaderCheckpoint['reviewReason'] = null;
  // KOReader writes intentionally preserve old web timestamps; they cannot date this native point.
  if (nativeLocator) { updatedAt = ''; eventTimeSource = 'unknown'; reviewReason = 'native-time-unavailable'; }
  if (syncInfo != null) {
    const sync = syncSchema.safeParse(syncInfo);
    if (!sync.success) throw new KoreaderContractError('response', 'Unexpected BookOrbit KOReader sync metadata.');
    const info = sync.data;
    // The dashboard can choose another edition; only use metadata for this exact file/percentage.
    if (info.bookId === binding.bookId && info.bookFileId === binding.fileId && Math.abs(info.canonicalPercentage - row.percentage) < 0.00001) {
      updatedAt = info.canonicalUpdatedAt;
      eventTimeSource = info.canonicalSource === 'koreader' ? 'canonical-koreader' : 'canonical-web';
      reviewReason = info.canonicalSource === 'koreader' && info.fileModifiedSinceLastSync ? 'file-modified' : null;
    }
  }
  const cfi = row.cfi ?? null, page = row.pageNumber ?? null;
  if (binding.kind === 'epub' && cfi && !/^epubcfi\(.+\)$/.test(cfi)) throw new KoreaderContractError('format', 'BookOrbit did not provide a valid EPUB CFI. The native KOReader position cannot be guessed.');
  const locator = binding.kind === 'epub' ? cfi : page === null ? null : String(page);
  const checkpoint: KoreaderCheckpoint = {
    version: 1, binding: { ...binding, ...(binding.fingerprint ? { fingerprint: { ...binding.fingerprint } } : {}) }, nativeLocator,
    readerAnchor: locator && reviewReason !== 'file-modified' ? { bookId: binding.bookId, fileId: binding.fileId, kind: binding.kind,
      locator, progress: row.percentage / 100, updatedAt } : null,
    progress: row.percentage / 100, serverCfi: cfi, serverPage: page,
    translation: locator ? binding.kind === 'epub' ? 'server-cfi' : 'server-page' : 'unavailable',
    precision: binding.kind === 'epub' ? 'unspecified' : 'page', eventTimeSource,
    reviewReason: !locator && !reviewReason ? 'locator-unavailable' : reviewReason,
  };
  return checkpoint;
}
export function koreaderRestoreAnchor(checkpoint: KoreaderCheckpoint, expected: KoreaderBinding): KoreaderReadingAnchor | null {
  assertKoreaderBinding(checkpoint.binding, expected);
  if (checkpoint.reviewReason === 'file-modified') throw new KoreaderContractError('identity', 'The source file changed after KOReader synchronized. Review the edition before restoring.');
  return checkpoint.readerAnchor ? { ...checkpoint.readerAnchor, koreader: checkpoint } : null;
}
/** Build ordinary authenticated file progress. BookOrbit owns EPUB CFI↔XPointer conversion. */
export function bookOrbitTextProgress(anchor: ReadingAnchor, binding: KoreaderBinding): { percentage: number; cfi?: string; pageNumber?: number; koreaderProgress?: string } {
  if (anchor.kind === 'audio' || anchor.kind !== binding.kind || anchor.bookId !== binding.bookId || anchor.fileId !== binding.fileId) {
    throw new KoreaderContractError('identity', 'The progress checkpoint does not match the selected source file.');
  }
  if (!Number.isFinite(anchor.progress) || anchor.progress < 0 || anchor.progress > 1) throw new KoreaderContractError('format', 'Progress must be between 0 and 1.');
  const percentage = anchor.progress * 100;
  if (anchor.kind !== 'epub') {
    let page: unknown = anchor.locator;
    if (anchor.locator.trim().startsWith('{')) {
      try { page = JSON.parse(anchor.locator).page; } catch { throw new KoreaderContractError('format', 'The saved page locator is invalid.'); }
    }
    const number = typeof page === 'string' && /^\d+$/.test(page.trim()) ? Number(page) : typeof page === 'number' ? page : NaN;
    if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw new KoreaderContractError('format', 'Page locators must be positive integers.');
    // KOReader paged readers use the same 1-based page. A webtoon offset has no KOSync equivalent.
    return { percentage, pageNumber: number, koreaderProgress: String(number) };
  }
  if (!/^epubcfi\(.+\)$/.test(anchor.locator)) throw new KoreaderContractError('format', 'EPUB progress requires a native EPUB CFI.');
  const retained = (anchor as KoreaderReadingAnchor).koreader;
  if (retained) {
    assertKoreaderBinding(retained.binding, binding);
    if (retained.readerAnchor?.locator === anchor.locator && retained.progress === anchor.progress && retained.nativeLocator) {
      return { percentage, cfi: anchor.locator, koreaderProgress: retained.nativeLocator };
    }
  }
  // Omission clears the obsolete native locator on this pinned server, which converts the new CFI when KOReader pulls.
  return { percentage, cfi: anchor.locator };
}
