import type { InspectorView } from "../workspaceResource";

/**
 * Arriving in a view gives the keys to what it shows, not to the header that
 * led there: the review's diff in Changes, the file's text, its rendered
 * page or the page's frame in Files, the commits in Commits, the messages in
 * History. Whatever the way in (a tab picked, a file opened from the tree or
 * from a review, a review shown, the view restored after a reload, a phone's
 * view switcher), j/k, n/p, `/` and the scrolling keys then act at once.
 *
 * The keys are only taken from nobody (the page), from the inspector's own
 * parts, or from a header bar's button. Typed text (a field, a comment
 * editor, the command palette's search, a terminal) keeps them, and so do a
 * dialog, a menu or a popover, and a header button whose menu is open. The
 * keyboard's own moves keep them too: Tab, and a tab strip's arrows stepping
 * through its tabs.
 */

/** A dialog, menu or popover the user is in: it keeps the keys. */
const KEEPS_FOCUS = [
  "[role='dialog']",
  "[role='alertdialog']",
  "[role='menu']",
  "[role='listbox']",
  "[data-radix-popper-content-wrapper]",
  ".shortcut-modal",
].join(", ");

/** The bars whose buttons lead to a view: the keys go on to the view. */
const HEADER_BARS = "header, nav, [role='tablist'], [role='toolbar']";

/** The keys a tab strip steps with: the tab stepped to keeps the focus. */
const TAB_STEP_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
]);

const NOT_TYPED = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** An element the user types in: a field, an editor, a terminal. */
export function takesTyping(element: Element): boolean {
  if (element.tagName === "TEXTAREA" || element.tagName === "SELECT")
    return true;
  if (element.tagName === "INPUT")
    return !NOT_TYPED.has((element as HTMLInputElement).type);
  return (element as HTMLElement).isContentEditable === true;
}

/** Per document: whether the last key moved the focus (Tab, a tab's step). */
const tabSteps = new WeakMap<Document, { stepping: boolean }>();

/**
 * Follows the keys that move the focus: Tab, and a tab strip's arrows (a
 * view they show leaves the focus on its tab, so they go on through the
 * tabs). Where they put the focus, it stays.
 */
