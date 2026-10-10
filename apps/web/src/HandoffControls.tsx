import { useReadAlongI18n } from "./readAlongMessages";
import type { HandoffPolicy } from "./readAlongState";

export function HandoffControls({
  policy,
  onPolicy,
  preview,
  onPreview,
  onConfirm,
}: {
  policy: HandoffPolicy;
  onPolicy: (policy: HandoffPolicy) => void;
  preview?: boolean;
  onPreview?: (preview: boolean) => void;
  onConfirm?: () => void;
}) {
  const t = useReadAlongI18n();
  return (
    <div className="read-along-settings">
      <label>
        {t("policy")}{" "}
        <select
          value={policy}
          onChange={(event) => onPolicy(event.target.value as HandoffPolicy)}
        >
          <option value="manual">{t("manual")}</option>
          <option value="latest">{t("latest")}</option>
          <option value="separate">{t("separate")}</option>
        </select>
      </label>
      {onPreview && (
        <label className="read-along-check">
          <input
            type="checkbox"
            checked={preview}
            onChange={(event) => onPreview(event.target.checked)}
          />
          {t("preview")}
        </label>
      )}
      {preview && onConfirm && (
        <button type="button" className="reader-secondary" onClick={onConfirm}>
          {t("confirm")}
        </button>
      )}
      <p>{t("hint")}</p>
    </div>
  );
}
