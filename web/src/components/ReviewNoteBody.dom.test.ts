import { afterAll, afterEach, expect, jest, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

if (process.env.ROAMGATE_NOTE_BODY_DOM_TEST !== "1") {
  test("message parts in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_NOTE_BODY_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 15_000);

  test("the + is drawn by its style, and never selected", () => {
    const css = readFileSync(
      new URL("./ReviewNoteBody.css", import.meta.url),
      "utf8",
    );
    expect(css).toMatch(/\.rc-part-add::before\s*{\s*content:\s*"\+";/);
    const rule = /\.rc-part-add\s*{([^}]*)}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("user-select: none");
  });
} else {
  await registerTests();
}

async function registerTests() {
  const browser = new Window({ url: "http://localhost" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "MouseEvent",
    "PointerEvent",
    "DOMParser",
    "NodeFilter",
  ] as const) {
    Object.defineProperty(globalThis, key, {
      value: key === "window" ? browser : browser[key],
      writable: true,
      configurable: true,
    });
  }
  Object.assign(globalThis, {
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { act, createElement: h } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NoteBody, NoteCode } = await import("./ReviewNoteBody");

  let root: Root | null = null;
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
  });
  afterAll(async () => browser.happyDOM.close());

  test("a part's + comments at once, with a menu or not", async () => {
    const onComment = mock<(quote: string) => void>(() => {});
    const onPartMenu = mock(() => {});
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        h(NoteBody, {
          text: "First part.\n\nSecond part.",
          parts: { notes: [], focused: null, onComment, onPartMenu },
        }),
      ),
    );
    const plus =
      container.querySelectorAll<HTMLButtonElement>(".rc-part-add")[1]!;
    expect(plus.getAttribute("aria-haspopup")).toBeNull();
    expect(plus.title).toBe("Comment on this part");
    await act(async () => plus.click());
    expect(onComment).toHaveBeenCalledWith("Second part.");
    expect(onPartMenu).not.toHaveBeenCalled();
  });

  test("a right-click on a part hands its words, or the selected ones, to its menu", async () => {
    const onPartMenu = mock<
      (quote: string, at: { x: number; y: number; part: HTMLElement }) => void
    >(() => {});
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        h(NoteBody, {
          text: "First part.\n\nSecond [link](https://example.com) part.",
          parts: { notes: [], focused: null, onComment: () => {}, onPartMenu },
        }),
      ),
    );
    const part = (index: number) =>
      container.querySelector<HTMLElement>(`[data-part="${index}"]`)!;
    const rightClick = (target: Element) => {
      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 50,
      });
      target.dispatchEvent(event);
      return event;
    };
    const text = part(0).querySelector("p") ?? part(0);
    const first = rightClick(text);
    expect(first.defaultPrevented).toBe(true);
    expect(onPartMenu).toHaveBeenCalledTimes(1);
    expect(onPartMenu.mock.calls[0]![0]).toBe("First part.");
    expect(onPartMenu.mock.calls[0]![1]).toEqual({
      x: 40,
      y: 50,
      part: part(0),
    });
    // A link keeps the browser's menu.
    const link = rightClick(part(1).querySelector("a")!);
    expect(link.defaultPrevented).toBe(false);
    expect(onPartMenu).toHaveBeenCalledTimes(1);
    // Words selected in the message: those, wherever the click is.
    const words = part(1).querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(words, 0);
    range.setEnd(words, 6);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    rightClick(text);
    expect(onPartMenu.mock.calls[1]![0]).toBe("Second");
    window.getSelection()!.removeAllRanges();
  });

  test("a finger resting on a part opens its menu, moving it does not", async () => {
    jest.useFakeTimers();
    try {
      const onPartMenu = mock<(quote: string) => void>(() => {});
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () =>
        root!.render(
          h(NoteBody, {
            text: "First part.\n\nSecond part.",
            parts: { notes: [], focused: null, onPartMenu },
          }),
        ),
      );
      const second = container.querySelector<HTMLElement>('[data-part="1"]')!;
      const finger = (type: string, x: number, y: number) =>
        second.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerType: "touch",
            isPrimary: true,
            clientX: x,
            clientY: y,
          }),
        );
      await act(async () => {
        finger("pointerdown", 10, 10);
        finger("pointermove", 40, 10);
        jest.advanceTimersByTime(1000);
      });
      expect(onPartMenu).not.toHaveBeenCalled();
      await act(async () => {
        finger("pointerdown", 10, 10);
        jest.advanceTimersByTime(1000);
      });
      expect(onPartMenu).toHaveBeenCalledTimes(1);
      expect(onPartMenu.mock.calls[0]![0]).toBe("Second part.");
      // The browser's own long-press menu after it is not shown.
      const native = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      second.dispatchEvent(native);
      expect(native.defaultPrevented).toBe(true);
      expect(onPartMenu).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a numbered list drawn in parts keeps its numbers", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        h(NoteBody, {
          text: "Steps:\n\n1. reproduce\n2. fix\n3. check",
          parts: { notes: [], focused: null, onComment: () => {} },
        }),
      ),
    );
    const lists = [...container.querySelectorAll("ol")];
    // One part per item, each its own list, numbered as in the message.
    expect(lists.map((list) => list.textContent?.trim())).toEqual([
      "reproduce",
      "fix",
      "check",
    ]);
    expect(lists.map((list) => list.getAttribute("start") ?? "1")).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  test("a code block's selection copies its code, without the comment +", async () => {
    const onComment = mock(() => {});
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        h(NoteCode, {
          lines: ["const a = 1;", "a + 1;"],
          language: "text",
          first: 0,
          parts: { notes: [], focused: null, onComment },
          notesAt: () => [],
        }),
      ),
    );
    const block = container.querySelector("pre.note-code")!;
    const buttons = [
      ...container.querySelectorAll<HTMLButtonElement>(".rc-part-add"),
    ];
    expect(buttons).toHaveLength(2);
    const range = document.createRange();
    range.selectNodeContents(block);
    const copied = range.toString();
    expect(copied).toContain("const a = 1;");
    // The only + is the code's own.
    expect(copied.split("+")).toHaveLength(2);
    // Still a button one reaches and presses.
    expect(buttons[1]!.getAttribute("aria-label")).toBe("Comment on this part");
    expect(buttons[1]!.tabIndex).not.toBe(-1);
    await act(async () => buttons[1]!.click());
    expect(onComment).toHaveBeenCalledWith("a + 1;");
  });
}
