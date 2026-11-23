import { inIsolatedChild } from "../testIsolated";
import { expect, mock, test } from "bun:test";

if (
  inIsolatedChild(
    import.meta.path,
    "the archive search view in an isolated browser runtime",
    "ROAMGATE_ARCHIVE_SEARCH_DOM_TEST",
    30_000,
  )
) {
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost/" });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    KeyboardEvent: browser.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });

  const calls: { method: string; params: Record<string, unknown> }[] = [];
  mock.module("../api", () => ({
    bridge: {
      call: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        if (method === "bridge.archive.search")
          return {
            query: params.query,
            total: 3,
            sessions: 1,
            truncated: false,
            source: "text",
            hits: [
              {
                session: "abc",
                agent: "claude",
                host: "desk",
                project: "-home-me-devel-zoo",
                subagent: false,
                title: "Zoo planning",
                ts: "2026-11-14T10:00:00",
                role: "user",
                kind: "text",
                tool: null,
                snippet: "the [lemur] plan",
                doc: 7,
                cost_usd: null,
                matches: 3,
                snippets: ["one [lemur]", "the [lemur] plan"],
                key: "desk/claude/-home-me-devel-zoo/abc.jsonl",
              },
            ],
          };
        if (method === "bridge.archive.open")
          return {
            key: params.key,
            host: "desk",
            agent: "claude",
            relpath: "-home-me-devel-zoo/abc.jsonl",
            session: "abc",
            project: "-home-me-devel-zoo",
            title: "Zoo planning",
            cwd: "/home/me/devel/zoo",
            hit: 9,
            before: false,
            after: true,
            records: [
              {
                line: 8,
                ts: "2026-11-14T09:59:00",
                hit: false,
                messages: [
                  { role: "assistant", kind: "text", tool: null, text: "ok" },
                ],
              },
              {
                line: 9,
                ts: "2026-11-14T10:00:00",
                hit: true,
                messages: [
                  {
                    role: "user",
                    kind: "text",
                    tool: null,
                    text: "the lemur plan",
                  },
                ],
              },
            ],
          };
        throw new Error(method);
      },
    },
  }));

  const { ArchiveSearch, markedSnippet } = await import("./ArchiveSearch");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const settle = async () => {
    for (let i = 0; i < 5; i++)
      await act(async () => {
        await Promise.resolve();
      });
  };
  const text = (element: Element | null) =>
    element?.textContent?.replace(/\s+/g, " ").trim() ?? "";

  test("searches, lists sessions with marked snippets, opens a hit", async () => {
    expect(markedSnippet("a [b] c").length).toBe(3);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let closed = false;
    await act(async () => {
      root.render(
        <ArchiveSearch onClose={() => (closed = true)} initialQuery="lemur" />,
      );
    });
    const form = container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(calls[0]).toEqual({
      method: "bridge.archive.search",
      params: {
        query: "lemur",
        regex: false,
        recent: false,
        tool_output: false,
        limit: 50,
      },
    });
    const hit = container.querySelector(".archive-search-hit")!;
    expect(text(hit)).toContain("Zoo planning");
    expect(text(hit)).toContain("3 match(es)");
    expect(hit.querySelectorAll("mark").length).toBe(2);

    await act(async () => {
      (hit as HTMLElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await settle();
    expect(calls[1]?.params).toEqual({
      key: "desk/claude/-home-me-devel-zoo/abc.jsonl",
      line: 7,
      raw: false,
    });
    expect(text(container.querySelector(".is-hit"))).toContain(
      "the lemur plan",
    );

    // Escape goes back to the results, then closes.
    const escape = () =>
      act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
    await escape();
    expect(container.querySelector(".archive-search-hit")).not.toBeNull();
    await escape();
    expect(closed).toBe(true);
    await act(async () => root.unmount());
  });
}
