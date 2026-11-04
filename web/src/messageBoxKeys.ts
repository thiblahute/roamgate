import { detectShortcutPlatform, type ShortcutEvent } from "./shortcutBindings";

/**
 * The message boxes: an agent chat's composer (its textarea or its
 * CodeMirror/Vim box), a terminal's composer, and a review comment's editor.
 * Typing goes there, but they are where the user lives, so the app's own
 * shortcuts (the command menu, Activity, the overlay tab...) must reach past
 * them, in Vim's insert and normal modes alike.
 */
export const MESSAGE_BOX_SELECTOR =
  ".agent-history-composer, .agent-history-composer-editor, .terminal-composer, .rc-editor";

export function inMessageBox(target: EventTarget | null) {
  return (
    !!target &&
    typeof (target as Element).closest === "function" &&
    !!(target as Element).closest(MESSAGE_BOX_SELECTOR)
  );
}

const EDITING_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
  "Enter",
  "Tab",
  "Escape",
  " ",
]);

/** Cmd (Ctrl elsewhere) with these edits text: select all, copy, paste... */
const EDITING_LETTERS = new Set(["a", "c", "v", "x", "z", "y"]);

function letter(event: ShortcutEvent) {
  const code = event.code ?? "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  return event.key.length === 1 ? event.key.toLowerCase() : "";
}

/**
 * Whether a key edits text where it is typed, so a message box keeps it: a
 * character (Shift or not), a moving or deleting key with any modifier, the
 * clipboard and undo keys, and on a Mac Ctrl+letter (Emacs-style moves).
 * Anything else (Cmd+K, Ctrl+Alt+K, Option+A, Alt+F...) is the app's.
 */
export function editsText(
  event: ShortcutEvent,
  mac = detectShortcutPlatform() === "mac",
) {
  if (EDITING_KEYS.has(event.key)) return true;
  if (!event.ctrlKey && !event.metaKey && !event.altKey) return true;
  const primary = mac ? event.metaKey : event.ctrlKey;
  const other = mac ? event.ctrlKey : event.metaKey;
  if (primary && !other && !event.altKey && EDITING_LETTERS.has(letter(event)))
    return true;
  if (mac && event.ctrlKey && !event.metaKey && !event.altKey) return true;
  return false;
}

/** A key the app may take from a message box: it edits nothing there. */
export function appKeyInMessageBox(
  event: ShortcutEvent & { target?: EventTarget | null },
  mac = detectShortcutPlatform() === "mac",
) {
  return inMessageBox(event.target ?? null) && !editsText(event, mac);
}
