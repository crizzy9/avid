import type {
  AlignmentEdition,
  StandaloneAlignedSegment,
} from "./standalone-alignment";

/** An exact whole-element CFI, extracted from the source publication, not a percentage. */
export interface GeneratedTextPassage {
  id: string;
  text: string;
  textLocator: string;
  sectionIndex: number;
  textHref: string;
  /** Element children from the XHTML body. Never IDs invented in the source. */
  elementPath: number[];
}
export interface ExtractedPublicationText {
  version: 1;
  textSha256: string;
  passages: GeneratedTextPassage[];
}
export interface RecognizedWord {
  text: string;
  start: number;
  end: number;
}
export interface GeneratedAudioIdentity {
  assetId: string;
  fileId: string;
  sha256: string;
  sizeBytes: number;
  duration: number;
}
export interface GeneratedAudioTrack extends GeneratedAudioIdentity {
  /** Actual recognizer boundaries relative to this track. Never distribute a sentence by length. */
  words: RecognizedWord[];
}
export interface GeneratedAlignedSegment extends StandaloneAlignedSegment {
  textElementPath: number[];
  /** Token agreement with the EPUB, not a calibrated recognizer probability. */
  confidence: number;
}
export interface GeneratedAlignmentSnapshot {
  version: 1;
  source: "generated";
  algorithm: "avid-word-match-v1";
  edition: AlignmentEdition;
  model: { id: string; revision: string };
  language?: string;
  tracks: GeneratedAudioIdentity[];
  passages: GeneratedTextPassage[];
  segments: GeneratedAlignedSegment[];
  coverage: {
    matchedPassages: number;
    totalPassages: number;
    matchedWords: number;
    totalWords: number;
  };
}
const hashPattern = /^[0-9a-f]{64}$/;
const MAX_PASSAGES = 100_000,
  MAX_WORDS = 1_000_000;
export function alignmentTokens(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'");
  return [
    ...new Intl.Segmenter(undefined, { granularity: "word" }).segment(
      normalized,
    ),
  ]
    .filter((item) => item.isWordLike)
    .map((item) => item.segment.replace(/'/g, ""));
}
function fail(): never {
  throw new Error(
    "The generated alignment has invalid source identities, text, or timing.",
  );
}
function validString(value: unknown, max = 16_384): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u0008]/.test(value)
  );
}
function validatePassage(p: GeneratedTextPassage) {
  if (
    !p ||
    !validString(p.id) ||
    !validString(p.text, 250_000) ||
    !validString(p.textLocator) ||
    !p.textLocator.startsWith("epubcfi(") ||
    !validString(p.textHref) ||
    !Number.isSafeInteger(p.sectionIndex) ||
    p.sectionIndex < 0 ||
    !Array.isArray(p.elementPath) ||
    p.elementPath.length > 128 ||
    p.elementPath.some((n) => !Number.isSafeInteger(n) || n < 0)
  )
    fail();
}
export function validateGeneratedAlignment(
  snapshot: GeneratedAlignmentSnapshot,
): void {
  if (
    !snapshot ||
    snapshot.version !== 1 ||
    snapshot.source !== "generated" ||
    snapshot.algorithm !== "avid-word-match-v1" ||
    !snapshot.edition ||
    !hashPattern.test(snapshot.edition.textSha256) ||
    [
      "accountScope",
      "bookId",
      "textFileId",
      "audioFileId",
      "manifestRevision",
    ].some(
      (k) => !validString(snapshot.edition[k as keyof AlignmentEdition]),
    ) ||
    !snapshot.model ||
    !validString(snapshot.model.id) ||
    !validString(snapshot.model.revision) ||
    (snapshot.language !== undefined && !validString(snapshot.language, 128)) ||
    !Array.isArray(snapshot.tracks) ||
    !snapshot.tracks.length ||
    snapshot.tracks.length > 10_000 ||
    !Array.isArray(snapshot.passages) ||
    !snapshot.passages.length ||
    snapshot.passages.length > MAX_PASSAGES ||
    !Array.isArray(snapshot.segments) ||
    !snapshot.segments.length ||
    snapshot.segments.length > snapshot.passages.length
  )
    fail();
  const assets = new Set<string>(),
    files = new Set<string>(),
    offsets = new Map<string, number>();
  let duration = 0;
  for (const track of snapshot.tracks) {
    if (
      !track ||
      !validString(track.assetId) ||
      !validString(track.fileId) ||
      assets.has(track.assetId) ||
      files.has(track.fileId) ||
      !hashPattern.test(track.sha256) ||
      !Number.isSafeInteger(track.sizeBytes) ||
      track.sizeBytes <= 0 ||
      !Number.isFinite(track.duration) ||
      track.duration <= 0
    )
      fail();
    assets.add(track.assetId);
    files.add(track.fileId);
    offsets.set(track.fileId, duration);
    duration += track.duration;
  }
  if (!files.has(snapshot.edition.audioFileId) || !Number.isFinite(duration))
    fail();
  const passages = new Map<string, GeneratedTextPassage>(),
    locators = new Set<string>();
  let totalWords = 0;
  for (const passage of snapshot.passages) {
    validatePassage(passage);
    if (passages.has(passage.id) || locators.has(passage.textLocator)) fail();
    passages.set(passage.id, passage);
    locators.add(passage.textLocator);
    totalWords += alignmentTokens(passage.text).length;
  }
  const ids = new Set<string>();
  let previousEnd = -1,
    previousPassage = -1,
    matchedWords = 0;
  const order = new Map(snapshot.passages.map((p, i) => [p.id, i]));
  for (const segment of snapshot.segments) {
    const p = passages.get(segment.id),
      track = snapshot.tracks.find((t) => t.fileId === segment.trackId);
    if (
      !p ||
      !track ||
      ids.has(segment.id) ||
      order.get(segment.id)! <= previousPassage ||
      segment.textFileId !== snapshot.edition.textFileId ||
      segment.audioFileId !== snapshot.edition.audioFileId ||
      segment.textLocator !== p.textLocator ||
      segment.sectionIndex !== p.sectionIndex ||
      segment.textHref !== p.textHref ||
      segment.textFragment !== "" ||
      JSON.stringify(segment.textElementPath) !==
        JSON.stringify(p.elementPath) ||
      !Number.isFinite(segment.confidence) ||
      segment.confidence < 0.88 ||
      segment.confidence > 1 ||
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      segment.start < previousEnd ||
      segment.end <= segment.start ||
      !Number.isFinite(segment.trackTime) ||
      segment.trackTime < 0 ||
      segment.trackTime >= track.duration ||
      Math.abs(
        segment.start - (offsets.get(track.fileId)! + segment.trackTime),
      ) > 1e-9 ||
      segment.end > offsets.get(track.fileId)! + track.duration
    )
      fail();
    ids.add(segment.id);
    previousEnd = segment.end;
    previousPassage = order.get(segment.id)!;
    matchedWords += alignmentTokens(p.text).length;
  }
  const c = snapshot.coverage;
  if (
    !c ||
    c.totalPassages !== snapshot.passages.length ||
    c.matchedPassages !== snapshot.segments.length ||
    c.totalWords !== totalWords ||
    c.matchedWords !== matchedWords ||
    totalWords > MAX_WORDS
  )
    fail();
}

