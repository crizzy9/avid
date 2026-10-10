/** Installed native shells already ship their application resources. */
export function registerOfflineShell() {
  if (
    !import.meta.env.PROD ||
    !("serviceWorker" in navigator) ||
    !["https:", "http:"].includes(location.protocol)
  )
    return;
  void navigator.serviceWorker.register("/sw.js").catch(() => {
    // Downloaded bytes remain available in an open app; the downloads screen reports shell readiness.
  });
}
