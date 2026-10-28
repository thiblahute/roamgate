import { expect, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_PANE_JUMP_LANDING_DOM_TEST !== "1") {
  test("Find's selection in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_PANE_JUMP_LANDING_DOM_TEST: "1" },
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
  }, 20_000);
} else {
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost/" });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    KeyboardEvent: browser.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const { createRoot } = await import("react-dom/client");
  const { usePaneJumpLanding } = await import("./paneJumpLanding");

  type Row = { name: string; current?: boolean };
  /**
   * Find as the app draws it: a list rebuilt on every render (the agents of
   * other servers, statuses), Up and Down wrapping around, a new search
   * putting the selection back at the top.
   */
  function Find({ rows, query }: { rows: Row[]; query: string }) {
    const entries = rows.map((row) => ({ ...row }));
    const indexRef = React.useRef(0);
    const [index, setIndex] = React.useState(0);
    const select = React.useCallback(
      (next: number) => {
        const wrapped = (next + rows.length) % rows.length;
        indexRef.current = wrapped;
        setIndex(wrapped);
      },
      [rows.length],
    );
    const landing = usePaneJumpLanding(true, entries, indexRef, select);
    const searched = React.useRef(query);
    if (searched.current !== query) {
      searched.current = query;
      landing.land();
      indexRef.current = 0;
      setIndex(0);
    }
    return (
      <input
        aria-label="Search"
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          landing.moved();
          select(indexRef.current + (event.key === "ArrowDown" ? 1 : -1));
        }}
        data-selected={entries[index]?.name}
      />
    );
  }

  const mount = () => {
    const container = document.createElement("div");
    document.body.append(container);
    return { container, root: createRoot(container) };
  };
  const press = (container: HTMLElement, key: string) =>
    React.act(async () => {
      container
        .querySelector("input")!
        .dispatchEvent(
          new window.KeyboardEvent("keydown", { key, bubbles: true }),
        );
    });
  const selected = (container: HTMLElement) =>
    container.querySelector("input")!.getAttribute("data-selected");

  test("Find lands past the current workspace, and Up and Down reach every row", async () => {
    const { container, root } = mount();
    const rows: Row[] = [
      { name: "here", current: true },
      { name: "build" },
      { name: "docs" },
    ];
    try {
      await React.act(async () => root.render(<Find rows={rows} query="" />));
      expect(selected(container)).toBe("build");
      await press(container, "ArrowUp");
      expect(selected(container)).toBe("here");
      await press(container, "ArrowUp");
      expect(selected(container)).toBe("docs");
      await press(container, "ArrowDown");
      expect(selected(container)).toBe("here");
      await press(container, "ArrowDown");
      expect(selected(container)).toBe("build");
      // A new search lands again.
      await React.act(async () => root.render(<Find rows={rows} query="d" />));
      expect(selected(container)).toBe("build");
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
    }
  });

  test("with what needs the user first, Down goes on to the current workspace", async () => {
    const { container, root } = mount();
    const rows: Row[] = [
      { name: "blocked" },
      { name: "here", current: true },
      { name: "docs" },
    ];
    try {
      await React.act(async () => root.render(<Find rows={rows} query="" />));
      expect(selected(container)).toBe("blocked");
      await press(container, "ArrowDown");
      expect(selected(container)).toBe("here");
      await press(container, "ArrowDown");
      expect(selected(container)).toBe("docs");
      await press(container, "ArrowUp");
      await press(container, "ArrowUp");
      expect(selected(container)).toBe("blocked");
      await press(container, "ArrowUp");
      expect(selected(container)).toBe("docs");
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
      await browser.happyDOM.close();
    }
  });
}
