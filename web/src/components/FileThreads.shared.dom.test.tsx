import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

if (
  inIsolatedChild(
    import.meta.path,
    "shared file threads in an isolated DOM runtime",
    "ROAMGATE_FILE_THREADS_SHARED_DOM_TEST",
    20_000,
  )
) {
  const { installTestDom } = await import("../testDom");
  installTestDom();
  const writes: { method: string; params: Record<string, unknown> }[] = [];

  const at = (second: number) =>
    `2026-11-10T10:00:${String(second).padStart(2, "0")}Z`;
  const comment = (id: string, author: string, body: string, second = 0) => ({
    id,
    author,
    body,
    createdAt: at(second),
    updatedAt: at(second),
  });
  const base = {
    connectionId: "local",
    workspaceId: "w1",
    root: "/repo",
    gitlab: false,
    summary: "",
    agent: { name: "claude", paneId: "w1:p1" },
    createdAt: "2026-11-10",
    updatedAt: "2026-11-10",
  };
  // The code review's decision thread on the plan, written in the diff.
  const decision = {
    id: "c1t",
    sessionId: "c1",
    kind: "discussion",
    anchor: { path: "plan.md", line: 3, side: "new", text: "First para." },
    comments: [
      comment(
        "c1a",
        "claude",
        "**Option a.** Keep it.\n\n**Option b.** Drop it.",
        1,
      ),
    ],
    resolved: false,
    createdAt: at(1),
    updatedAt: at(1),
  };
  // Its line moved down two: found by its text.
  const moved = {
    ...decision,
    id: "c2t",
    anchor: { path: "plan.md", line: 3, side: "new", text: "Third para." },
    comments: [comment("c2a", "you", "This one moved", 2)],
  };
  // On a removed line: listed, not drawn.
  const removed = {
    ...decision,
    id: "c3t",
    anchor: { path: "plan.md", line: 9, side: "old", text: "gone" },
    comments: [comment("c3a", "you", "On a removed line", 3)],
  };
  // A merge request's GitLab discussion on the file.
  const gitlab = {
    id: "gl:d1",
    sessionId: "m1",
    kind: "merge-request",
    anchor: { path: "plan.md", line: 5, side: "new" },
    comments: [comment("gl:1", "@reviewer", "Why the second para?", 4)],
    resolved: false,
    createdAt: at(4),
    updatedAt: at(4),
    gitlab: { discussionId: "d1" },
  };
  const own = {
    id: "r1t",
    sessionId: "r1",
    kind: "discussion",
    anchor: {
      path: "plan.md",
      line: 1,
      side: "new",
      text: "# Plan",
      render: { quote: "Plan" },
    },
    comments: [comment("r1a", "you", "Written in the rendered view", 9)],
    resolved: false,
    createdAt: at(9),
    updatedAt: at(9),
  };
  const code = {
    session: {
      ...base,
      id: "c1",
      title: "main..topic",
      target: { kind: "worktree" },
    },
    threads: [decision, moved, removed],
  };
  const mr = {
    session: {
      ...base,
      id: "m1",
      title: "!3",
      gitlab: true,
      target: {
        kind: "mr",
        url: "https://gitlab.example/g/p/-/merge_requests/3",
      },
    },
    threads: [gitlab],
  };
  let rendered: Record<string, unknown> | null = null;
  const renderedReview = () => ({
    session: {
      ...base,
      id: "r1",
      title: "plan.md",
      target: { kind: "rendered", path: "plan.md" },
    },
    threads: [own],
    shared: [decision, moved, removed, gitlab],
  });
  const { mock } = await import("bun:test");
  mock.module("../review", () => ({
    reviewCall: async (
      _connection: string,
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      if (method === "review.get") return {};
      writes.push({ method, params });
      return {};
    },
    rememberReviewSnapshot: () => {},
    useReviewState: () => ({
      sessions: new Map<string, unknown>([
        ["c1", code],
        ["m1", mr],
        ...(rendered ? [["r1", rendered] as [string, unknown]] : []),
      ]),
      openRequest: null,
    }),
  }));

  const settle = async () => {
    for (let i = 0; i < 20; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const TEXT =
    "# Plan\n\nNew para.\n\nNewer para.\n\nFirst para.\n\nThird para.\n";

  async function mount() {
    const { act, useMemo, useState } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const {
      fileThreadKeys,
      focusFileThread,
      SlotThreads,
      ThreadsList,
      useFileThreads,
      useFileThreadView,
    } = await import("./FileThreads");
    const { useThreadKeys } = await import("./useThreadKeys");
    const { MarkdownPreview } = await import("./markdown");
    const state: { api?: ReturnType<typeof useFileThreads> } = {};
    // As FilePreviewContent wires them.
    function Preview() {
      const api = useFileThreads("local", { absolute: "/repo/plan.md" }, TEXT);
      state.api = api;
      const [element, setElement] = useState<HTMLDivElement | null>(null);
      const view = useFileThreadView(() => element);
      const byId = useMemo(
        () => new Map(api.all.map((each) => [each.id, each])),
        [api.all],
      );
      useThreadKeys(
        () => element,
        element,
        fileThreadKeys({
          view,
          api,
          threadsById: byId,
          goToThread: (each) => focusFileThread(element, each, view.setCursor),
          openOverview: () => {},
          jumpUnresolved: () => {},
          comment: () => true,
        }),
      );
      return (
        <section className="file-preview">
          <div
            ref={setElement}
            className="file-preview-file-content"
            tabIndex={-1}
          >
            <MarkdownPreview
              text={TEXT}
              threadsFor={(stops, stopOf) => (
                <SlotThreads
                  stops={stops}
                  stopOf={stopOf}
                  threads={api.threads}
                  api={api}
                  view={view}
                  nested={api.nested}
                />
              )}
            />
          </div>
          <ThreadsList
            threads={api.all.filter((each) => each.kind !== "merge-request")}
            api={api}
            onGo={() => {}}
            onClose={() => {}}
          />
        </section>
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Preview />));
    await act(settle);
    return { host, root, act, state };
  }

  test("a code review's threads on the file show in the rendered view before it has a review of its own", async () => {
    rendered = null;
    const { host, root, act } = await mount();
    const card = host.querySelector('.chat-thread[data-thread-id="c1t"]');
    expect(card?.closest(".md-thread-slot")).not.toBeNull();
    expect(card?.textContent).toContain("Option a.");
    await act(async () => root.unmount());
    host.remove();
  });

  test("the rendered view shows the code reviews' threads where they are now, GitLab's as the review pane draws them, and writes each in its own review", async () => {
    rendered = renderedReview();
    writes.length = 0;
    const { host, root, act, state } = await mount();
    const slotOf = (id: string) =>
      host
        .querySelector(`[data-thread-id="${id}"]`)
        ?.closest<HTMLElement>("[data-for-stop]")?.dataset.forStop;
    // Its own, and the code review's, each under its block: the moved one
    // found by its text two blocks further down.
    expect(slotOf("r1t")).toBe("b:1");
    expect(slotOf("c1t")).toBe("b:7");
    expect(slotOf("c2t")).toBe("b:9");
    // A removed line's thread is only listed.
    expect(
      host.querySelector('.md-thread-slot [data-thread-id="c3t"]'),
    ).toBeNull();
    expect(host.textContent).toContain("On a removed line");
    // GitLab's discussion, as the review pane draws it: Draft reply.
    const discussion = host.querySelector<HTMLElement>(
      '.mrt[data-thread-id="gl:d1"]',
    );
    expect(discussion?.textContent).toContain("Why the second para?");
    expect(discussion?.textContent).toContain("Draft reply");
    expect(discussion?.textContent).not.toContain("Resolve");
    // Resolved from here: in the code review it lives in.
    state.api!.resolve(state.api!.all.find((each) => each.id === "c1t")!);
    await act(settle);
    expect(writes[writes.length - 1]).toMatchObject({
      method: "review.resolve",
      params: { session_id: "c1", comment_id: "c1t", resolved: true },
    });
    await act(async () => root.unmount());
    host.remove();
  });

  test("a part of a comment in the rendered view takes a thread of its own, in its thread's review", async () => {
    rendered = renderedReview();
    writes.length = 0;
    const { EditorView } = await import("@codemirror/view");
    const { host, root, act } = await mount();
    const card = host.querySelector<HTMLElement>(
      '.chat-thread[data-thread-id="c1t"]',
    )!;
    const plus = card.querySelectorAll<HTMLButtonElement>(".rc-part-add");
    // One + per part of the message.
    expect(plus.length).toBe(2);
    await act(async () => plus[1]!.click());
    for (let i = 0; i < 50 && !card.querySelector(".is-draft .cm-content"); i++)
      await act(settle);
    const view = EditorView.findFromDOM(
      card.querySelector<HTMLElement>(".is-draft .cm-content")!,
    );
    expect(view).not.toBeNull();
    await act(async () =>
      view!.dispatch({ changes: { from: 0, insert: "Why drop it?" } }),
    );
    const send = [...card.querySelectorAll("button")].find(
      (button) => button.textContent === "Send",
    )!;
    await act(async () => send.click());
    await act(settle);
    expect(writes[writes.length - 1]).toMatchObject({
      method: "review.thread.add",
      params: {
        session_id: "c1",
        kind: "discussion",
        text: "Why drop it?",
        anchor: {
          path: "plan.md",
          message: {
            thread: "c1t",
            comment: "c1a",
            quote: "Option b. Drop it.",
          },
        },
      },
    });
    await act(async () => root.unmount());
    host.remove();
  });

  test("g; goes to the comment written last, as in the review pane and a chat", async () => {
    rendered = renderedReview();
    const { host, root, act } = await mount();
    const content = host.querySelector<HTMLElement>(
      ".file-preview-file-content",
    )!;
    content.focus();
    await act(async () => {
      for (const key of ["g", ";"])
        content.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true }),
        );
      await settle();
    });
    // The rendered view's own comment, written last (second 9).
    expect(
      host
        .querySelector(".chat-thread-message.is-focused")
        ?.closest("[data-thread-id]")
        ?.getAttribute("data-thread-id"),
    ).toBe("r1t");
    await act(async () => root.unmount());
    host.remove();
  });
}
