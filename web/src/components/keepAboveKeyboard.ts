/**
 * A comment box written in on a phone: its whole box, the bar with Send
 * too, stays in what the on-screen keyboard leaves of the screen. The
 * browser only keeps the caret in view, so a box opened by Reply ended with
 * its buttons under the keyboard.
 *
 * The app keeps its own height and lifts its content above the keyboard
 * (App.tsx measures the visual viewport, a padding follows a moment later),
 * so the box is brought back in view when the keyboard opens (the visual
 * viewport resizes or scrolls), when that lift lands (its scroll container
 * resizes), when it is focused, and when it grows (more text, a Vim mode
 * bar). Only with a touch screen, and only while it is written in.
 *
 * Returns what stops watching.
 */
export function keepAboveKeyboard(
  box: () => HTMLElement | null | undefined,
  writing: () => boolean,
  win: typeof window = window,
): () => void {
  let frame = 0;
  let watched: { box: Element; scroller: Element | null } | null = null;
  const resized =
    typeof win.ResizeObserver === "function"
      ? new win.ResizeObserver(() => reveal())
      : null;
  // Watch the box and the container it scrolls in, as they are now.
  const watch = (element: HTMLElement) => {
    const scroller = scrollContainer(element, win);
    if (watched?.box === element && watched.scroller === scroller) return;
    resized?.disconnect();
    resized?.observe(element);
    if (scroller) resized?.observe(scroller);
    watched = { box: element, scroller };
  };
  const reveal = () => {
    if (!win.matchMedia?.("(pointer: coarse)").matches || !writing()) return;
    win.cancelAnimationFrame(frame);
    // After the app has measured the keyboard and laid out again.
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      const element = box();
      if (!element?.isConnected || !writing()) return;
      watch(element);
      bringAboveKeyboard(element, win);
    });
  };
  const viewport = win.visualViewport;
  viewport?.addEventListener("resize", reveal);
  viewport?.addEventListener("scroll", reveal);
  win.document.addEventListener("focusin", reveal);
  return () => {
    win.cancelAnimationFrame(frame);
    resized?.disconnect();
    viewport?.removeEventListener("resize", reveal);
    viewport?.removeEventListener("scroll", reveal);
    win.document.removeEventListener("focusin", reveal);
  };
}

/** The nearest ancestor that scrolls up and down. */
function scrollContainer(
  element: Element,
  win: typeof window,
): HTMLElement | null {
  for (let at = element.parentElement; at; at = at.parentElement) {
    const overflow = win.getComputedStyle(at).overflowY;
    if (overflow === "auto" || overflow === "scroll") return at;
  }
  return null;
}

/**
 * Scrolls `box` into what its scroll container shows above the keyboard:
 * its bottom first, where Send is, when it does not all fit.
 */
export function bringAboveKeyboard(
  box: HTMLElement,
  win: typeof window = window,
) {
  const viewport = win.visualViewport;
  const scroller = scrollContainer(box, win);
  const area = scroller?.getBoundingClientRect();
  // The visual viewport, in the layout viewport's coordinates the boxes are
  // measured in: what the keyboard leaves.
  const screenTop = viewport?.offsetTop ?? 0;
  const screenBottom = screenTop + (viewport?.height ?? win.innerHeight);
  const top = Math.max(screenTop, area ? area.top + scroller!.clientTop : 0);
  const bottom = Math.min(
    screenBottom,
    area ? area.top + scroller!.clientTop + scroller!.clientHeight : Infinity,
  );
  const rect = box.getBoundingClientRect();
  const fits = rect.height <= bottom - top;
  if (rect.bottom > bottom + 1)
    box.scrollIntoView({ block: fits ? "nearest" : "end" });
  else if (rect.top < top - 1 && fits) box.scrollIntoView({ block: "nearest" });
  else return;
  // Where the app did not lift its content above the keyboard, the
  // container's bottom is under it: scroll by what the keyboard still covers.
  if (!scroller) return;
  const covered = box.getBoundingClientRect().bottom - screenBottom;
  if (covered > 1) scroller.scrollTop += covered;
}
