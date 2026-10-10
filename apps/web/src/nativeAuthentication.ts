import type { Session } from "../../../packages/core/src/types";
import type { NativeOidcCoordinator } from "./nativeOidcCoordinator";

/** A callback must be consumed before vault restoration, which rotates its generation. */
export function startNativeAuthentication(options: {
  provider: Pick<
    NativeOidcCoordinator,
    "subscribe" | "pending" | "resume"
  > | null;
  canRestore: () => boolean;
  attempt: () => number | null;
  claimStartup: () => void;
  active: (attempt: number) => boolean;
  connect: (
    session: Session,
    readOnly: boolean,
    active: () => boolean,
  ) => Promise<void>;
  connected: () => void;
  restore: (active: () => boolean) => Promise<void>;
  error: (error: unknown) => void;
}) {
  let mounted = true;
  let listener: { remove(): Promise<void> } | undefined;
  let callbackFlight: Promise<boolean> | undefined;
  const restoreActive = () => mounted && options.canRestore();
  const complete = (): Promise<boolean> => {
    if (callbackFlight) return callbackFlight;
    const attempt = options.attempt();
    if (attempt === null || !options.provider) return Promise.resolve(false);
    const active = () => mounted && options.active(attempt);
    const promise = (async () => {
      const result = await options.provider!.resume();
      if (!result || !active()) return false;
      await options.connect(result.session, result.readOnly, active);
      if (active()) options.connected();
      return true;
    })();
    callbackFlight = promise;
    void promise
      .finally(() => {
        if (callbackFlight === promise) callbackFlight = undefined;
      })
      .catch(() => {});
    return promise;
  };
  void (async () => {
    if (options.provider) {
      listener = await options.provider.subscribe(() => {
        const attempt = options.attempt();
        void complete().catch((error) => {
          if (mounted && attempt !== null && options.active(attempt))
            options.error(error);
        });
      });
      if (!mounted) {
        await listener.remove();
        return;
      }
      if (!restoreActive()) return;
      options.claimStartup();
      // resume() shares an exchange already started by an event or StrictMode mount.
      if ((await complete()) || !restoreActive()) return;
      if ((await options.provider.pending()) || !restoreActive()) return;
    }
    if (restoreActive()) await options.restore(restoreActive);
  })().catch((error) => {
    if (restoreActive()) options.error(error);
  });
  return () => {
    mounted = false;
    void listener?.remove().catch(() => {});
  };
}
