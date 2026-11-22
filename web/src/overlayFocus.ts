import { activeTerminalInput } from "./activeTerminalInput";

/**
 * Puts the keyboard in a shown overlay tab. Showing it only flips its
 * visibility, and the terminal's own activation focus gives way to a chat's
 * message box, another field or an open menu, so the shortcut pressed from a
 * chat left the keys there. This runs once per show instead: it waits for the
 * frame to be visible and its pane to have an input (the first show creates
 * the tab and attaches it), then focuses that input. It stops when the input
 * has the keyboard, the overlay is hidden, or the user put focus somewhere
 * else meanwhile.
 */

export type OverlayFocusStep = "done" | "focus" | "wait" | "abandon";

type FocusTarget = Pick<HTMLElement, "focus">;

function takesTyping(element: Element | null) {
  if (!element) return false;
  if (element.closest(".xterm")) return element.tagName === "TEXTAREA";
  return (
    element.tagName === "TEXTAREA" ||
    element.tagName === "INPUT" ||
    (element as HTMLElement).isContentEditable === true
  );
}

/** What one attempt does, given where the keyboard is now. */
export function overlayFocusStep(
  frame: Element | null,
  frameVisible: boolean,
  input: FocusTarget | null,
  active: Element | null,
  origin: Element | null,
  body: Element | null,
): OverlayFocusStep {
  const inFrame = !!frame && !!active && frame.contains(active);
  if (inFrame && takesTyping(active)) return "done";
  // Focus moved since the shortcut, and not by this: the user chose a place.
  if (!inFrame && active !== origin && active !== body && active !== null)
    return "abandon";
  if (!frame || !frameVisible || !input) return "wait";
  return "focus";
}

export type OverlayFocusEnvironment = {
  document: Document;
  /** The shown overlay's frame, or null while it is not mounted or shown. */
  frame: () => Element | null;
  /**
   * The input of the overlay's active pane: its xterm's textarea, or its
   * chat's message box; null while it has none. Not the pane's view: once
   * focused, focusing it again would not hand over to xterm when it opens.
   */
  input: () => FocusTarget | null;
  /** Whether the overlay is still meant to be shown. */
  open: () => boolean;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  now: () => number;
};

/** Gives up after this long: a slow first attach still gets the keyboard. */
export const OVERLAY_FOCUS_TIMEOUT_MS = 5000;

/** Starts focusing the shown overlay; returns a cancel function. */
export function focusShownOverlay(env: OverlayFocusEnvironment): () => void {
  const doc = env.document;
  const origin = doc.activeElement;
  const deadline = env.now() + OVERLAY_FOCUS_TIMEOUT_MS;
  let handle = 0;
  let cancelled = false;
  const attempt = () => {
    if (cancelled || !env.open() || env.now() > deadline) return;
    const frame = env.frame();
    const view = doc.defaultView;
    const visible =
      !!frame &&
      (!view || view.getComputedStyle(frame).visibility !== "hidden");
    const input = env.input();
    const step = overlayFocusStep(
      frame,
      visible,
      input,
      doc.activeElement,
      origin,
      doc.body,
    );
    if (step === "done" || step === "abandon") return;
    if (step === "focus") input?.focus({ preventScroll: true });
    // Check on the next frame that the input kept the keyboard.
    handle = env.requestFrame(attempt);
  };
  handle = env.requestFrame(attempt);
  return () => {
    cancelled = true;
    env.cancelFrame(handle);
  };
}

/** The input of the shown overlay's active pane, for `focusShownOverlay`. */
export function overlayPaneInput(root: Document): HTMLElement | null {
  const frame = root.querySelector(".overlay-tab[data-open]");
  const input = frame ? activeTerminalInput(root) : null;
  if (!frame || !input || !frame.contains(input)) return null;
  return input.classList.contains("terminal-view")
    ? input.querySelector<HTMLElement>(".xterm-helper-textarea")
    : input;
}