export function watchTabSteps(document: Document): void {
  if (tabSteps.has(document)) return;
  const state = { stepping: false };
  tabSteps.set(document, state);
  document.addEventListener(
    "keydown",
    (event) => {
      state.stepping =
        event.key === "Tab" ||
        (TAB_STEP_KEYS.has(event.key) &&
          event.target instanceof Element &&
          !!event.target.closest("[role='tab']"));
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    () => {
      state.stepping = false;
    },
    true,
  );
}

/**
 * Whether arriving in a view may take the keys from `active`, the element
 * that has them; `scope` is the view's frame (the inspector).
 */
export function contentMayTakeFocus(
  active: Element | null,
  scope: Element | null,
): boolean {
  if (!active || !active.isConnected) return true;
  const document = active.ownerDocument;
  if (active === document.body || active === document.documentElement)
    return true;
  if (takesTyping(active)) return false;
  if (active.closest(KEEPS_FOCUS)) return false;
  if (active.getAttribute("aria-expanded") === "true") return false;
  if (tabSteps.get(document)?.stepping) return false;
  if (scope?.contains(active)) return true;
  return !!active.closest(HEADER_BARS);
}

/** Shown: not in a hidden view, and laid out. */
function shown(element: Element): boolean {
  return (
    !element.closest(".is-hidden, [hidden]") &&
    element.getClientRects().length > 0
  );
}

function first(root: ParentNode, selectors: readonly string[]) {
  for (const selector of selectors) {
    const found = [...root.querySelectorAll<HTMLElement>(selector)].find(shown);
    if (found) return found;
  }
  return null;
}

/**
 * What a file shown in Files gives the keys to, inside its preview: its
 * changes' diff, its page's frame, its text's editor, its rendered
 * Markdown or diagram, else the preview; null while it is read.
 */
export function filePreviewContent(preview: Element): HTMLElement | null {
  if (preview.querySelector(".file-preview-file-content .file-loading-spinner"))
    return null;
  return first(preview, [
    ".file-preview-changes .diff-content-view",
    ".file-preview-file-content iframe",
    ".file-preview-code .cm-content",
    ".file-preview-markdown",
    ".file-preview-mermaid",
    ".file-preview-file-content",
  ]);
}

/**
 * The content a view of the inspector (`host`) gives the keys to, once it
 * is drawn; null until then. `file`: Files shows a file (else its tree).
 */
export function inspectorViewContent(
  host: Element,
  view: InspectorView,
  options: { file: boolean },
): HTMLElement | null {
  switch (view) {
    case "changes": {
      const resource = host.querySelector(".inspector-changes-resource");
      if (!resource) return null;
      // A phone's Changes shows its tree until a file is picked.
      const detail = first(resource, [".workspace-inspector-detail"]);
      return detail
        ? first(detail, [
            "section.diff-content-view[data-review-cursor]",
            "section.diff-content-view",
          ])
        : first(resource, [".diff-tree-file.is-selected", ".diff-tree-file"]);
    }
    case "files": {
      const resource = host.querySelector(".inspector-files-resource");
      if (!resource) return null;
      const preview = options.file ? first(resource, [".file-preview"]) : null;
      if (preview) return filePreviewContent(preview);
      return first(resource, [
        ".file-row[role='treeitem'][tabindex='0']",
        ".file-row[role='treeitem']",
      ]);
    }
    case "commits": {
      const resource = host.querySelector(".inspector-commits-resource");
      return resource
        ? first(resource, [".git-commit-row.is-selected", ".git-commit-row"])
        : null;
    }
    case "history": {
      const resource = host.querySelector(".inspector-history-resource");
      return resource
        ? first(resource, [".agent-history-chat", ".agent-history-content"])
        : null;
    }
    case "work":
    case "reviews":
      return host.querySelector<HTMLElement>(
        ".inspector-board-resource .mr-reviews-panel",
      );
  }
}

/** A content that is no control is focused by script only, never by Tab. */
function focusable(element: HTMLElement) {
  if (
    !element.hasAttribute("tabindex") &&
    !element.matches("iframe, button, a[href], input, select, textarea")
  )
    element.tabIndex = -1;
  return element;
}

/**
 * A page's frame focused before its page loaded: the page that loads does
 * not have the keys (the frame does, not its document); given again then.
 */
function keepInFrame(frame: HTMLIFrameElement) {
  frame.addEventListener(
    "load",
    () => {
      if (frame.ownerDocument.activeElement === frame)
        frame.contentWindow?.focus();
    },
    { once: true },
  );
}

/** How long a view's content is waited for (a large review is read first). */
export const CONTENT_FOCUS_WAIT_MS = 30_000;

export type ContentFocusEnvironment = {
  document: Document;
  /** The view's frame: the keys in it may move to its content. */
  scope: () => Element | null;
  /** The content to give the keys to, null until it is drawn. */
  target: () => HTMLElement | null;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  now: () => number;
};

/**
 * Gives the keys to a view's content once it is drawn, each frame until it
 * has them; returns the cancel. It gives up when they are somewhere that
 * keeps them (see contentMayTakeFocus), on a press or a key (the user acts),
 * or after CONTENT_FOCUS_WAIT_MS.
 */
export function focusContentOnArrival(
  env: ContentFocusEnvironment,
): () => void {
  const doc = env.document;
  watchTabSteps(doc);
  const deadline = env.now() + CONTENT_FOCUS_WAIT_MS;
  let handle = 0;
  let done = false;
  let held = 0;
  const stop = () => {
    if (done) return;
    done = true;
    env.cancelFrame(handle);
    doc.removeEventListener("pointerdown", stop, true);
    doc.removeEventListener("keydown", stop, true);
  };
  const attempt = () => {
    if (done) return;
    if (env.now() > deadline) return stop();
    const active = doc.activeElement;
    const target = env.target();
    if (target && active === target) {
      // Kept for a frame: a browser can hand the focus on after it.
      if (++held >= 2) return stop();
    } else if (!contentMayTakeFocus(active, env.scope())) return stop();
    else if (target) {
      focusable(target).focus({ preventScroll: true });
      if (target.tagName === "IFRAME") keepInFrame(target as HTMLIFrameElement);
    }
    handle = env.requestFrame(attempt);
  };
  doc.addEventListener("pointerdown", stop, true);
  doc.addEventListener("keydown", stop, true);
  handle = env.requestFrame(attempt);
  return stop;
}
