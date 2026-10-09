import type { ReadingAnchor } from "../../../packages/core/src/types";

/** Event time wins, including intentional backwards reading; percentage never orders devices. */
export function newestAnchor(
  local: ReadingAnchor | undefined,
  remote: ReadingAnchor | null | undefined,
): ReadingAnchor | undefined {
  if (!local) return remote ?? undefined;
  if (!remote) return local;
  if (
    local.bookId !== remote.bookId ||
    local.fileId !== remote.fileId ||
    local.kind !== remote.kind
  )
    return local;
  const localTime = Date.parse(local.updatedAt),
    remoteTime = Date.parse(remote.updatedAt);
  return Number.isFinite(remoteTime) &&
    Number.isFinite(localTime) &&
    remoteTime > localTime
    ? remote
    : local;
}
