import { expect, test } from "bun:test";

// CSS contract tests for a chat's comments on a phone: the part tapped
// shows its + on the screen, a finger wide, beside its text and not on it.
// Painted layout is checked on a device (or a phone-sized Chrome).
const threads = await Bun.file(
  new URL("./ChatThreads.css", import.meta.url),
).text();
const notes = await Bun.file(
  new URL("./ReviewNoteBody.css", import.meta.url),
).text();

const TOUCH = "@media (hover: none) and (pointer: coarse) {";

/** The body of the touch block. */
function touchBlock() {
  const start = threads.indexOf(TOUCH);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let at = start + TOUCH.length - 1; at < threads.length; at++) {
    if (threads[at] === "{") depth++;
    else if (threads[at] === "}" && --depth === 0)
      return threads.slice(start + TOUCH.length, at);
  }
  throw new Error("unclosed touch block");
}

function rule(css: string, selector: string) {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start) + 1);
}

function px(body: string, property: string) {
  const found = new RegExp(`(?:^|[\\s;{])${property}:\\s*(-?\\d+)px`).exec(
    body,
  );
  expect(found).not.toBeNull();
  return Number(found![1]);
}

/** The value a declaration sets, spaces folded. */
function value(body: string, property: string) {
  const found = new RegExp(`(?:^|[\\s;{])${property}:\\s*([^;]+);`).exec(body);
  expect(found).not.toBeNull();
  return found![1]!.replace(/\s+/g, " ").trim();
}

// A phone's chat (AgentHistoryDrawer.css on touch screens): content padding
// 6px, bubble padding 9px. A message's part starts that far in.
const PART_LEFT = 6 + 9;

test("the + of the part tapped stays on a narrow screen, 44px wide and high", () => {
  const block = touchBlock();
  const add = rule(block, ".chat-review .rc-part > .rc-part-add");
  const left = px(add, "--rc-add-left");
  expect(value(add, "left")).toBe(
    "calc(var(--rc-depth, 0) * 1.4em + var(--rc-add-left))",
  );
  const size = px(add, "width");
  expect(px(add, "height")).toBe(size);
  expect(size).toBeGreaterThanOrEqual(44);
  // Its whole target, transparent border included, is on the screen.
  expect(PART_LEFT + left).toBeGreaterThanOrEqual(0);
  // The + drawn inside its border, a finger's mark, is inside the part.
  const border = Number(/border:\s*(\d+)px solid transparent/.exec(add)?.[1]);
  expect(value(add, "background-clip")).toBe("padding-box");
  expect(left + border).toBeGreaterThanOrEqual(0);
  expect(size - 2 * border).toBeGreaterThanOrEqual(20);
  // Above the parts after it, which would take the taps on its lower half.
  expect(value(add, "z-index")).toBe("1");
});

test("the part tapped makes room for its +: the target ends before the text", () => {
  const block = touchBlock();
  const add = rule(block, ".chat-review .rc-part > .rc-part-add");
  const focused = rule(block, ".chat-review .rc-part.is-focused");
  expect(value(focused, "padding-left")).toMatch(
    /^calc\(var\(--rc-depth, 0\) \* 1\.4em \+ \d+px\)$/,
  );
  const gutter = Number(
    /\+ (\d+)px\)$/.exec(value(focused, "padding-left"))![1],
  );
  expect(px(add, "--rc-add-left") + px(add, "width")).toBeLessThanOrEqual(
    gutter,
  );
  // A table scrolls sideways (overflow clips): its cell's + stays inside.
  const cellAdd = rule(block, ".chat-review .rc-table .rc-part > .rc-part-add");
  expect(px(cellAdd, "--rc-add-left")).toBe(0);
  const cell = rule(block, ".chat-review .rc-table .rc-part.is-focused");
  expect(px(cell, "padding-left")).toBeGreaterThanOrEqual(px(add, "width"));
});

test("only the part tapped has a + to hit; none waits invisible over the text", () => {
  const block = touchBlock();
  expect(
    value(rule(block, ".chat-review .rc-part > .rc-part-add"), "visibility"),
  ).toBe("hidden");
  expect(
    value(
      rule(block, ".chat-review .rc-part.is-focused > .rc-part-add"),
      "visibility",
    ),
  ).toBe("visible");
});

test("with a mouse the + sits in the message's gutter, inside the bubble, beside the text", () => {
  const outside = threads.slice(0, threads.indexOf(TOUCH));
  const size = px(rule(notes, ".rc-part-add"), "width");
  const gutter = px(
    rule(outside, ".chat-review .rc-text:has(.rc-part-add)"),
    "padding-left",
  );
  const left = px(
    rule(outside, ".chat-review .rc-part > .rc-part-add"),
    "left",
  );
  // From the bubble's text box: its padding (11px on a desktop chat, a
  // thread card's 8px) is room enough, its border is not crossed.
  expect(gutter + left).toBeGreaterThanOrEqual(-8);
  // It ends before the part's text starts.
  expect(gutter + left + size).toBeLessThanOrEqual(gutter);
  // A table's cell keeps its + inside (the table clips what overflows).
  expect(
    px(rule(outside, ".chat-review .rc-table .rc-part > .rc-part-add"), "left"),
  ).toBeGreaterThanOrEqual(0);
  // The part j / k is on is drawn as before.
  expect(
    px(rule(outside, ".chat-review .rc-part.is-focused"), "padding-left"),
  ).toBe(8);
  // A phone keeps no gutter: the part tapped makes its own.
  expect(
    value(
      rule(touchBlock(), ".chat-review .rc-text:has(.rc-part-add)"),
      "padding-left",
    ),
  ).toBe("0");
});

test("the comments' buttons and Comment on a selection take a finger's 44px", () => {
  const block = touchBlock();
  // The bar is 44px high, its buttons' targets fill it.
  expect(px(rule(block, ".chat-thread-bar"), "min-height")).toBe(44);
  const target = rule(block, ".chat-thread-bar button::before");
  expect(value(target, "position")).toBe("absolute");
  // A 20px button, 12px more above and below: 44px.
  expect(value(target, "inset")).toBe("-12px -2px");
  expect(px(rule(block, ".chat-thread-select"), "min-height")).toBe(44);
  expect(px(rule(block, ".chat-thread.is-folded"), "min-height")).toBe(44);
});
