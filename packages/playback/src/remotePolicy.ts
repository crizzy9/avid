import type { PlaybackBook, PlaybackSnapshot } from "./types";
export interface RemoteSkipPolicy {
  mode: "time" | "chapter";
  /** Legacy symmetric interval; retained for older saved policies and bridges. */
  seconds: number;
  backwardSeconds?: number;
  forwardSeconds?: number;
}
export const defaultRemotePolicy: RemoteSkipPolicy = {
  mode: "time",
  seconds: 30,
};
export const remotePolicyKey = "avid.audio.remote-policy.v1";
export function normalizeRemotePolicy(
  value: Partial<RemoteSkipPolicy> | null | undefined,
): RemoteSkipPolicy {
  return {
    mode: value?.mode === "chapter" ? "chapter" : "time",
    seconds: Number.isFinite(value?.seconds)
      ? Math.max(1, Math.min(300, Math.round(value!.seconds!)))
      : 30,
    ...(value?.backwardSeconds !== undefined || value?.forwardSeconds !== undefined ? {
      backwardSeconds: interval(value.backwardSeconds, value.seconds, 15),
      forwardSeconds: interval(value.forwardSeconds, value.seconds, 30),
    } : {}),
  };
}
function interval(value: number | undefined, legacy: number | undefined, fallback: number): number {
  const candidate = Number.isFinite(value) ? value! : Number.isFinite(legacy) ? legacy! : fallback;
  return Math.max(1, Math.min(300, Math.round(candidate)));
}
/** Source seconds; acceleration and future DSP never scale a seek interval. */
export function remoteSkipSeconds(policy: RemoteSkipPolicy, direction: 1 | -1): number {
  return interval(direction < 0 ? policy.backwardSeconds : policy.forwardSeconds, policy.seconds, direction < 0 ? 15 : 30);
}
export function readRemotePolicy(
  storage?: Pick<Storage, "getItem">,
): RemoteSkipPolicy {
  try {
    return normalizeRemotePolicy(
      JSON.parse(storage?.getItem(remotePolicyKey) ?? "null"),
    );
  } catch {
    return { ...defaultRemotePolicy };
  }
}
export function remoteSkipPosition(
  book: PlaybackBook | null,
  state: PlaybackSnapshot,
  direction: 1 | -1,
  policy: RemoteSkipPolicy,
): number {
  if (policy.mode === "chapter" && book?.chapters?.length) {
    // A chapter's display interval can end before the next starts. Remote commands
    // still navigate by source starts, including gaps and the exact end of a book.
    let index = -1;
    for (let i = 0; i < book.chapters.length; i++)
      if (book.chapters[i]!.start <= state.currentTime) index = i;
      else break;
    const current = book.chapters[index];
    if (direction < 0)
      return current && state.currentTime - current.start > 3
        ? current.start
        : (book.chapters[Math.max(0, index - 1)]?.start ?? 0);
    const next = book.chapters[index + 1];
    if (next) return next.start;
  }
  return Math.max(
    0,
    Math.min(
      state.duration || Infinity,
      state.currentTime + direction * remoteSkipSeconds(policy, direction),
    ),
  );
}
