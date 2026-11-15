import { describe, expect, test } from "bun:test";
import { focusIfUnchanged, focusReturnTarget } from "./dialogFocus";

function fixture() {
  const source = { isConnected: true } as Element;
  const body = {} as HTMLElement;
  const document = { activeElement: source, body };
  let focused = 0;
  const target = {
    ownerDocument: document,
    focus: () => {
      focused += 1;
      document.activeElement = target;
    },
  } as unknown as HTMLElement;
  return { source, body, document, target, count: () => focused };
}

describe("deferred Inspector focus", () => {
  test("waits for the lazy target, then focuses it without repeating", () => {
    const f = fixture();
    expect(focusIfUnchanged(null, f.source)).toBe(false);
    expect(f.count()).toBe(0);
    expect(focusIfUnchanged(f.target, f.source)).toBe(true);
    expect(f.document.activeElement).toBe(f.target);
    expect(focusIfUnchanged(f.target, f.source)).toBe(true);
    expect(f.count()).toBe(1);
  });

  test("consumes the request without stealing focus from another control", () => {
    const f = fixture();
    f.document.activeElement = {} as Element;
    expect(focusIfUnchanged(f.target, f.source)).toBe(true);
    expect(f.count()).toBe(0);
  });

  test("allows a removed menu opener to fall back to body, but not a user-focused control", () => {
    const f = fixture();
    const removed = { isConnected: false } as Element;
    f.document.activeElement = {} as Element;
    expect(focusIfUnchanged(f.target, removed)).toBe(true);
    expect(f.count()).toBe(0);
    f.document.activeElement = f.body;
    expect(focusIfUnchanged(f.target, removed)).toBe(true);
    expect(f.count()).toBe(1);
  });
});

describe("where the keys go back", () => {
  const body = {} as HTMLElement;
  const element = (inside: boolean, connected = true) =>
    ({
      isConnected: connected,
      ownerDocument: { body },
      closest: () => (inside ? {} : null),
    }) as unknown as HTMLElement;
  const terminal = {} as HTMLElement;
  const root = {
    querySelectorAll: () => [
      { dataset: { paneId: "other" }, querySelector: () => null },
      {
        dataset: { paneId: "p1" },
        querySelector: (selector: string) =>
          selector === ".xterm-helper-textarea" ? terminal : null,
      },
    ],
  } as unknown as ParentNode;

  test("to the element they came from, while it is on the page", () => {
    const from = element(false);
    expect(focusReturnTarget(from, ".slot", "p1", root)).toBe(from);
  });

  test("else to the pane's terminal: never the body, a removed element or the closing view", () => {
    for (const from of [
      null,
      body,
      element(false, false),
      element(true),
    ] as (HTMLElement | null)[]) {
      if (from === body)
        Object.assign(body, {
          isConnected: true,
          ownerDocument: { body },
          closest: () => null,
        });
      expect(focusReturnTarget(from, ".slot", "p1", root)).toBe(terminal);
    }
    expect(focusReturnTarget(null, ".slot", undefined, root)).toBe(null);
    expect(focusReturnTarget(null, ".slot", "gone", root)).toBe(null);
  });
});
