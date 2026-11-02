import { expect, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_CHAT_RENDERS_DOM_TEST !== "1") {
  test("chat refresh renders in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CHAT_RENDERS_DOM_TEST: "1" },
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
  }, 30_000);
} else {
  test("a history refresh draws only the bubbles and blocks that changed", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      HTMLDialogElement: browser.HTMLDialogElement,
      Element: browser.Element,
      Node: browser.Node,
      DOMParser: browser.DOMParser,
      NodeFilter: browser.NodeFilter,
      ResizeObserver: browser.ResizeObserver,
      Event: browser.Event,
      MouseEvent: browser.MouseEvent,
      KeyboardEvent: browser.KeyboardEvent,
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(0), 0),
      cancelAnimationFrame: (id: number) => clearTimeout(id),
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    const { AgentHistoryChat } = await import("./AgentHistoryChat");
    const { groupHistoryChatItems } = await import("./agentHistoryView");
    const { mergeAgentHistory } = await import("./agentHistory");
    type Entry = import("./agentHistory").HistoryEntry;
    const { takeRenderCounts } = await import("../renderTrace");
    const { createRoot } = await import("react-dom/client");

    // A full window: 200 messages, a tool call and result after each tenth.
    const entries = (from: number, to: number): Entry[] =>
      Array.from({ length: to - from }, (_, index) => from + index).flatMap(
        (n): Entry[] => [
          {
            id: `m${n}`,
            role: n % 2 ? "assistant" : "user",
            kind: "message",
            text: `message ${n}`,
            sent_at: "2026-01-01T00:00:00Z",
          },
          ...(n % 10 === 0
            ? ([
                {
                  id: `c${n}`,
                  role: "tool",
                  kind: "tool_call",
                  tool_name: "Bash",
                  source_call_id: `t${n}`,
                  text: "{}",
                  sent_at: "2026-01-01T00:00:00Z",
                },
                {
                  id: `r${n}`,
                  role: "tool",
                  kind: "tool_result",
                  tool_name: "Bash",
                  source_call_id: `t${n}`,
                  text: "done",
                  sent_at: "2026-01-01T00:00:00Z",
                },
              ] as Entry[])
            : []),
        ],
      );
    const snapshot = (list: Entry[], revision: number) => ({
      history_version: 2 as const,
      mode: "snapshot" as const,
      cursor: { epoch: "e", revision },
      window_limit: 200,
      // Every entry a new object, as a reply parsed from JSON is.
      entries: structuredClone(list),
      agent: "claude",
      pane_id: "p",
      workspace_id: "w",
      tab_id: "t",
      updated_at: "2026-01-01T00:00:00Z",
      path: "/s.jsonl",
    });
    const first = mergeAgentHistory(null, snapshot(entries(0, 200), 1), null)!;

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const listRef = React.createRef<HTMLDivElement>();
    const contentRef = React.createRef<HTMLDivElement>();
    const onOpen = () => {};
    const render = (messages: Entry[]) =>
      React.act(async () =>
        root.render(
          <AgentHistoryChat
            items={groupHistoryChatItems(messages)}
            listRef={listRef}
            contentRef={contentRef}
            onOpen={onOpen}
          />,
        ),
      );
    await render(first.messages);
    const counts = () =>
      Object.fromEntries(
        takeRenderCounts()
          .split(", ")
          .filter(Boolean)
          .map((part) => {
            const [name, count] = part.split(" ");
            return [name, Number(count)];
          }),
      ) as Record<string, number>;
    expect(counts().ChatBubble).toBe(200);

    // One message more: the window slides, the oldest one leaves it and
    // every bubble's sequence moves by one.
    const next = mergeAgentHistory(
      first,
      snapshot(entries(1, 201), 2),
      first.cursor,
    )!;
    expect(next.messages[0]!.id).toBe("m1");
    await render(next.messages);
    const after = counts();
    expect(after.ChatBubble).toBe(1);
    // The block the new message brought, none of the others.
    expect(after.ToolBlock).toBe(1);

    // The bubbles carry their new place for the minimap and its jumps.
    const content = contentRef.current!;
    const first2 = content.querySelector<HTMLElement>('[data-bubble-id="m1"]');
    const last = content.querySelector<HTMLElement>('[data-bubble-id="m200"]');
    expect(first2?.dataset.sequence).toBe("1");
    expect(last?.dataset.sequence).toBe("200");
    expect(content.querySelector('[data-sequence="1"]')).toBe(first2);
    await React.act(async () => root.unmount());
  }, 20_000);
}
