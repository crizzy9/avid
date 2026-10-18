import { z } from "zod";
import type { Book } from "./types";
/** BookOrbit v3.4.0 / 2cc0906ddf13b5b4c70250d27736ecc1eef742cb. */
export const BOOK_REQUEST_PAIR_FEATURE = "book-request-pairs";
export const bookRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "searching",
  "grabbed",
  "downloading",
  "importing",
  "needs_review",
  "available",
  "failed",
]);
export type BookRequestStatus = z.infer<typeof bookRequestStatusSchema>;
export type BookRequestMediaKind = "ebook" | "audiobook";
const id = z.number().int().positive();
export const bookRequestWorkSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    authors: z.array(z.string().max(255)).max(50).optional(),
    note: z.string().max(2000).optional(),
    language: z.string().max(20).optional(),
    isbn10: z.string().max(20).optional(),
    isbn13: z.string().max(20).optional(),
    seriesName: z.string().max(500).optional(),
    publishedYear: z.number().int().min(0).max(9999).optional(),
  })
  .strict();
export type BookRequestWork = z.infer<typeof bookRequestWorkSchema>;
export const createBookRequestSchema = bookRequestWorkSchema.extend({
  mediaKind: z.enum(["ebook", "audiobook"]),
  targetBookId: id.optional(),
  preferredFormats: z.array(z.string().max(20)).max(20).optional(),
});
export type CreateBookRequest = z.infer<typeof createBookRequestSchema>;
export const bookRequestAvailabilityQuerySchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    author: z.string().max(255).optional(),
    isbn13: z.string().max(20).optional(),
    mediaKind: z.enum(["ebook", "audiobook"]),
  })
  .strict();
export type BookRequestAvailabilityQuery = z.infer<
  typeof bookRequestAvailabilityQuerySchema
>;
export const bookRequestAvailabilitySchema = z.object({
  ownedBookId: id.nullable(),
  existingRequestId: id.nullable(),
  existingRequestStatus: bookRequestStatusSchema.nullable(),
  alreadySubscribed: z.boolean(),
});
export type BookRequestAvailability = z.infer<
  typeof bookRequestAvailabilitySchema
>;
const itemBase = z.object({
  id,
  userId: id,
  title: z.string(),
  authors: z.array(z.string()),
  mediaKind: z.enum(["ebook", "audiobook", "comic"]),
  status: bookRequestStatusSchema,
  note: z.string().nullable(),
  targetBookId: id.nullable().optional(),
  companionRequestId: id.nullable().optional(),
  matchedBookId: id.nullable(),
  statusReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const bookRequestItemSchema = itemBase.extend({
  companion: itemBase.nullable().optional(),
});
export type BookRequestItem = z.infer<typeof bookRequestItemSchema>;
export const bookRequestPageSchema = z.object({
  items: z.array(bookRequestItemSchema).max(100),
  total: z.number().int().nonnegative(),
});
export type BookRequestPage = z.infer<typeof bookRequestPageSchema>;
export const bookRequestSubmitSchema = z.object({
  request: bookRequestItemSchema,
  subscribed: z.boolean(),
});
export type BookRequestSubmitResult = z.infer<typeof bookRequestSubmitSchema>;
export const bookRequestPairSubmitSchema = z.object({
  ebook: bookRequestSubmitSchema,
  audiobook: bookRequestSubmitSchema,
});
export type BookRequestPairResult = z.infer<typeof bookRequestPairSubmitSchema>;
export interface BookRequestCapabilities {
  available: boolean;
  pairs: boolean;
  targetBook: boolean;
  canSubmit: boolean;
  reason?: "unsupported" | "forbidden" | "read-only";
}
/** v3.4 groups comics with readable ebook requests; this is independent of the primary cover. */
export function missingBookRequestMedia(
  book: Book,
): BookRequestMediaKind | null {
  const readable = book.files.some((file) => file.format !== "AUDIO"),
    audio = book.files.some((file) => file.format === "AUDIO");
  return readable && !audio ? "audiobook" : audio && !readable ? "ebook" : null;
}
export function bookRequestWork(book: Book): BookRequestWork {
  return bookRequestWorkSchema.parse({
    title: book.title,
    authors: book.authors,
    ...(book.language ? { language: book.language } : {}),
    ...(book.isbn10 ? { isbn10: book.isbn10 } : {}),
    ...(book.isbn13 ? { isbn13: book.isbn13 } : {}),
    ...(book.series ? { seriesName: book.series } : {}),
    ...(book.publishedYear !== undefined
      ? { publishedYear: book.publishedYear }
      : {}),
  });
}
