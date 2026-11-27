import { expect, test } from "bun:test";

// CSS contract tests for a narrow message box (Ranger docked at ~640px or
// 420px, a small pane): the box keeps Send beside it while it has 200px,
// and only below that do the buttons wrap into a toolbar under it. Painted layout is checked in
// Chrome; happy-dom has no layout.
const css = await Bun.file(
  new URL("./AgentHistoryComposer.css", import.meta.url),
).text();
const tsx = await Bun.file(
  new URL("./AgentHistoryComposer.tsx", import.meta.url),
).text();

/** The body of the `@container agent-composer (max-width: <px>px)` block. */
function block(maxWidth: number) {
  const head = `@container agent-composer (max-width: ${maxWidth}px) {`;
  const start = css.indexOf(head);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let at = start + head.length - 1; at < css.length; at++) {
    if (css[at] === "{") depth++;
    else if (css[at] === "}" && --depth === 0)
      return css.slice(start + head.length, at);
  }
  throw new Error("unclosed container block");
}

function rule(body: string, selector: string) {
  const start = body.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return body.slice(start, body.indexOf("}", start) + 1);
}

test("the box is a container, so its own width decides, not the screen", () => {
  expect(css).toContain("container: agent-composer / inline-size;");
});

test("below 720px the editor keeps Send beside it until it would go under 200px", () => {
  const narrow = block(719);
  expect(
    rule(
      narrow,
      ".agent-history-composer:not(.is-mobile) .agent-history-composer-row",
    ),
  ).toContain("flex-wrap: wrap;");
  const field = narrow.slice(
    narrow.indexOf("> .agent-history-composer-field {"),
  );
  const body = field.slice(0, field.indexOf("}"));
  // No line under the box for Send alone; the box wraps above when narrow.
  expect(body).toContain("flex: 1 1 200px;");
  expect(body).toContain("order: -1;");
});

test("the narrow editor is at least two lines high", () => {
  const narrow = block(719);
  expect(narrow).toContain("min-height: 52px;");
});

test("Stop, Queue and Send gather at the toolbar's end", () => {
  const narrow = block(719);
  expect(narrow).toContain("margin-left: auto;");
  expect(narrow).toContain("margin-left: 0;");
});

test("the phone's docked box keeps its own layout", () => {
  for (const width of [719, 339, 259])
    expect(block(width)).not.toMatch(/\.agent-history-composer\s/);
  expect(block(719)).toContain(".agent-history-composer:not(.is-mobile)");
});

test("labels drop to icons when the toolbar is too narrow", () => {
  expect(block(339)).toContain(
    ".agent-history-composer-queue\n    .agent-history-composer-label",
  );
  expect(block(339)).toContain("display: none;");
  expect(block(259)).toContain("display: none;");
  // The buttons keep their names for screen readers and titles.
  expect(tsx).toContain('aria-label="Queue"');
  expect(tsx).toContain('className="agent-history-composer-label"');
});
