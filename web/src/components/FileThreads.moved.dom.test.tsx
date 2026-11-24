import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";
import { mockReviewStore } from "../reviewState.testkit";

/*
 * The Files preview's threads follow the file: read again after an edit,
 * each is drawn where its lines are now (moved as they were, or reworded),
 * one whose lines are gone is listed with its words, drawn on no line, and
 * the review is told to place them again (review.reanchor).
 */
if (
  inIsolatedChild(
    import.meta.path,
    "file threads following the file in an isolated DOM runtime",
    "ROAMGATE_FILE_THREADS_MOVED_DOM_TEST",
    20_000,
  )
) {
  const { installTestDom } = await import("../testDom");
  installTestDom();
  const { threadComment } = await import("./FileThreads.testkit");

  const before = [
    "# TODO",
    "",
    "## Waiting",
    "",
    "- [ ] Firefox: old Roamgate notifications pile up since first use. What is",
    "      wanted: clear them when they no longer apply? (asked",
    "      2026-11-20 00:xx, no answer yet)",
    "- [ ] Headset (boom mic) muting after each turn: fixed twice on",
    "      2026-11-19, needs one real headset call to confirm.",
    "- [ ] Call 1 on 2026-11-19 stopped listening at 23:31 after another voice.",
    "- [ ] Learn my music tastes: nothing built yet.",
    "",
    "## Done",
    "",
    "- [x] Something older.",
    "",
  ].join("\n");
  const after = [
    "# TODO",
    "",
    "## Waiting",
    "",
    "- [ ] Learn my music tastes: nothing built yet.",
    "",
    "## Done",
    "",
    "- [x] Something older.",
    "- [x] Headset (boom mic) muting after each turn: fixed twice on",
    "      2026-11-19, needs one real headset call to confirm.",
    "- [x] Firefox: old Roamgate notifications piling up (the user says it is fixed, 2026-11-20).",
    "",
  ].join("\n");
  const lines = before.split("\n");
  const onItem = (
    id: string,
    line: number,
    endLine: number | undefined,
    quote: string,
    resolved = false,
  ) => ({
    id,
    sessionId: "s1",
    kind: "discussion",
    anchor: {
      path: "todo.md",
      line,
      ...(endLine !== undefined ? { endLine } : {}),
      side: "new",
      text: lines[(endLine ?? line) - 1],
      render: { quote },
    },
    comments: [threadComment(`${id}c`, "you", `About ${id}`)],
    resolved,
    createdAt: `2026-11-20T10:00:${String(line).padStart(2, "0")}Z`,
    updatedAt: `2026-11-20T10:00:${String(line).padStart(2, "0")}Z`,
  });
  const review = {
    session: {
      id: "s1",
      connectionId: "local",
      workspaceId: "w1",
      root: "/repo",
      title: "todo.md",
      target: { kind: "rendered", path: "todo.md" },
      gitlab: false,
      summary: "",
      agent: {},
      createdAt: "2026-11-20",
      updatedAt: "2026-11-20",
    },
    threads: [
      onItem(
        "firefox",
        5,
        7,
        "Firefox: old Roamgate notifications pile up since first use. What is\nwanted: clear them when they no longer apply? (asked\n2026-11-20 00:xx, no answer yet)",
      ),
      onItem(
        "headset",
        8,
        9,
        "Headset (boom mic) muting after each turn: fixed twice on\n2026-11-19, needs one real headset call to confirm.",
        true,
      ),
      onItem(
        "call",
        10,
        undefined,
        "Call 1 on 2026-11-19 stopped listening at 23:31 after another voice.",
      ),
      onItem(
        "music",
        11,
        undefined,
        "Learn my music tastes: nothing built yet.",
      ),
    ],
  };
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let target: "rendered" | "worktree" = "rendered";
  const { mock } = await import("bun:test");
  mock.module("../review", () => ({
    reviewCall: async (
      _connection: string,
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      calls.push({ method, params });
      return method === "review.get" ? review : {};
    },
    rememberReviewSnapshot: () => {},
    ...mockReviewStore(() => ({
      // The file's own rendered review, or the checkout's (the review in
      // Changes, where the Files preview writes on checkout files).
      sessions: new Map<string, unknown>([
        [
          "s1",
          {
            ...review,
            session: {
              ...review.session,
              target:
                target === "rendered"
                  ? { kind: "rendered", path: "todo.md" }
                  : { kind: "worktree" },
            },
          },
        ],
      ]),
      openRequest: null,
    })),
  }));

  const settle = async () => {
    for (let i = 0; i < 20; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  };

  async function followsThrough(kind: "rendered" | "worktree") {
    target = kind;
    calls.length = 0;
    const { act, useState } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const {
      DetachedFileThreads,
      SlotThreads,
      useFileThreads,
      useFileThreadView,
    } = await import("./FileThreads");
    const { MarkdownPreview } = await import("./markdown");
    let setText: (text: string) => void = () => {};
    function Preview() {
      const [text, set] = useState(before);
      setText = set;
      const api = useFileThreads("local", { absolute: "/repo/todo.md" }, text);
      const [element, setElement] = useState<HTMLDivElement | null>(null);
      const view = useFileThreadView(() => element);
      return (
        <section className="file-preview">
          <div ref={setElement} className="file-preview-file-content">
            <MarkdownPreview
              text={text}
              lead={
                <DetachedFileThreads
                  threads={api.threads}
                  api={api}
                  view={view}
                />
              }
              threadsFor={(stops, stopOf, where) => (
                <SlotThreads
                  stops={stops}
                  stopOf={stopOf}
                  where={where}
                  threads={api.threads}
                  api={api}
                  view={view}
                />
              )}
            />
          </div>
        </section>
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Preview />));
      await act(settle);
      const stopOf = (id: string) =>
        host
          .querySelector(`.chat-thread[data-thread-id="${id}"]`)
          ?.closest<HTMLElement>("[data-for-stop]")?.dataset.forStop;
      const detached = () =>
        [
          ...(host
            .querySelector('[data-testid="file-preview-detached"]')
            ?.querySelectorAll<HTMLElement>(".chat-thread[data-thread-id]") ??
            []),
        ].map((card) => card.dataset.threadId);
      // As written: each under its item.
      expect(stopOf("firefox")).toBe("b:5");
      expect(stopOf("headset")).toBe("b:8");
      expect(stopOf("call")).toBe("b:10");
      expect(stopOf("music")).toBe("b:11");
      expect(detached()).toEqual([]);
      expect(calls.filter((call) => call.method === "review.reanchor")).toEqual(
        [],
      );

      // The file read again, edited: the items moved and reworded are
      // found, the deleted one is listed, the review told.
      await act(async () => setText(after));
      await act(settle);
      expect(stopOf("music")).toBe("b:5");
      expect(stopOf("headset")).toBe("b:10");
      expect(stopOf("firefox")).toBe("b:12");
      expect(stopOf("call")).toBeUndefined();
      expect(detached()).toEqual(["call"]);
      const listed = host.querySelector(
        '[data-testid="file-preview-detached"]',
      )!;
      // First in the document, in its scroll, through its HTML replaced;
      // one thread: open.
      expect(listed.parentElement?.classList.contains("md-lead-slot")).toBe(
        true,
      );
      expect(host.querySelector(".file-preview-markdown")?.firstChild).toBe(
        listed.parentElement,
      );
      expect((listed as HTMLDetailsElement).open).toBe(true);
      expect(listed.querySelector("summary")?.textContent).toContain(
        "1 comment not shown in the page",
      );
      // Not a block of the document for the threads under blocks.
      expect(
        listed.parentElement?.closest("[data-for-stop]") ?? null,
      ).toBeNull();
      expect(listed.textContent).toContain(
        'todo.md · "Call 1 on 2026-11-19 stopped listening at 23:31 after an',
      );
      // Nothing under the old lines' new content but their own threads.
      const under = (stop: string) =>
        [
          ...host.querySelectorAll<HTMLElement>(
            `[data-for-stop="${stop}"] .chat-thread[data-thread-id]`,
          ),
        ].map((card) => card.dataset.threadId);
      expect(under("b:10")).toEqual(["headset"]);
      expect(under("b:9")).toEqual([]);
      // The reworded item's words highlighted: its quote reads as it is now.
      expect(
        host.querySelector<HTMLElement>(
          '[data-for-stop="b:12"] .chat-thread[data-thread-id="firefox"]',
        ),
      ).not.toBeNull();
      expect(calls.filter((call) => call.method === "review.reanchor")).toEqual(
        [
          {
            method: "review.reanchor",
            params: { session_id: "s1", path: "todo.md" },
          },
        ],
      );
      // Resolved threads hidden (gH): the listed ones too.
      await act(async () => setText(before));
      await act(settle);
      expect(stopOf("call")).toBe("b:10");
      expect(detached()).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  }

  test("threads follow their items through an edit; a deleted item's is listed, drawn on no line", () =>
    followsThrough("rendered"));

  test("the checkout's review's threads on the file (written in Files, kept in Changes) follow it too", () =>
    followsThrough("worktree"));
}
