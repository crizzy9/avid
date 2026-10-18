import {
  assertStandaloneAlignment,
  type AlignmentEdition,
  type StandaloneAlignedSegment,
  type VerifiedAudioAlignment,
} from "../../playback/src/standalone-alignment";
import { textAtAudioTime } from "../../playback/src/alignment";
import type { AlignedPassageText } from "./alignedPassage";
import { passageElement } from './generatedText';

export const AUDIO_HIGHLIGHT_CLASS = "avid-audio-active";
export interface ReadAlongPort {
  /** Must establish account, file and full SHA-256 identity of the currently parsed EPUB. */
  validate(
    map: VerifiedAudioAlignment,
    edition: AlignmentEdition,
  ): Promise<void>;
  timedText(
    map: VerifiedAudioAlignment,
    edition: AlignmentEdition,
  ): Promise<readonly AlignedPassageText[]>;
  contents(): readonly { doc: Document | null; index: number }[];
  navigate(locator: string): Promise<unknown>;
}

/** Owns one highlight, never an audio clock, playback state or persisted checkpoint. */
export class ReadAlongHighlighter {
  private generation = 0;
  private closed = false;
  private target: {
    map: VerifiedAudioAlignment;
    segment: StandaloneAlignedSegment;
    line: AlignedPassageText;
    follow: boolean;
  } | null = null;
  private marked = new Set<Element>();
  private readonly owner = crypto.randomUUID();
  private navigation: Promise<unknown> = Promise.resolve();
  private followed: { map: VerifiedAudioAlignment; segmentId: string } | null =
    null;
  constructor(private readonly port: ReadAlongPort) {}

  async update(
    map: VerifiedAudioAlignment,
    edition: AlignmentEdition,
    seconds: number,
    options: { follow: boolean },
  ): Promise<AlignedPassageText | null> {
    const generation = ++this.generation;
    if (this.closed)
      throw new Error("The aligned reader is no longer available.");
    try {
      assertStandaloneAlignment(map, edition);
      await this.port.validate(map, edition);
    } catch (error) {
      if (generation === this.generation) this.reset();
      throw error;
    }
    if (generation !== this.generation || this.closed) return null;
    const segment =
      Number.isFinite(seconds) && seconds >= 0
        ? (textAtAudioTime(map, seconds) as StandaloneAlignedSegment | null)
        : null;
    if (!segment) {
      this.reset();
      return null;
    }
    let lines: readonly AlignedPassageText[];
    try {
      lines = await this.port.timedText(map, edition);
    } catch (error) {
      if (generation === this.generation) this.reset();
      throw error;
    }
    if (generation !== this.generation || this.closed) return null;
    const line = lines.find((item) => item.segmentId === segment.id);
    if (!line) {
      this.reset();
      return null;
    }
    this.target = { map, segment, line, follow: options.follow };
    if (!options.follow) this.followed = null;
    this.refresh();
    if (options.follow) {
      // Serialize navigation because a new tick/seek cannot cancel a renderer load.
      // Queued obsolete ticks are discarded; the newest requested passage wins.
      const navigate = async () => {
        if (
          generation !== this.generation ||
          this.closed ||
          this.target?.follow !== true
        )
          return;
        if (
          this.followed?.map !== map ||
          this.followed.segmentId !== segment.id
        ) {
          await this.port.navigate(segment.textLocator);
          if (generation !== this.generation || this.closed) return;
          this.followed = { map, segmentId: segment.id };
        }
        this.refresh();
      };
      this.navigation = this.navigation.catch(() => {}).then(navigate);
      await this.navigation;
    }
    return generation === this.generation && !this.closed ? line : null;
  }

  /** Reapply after page/section DOM replacement; holding the page never navigates it. */
  refresh(): void {
    this.removeMarks();
    const target = this.target;
    if (!target || this.closed) return;
    for (const { doc, index } of this.port.contents()) {
      if (!doc || index !== target.segment.sectionIndex) continue;
      const element = passageElement(doc, target.segment);
      if (!element) continue;
      element.classList.add(AUDIO_HIGHLIGHT_CLASS);
      element.setAttribute("data-avid-audio-segment", target.segment.id);
      element.setAttribute("data-avid-audio-owner", this.owner);
      this.marked.add(element);
    }
  }
  clear(): void {
    ++this.generation;
    this.reset();
  }
  destroy(): void {
    this.closed = true;
    this.clear();
  }
  private reset(): void {
    this.target = null;
    this.followed = null;
    this.removeMarks();
  }
  private removeMarks(): void {
    // A renderer may replace/clone a document during reflow. Its copied marker
    // no longer shares the Element reference we originally tracked.
    const marked = new Set(this.marked);
    for (const { doc } of this.port.contents())
      for (const element of doc?.querySelectorAll(
        `[data-avid-audio-owner="${this.owner}"]`,
      ) ?? [])
        marked.add(element);
    for (const element of marked) {
      element.classList.remove(AUDIO_HIGHLIGHT_CLASS);
      element.removeAttribute("data-avid-audio-segment");
      element.removeAttribute("data-avid-audio-owner");
    }
    this.marked.clear();
  }
}
