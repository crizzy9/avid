// Foliate has an unstable JavaScript API. Keep its version-pinned boundary local.
declare module '*foliate/view.js' {
  export const makeBook: (source: File | Blob | string) => Promise<any>;
}
declare module '*foliate/overlayer.js' { export const Overlayer: any; }
declare module '*foliate/epub.js' { export const EPUB: any; }
declare module '*foliate/epubcfi.js' {
  export function fromRange(range: Range): string;
  export function parse(cfi: string): any;
  export function toRange(doc: Document, cfi: any): Range;
}

declare module '*foliate/mobi.js' { export const MOBI: any; export const isMOBI: (file: Blob) => Promise<boolean>; }
