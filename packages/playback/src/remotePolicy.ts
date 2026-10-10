import type { PlaybackBook, PlaybackSnapshot } from "./types";
export interface RemoteSkipPolicy {
  mode: "time" | "chapter";
  seconds: number;
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
      ? Math.max(5, Math.min(120, Math.round(value!.seconds!)))
      : 30,
  };
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
      state.currentTime + direction * policy.seconds,
    ),
  );
}
