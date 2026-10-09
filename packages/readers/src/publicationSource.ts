/** Foliate format sniffing needs a filename, including for downloaded Blob data. */
export function publicationSource(source: Blob | string, name: string, format: string): File | string {
  if (typeof source === 'string' || source instanceof File) return source;
  return new File([source], name || `book.${format.toLowerCase()}`, { type: source.type });
}
