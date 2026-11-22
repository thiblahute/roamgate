import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";
import * as React from "react";
import type { HistoryStatus } from "../../../shared/history";

function status(extra: Partial<HistoryStatus> = {}): HistoryStatus {
  return {
    enabled: true,
    location: "/home/u/.config/roamgate/history",
    defaultLocation: "/home/u/.config/roamgate/history",
    exists: true,
    lastCommit: {
      sha: "6eec4116c2aa",
      subject: "work: 2 items; reviews: 3 threads in 2 reviews",
      at: new Date(Date.now() - 5 * 60_000).toISOString(),
      author: "Roamgate",
    },
    commits: 12,
    sizeBytes: 22 * 1024 * 1024,
    files: { work: 181, reviews: 2391, FORMAT: 1, "README.md": 1 },
    lastPass: null,
    blocked: [
      { file: "reviews/2026/abc/t1.md", line: 4, kind: "glpat-... token" },
    ],
    errors: [],
    pending: [],
    running: false,
    deferred: null,
    ...extra,
  };
}

if (
  inIsolatedChild(
    import.meta.path,
    "history settings in an isolated browser runtime",
    "ROAMGATE_HISTORY_SETTINGS_DOM_TEST",
    20_000,
  )
) {
  test("shows the history's status, what was kept out, and sets the location", async () => {
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
      MouseEvent: browser.MouseEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    let state = status();
    const writes: unknown[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      if (init?.method === "PUT" && path === "/api/history") {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        state = {
          ...state,
          ...(body.location === null ? {} : { location: body.location }),
        };
      } else if (init?.method === "POST" && path === "/api/history/commit")
        writes.push("commit");
      else if (path !== "/api/history")
        return new Response(null, { status: 404 });
      return Response.json(state);
    }) as typeof fetch;
    const { HistorySettings } = await import("./HistorySettings");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const wait = async (check: () => boolean) =>
      React.act(async () => {
        for (let i = 0; i < 300 && !check(); i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
      });
    const button = (text: string) =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (entry) => entry.textContent?.includes(text),
      );
    try {
      await React.act(async () => root.render(<HistorySettings />));
      await wait(() => Boolean(button("Commit now")));
      const text = container.textContent ?? "";
      expect(text).toContain("History and backup");
      expect(text).toContain(
        "5 min ago: work: 2 items; reviews: 3 threads in 2 reviews",
      );
      expect(text).toContain("22 MB, 12 commits");
      expect(text).toContain("reviews 2391, work 181");
      expect(text).not.toContain("FORMAT");
      expect(text).toContain("reviews/2026/abc/t1.md:4");
      expect(text).toContain("does not survive the loss of this disk");
      expect(button("Use the default")?.disabled).toBe(true);
      const input =
        container.querySelector<HTMLInputElement>("input[type=text]")!;
      await React.act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(input),
          "value",
        )!.set!;
        setter.call(input, "/data/history");
        input.dispatchEvent(
          new browser.Event("input", { bubbles: true }) as never,
        );
      });
      await React.act(async () => button("Save")?.click());
      await wait(() => writes.length > 0);
      expect(writes).toEqual([{ location: "/data/history" }]);
      await wait(() => button("Use the default")?.disabled === false);
      await React.act(async () => button("Commit now")?.click());
      await wait(() => writes.length > 1);
      expect(writes[1]).toBe("commit");
    } finally {
      await React.act(async () => root.unmount());
    }
  });
}
