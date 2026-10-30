import { expect, mock, test } from "bun:test";
import type { ReviewSnapshot } from "../../../shared/review";

if (process.env.ROAMGATE_REVIEW_OVERLAY_DOM_TEST !== "1") {
  test("review overlay in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_REVIEW_OVERLAY_DOM_TEST: "1" },
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
    localStorage: browser.localStorage,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    DOMParser: browser.DOMParser,
    NodeFilter: browser.NodeFilter,
    ResizeObserver: browser.ResizeObserver,
    MutationObserver: browser.MutationObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    getSelection: browser.getSelection.bind(browser),
    Range: browser.Range,
    Text: browser.Text,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    HTMLInputElement: browser.HTMLInputElement,
    Event: browser.Event,
    KeyboardEvent: browser.KeyboardEvent,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
      clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });

  const calls: string[] = [];
  /** The files `review.diff` answers with. */
  let diffFiles: unknown[] = [];
  /** The text `review.file` answers with. */
  let fileText = "";
  /** The parameters of each write, in order. */
  const writes: { method: string; params: Record<string, unknown> }[] = [];
  /** The parameters of each review.update and review.handoff. */
  const agentCalls: { method: string; params: Record<string, unknown> }[] = [];
  /** Methods that fail, as when the connection drops. */
  const failing = new Set<string>();
  /** What `review.commits` answers, and the parameters of each call. */
  let commitsAnswer: unknown = { commits: [] };
  const commitsParams: Record<string, unknown>[] = [];
  /** The parameters of each `review.diff` call. */
  const diffParams: Record<string, unknown>[] = [];
  /** Methods held until the test answers them. */
  const held = new Map<string, (error?: Error) => void>();
  mock.module("../review", () => ({
    reviewCall: async (
      _connection: string,
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      calls.push(method);
      if (method === "review.reply" || method === "review.thread.add")
        writes.push({ method, params });
      if (method === "review.update" || method === "review.handoff")
        agentCalls.push({ method, params });
      if (held.has(method)) {
        const answer = held.get(method)!;
        await new Promise<void>((resolve, reject) =>
          held.set(method, (error) => {
            answer(error);
            if (error) reject(error);
            else resolve();
          }),
        );
      }
      if (failing.has(method)) throw new Error("not connected to bridge");
      if (method === "review.commits") {
        commitsParams.push(params);
        return commitsAnswer;
      }
      if (method === "review.state") return { state: "s" };
      if (method === "review.repos") return { repos: [] };
      if (method === "review.diff") {
        diffParams.push(params);
        // The view it opens on: here all the changes (a worktree's, or a
        // range without commits).
        return {
          files: diffFiles,
          headSha: "h",
          truncated: false,
          ...(params.first ? { view: null } : {}),
        };
      }
      if (method === "review.file") return { text: fileText };
      return {};
    },
    rememberReviewSnapshot: () => {},
    useReviewState: () => ({
      sessions: new Map(),
      openRequest: null,
    }),
  }));

  const snapshot: ReviewSnapshot = {
    session: {
      id: "s1",
      connectionId: "desktop",
      workspaceId: "w1",
      root: "/repo",
      title: "Review",
      target: { kind: "worktree" },
      gitlab: false,
      summary: "",
      agent: {},
      createdAt: "2026-10-30",
      updatedAt: "2026-10-30",
    },
    threads: [],
  } as unknown as ReviewSnapshot;

  const settle = async () => {
    for (let i = 0; i < 10; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  };

  test("a review pinned out of sight loads nothing and is no dialog until shown", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ReviewOverlay } = await import("./ReviewOverlay");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const render = (hidden: boolean) =>
      act(async () => {
        root.render(
          <ReviewOverlay
            snapshot={snapshot}
            connectionId="desktop"
            onClose={() => {}}
            repoDirs={["/repo"]}
            hidden={hidden}
          />,
        );
      });
    await render(true);
    await act(settle);
    expect(calls).toEqual([]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await render(false);
    await act(settle);
    expect(calls).toContain("review.commits");
    expect(calls).toContain("review.state");
    expect(calls).toContain("review.repos");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    // Hidden again, it keeps what it loaded and asks nothing more.
    await render(true);
    calls.length = 0;
    await act(settle);
    expect(calls).toEqual([]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => root.unmount());
  });

  test("the code it opens on is read with its commits, once", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ReviewOverlay } = await import("./ReviewOverlay");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    calls.length = 0;
    diffParams.length = 0;
    // The commits answer only once the diff was asked: not after them.
    held.set("review.commits", () => {});
    await act(async () => {
      root.render(
        <ReviewOverlay
          snapshot={{
            ...snapshot,
            session: { ...snapshot.session, id: "opens-once" },
          }}
          connectionId="desktop"
          onClose={() => {}}
          repoDirs={["/repo"]}
        />,
      );
    });
    await act(settle);
    expect(diffParams).toEqual([{ session_id: "opens-once", first: true }]);
    await act(async () => held.get("review.commits")!());
    held.delete("review.commits");
    await act(settle);
    // Its answer shows: no second read of the same view.
    expect(diffParams).toHaveLength(1);
    expect(calls.filter((call) => call === "review.diff")).toHaveLength(1);
    await act(async () => root.unmount());
  });

  test("an overall comment whose save fails is kept to write on", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { EditorView } = await import("@codemirror/view");
    const { ReviewOverlay } = await import("./ReviewOverlay");
    const { takeReviewDraft } = await import("../reviewDrafts");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ReviewOverlay
          snapshot={snapshot}
          connectionId="desktop"
          onClose={() => {}}
        />,
      );
    });
    await act(settle);
    const button = [...host.querySelectorAll("button")].find(
      (element) => element.textContent === "Overall comment",
    );
    expect(button).toBeTruthy();
    await act(async () => button!.click());
    await act(settle);
    const content = host.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    const view = EditorView.findFromDOM(content!);
    expect(view).not.toBeNull();
    await act(async () =>
      view!.dispatch({ changes: { from: 0, insert: "Looks good overall" } }),
    );
    failing.add("review.update");
    const save = [...host.querySelectorAll("button")].find(
      (element) => element.textContent === "Save",
    );
    expect(save).toBeTruthy();
    await act(async () => save!.click());
    await act(settle);
    expect(calls).toContain("review.update");
    expect(host.textContent).toContain("Not saved: not connected to bridge");
    expect(takeReviewDraft("s1", "overall")).toBe("Looks good overall");
    await act(async () => root.unmount());
  });

  test("text in an editor open as the review goes away is kept", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { EditorView } = await import("@codemirror/view");
    const { ReviewOverlay } = await import("./ReviewOverlay");
    const { reviewDraftCount, takeReviewDraft } = await import(
      "../reviewDrafts"
    );
    failing.clear();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ReviewOverlay
          snapshot={snapshot}
          connectionId="desktop"
          onClose={() => {}}
        />,
      );
    });
    await act(settle);
    const button = [...host.querySelectorAll("button")].find(
      (element) => element.textContent === "Overall comment",
    );
    await act(async () => button!.click());
    await act(settle);
    const view = EditorView.findFromDOM(
      host.querySelector<HTMLElement>(".cm-content")!,
    );
    await act(async () =>
      view!.dispatch({ changes: { from: 0, insert: "Half written" } }),
    );
    // Another connection shown, or the review dropped from the kept ones.
    await act(async () => root.unmount());
    expect(reviewDraftCount("s1")).toBe(1);
    expect(takeReviewDraft("s1", "overall")).toBe("Half written");
  });

  test("a save waits while an image of the comment uploads", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { EditorView } = await import("@codemirror/view");
    const { ReviewOverlay } = await import("./ReviewOverlay");
    const { imageUploadToken } = await import("./ReviewCommentEditor");
    failing.clear();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ReviewOverlay
          snapshot={snapshot}
          connectionId="desktop"
          onClose={() => {}}
        />,
      );
    });
    await act(settle);
    const button = [...host.querySelectorAll("button")].find(
      (element) => element.textContent === "Overall comment",
    );
    await act(async () => button!.click());
    await act(settle);
    const view = EditorView.findFromDOM(
      host.querySelector<HTMLElement>(".cm-content")!,
    );
    await act(async () =>
      view!.dispatch({
        changes: { from: 0, insert: `See ${imageUploadToken(1)}` },
      }),
    );
    calls.length = 0;
    const save = [...host.querySelectorAll("button")].find(
      (element) => element.textContent === "Save",
    );
    await act(async () => save!.click());
    await act(settle);
    expect(calls).not.toContain("review.update");
    // The editor stays, for the image to land in.
    expect(host.querySelector(".cm-content")).not.toBeNull();
    await act(async () => root.unmount());
  });

  test("a reply shows at once as pending, is sent once, and retried with its id", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { EditorView } = await import("@codemirror/view");
    const { ReviewOverlay } = await import("./ReviewOverlay");
    failing.clear();
    writes.length = 0;
    const withThread = {
      ...snapshot,
      threads: [
        {
          id: "t1",
          sessionId: "s1",
          kind: "discussion",
          anchor: {},
          comments: [
            {
              id: "c1",
              author: "you",
              body: "Why not one?",
              createdAt: "2026-10-31T19:16:11Z",
              updatedAt: "2026-10-31T19:16:11Z",
            },
          ],
          resolved: false,
          createdAt: "2026-10-31T19:16:11Z",
          updatedAt: "2026-10-31T19:16:11Z",
        },
      ],
    } as unknown as ReviewSnapshot;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ReviewOverlay
          snapshot={withThread}
          connectionId="desktop"
          onClose={() => {}}
        />,
      );
    });
    await act(settle);
    const button = (label: string) =>
      [...host.querySelectorAll("button")].find(
        (element) => element.textContent === label,
      );
    expect(button("Reply")).toBeTruthy();
    await act(async () => button("Reply")!.click());
    await act(settle);
    const view = EditorView.findFromDOM(
      host.querySelector<HTMLElement>(".cm-content")!,
    );
    await act(async () =>
      view!.dispatch({
        changes: { from: 0, insert: "but i like my overlay!" },
      }),
    );
    // The server is slow to answer.
    held.set("review.reply", () => {});
    const save = button("Save")!;
    await act(async () => {
      save.click();
      save.click();
    });
    await act(settle);
    const answer = held.get("review.reply")!;
    // Shown at once, pending, and sent once.
    const pending = host.querySelector(".rc-pending");
    expect(pending?.textContent).toContain("but i like my overlay!");
    expect(pending?.textContent).toContain("Sending...");
    expect(writes).toHaveLength(1);
    const id = writes[0]!.params.new_comment_id;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(writes[0]!.params.comment_id).toBe("t1");

    // It fails: kept, with why and Retry.
    await act(async () => answer(new Error("timeout: review.reply")));
    held.delete("review.reply");
    await act(settle);
    expect(host.querySelector(".rc-pending")?.textContent).toContain(
      "Not saved: timeout: review.reply",
    );
    await act(async () => button("Retry")!.click());
    await act(settle);
    expect(writes).toHaveLength(2);
    expect(writes[1]!.params.new_comment_id).toBe(id);

    // The review sent back has it: no longer pending, shown once.
    const saved = {
      ...withThread,
      threads: [
        {
          ...withThread.threads[0]!,
          comments: [
            ...withThread.threads[0]!.comments,
            {
              id: id as string,
              author: "you",
              body: "but i like my overlay!",
              createdAt: "2026-10-31T19:22:36Z",
              updatedAt: "2026-10-31T19:22:36Z",
            },
          ],
        },
      ],
    } as ReviewSnapshot;
    await act(async () => {
      root.render(
        <ReviewOverlay
          snapshot={saved}
          connectionId="desktop"
          onClose={() => {}}
        />,
      );
    });
    await act(settle);
    expect(host.querySelector(".rc-pending")).toBeNull();
    expect(host.textContent!.split("but i like my overlay!").length - 1).toBe(
      1,
    );
    await act(async () => root.unmount());
  });

  test("a reply that did not reach the agent says why, with Retry; the live agent's pane is attached", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ReviewOverlay } = await import("./ReviewOverlay");
    failing.clear();
    agentCalls.length = 0;
    const thread = (updatedAt: string) => ({
      id: "t1",
      sessionId: "s1",
      kind: "discussion",
      anchor: {},
      comments: [
        {
          id: "c0",
          author: "Claude",
          body: "Which object posts?",
          createdAt: "2026-11-04T14:11:18Z",
          updatedAt: "2026-11-04T14:11:18Z",
        },
        {
          id: "c1",
          author: "you",
          body: "The bus, set by core",
          createdAt: updatedAt,
          updatedAt,
        },
      ],
      resolved: false,
      createdAt: "2026-11-04T14:11:18Z",
      updatedAt,
    });
    // The agent opened the review without naming its pane (conversation
    // mode's claude did): the bridge could not deliver.
    const undelivered = {
      ...snapshot,
      session: {
        ...snapshot.session,
        autoSend: true,
        agent: { name: "Claude" },
        deliveryError: "no pane is known for Claude",
      },
      threads: [thread("2026-11-04T14:33:29Z")],
    } as unknown as ReviewSnapshot;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const render = (value: ReviewSnapshot) =>
      act(async () => {
        root.render(
          <ReviewOverlay
            snapshot={value}
            connectionId="desktop"
            onClose={() => {}}
            agentPanes={[{ paneId: "w1:p1", agent: "claude" }]}
          />,
        );
      });
    await render(undelivered);
    await act(settle);
    // Shown "live" with the workspace's pane: the review is told that pane.
    expect(agentCalls).toEqual([
      {
        method: "review.update",
        params: { session_id: "s1", agent: "Claude", agent_pane: "w1:p1" },
      },
    ]);
    const label = host.querySelector(".rc-failed");
    expect(label?.textContent).toBe(
      "not delivered: no pane is known for Claude",
    );
    expect(host.textContent).not.toContain("→ Claude...");
    const retry = [...host.querySelectorAll("button")].find(
      (element) => element.textContent === "Retry",
    );
    await act(async () => retry!.click());
    await act(settle);
    expect(agentCalls[agentCalls.length - 1]).toEqual({
      method: "review.update",
      params: { session_id: "s1", agent: "Claude", agent_pane: "w1:p1" },
    });

    // Attached and retried by the bridge: on its way, then delivered.
    const attached = {
      ...undelivered,
      session: {
        ...undelivered.session,
        agent: { name: "Claude", paneId: "w1:p1" },
      },
    } as unknown as ReviewSnapshot;
    delete (attached.session as { deliveryError?: string }).deliveryError;
    await render(attached);
    await act(settle);
    expect(host.querySelector(".rc-failed")).toBeNull();
    expect(host.textContent).toContain("→ Claude...");
    await render({
      ...attached,
      session: { ...attached.session, deliveredAt: "2026-11-04T14:39:07Z" },
    } as ReviewSnapshot);
    await act(settle);
    expect(host.textContent).not.toContain("→ Claude...");
    expect(host.textContent).toContain("→ Claude");

    // A terminal-mode agent the bridge could not type into: the same.
    await render({
      ...attached,
      session: { ...attached.session, deliveryError: "herdr: pane not found" },
    } as ReviewSnapshot);
    await act(settle);
    expect(host.querySelector(".rc-failed")?.textContent).toBe(
      "not delivered: herdr: pane not found",
    );
    const sent = agentCalls.length;
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((element) => element.textContent === "Retry")!
        .click(),
    );
    await act(settle);
    expect(agentCalls.slice(sent).map((call) => call.method)).toEqual([
      "review.handoff",
    ]);
    await act(async () => root.unmount());
  });

  test("resolving a conversation keeps the list where it is; resolved ones are hidden until shown", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ReviewOverlay } = await import("./ReviewOverlay");
    failing.clear();
    localStorage.clear();
    /** Every scrollIntoView made in the list, by conversation. */
    const scrolled: string[] = [];
    const scrollIntoView = browser.Element.prototype.scrollIntoView;
    browser.Element.prototype.scrollIntoView = function (this: Element) {
      const id =
        this.closest("[data-thread-id]")?.getAttribute("data-thread-id");
      if (id) scrolled.push(id);
    };
    const thread = (i: number, resolved: boolean) => ({
      id: `t${i}`,
      sessionId: "s1",
      kind: "discussion",
      anchor: {},
      comments: [
        {
          id: `c${i}`,
          author: "you",
          body: `Point ${i}`,
          createdAt: `2026-10-31T19:${String(60 - i).padStart(2, "0")}:00Z`,
          updatedAt: `2026-10-31T19:${String(60 - i).padStart(2, "0")}:00Z`,
        },
      ],
      resolved,
      createdAt: "2026-10-31T19:00:00Z",
      updatedAt: "2026-10-31T19:00:00Z",
    });
    // Fifteen, newest first; the last three resolved.
    const review = (resolved: Set<number>) =>
      ({
        ...snapshot,
        threads: Array.from({ length: 15 }, (_, i) =>
          thread(i + 1, resolved.has(i + 1)),
        ),
      }) as unknown as ReviewSnapshot;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const show = (resolved: Set<number>) =>
      act(async () => {
        root.render(
          <ReviewOverlay
            snapshot={review(resolved)}
            connectionId="desktop"
            onClose={() => {}}
          />,
        );
      });
    const resolved = new Set([13, 14, 15]);
    await show(resolved);
    await act(settle);
    const button = (label: RegExp, scope: ParentNode = host) =>
      [...scope.querySelectorAll("button")].find((element) =>
        label.test(element.textContent ?? ""),
      );
    await act(async () => button(/^Conversations \(/)!.click());
    await act(settle);
    const list = host.querySelector<HTMLElement>(".review-threads")!;
    const ids = () =>
      [...list.querySelectorAll("[data-thread-id]")].map((node) =>
        node.getAttribute("data-thread-id"),
      );
    const selected = () =>
      list.querySelector(".rt-item.selected")?.getAttribute("data-thread-id");
    const key = (name: string) =>
      act(async () => {
        list.dispatchEvent(
          new KeyboardEvent("keydown", { key: name, bubbles: true }),
        );
      });

    // Open ones only, with the count of the resolved ones to show them.
    expect(ids()).toEqual(Array.from({ length: 12 }, (_, i) => `t${i + 1}`));
    expect(list.querySelector(".rt-count")?.textContent).toBe(
      "12 open · 3 resolved, show",
    );
    expect(list.querySelector(".rt-group")?.textContent).toBe(
      "3 resolved, show",
    );

    for (let i = 0; i < 6; i++) await key("j");
    expect(selected()).toBe("t7");
    list.scrollTop = 120;
    scrolled.length = 0;
    // r resolves it; the review comes back with it resolved.
    await key("r");
    resolved.add(7);
    await show(resolved);
    await act(settle);
    expect(ids()).not.toContain("t7");
    expect(selected()).toBe("t8");
    expect(list.scrollTop).toBe(120);
    expect(scrolled).toEqual([]);

    // Scrolled up by hand, it stays there through new renders.
    list.scrollTop = 0;
    await show(resolved);
    await act(settle);
    expect(list.scrollTop).toBe(0);
    expect(scrolled).toEqual([]);
    // A move by key still brings the selection into view.
    await key("j");
    expect(scrolled).toEqual(["t9"]);

    // H lists the resolved ones after the open ones, and is remembered.
    await key("H");
    expect(ids()).toEqual([
      ...[1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12].map((i) => `t${i}`),
      ...[7, 13, 14, 15].map((i) => `t${i}`),
    ]);
    expect(list.querySelector(".rt-group")?.textContent).toBe(
      "4 resolved, hide",
    );
    expect(
      JSON.parse(localStorage.getItem("roamgate:reviewPrefs") ?? "{}"),
    ).toMatchObject({ resolvedShown: true });

    // R answers the selected one right there; it reloads nothing.
    const loads = () => calls.filter((call) => call === "review.commits");
    const loaded = loads().length;
    await key("R");
    await act(settle);
    expect(selected()).toBe("t9");
    expect(
      list.querySelector("[data-thread-id='t9'] .rc-editor"),
    ).not.toBeNull();
    expect(loads()).toHaveLength(loaded);
    browser.Element.prototype.scrollIntoView = scrollIntoView;
    await act(async () => root.unmount());
  });

  test("typing a comment renders the editor alone, not the review", async () => {
    const { act, Profiler } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { EditorView } = await import("@codemirror/view");
    const { ReviewOverlay } = await import("./ReviewOverlay");
    const { takeReviewDraft } = await import("../reviewDrafts");
    failing.clear();
    // Left by the tests above.
    takeReviewDraft("s1", "overall");
    diffFiles = [
      {
        path: "a.ts",
        oldPath: "a.ts",
        hunks: [
          {
            header: "@@ -1,0 +1,40 @@",
            lines: Array.from({ length: 40 }, (_, i) => ({
              kind: "+",
              old: null,
              new: i + 1,
              text: `const line${i} = ${i};`,
            })),
          },
        ],
      },
    ];
    let commits = 0;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <Profiler id="review" onRender={() => commits++}>
          <ReviewOverlay
            snapshot={snapshot}
            connectionId="desktop"
            onClose={() => {}}
          />
        </Profiler>,
      );
    });
    await act(settle);
    expect(host.querySelectorAll(".rl").length).toBeGreaterThanOrEqual(40);
    const button = [...host.querySelectorAll("button")].find(
      (element) => element.textContent === "Overall comment",
    );
    await act(async () => button!.click());
    await act(settle);
    const view = EditorView.findFromDOM(
      host.querySelector<HTMLElement>(".cm-content")!,
    );
    commits = 0;
    for (const key of "Looks good") {
      await act(async () =>
        view!.dispatch({
          changes: { from: view!.state.doc.length, insert: key },
        }),
      );
    }
    await act(settle);
    // Each key re-rendered every diff line and thread before.
    expect(commits).toBe(0);
    // What was typed is still what the editor keeps and saves.
    await act(async () => root.unmount());
    expect(takeReviewDraft("s1", "overall")).toBe("Looks good");
    diffFiles = [];
  });
  test("a large file with threads opens, each thread on its line; one between hunks gets context", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ReviewOverlay } = await import("./ReviewOverlay");
    failing.clear();
    const question = (id: string, line: number, body: string) => ({
      id,
      sessionId: "s1",
      kind: "discussion",
      anchor: { path: "plan.md", line, side: "new" },
      comments: [
        {
          id: `${id}c`,
          author: "Claude",
          body,
          createdAt: "2026-11-04T14:11:18Z",
          updatedAt: "2026-11-04T14:11:18Z",
        },
      ],
      resolved: false,
      createdAt: "2026-11-04T14:11:18Z",
      updatedAt: "2026-11-04T14:11:18Z",
    });
    const lines = Array.from({ length: 1000 }, (_, i) => `plan line ${i + 1}`);
    fileText = `${lines.join("\n")}\n`;
    // 816 changed lines (past the large-file fold), then unchanged lines,
    // then a last small hunk: line 900 is between the hunks.
    diffFiles = [
      {
        path: "plan.md",
        oldPath: "plan.md",
        hunks: [
          {
            header: "@@ -1,0 +1,816 @@",
            lines: lines.slice(0, 816).map((text, i) => ({
              kind: "+",
              old: null,
              new: i + 1,
              text,
            })),
          },
          {
            header: "@@ -950,1 +950,1 @@",
            lines: [{ kind: " ", old: 950, new: 950, text: lines[949] }],
          },
        ],
      },
    ];
    const withThreads = {
      ...snapshot,
      threads: [
        question("q1", 354, "How does element code get its Element?"),
        question("q2", 900, "And this unchanged line?"),
      ],
    } as unknown as ReviewSnapshot;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ReviewOverlay
          snapshot={withThreads}
          connectionId="desktop"
          onClose={() => {}}
        />,
      );
    });
    await act(settle);
    await act(settle);
    // Not folded: no "Show 816 lines", the file's lines are there.
    expect(host.textContent).not.toContain("Show 817 lines");
    expect(host.textContent).not.toContain("Show 816 lines");
    expect(host.textContent).toContain("plan line 354");
    // Neither thread is in the list apart from the code.
    const apart = host.querySelector(".review-mr")?.textContent ?? "";
    expect(apart).not.toContain("How does element code get its Element?");
    expect(apart).not.toContain("And this unchanged line?");
    expect(host.textContent).toContain(
      "How does element code get its Element?",
    );
    expect(host.textContent).toContain("And this unchanged line?");
    // The unchanged line is shown with its neighbours.
    for (const around of [897, 899, 900, 901, 903])
      expect(host.textContent).toContain(`plan line ${around}`);
    await act(async () => root.unmount());
    diffFiles = [];
    fileText = "";
  });

  test("r marks the chunk under the cursor reviewed, folded to a line; Option+V the file", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ReviewOverlay } = await import("./ReviewOverlay");
    failing.clear();
    localStorage.clear();
    agentCalls.length = 0;
    const lines = (path: string, from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        kind: "+",
        old: null,
        new: from + i,
        text: `${path} line ${from + i}`,
      }));
    diffFiles = [
      {
        path: "a.ts",
        oldPath: "a.ts",
        hunks: [
          { header: "@@ -1,0 +1,3 @@", lines: lines("a.ts", 1, 3) },
          { header: "@@ -10,0 +20,3 @@", lines: lines("a.ts", 20, 3) },
        ],
      },
      {
        path: "b.ts",
        oldPath: "b.ts",
        hunks: [{ header: "@@ -1,0 +1,2 @@", lines: lines("b.ts", 1, 2) }],
      },
    ];
    let marks: Record<string, string> = {};
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const render = () =>
      act(async () => {
        root.render(
          <ReviewOverlay
            snapshot={
              {
                ...snapshot,
                session: { ...snapshot.session, reviewed: marks },
              } as unknown as ReviewSnapshot
            }
            connectionId="desktop"
            onClose={() => {}}
          />,
        );
      });
    /** The marks the last review.update wrote, applied as the bridge does. */
    const applyUpdate = async () => {
      const updates = agentCalls.filter((c) => c.method === "review.update");
      const update = updates[updates.length - 1];
      const changes = (update?.params.reviewed ?? {}) as Record<
        string,
        string | null
      >;
      const next = { ...marks };
      for (const [key, value] of Object.entries(changes))
        if (value === null) delete next[key];
        else next[key] = value;
      marks = next;
      await render();
      await act(settle);
    };
    await render();
    await act(settle);
    const overlay = host.querySelector<HTMLElement>(".review-overlay")!;
    const keys = (...names: string[]) =>
      act(async () => {
        for (const name of names)
          overlay.dispatchEvent(
            new KeyboardEvent("keydown", { key: name, bubbles: true }),
          );
      });
    const cursorText = () => host.querySelector(".rl.cur")?.textContent ?? "";

    expect(cursorText()).toContain("a.ts line 1");
    await keys("r");
    await act(settle);
    await applyUpdate();
    const written = Object.keys(marks);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^all:a\.ts\nh3\./);
    // Folded to one line; the cursor on the next chunk; 1/2 in the list.
    expect(host.textContent).not.toContain("a.ts line 3");
    expect(host.querySelector(".rd-hunk-done")?.textContent).toContain(
      "chunk reviewed",
    );
    expect(cursorText()).toContain("a.ts line 20");
    expect(host.querySelector(".rf-chunks")?.textContent).toBe("1/2 chunks");

    // A click on it shows it again, za folds it back.
    await act(async () =>
      host.querySelector<HTMLElement>(".rd-hunk-done")!.click(),
    );
    await act(settle);
    expect(host.textContent).toContain("a.ts line 3");
    await keys("z", "a");
    await act(settle);
    expect(host.textContent).not.toContain("a.ts line 3");
    // r on it unmarks it; r again marks it and goes on.
    await keys("r");
    await act(settle);
    await applyUpdate();
    expect(host.textContent).toContain("a.ts line 3");
    expect(Object.values(marks)).toEqual([""]);
    expect(host.querySelector(".rf-chunks")).toBeNull();
    await keys("r");
    await act(settle);
    await applyUpdate();
    expect(cursorText()).toContain("a.ts line 20");

    // gU goes back over the reviewed one: b.ts is the previous not reviewed.
    await keys("g", "U");
    await act(settle);
    expect(cursorText()).toContain("b.ts line 1");
    await keys("g", "u");
    await act(settle);
    expect(cursorText()).toContain("a.ts line 20");

    // The second chunk: the file is reviewed, folded, ticked.
    await keys("r");
    await act(settle);
    await applyUpdate();
    expect(host.textContent).not.toContain("a.ts line 20");
    expect(host.querySelector(".rf-check.done")).not.toBeNull();
    expect(Object.values(marks)).toContain("1");
    expect(Object.keys(marks)).toContain("all:a.ts");

    // Shown again, the reviewed file shows its chunks.
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".rd-file .rd-show")!.click(),
    );
    await act(settle);
    expect(host.textContent).toContain("a.ts line 3");

    // Option+V on b.ts marks it whole: a Mac types "√", its code is KeyV.
    const optionV = async (target: HTMLElement = overlay) => {
      const event = new KeyboardEvent("keydown", {
        key: "√",
        code: "KeyV",
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        target.dispatchEvent(event);
      });
      return event;
    };
    const updates = () =>
      agentCalls.filter((call) => call.method === "review.update").length;
    const bRow = () =>
      [...host.querySelectorAll<HTMLElement>(".rl[data-at]")].find((row) =>
        row.textContent?.includes("b.ts line 1"),
      )!;
    await act(async () => bRow().click());
    expect((await optionV()).defaultPrevented).toBe(true);
    await act(settle);
    await applyUpdate();
    expect(Object.keys(marks)).toContain("all:b.ts");
    expect(host.textContent).not.toContain("b.ts line 1");
    // Shown again from the file list, Option+V on it unmarks it.
    await act(async () =>
      host.querySelector<HTMLButtonElement>("button[title='b.ts']")!.click(),
    );
    await act(settle);
    await act(async () => bRow().click());
    await optionV();
    await act(settle);
    await applyUpdate();
    expect(marks["all:b.ts"]).toBe("");
    expect(host.textContent).toContain("b.ts line 1");

    // In a comment it types, and the file stays as it is.
    await act(async () => bRow().click());
    await keys("c");
    await act(settle);
    const before = updates();
    const typed = await optionV(
      host.querySelector<HTMLElement>(".rc-editor .cm-content")!,
    );
    await act(settle);
    expect(typed.defaultPrevented).toBe(false);
    expect(updates()).toBe(before);
    expect(host.textContent).toContain("b.ts line 1");
    await act(async () => root.unmount());
    diffFiles = [];
    localStorage.clear();
  });

  test("a reload stays on the commit reviewed, or on what a rebase made of it", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ReviewOverlay } = await import("./ReviewOverlay");
    failing.clear();
    localStorage.clear();
    const commit = (sha: string, subject: string) => ({
      sha: sha.repeat(40),
      parent: null,
      author: "T",
      date: "2026-11-05",
      subject,
      body: "",
    });
    commitsAnswer = {
      commits: [
        commit("a", "First"),
        commit("b", "Second"),
        commit("c", "Third"),
      ],
    };
    diffFiles = [
      {
        path: "a.ts",
        oldPath: "a.ts",
        hunks: [
          {
            header: "@@ -1,0 +1,30 @@",
            lines: Array.from({ length: 30 }, (_, i) => ({
              kind: "+",
              old: null,
              new: i + 1,
              text: `a.ts line ${i + 1}`,
            })),
          },
        ],
      },
    ];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ReviewOverlay
          snapshot={snapshot}
          connectionId="desktop"
          onClose={() => {}}
        />,
      );
    });
    await act(settle);
    const overlay = host.querySelector<HTMLElement>(".review-overlay")!;
    const keys = (...names: string[]) =>
      act(async () => {
        for (const name of names)
          overlay.dispatchEvent(
            new KeyboardEvent("keydown", { key: name, bubbles: true }),
          );
      });
    const head = () =>
      host.querySelector(".review-commits .review-commit-name .note")
        ?.textContent ?? "";
    const cursorText = () => host.querySelector(".rl.cur")?.textContent ?? "";
    expect(head()).toBe("1/3 aaaaaaaa");
    await keys(">");
    await act(settle);
    expect(head()).toBe("2/3 bbbbbbbb");
    const row = [...host.querySelectorAll<HTMLElement>(".rl[data-at]")].find(
      (element) => element.textContent?.includes("a.ts line 12"),
    )!;
    await act(async () => row.click());
    expect(cursorText()).toContain("a.ts line 12");

    // Reloaded as it is: the same commit and line. R reloads as gr does.
    const reads = commitsParams.length;
    await keys("R");
    await act(settle);
    expect(commitsParams).toHaveLength(reads + 1);
    expect(commitsParams[commitsParams.length - 1]?.follow).toBe(
      "b".repeat(40),
    );
    expect(head()).toBe("2/3 bbbbbbbb");
    expect(cursorText()).toContain("a.ts line 12");

    // Rebased with the second commit reworded: its patch id finds it.
    commitsAnswer = {
      commits: [
        commit("d", "First"),
        commit("e", "Third"),
        commit("f", "Second, reworded"),
      ],
      patchIds: {
        ["b".repeat(40)]: "1".repeat(40),
        ["d".repeat(40)]: "2".repeat(40),
        ["e".repeat(40)]: "3".repeat(40),
        ["f".repeat(40)]: "1".repeat(40),
      },
    };
    await keys("g", "r");
    await act(settle);
    expect(head()).toBe("3/3 ffffffff");
    expect(cursorText()).toContain("a.ts line 12");

    // Amended (new patch id): found by its subject.
    commitsAnswer = {
      commits: [
        commit("1", "First"),
        commit("2", "Second, reworded"),
        commit("3", "Third"),
      ],
    };
    await keys("g", "r");
    await act(settle);
    expect(head()).toBe("2/3 22222222");

    // Gone: the nearest commit by place.
    commitsAnswer = { commits: [commit("4", "Other")] };
    await keys("g", "r");
    await act(settle);
    expect(head()).toBe("1/1 44444444");

    // All changes stays all changes.
    commitsAnswer = {
      commits: [commit("4", "Other"), commit("5", "More")],
    };
    await keys("g", "r");
    await act(settle);
    await keys("<");
    await act(settle);
    expect(head()).toBe("All changes");
    await keys("g", "r");
    await act(settle);
    expect(commitsParams[commitsParams.length - 1]?.follow).toBeUndefined();
    expect(head()).toBe("All changes");

    await act(async () => root.unmount());
    commitsAnswer = { commits: [] };
    diffFiles = [];
    localStorage.clear();
  });
}