type TimedToken = {
  token: string;
  start: number;
  end: number;
  trackId: string;
};
type Match = { first: number; last: number; score: number };
/** Match near an observed three-word seed; edit distance never invents audio boundaries. */
function nearMatch(
  expected: string[],
  tokens: TimedToken[],
  offset: number,
): Match | null {
  const allowance = Math.min(8, Math.floor(expected.length * 0.12));
  const begin = Math.max(0, offset - allowance),
    end = Math.min(tokens.length, offset + expected.length + allowance);
  const width = end - begin;
  type Cell = { cost: number; first: number; last: number; matches: number };
  let previous: Cell[] = Array.from({ length: width + 1 }, () => ({
    cost: 0,
    first: -1,
    last: -1,
    matches: 0,
  }));
  for (let i = 1; i <= expected.length; i++) {
    const current: Cell[] = [{ cost: i, first: -1, last: -1, matches: 0 }];
    for (let j = 1; j <= width; j++) {
      const same = expected[i - 1] === tokens[begin + j - 1]!.token;
      const diagonal = previous[j - 1]!;
      const choices = [
        {
          cost: diagonal.cost + (same ? 0 : 1),
          first: same && diagonal.first < 0 ? begin + j - 1 : diagonal.first,
          last: same ? begin + j - 1 : diagonal.last,
          matches: diagonal.matches + (same ? 1 : 0),
        },
        { ...previous[j]!, cost: previous[j]!.cost + 1 },
        { ...current[j - 1]!, cost: current[j - 1]!.cost + 1 },
      ];
      choices.sort((a, b) => a.cost - b.cost || b.matches - a.matches);
      current.push(choices[0]!);
    }
    previous = current;
  }
  const result = previous
    .filter((c) => c.first >= 0 && c.last >= c.first && c.cost <= allowance)
    .sort((a, b) => a.cost - b.cost || b.matches - a.matches)[0];
  if (!result) return null;
  const score =
    result.matches / Math.max(expected.length, result.last - result.first + 1);
  if (
    score < 0.88 ||
    tokens[result.first]!.trackId !== tokens[result.last]!.trackId
  )
    return null;
  return { first: result.first, last: result.last, score };
}

