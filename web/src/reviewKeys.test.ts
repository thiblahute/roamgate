import { expect, test } from "bun:test";
import {
  defaultShortcutBindings,
  matchesShortcut,
  type ShortcutId,
} from "./shortcutBindings";
import { reviewKeyRoute } from "./reviewKeys";

function press(
  key: string,
  code: string,
  modifiers: { alt?: boolean; ctrl?: boolean; shift?: boolean } = {},
) {
  const bindings = defaultShortcutBindings("mac");
  const event = {
    type: "keydown",
    key,
    code,
    altKey: !!modifiers.alt,
    ctrlKey: !!modifiers.ctrl,
    metaKey: false,
    shiftKey: !!modifiers.shift,
  };
  return (id: ShortcutId) => matchesShortcut(event, id, bindings, "mac");
}

test("Option-F reaches the overlay tab from inside the review, which stays", () => {
  // Option-F on a Mac types "ƒ"; the key's code still names it.
  expect(reviewKeyRoute(press("ƒ", "KeyF", { alt: true }), false)).toBe("app");
  expect(reviewKeyRoute(press("ƒ", "KeyF", { alt: true }), true)).toBe("app");
});

test("Option-Shift-F reaches the overlay only while it shows", () => {
  const fullscreen = press("Ï", "KeyF", { alt: true, shift: true });
  expect(reviewKeyRoute(fullscreen, true)).toBe("app");
  expect(reviewKeyRoute(fullscreen, false)).toBe("review");
});

test("the review keeps its own keys and leaves for another workspace", () => {
  expect(reviewKeyRoute(press("j", "KeyJ"), true)).toBe("review");
  expect(reviewKeyRoute(press("Escape", "Escape"), true)).toBe("review");
  expect(reviewKeyRoute(press("®", "KeyR", { alt: true }), false)).toBe("app");
  expect(reviewKeyRoute(press("Tab", "Tab", { ctrl: true }), false)).toBe(
    "leave",
  );
});
