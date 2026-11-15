/** Returns false while the target is unmounted; otherwise consumes the request. */
export function focusIfUnchanged(
  target: HTMLElement | null,
  source: Element | null,
): boolean {
  if (!target) return false;
  const document = target.ownerDocument;
  if (
    document.activeElement === source ||
    (source && !source.isConnected && document.activeElement === document.body)
  ) {
    target.focus({ preventScroll: true });
  }
  return true;
}

export function focusDialogElement(
  element: HTMLElement | null,
  options: { select?: boolean } = {},
) {
  const timers: number[] = [];
  const frames: number[] = [];

  const focus = () => {
    if (!element?.isConnected) return;
    element.focus({ preventScroll: true });
    if (options.select && element instanceof HTMLInputElement) {
      element.select();
    }
  };

  focus();
  frames.push(
    window.requestAnimationFrame(() => {
      focus();
      frames.push(window.requestAnimationFrame(focus));
    }),
  );
  timers.push(window.setTimeout(focus, 0));
  timers.push(window.setTimeout(focus, 50));
  timers.push(window.setTimeout(focus, 150));

  return () => {
    for (const frame of frames) window.cancelAnimationFrame(frame);
    for (const timer of timers) window.clearTimeout(timer);
  };
}

/**
 * Keeps the focus inside `container` for `ms` after `element` took it: a
 * focus that moves out without the user (no pointer press, no key pressed
 * outside) goes back to `element`. A browser can hand the focus to the
 * page's first control once a shortcut's modifiers are released; a view
 * opened by that shortcut keeps the keys. Returns the cancel.
 */
export function holdFocus(
  element: HTMLElement,
  container: Element,
  ms = 1500,
): () => void {
  const document = element.ownerDocument;
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("pointerdown", stop, true);
    document.removeEventListener("keydown", onKeyDown, true);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.target instanceof Node) || !container.contains(event.target))
      stop();
  };
  const onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (target instanceof Node && container.contains(target)) return;
    if (!element.isConnected) return stop();
    element.focus({ preventScroll: true });
  };
  const timer = setTimeout(stop, ms);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("pointerdown", stop, true);
  document.addEventListener("keydown", onKeyDown, true);
  return stop;
}

/**
 * Where the keys go back once a view that took them closes: the element
 * they came from while it is still on the page, not the body and not inside
 * `away` (the closing view), else the input of the pane `paneId` (its
 * terminal, or its chat's message box), else nothing.
 */
export function focusReturnTarget(
  from: HTMLElement | null,
  away: string,
  paneId: string | undefined,
  root: ParentNode = document,
): HTMLElement | null {
  if (
    from?.isConnected &&
    from !== from.ownerDocument.body &&
    !from.closest(away)
  )
    return from;
  if (!paneId) return null;
  const shell = [
    ...root.querySelectorAll<HTMLElement>(".terminal-shell[data-pane-id]"),
  ].find((each) => each.dataset.paneId === paneId);
  return (
    shell?.querySelector<HTMLElement>(".xterm-helper-textarea") ??
    shell?.querySelector<HTMLElement>("textarea") ??
    null
  );
}
