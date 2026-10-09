// Vendored Foliate.js intentionally exposes a narrow, version-pinned boundary.
declare module '*.js' {
  export const makeBook: (source: File | Blob | string) => Promise<any>;
  export const Overlayer: any;
  export const EPUB: any;
  export function fromRange(range: Range): string;
  export function parse(cfi: string): any;
  export function toRange(doc: Document, cfi: any): Range;
}
declare module '*?url' { const url: string; export default url; }