/** Conservative actual-transcript matching. Ambiguity, skipped text and silence remain gaps. */
export function generateAlignment(input: {
  edition: AlignmentEdition;
  publication: ExtractedPublicationText;
  tracks: GeneratedAudioTrack[];
  model: { id: string; revision: string };
  language?: string;
}): GeneratedAlignmentSnapshot {
  if (
    input.publication.version !== 1 ||
    input.publication.textSha256 !== input.edition.textSha256 ||
    !input.publication.passages.length ||
    input.publication.passages.length > MAX_PASSAGES
  )
    fail();
  const tokens: TimedToken[] = [],
    offsets = new Map<string, number>();
  let offset = 0;
  for (const track of input.tracks) {
    offsets.set(track.fileId, offset);
    let previousStart = -1;
    for (const word of track.words) {
      if (
        !Number.isFinite(word.start) ||
        !Number.isFinite(word.end) ||
        word.start < 0 ||
        word.start < previousStart ||
        word.end <= word.start ||
        word.end > track.duration
      )
        fail();
      previousStart = word.start;
      for (const token of alignmentTokens(word.text))
        tokens.push({
          token,
          start: offset + word.start,
          end: offset + word.end,
          trackId: track.fileId,
        });
      if (tokens.length > MAX_WORDS) fail();
    }
    offset += track.duration;
  }
  const seeds = new Map<string, number[]>();
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (tokens[i]!.trackId !== tokens[i + 2]!.trackId) continue;
    const key = tokens
      .slice(i, i + 3)
      .map((t) => t.token)
      .join("\u0001");
    const positions = seeds.get(key) ?? [];
    if (positions.length < 65) positions.push(i);
    seeds.set(key, positions);
  }
  const normalized = input.publication.passages.map((p) => {
    validatePassage(p);
    return alignmentTokens(p.text);
  });
  const counts = new Map<string, number>();
  normalized.forEach((words) => {
    const key = words.join(" ");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  const segments: GeneratedAlignedSegment[] = [];
  let previousEnd = -1,
    matchedWords = 0;
  for (const [index, passage] of input.publication.passages.entries()) {
    const words = normalized[index]!;
    // Short/repeated lines cannot distinguish book editions; oversized paragraphs need a later finer extractor.
    if (
      words.length < 6 ||
      words.length > 512 ||
      counts.get(words.join(" ")) !== 1
    )
      continue;
    const candidates = new Set<number>(),
      anchors: { offset: number; hits: number[] }[] = [];
    for (let i = 0; i + 2 < words.length; i++) {
      const hits = seeds.get(words.slice(i, i + 3).join("\u0001")) ?? [];
      if (hits.length && hits.length <= 32) anchors.push({ offset: i, hits });
    }
    // Common phrases occur thousands of times in a novel. Use the most distinctive
    // observed anchors; collecting every common seed would drown out the real match.
    anchors.sort((a, b) => a.hits.length - b.hits.length);
    for (const anchor of anchors.slice(0, 8))
      for (const hit of anchor.hits) candidates.add(hit - anchor.offset);
    const clustered: number[] = [];
    for (const value of [...candidates].sort((a, b) => a - b))
      if (!clustered.some((old) => Math.abs(old - value) <= 2))
        clustered.push(value);
    if (!clustered.length || clustered.length > 32) continue;
    const matches: Match[] = [];
    for (const candidate of clustered) {
      const match = nearMatch(words, tokens, candidate);
      if (
        match &&
        !matches.some(
          (old) => old.first === match.first && old.last === match.last,
        )
      )
        matches.push(match);
    }
    matches.sort((a, b) => b.score - a.score);
    const best = matches[0];
    // Two plausible distinct recordings/occurrences must not be disambiguated by percentage or current position.
    if (
      !best ||
      matches.some(
        (other) =>
          other !== best &&
          (other.last < best.first || other.first > best.last) &&
          other.score >= best.score - 0.04,
      )
    )
      continue;
    const first = tokens[best.first]!,
      last = tokens[best.last]!;
    if (first.start < previousEnd || last.end <= first.start) continue;
    segments.push({
      id: passage.id,
      textFileId: input.edition.textFileId,
      audioFileId: input.edition.audioFileId,
      textLocator: passage.textLocator,
      sectionIndex: passage.sectionIndex,
      textHref: passage.textHref,
      textFragment: "",
      textElementPath: [...passage.elementPath],
      start: first.start,
      end: last.end,
      trackId: first.trackId,
      trackTime: first.start - offsets.get(first.trackId)!,
      confidence: best.score,
    });
    previousEnd = last.end;
    matchedWords += words.length;
  }
  if (!segments.length)
    throw new Error(
      "No sufficiently clear, unique passages matched this ebook and recording. Try the same unabridged edition.",
    );
  const snapshot: GeneratedAlignmentSnapshot = {
    version: 1,
    source: "generated",
    algorithm: "avid-word-match-v1",
    edition: { ...input.edition },
    model: { ...input.model },
    ...(input.language ? { language: input.language } : {}),
    tracks: input.tracks.map(({ words: _words, ...track }) => ({ ...track })),
    passages: input.publication.passages.map((p) => ({
      ...p,
      elementPath: [...p.elementPath],
    })),
    segments,
    coverage: {
      matchedPassages: segments.length,
      totalPassages: normalized.length,
      matchedWords,
      totalWords: normalized.reduce((n, w) => n + w.length, 0),
    },
  };
  validateGeneratedAlignment(snapshot);
  return snapshot;
}
