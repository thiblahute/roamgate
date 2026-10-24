import { bridge } from "./api";

/** The hashed entry script an index page loads, e.g. `/assets/index-Ab12.js`. */
export function entryScript(html: string): string | null {
  return /\/assets\/index-[\w-]+\.js/.exec(html)?.[0] ?? null;
}

/**
 * Reloads the page when the server now serves another frontend build: after a
 * rebuild that keeps the version (a development deploy), an open page would
 * otherwise keep running the old code. Checked when the bridge reconnects (a
 * restart drops it) and when the page comes back to the foreground (a phone
 * reopening its installed app restores the page without reloading it).
 */
export function startFrontendFreshness(): () => void {
  const running = entryScript(
    document.querySelector<HTMLScriptElement>(
      'script[type="module"][src*="/assets/index-"]',
    )?.src ?? "",
  );
  // A development server (Vite) has no hashed entry: nothing to compare.
  if (!running) return () => {};
  let checking = false;
  // Not while words are being written: the reload waits until the box they
  // are in is empty or left.
  let stale = false;
  const writing = () => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    const editable =
      active.isContentEditable ||
      active.tagName === "TEXTAREA" ||
      active.tagName === "INPUT";
    const text =
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLInputElement
        ? active.value
        : (active.textContent ?? "");
    return editable && text.trim() !== "";
  };
  const reloadWhenFree = () => {
    if (writing()) stale = true;
    else window.location.reload();
  };
  const onWritingEnds = () => {
    if (stale) setTimeout(() => !writing() && window.location.reload(), 0);
  };
  document.addEventListener("focusout", onWritingEnds, true);
  document.addEventListener("input", onWritingEnds, true);
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const response = await fetch("/", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const served = response.ok ? entryScript(await response.text()) : null;
      if (served && served !== running) reloadWhenFree();
    } catch {
      // Unreachable for now: the next reconnect checks again.
    } finally {
      checking = false;
    }
  };
  const offStatus = bridge.onStatus((status) => {
    if (status === "connected") void check();
  });
  const onVisible = () => {
    if (document.visibilityState === "visible") void check();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    offStatus();
    document.removeEventListener("visibilitychange", onVisible);
    document.removeEventListener("focusout", onWritingEnds, true);
    document.removeEventListener("input", onWritingEnds, true);
  };
}
