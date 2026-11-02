import { bridge } from "./api";
import { isCompanionVoice } from "./companionCall";
import { callCompanion } from "./companionCallOpen";
import { terminalComposerBusy } from "./terminalComposer";
import {
  rememberCallForReload,
  takeCallAfterReload,
  voiceCallReloadState,
} from "./voiceCallReload";
import { voiceTrace } from "./voiceChat";
import { handOffVoice } from "./voiceRoute";

/** The hashed entry script an index page loads, e.g. `/assets/index-Ab12.js`. */
export function entryScript(html: string): string | null {
  return /\/assets\/index-[\w-]+\.js/.exec(html)?.[0] ?? null;
}

type FreshnessOptions = {
  /** Calls back each time the bridge connects; returns an unsubscribe. */
  onConnected?: (callback: () => void) => () => void;
  /** The index page the server serves now. */
  fetchIndex?: () => Promise<string | null>;
  reload?: () => void;
  /** The page's voice call: a reload waits for a moment between turns. */
  voiceCall?: () => "none" | "safe" | "busy";
  trace?: (line: string) => void;
  /** Starts a call with the companion again (companionCallOpen.ts). */
  resumeCompanion?: () => void;
};

async function fetchServedIndex() {
  const response = await fetch("/", {
    cache: "no-store",
    credentials: "same-origin",
  });
  return response.ok ? response.text() : null;
}

/**
 * Why a reload would lose something now, or null. Blurring a field does
 * not save its contents.
 */
function writing(): string | null {
  if (terminalComposerBusy()) return "the composer is sending";
  if (document.querySelector('[role="dialog"], [role="alertdialog"]'))
    return "a dialog is open";
  const field = [
    ...document.querySelectorAll("input, textarea, [contenteditable]"),
  ].some((field) => {
    if (
      field instanceof HTMLInputElement ||
      field instanceof HTMLTextAreaElement
    ) {
      if (field.disabled || field.readOnly) return false;
      if (
        field instanceof HTMLInputElement &&
        /^(button|submit|reset|checkbox|radio|range|color|hidden)$/.test(
          field.type,
        )
      )
        return false;
      return field.value !== "";
    }
    return (
      field.getAttribute("contenteditable") !== "false" && !!field.textContent
    );
  });
  return field ? "a field holds text" : null;
}

/**
 * Reloads the page when the server now serves another frontend build. Without
 * it an open page keeps running the old code against the new server after an
 * upgrade made outside this page (another browser, a package manager, a
 * development deploy that keeps the version). Checked when the bridge
 * reconnects (a restart drops it) and when the page comes back to the
 * foreground (a phone reopening its installed app restores the page without
 * reloading it). A field holding unsent text delays the reload until it is
 * emptied or saved. Uploads and submissions must also finish first. A page
 * in a voice call reloads between turns only, and the call goes on in the
 * reloaded page (voiceCallReload.ts).
 */
export function startFrontendFreshness({
  onConnected = (callback) =>
    bridge.onStatus((status) => {
      if (status === "connected") callback();
    }),
  fetchIndex = fetchServedIndex,
  reload = () => window.location.reload(),
  voiceCall = voiceCallReloadState,
  trace = voiceTrace,
  resumeCompanion = callCompanion,
}: FreshnessOptions = {}): () => void {
  // A call cut by the last reload goes on, once its pane shows.
  const back = takeCallAfterReload();
  if (back && isCompanionVoice(back)) {
    // A call with the companion belongs to no pane: it starts again.
    trace("a newer build: the call with the companion goes on");
    resumeCompanion();
  } else if (back) {
    trace(`a newer build: the voice call goes on in ${back.paneId}`);
    handOffVoice({ ...back, message: null });
  }
  const running = entryScript(
    document.querySelector<HTMLScriptElement>(
      'script[type="module"][src*="/assets/index-"]',
    )?.src ?? "",
  );
  // A development server (Vite) has no hashed entry: nothing to compare.
  if (!running) return () => {};
  let checking = false;
  let stale = false;
  let reloading = false;
  let disposed = false;
  let retry: ReturnType<typeof setInterval> | undefined;
  let waitingFor: string | null = null;
  const reloadWhenFree = () => {
    if (disposed || reloading) return;
    const call = voiceCall();
    const reason = call === "busy" ? "a pause in the voice call" : writing();
    if (reason) {
      if (reason !== waitingFor)
        trace(`a newer build is available: the reload waits for ${reason}`);
      waitingFor = reason;
      stale = true;
      retry ??= setInterval(reloadWhenFree, 1000);
      return;
    }
    clearInterval(retry);
    reloading = true;
    if (call === "safe") {
      rememberCallForReload();
      trace("a newer build is available: reloading between turns");
    } else trace("a newer build is available: reloading");
    reload();
  };
  const onWritingEnds = () => {
    if (stale) setTimeout(reloadWhenFree, 0);
  };
  document.addEventListener("focusout", onWritingEnds, true);
  document.addEventListener("input", onWritingEnds, true);
  const check = async () => {
    if (disposed || checking || reloading) return;
    checking = true;
    try {
      const html = await fetchIndex();
      const served = html ? entryScript(html) : null;
      if (served && served !== running) reloadWhenFree();
    } catch {
      // Unreachable for now: the next reconnect checks again.
    } finally {
      checking = false;
    }
  };
  const offConnected = onConnected(() => void check());
  const onVisible = () => {
    if (document.visibilityState === "visible") void check();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    disposed = true;
    clearInterval(retry);
    offConnected();
    document.removeEventListener("visibilitychange", onVisible);
    document.removeEventListener("focusout", onWritingEnds, true);
    document.removeEventListener("input", onWritingEnds, true);
  };
}
