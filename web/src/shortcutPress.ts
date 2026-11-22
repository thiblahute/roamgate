/*
 * Pressing a shortcut as the help lists it ("j", "gg", "Ctrl-d", "Shift+Tab",
 * "⌥V"): the key events a view's own handlers receive, so a shortcut picked
 * in the help (ShortcutHelp) runs as if typed there.
 */

const NAMED_KEYS: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  space: " ",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  "↑": "ArrowUp",
  "↓": "ArrowDown",
  "←": "ArrowLeft",
  "→": "ArrowRight",
};

/** The punctuation keys by their place, as the bindings name them. */
const PLACED_KEYS: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
};

const MODIFIER_WORDS: Record<string, keyof ModifierState> = {
  ctrl: "ctrlKey",
  control: "ctrlKey",
  "⌃": "ctrlKey",
  alt: "altKey",
  option: "altKey",
  opt: "altKey",
  "⌥": "altKey",
  shift: "shiftKey",
  "⇧": "shiftKey",
  cmd: "metaKey",
  command: "metaKey",
  meta: "metaKey",
  "⌘": "metaKey",
};

type ModifierState = {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
};

export type KeyPress = ModifierState & { key: string; code: string };

function codeOf(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^\d$/.test(key)) return `Digit${key}`;
  if (key === " ") return "Space";
  return key.length > 1 ? key : "";
}

function press(key: string, modifiers: ModifierState): KeyPress {
  // A capital letter is typed with Shift.
  const shiftKey =
    modifiers.shiftKey || (key.length === 1 && /[A-Z]/.test(key));
  return { ...modifiers, shiftKey, key, code: codeOf(key) };
}

/**
 * The key presses a shortcut is made of, in order; null when it is not
 * keys one can press (a count, a click, a `:command`, words).
 */
export function shortcutPresses(shortcut: string): KeyPress[] | null {
  let rest = shortcut.trim();
  if (!rest || /\s/.test(rest) || (rest.startsWith(":") && rest.length > 1))
    return null;
  const modifiers: ModifierState = {
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
  };
  let modified = false;
  for (;;) {
    // ⌥V: no separator after a symbol.
    if (/^[⌃⌥⇧⌘]/.test(rest) && rest.length > 1) {
      modifiers[MODIFIER_WORDS[rest[0]!]!] = true;
      modified = true;
      rest = rest.slice(1);
      continue;
    }
    const word = /^([a-z]+)[-+](.+)$/i.exec(rest);
    const named = word ? MODIFIER_WORDS[word[1]!.toLowerCase()] : undefined;
    if (!word || !named) break;
    modifiers[named] = true;
    modified = true;
    rest = word[2]!;
  }
  const named = NAMED_KEYS[rest.toLowerCase()] ?? NAMED_KEYS[rest];
  if (named) return [press(named, modifiers)];
  const placed = PLACED_KEYS[rest];
  if (placed) return [{ ...press(placed, modifiers), code: rest }];
  if (/^F\d{1,2}$/.test(rest)) return [press(rest, modifiers)];
  if (modified) {
    if ([...rest].length !== 1) return null;
    // Alt and Cmd letters are matched by their key's place (KeyV).
    return [press(rest.length === 1 ? rest.toLowerCase() : rest, modifiers)];
  }
  const keys = [...rest];
  // A sequence (gg, za, g;) is short; longer words are no keys.
  if (keys.length > 3 || /^\d\d/.test(rest)) return null;
  if (keys.length > 1 && /[()]/.test(rest)) return null;
  if (keys.length > 1 && /^\d/.test(rest)) return null;
  return keys.map((key) => press(key, modifiers));
}

/** Presses the keys on `target`, each a keydown then a keyup, bubbling. */
export function pressShortcut(target: EventTarget, presses: KeyPress[]) {
  for (const each of presses) {
    const init: KeyboardEventInit = {
      ...each,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  }
}
