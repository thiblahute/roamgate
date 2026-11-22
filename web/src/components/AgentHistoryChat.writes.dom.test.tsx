import { expect, mock, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_CHAT_WRITES_DOM_TEST !== "1") {
  test("chat write rows run in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CHAT_WRITES_DOM_TEST: "1" },
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

  // The rows' links: what they open, seen here.
  const opened: unknown[] = [];
  const real = await import("../roamgateWrites");
  mock.module("../roamgateWrites", () => ({
    ...real,
    openRoamgateWrite: (write: unknown) => {
      opened.push(write);
      return true;
    },
  }));

  test("answers in threads show as tool rows that link there, grouped", async () => {
    const { AgentHistoryChat } = await import("./AgentHistoryChat");
    const { groupHistoryChatItems } = await import("./agentHistoryView");
    type Entry = import("./agentHistory").HistoryEntry;
    const { createRoot } = await import("react-dom/client");
    const at = "2026-01-01T00:00:00Z";
    const thread = (id: string, quote: string, comment: string) =>
      JSON.stringify({
        id,
        session: "4aad5bedb15e09e5",
        on_chat_message: { quote },
        comments: [
          { id: "u1", author: "user", text: "Why?" },
          { id: comment, author: "Claude", text: "Because." },
        ],
      });
    const call = (
      id: string,
      name: string,
      args: Record<string, unknown>,
      output: string,
    ): Entry[] => [
      {
        id: `c${id}`,
        role: "tool",
        kind: "tool_call",
        tool_name: name,
        source_call_id: id,
        text: JSON.stringify(args),
        sent_at: at,
      },
      {
        id: `r${id}`,
        role: "tool",
        kind: "tool_result",
        tool_name: name,
        source_call_id: id,
        text: output,
        sent_at: at,
      },
    ];
    const entries: Entry[] = [
      { id: "q", role: "user", kind: "message", text: "Answer", sent_at: at },
      // The mod's tool, with a description.
      ...call(
        "t1",
        "mcp__roamgate__review_reply",
        {
          comment_id: "aaaa1111",
          text: "**Fixed** in the header bar.",
          description: "Answer the header bar question",
        },
        thread("aaaa1111bbbb", "the header bar", "c-one"),
      ),
      // Another tool in between: still one block.
      ...call("t2", "Read", { file_path: "/src/a.ts" }, "code"),
      // The review client, from Bash, without one: a generated line.
      ...call(
        "t3",
        "Bash",
        { command: "roamgate-review reply --comment cccc2222 -- Both done" },
        thread("cccc2222dddd", "split the bar", "c-two"),
      ),
    ];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () =>
      root.render(
        <AgentHistoryChat
          items={groupHistoryChatItems(entries)}
          listRef={React.createRef<HTMLDivElement>()}
          contentRef={React.createRef<HTMLDivElement>()}
          onOpen={() => {}}
        />,
      ),
    );
    const blocks = container.querySelectorAll(".agent-history-chat-tools");
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    // Closed, the block shows the answers as rows; the other call is only
    // in its progress.
    const writes = block.querySelector(".agent-history-chat-writes")!;
    const rows = [...writes.querySelectorAll(".agent-history-chat-step")];
    expect(
      rows.map(
        (row) =>
          row.querySelector(".agent-history-chat-step-headline")?.textContent,
      ),
    ).toEqual([
      "Answer the header bar question",
      'Replied on "split the bar" · Both done',
    ]);
    expect(rows.every((row) => row.classList.contains("is-write"))).toBe(true);
    const progress = block.querySelector(".agent-history-chat-progress");
    expect(progress?.textContent).toContain("Read /src/a.ts");
    expect(progress?.textContent).not.toContain("header bar");

    // Its link opens the thread at the reply.
    const link = rows[0]!.querySelector<HTMLButtonElement>(
      ".agent-history-chat-step-link",
    )!;
    expect(link.getAttribute("aria-label")).toBe(
      "Open the thread at this reply",
    );
    await React.act(async () => link.click());
    expect(opened).toEqual([
      expect.objectContaining({
        action: "reply",
        review: "4aad5bedb15e09e5",
        thread: "aaaa1111bbbb",
        comment: "c-one",
      }),
    ]);

    // Opened, a row shows the words written, whole.
    await React.act(async () =>
      rows[0]!
        .querySelector<HTMLButtonElement>(".agent-history-chat-step-row")!
        .click(),
    );
    const detail = rows[0]!.querySelector(".agent-history-chat-step-detail");
    expect(detail?.querySelector("h4")?.textContent).toBe(
      "Written on the header bar",
    );
    expect(detail?.querySelector("strong")?.textContent).toBe("Fixed");

    // The whole block opened: every call, the answers still linked.
    await React.act(async () =>
      block
        .querySelector<HTMLButtonElement>(".agent-history-chat-tools-toggle")!
        .click(),
    );
    const list = [
      ...block.querySelectorAll(
        ".agent-history-chat-tools-list:not(.agent-history-chat-writes) > .agent-history-chat-step",
      ),
    ];
    expect(list).toHaveLength(3);
    expect(
      list.map((row) => !!row.querySelector(".agent-history-chat-step-link")),
    ).toEqual([true, false, true]);
    expect(block.querySelector(".agent-history-chat-writes")).toBeNull();
    await React.act(async () => root.unmount());
  });
}
