import { useEffect, useRef, useState } from "react";
import type { AlignedPassageText } from "../../../packages/readers/src/alignedPassage";
import { useReadAlongI18n } from "./readAlongMessages";
import "./read-along.css";

export function ReadAlongPanel({
  lines,
  seconds,
  onSeek,
  onUndo,
  children,
}: {
  lines: readonly AlignedPassageText[];
  seconds: number | null;
  onSeek: (seconds: number) => void;
  onUndo?: () => void;
  children?: React.ReactNode;
}) {
  const t = useReadAlongI18n();
  const [visible, setVisible] = useState(false),
    [follow, setFollow] = useState(true);
  const active = lines.find(
    (line) => seconds !== null && seconds >= line.start && seconds < line.end,
  );
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!visible || !follow || !active) return;
    // Scroll only the transcript viewport; never scroll the player/page itself.
    const container = viewport.current;
    const selected = container?.querySelector<HTMLElement>(
      '[aria-current="true"]',
    );
    if (container && selected)
      container.scrollTop =
        selected.offsetTop -
        container.clientHeight / 2 +
        selected.clientHeight / 2;
  }, [active?.segmentId, visible, follow]);
  return (
    <section className="read-along-panel" aria-label={t("lyrics")}>
      <div className="read-along-heading">
        <button
          type="button"
          className="text-button"
          aria-expanded={visible}
          onClick={() => setVisible(!visible)}
        >
          {t(visible ? "hide" : "show")}
        </button>
        {onUndo && (
          <button type="button" className="text-button" onClick={onUndo}>
            {t("undo")}
          </button>
        )}
      </div>
      {visible && (
        <>
          <label className="read-along-check">
            <input
              type="checkbox"
              checked={follow}
              onChange={(event) => setFollow(event.target.checked)}
            />
            {t("follow")}
          </label>
          {!active && <p className="read-along-gap">{t("gap")}</p>}
          <div
            className="read-along-lines"
            ref={viewport}
            tabIndex={0}
            aria-label={t("lyrics")}
          >
            {lines.map((line) => (
              <button
                type="button"
                key={line.segmentId}
                aria-current={
                  line.segmentId === active?.segmentId ? "true" : undefined
                }
                title={t("seek")}
                onClick={() => onSeek(line.start)}
              >
                {line.text}
              </button>
            ))}
          </div>
        </>
      )}
      {children}
    </section>
  );
}
