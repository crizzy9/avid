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
  algorithm: "avid-word-match-v1" | "avid-word-match-v2";
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
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
function literalAlignmentTokens(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'");
  return [...wordSegmenter.segment(normalized)]
    .filter((item) => item.isWordLike)
    .map((item) => item.segment.replace(/'/g, ""));
}
const smallNumbers =
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(
    " ",
  );
const tens =
  "zero ten twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
/** English recognition spelling variants only; no fuzzy phonetic/name substitutions. */
export function alignmentTokens(text: string): string[] {
  return literalAlignmentTokens(text.replace(/&/g, " and ")).flatMap(
    (token) => {
      if (/^(?:0|[1-9]\d?)$/.test(token)) {
        const value = Number(token);
        return value < 20
          ? [smallNumbers[value]!]
          : [
              tens[Math.floor(value / 10)]!,
              ...(value % 10 ? [smallNumbers[value % 10]!] : []),
            ];
      }
      return [
        new Map([
          ["mr", "mister"],
          ["mrs", "missus"],
          ["dr", "doctor"],
        ]).get(token) ?? token,
      ];
    },
  );
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
    !["avid-word-match-v1", "avid-word-match-v2"].includes(
      snapshot.algorithm,
    ) ||
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
  const tokenize =
    snapshot.algorithm === "avid-word-match-v1"
      ? literalAlignmentTokens
      : alignmentTokens;
  const passages = new Map<string, GeneratedTextPassage>(),
    locators = new Set<string>();
  let totalWords = 0;
  for (const passage of snapshot.passages) {
    validatePassage(passage);
    if (passages.has(passage.id) || locators.has(passage.textLocator)) fail();
    passages.set(passage.id, passage);
    locators.add(passage.textLocator);
    totalWords += tokenize(passage.text).length;
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
    matchedWords += tokenize(p.text).length;
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
type Match = { first: number; last: number; score: number; mapping: number[] };
/** Bounded semiglobal edit alignment. Every mapped boundary is an observed recognizer token. */
function nearMatch(
  expected: string[],
  tokens: TimedToken[],
  offset: number,
  bounds: { begin: number; end: number } = { begin: 0, end: tokens.length },
): Match | null {
  // A long paragraph is checked in bounded pieces. Each piece must independently
  // agree, and every jump is constrained by observed words, never by duration.
  if (expected.length > 256) {
    const mapping: number[] = [],
      matches: Match[] = [];
    let cursor = offset;
    for (let i = 0; i < expected.length; i += 128) {
      const piece = expected.slice(i, i + 128);
      const match = nearMatch(piece, tokens, cursor, {
        begin: matches.length ? matches.at(-1)!.last + 1 : bounds.begin,
        end: bounds.end,
      });
      if (!match) return null;
      matches.push(match);
      mapping.push(...match.mapping);
      let lastMatched = match.mapping.length - 1;
      while (lastMatched >= 0 && match.mapping[lastMatched]! < 0) lastMatched--;
      cursor = match.last + piece.length - lastMatched;
    }
    const first = matches[0]!.first,
      last = matches.at(-1)!.last;
    const score =
      mapping.filter((value) => value >= 0).length /
      Math.max(expected.length, last - first + 1);
    return score >= 0.88 && tokens[first]!.trackId === tokens[last]!.trackId
      ? { first, last, score, mapping }
      : null;
  }
  const allowance = Math.floor(expected.length * 0.12);
  const begin = Math.max(bounds.begin, offset - allowance),
    end = Math.min(bounds.end, offset + expected.length + allowance),
    width = end - begin;
  if (width <= 0) return null;
  const stride = width + 1,
    directions = new Uint8Array((expected.length + 1) * stride);
  let costs = new Uint16Array(stride),
    agreements = new Uint16Array(stride);
  for (let i = 1; i <= expected.length; i++) {
    const next = new Uint16Array(stride),
      counts = new Uint16Array(stride);
    next[0] = i;
    directions[i * stride] = 2;
    for (let j = 1; j <= width; j++) {
      const same = expected[i - 1] === tokens[begin + j - 1]!.token;
      let cost = costs[j - 1]! + (same ? 0 : 1),
        count = agreements[j - 1]! + (same ? 1 : 0),
        direction = 1;
      if (
        costs[j]! + 1 < cost ||
        (costs[j]! + 1 === cost && agreements[j]! > count)
      ) {
        cost = costs[j]! + 1;
        count = agreements[j]!;
        direction = 2;
      }
      if (
        next[j - 1]! + 1 < cost ||
        (next[j - 1]! + 1 === cost && counts[j - 1]! > count)
      ) {
        cost = next[j - 1]! + 1;
        count = counts[j - 1]!;
        direction = 3;
      }
      next[j] = cost;
      counts[j] = count;
      directions[i * stride + j] = direction;
    }
    costs = next;
    agreements = counts;
  }
  let best = 0;
  for (let j = 1; j <= width; j++)
    if (
      costs[j]! < costs[best]! ||
      (costs[j] === costs[best] && agreements[j]! > agreements[best]!)
    )
      best = j;
  if (costs[best]! > allowance) return null;
  const mapping = new Array<number>(expected.length).fill(-1);
  for (let i = expected.length, j = best; i > 0;) {
    const direction = directions[i * stride + j];
    if (direction === 1) {
      if (expected[i - 1] === tokens[begin + j - 1]!.token)
        mapping[i - 1] = begin + j - 1;
      i--;
      j--;
    } else if (direction === 2) i--;
    else if (direction === 3) j--;
    else break;
  }
  const observed = mapping.filter((value) => value >= 0),
    first = observed[0],
    last = observed.at(-1);
  if (first === undefined || last === undefined) return null;
  const score = observed.length / Math.max(expected.length, last - first + 1);
  if (score < 0.88 || tokens[first]!.trackId !== tokens[last]!.trackId)
    return null;
  return { first, last, score, mapping };
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
  const accepted = new Map<number, Match>();
  const matchOptions = new Map<number, Match[]>();
  let previousEnd = -1;
  for (const [index] of input.publication.passages.entries()) {
    const words = normalized[index]!;
    // Short/repeated passages need two independently matched neighbors below.
    if (
      words.length < 6 ||
      words.length > 4096 ||
      counts.get(words.join(" ")) !== 1
    )
      continue;
    const candidates = new Set<number>(),
      anchors: { offset: number; hits: number[] }[] = [];
    // Early seeds avoid cumulative drift in unusually long paragraphs.
    for (let i = 0; i + 2 < Math.min(words.length, 256); i++) {
      const hits = seeds.get(words.slice(i, i + 3).join("\u0001")) ?? [];
      if (hits.length && hits.length <= 32) anchors.push({ offset: i, hits });
    }
    anchors.sort(
      (a, b) => a.hits.length - b.hits.length || a.offset - b.offset,
    );
    for (const anchor of anchors.slice(0, 12))
      for (const hit of anchor.hits) candidates.add(hit - anchor.offset);
    const clustered = [...candidates];
    if (!clustered.length || clustered.length > 64) continue;
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
    matchOptions.set(index, matches);
    const best = matches[0];
    if (
      !best ||
      matches.some(
        (other) =>
          other !== best &&
          other.score >=
            best.score -
              (other.last < best.first || other.first > best.last
                ? 0.04
                : 1e-9),
      )
    )
      continue;
    if (tokens[best.first]!.start < previousEnd) continue;
    accepted.set(index, best);
    previousEnd = tokens[best.last]!.end;
  }
  // Resolve short dialogue and repeated phrases only between two actual, unique
  // text/audio anchors. Missing or ambiguous lines are deliberately left unmapped.
  const anchors = [...accepted.entries()];
  for (let n = 1; n < anchors.length; n++) {
    const [leftIndex, left] = anchors[n - 1]!,
      [rightIndex, right] = anchors[n]!;
    if (
      rightIndex - leftIndex < 2 ||
      rightIndex - leftIndex > 34 ||
      tokens[left.first]!.trackId !== tokens[right.last]!.trackId
    )
      continue;
    const expected = normalized.slice(leftIndex, rightIndex + 1).flat();
    if (
      expected.length > 768 ||
      right.last - left.first > expected.length * 1.3 + 8
    )
      continue;
    const context = nearMatch(expected, tokens, left.first, {
      begin: left.first,
      end: right.last + 1,
    });
    if (!context || context.first !== left.first || context.last !== right.last)
      continue;
    let sourceOffset = normalized[leftIndex]!.length;
    for (let i = leftIndex + 1; i < rightIndex; i++) {
      const words = normalized[i]!,
        mapping = context.mapping.slice(
          sourceOffset,
          sourceOffset + words.length,
        );
      sourceOffset += words.length;
      const observed = mapping.filter((value) => value >= 0),
        first = observed[0],
        last = observed.at(-1);
      if (first === undefined || last === undefined || !words.length) continue;
      const score = observed.length / Math.max(words.length, last - first + 1);
      if (score < 0.88 || (words.length < 6 && score !== 1)) continue;
      // Exact duplicates inside this gap require their complete occurrence count.
      // Otherwise one spoken "yes" could be assigned to either printed "yes".
      const key = words.join(" ");
      const copies = normalized
        .slice(leftIndex + 1, rightIndex)
        .filter((w) => w.join(" ") === key).length;
      let occurrences = 0;
      for (let j = left.last + 1; j + words.length <= right.first; j++)
        if (words.every((word, k) => tokens[j + k]!.token === word))
          occurrences++;
      if (occurrences > copies) continue;
      if (words.length < 6 || (counts.get(key) ?? 0) > 1) {
        if (occurrences !== copies) continue;
      } else {
        // A contextual pass must not reintroduce a globally ambiguous line when
        // multiple equally plausible occurrences remain between these anchors.
        const options = matchOptions
          .get(i)
          ?.filter(
            (option) => option.first > left.last && option.last < right.first,
          );
        if (
          !options?.length ||
          options.some(
            (option) =>
              (option.first !== first || option.last !== last) &&
              option.score >=
                score -
                  (option.last < first || option.first > last ? 0.04 : 1e-9),
          )
        )
          continue;
      }
      accepted.set(i, { first, last, score, mapping });
    }
  }
  const segments: GeneratedAlignedSegment[] = [];
  let matchedWords = 0;
  previousEnd = -1;
  for (const [index, best] of [...accepted.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const passage = input.publication.passages[index]!,
      first = tokens[best.first]!,
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
    matchedWords += normalized[index]!.length;
  }
  if (!segments.length)
    throw new Error(
      "No sufficiently clear, unique passages matched this ebook and recording. Try the same unabridged edition.",
    );
  const snapshot: GeneratedAlignmentSnapshot = {
    version: 1,
    source: "generated",
    algorithm: "avid-word-match-v2",
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
