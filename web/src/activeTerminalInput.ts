import type { PointerEvent } from "react";

/** The Message box's Vim editor takes the keys in its content. */
function typingField(box: HTMLElement | null | undefined) {
  if (!box?.classList.contains("terminal-composer-vim")) return box ?? null;
  return box.querySelector<HTMLElement>(".cm-content") ?? box;
}

export function activeTerminalInput(root: ParentNode): HTMLElement | null {
  // A shown overlay tab takes the keyboard; a hidden one never does.
  const scope =
    root.querySelector<HTMLElement>(".overlay-tab[data-open]") ??
    root.querySelector<HTMLElement>(".workspace-terminal-surface") ??
    root;
  const shell = scope.querySelector<HTMLElement>(
    ".pane-layout-cell.is-active .terminal-shell, .workspace-terminal-surface > .terminal-shell, .overlay-tab-surface > .terminal-shell",
  );
  if (!shell) return null;
  const editor = shell.dataset.paneId
    ? Array.from(
        root.querySelectorAll<HTMLElement>(
          '.mobile-bottom-bar .terminal-composer[data-open][data-input-mode="composer"]',
        ),
      ).find((composer) => composer.dataset.paneId === shell.dataset.paneId)
    : undefined;
  return (
    typingField(
      editor?.querySelector<HTMLElement>(".terminal-composer-input") ??
        shell.querySelector<HTMLElement>(
          ".terminal-composer-input:not([hidden])",
        ),
    ) ??
    // A pane shown as a chat takes keys in its message box.
    shell.querySelector<HTMLElement>(
      ".terminal-chat-layer .agent-history-composer :is(textarea, [contenteditable='true'])",
    ) ??
    shell.querySelector<HTMLElement>(".terminal-view") ??
    null
  );
}

export function blurActiveInput(event: PointerEvent<HTMLButtonElement>) {
  // A compact-row gesture may be a horizontal pan. Dismiss input only once
  // its native click handler confirms navigation, not at the start of a swipe.
  if (
    event.currentTarget.closest(
      ".app[data-mobile-controls-compact] .mobile-controls-stack",
    )
  )
    return;
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  const button = event.currentTarget;
  window.setTimeout(() => button.blur(), 0);
}
