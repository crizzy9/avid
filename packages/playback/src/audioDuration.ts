/** Exact millisecond metadata and decoder timestamp quantization. */
export const EXACT_AUDIO_DURATION_PRECISION_SECONDS = 0.002;

/**
 * BookOrbit 3.3/3.4 stores per-file ffprobe duration as rounded integer seconds.
 * Generated matching preserves that canonical timeline, while recognizing only
 * observed audio inside it. This is a metadata consistency check, not a clock
 * conversion, codec-padding allowance, or substitute for source-byte identity.
 */
export function generatedDurationCompatible(
  canonical: number,
  observed: number,
): boolean {
  if (
    !Number.isFinite(canonical) ||
    canonical <= 0 ||
    !Number.isFinite(observed) ||
    observed <= 0
  )
    return false;
  const tolerance = Number.isInteger(canonical)
    ? 0.5 + EXACT_AUDIO_DURATION_PRECISION_SECONDS
    : EXACT_AUDIO_DURATION_PRECISION_SECONDS;
  return (
    Math.abs(observed - canonical) <=
    tolerance + Number.EPSILON * Math.max(canonical, observed)
  );
}
