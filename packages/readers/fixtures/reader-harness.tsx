import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Reader } from '../src/Reader';
import type { Annotation, Book, ReadingAnchor } from '../src/contracts';
import { HandoffHarness } from './handoff-harness';
import { PreparationHarness } from './preparation-harness';
const requestedFormat = new URLSearchParams(location.search).get('format') || 'EPUB';
const format = ['PDF', 'CBZ', 'CB7', 'CBR', 'MOBI'].includes(requestedFormat) ? requestedFormat as 'PDF' | 'CBZ' | 'CB7' | 'CBR' | 'MOBI' : 'EPUB';
const url = requestedFormat === 'ALIGNED' ? new URL('sample-aligned.epub', location.href).href : format === 'EPUB' ? undefined : new URL(`sample.${format.toLowerCase()}`, location.href).href;
const book: Book = { id: 'demo-reader-fixture', title: 'A Quiet Hour', authors: ['Avid original sample'], description: 'Reader engine test fixture', format, color: '#a58b55', progress: 0, status: 'unread', genres: [], addedAt: '2026-10-09', files: [{ id: 'demo-reader-file', name: `sample.${format.toLowerCase()}`, format, url }] };
function Harness() {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [anchor, setAnchor] = useState<ReadingAnchor>();
  const [open, setOpen] = useState(true);
  return open ? <Reader book={book} annotations={annotations} initialAnchor={anchor} onAnchor={setAnchor} onAnnotation={annotation => setAnnotations(items => [...items.filter(item => item.id !== annotation.id), annotation])} onClose={() => setOpen(false)} /> : <button onClick={() => setOpen(true)}>Reopen at saved anchor</button>;
}
createRoot(document.getElementById('root')!).render(requestedFormat === 'PREPARE' ? <PreparationHarness /> : requestedFormat === 'HANDOFF' ? <HandoffHarness /> : <Harness />);
