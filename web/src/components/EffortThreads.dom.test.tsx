import { expect, test } from "bun:test";

if (process.env.ROAMGATE_EFFORT_THREADS_DOM_TEST !== "1") {
  test("comments on an effort's view, in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_EFFORT_THREADS_DOM_TEST: "1" },
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
  test("a comment on a plan card and on a ledger row, kept across a refresh and a rebase", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({
      url: "http://localhost/",
      width: 1280,
      height: 800,
    });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      HTMLInputElement: browser.HTMLInputElement,
      HTMLButtonElement: browser.HTMLButtonElement,
      Element: browser.Element,
      Node: browser.Node,
      Text: browser.Text,
      DOMParser: browser.DOMParser,
      NodeFilter: browser.NodeFilter,
      Range: browser.Range,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      MutationObserver: browser.MutationObserver,
      ResizeObserver: browser.ResizeObserver,
      Event: browser.Event,
      CustomEvent: browser.CustomEvent,
      KeyboardEvent: browser.KeyboardEvent,
      MouseEvent: browser.MouseEvent,
      getSelection: browser.getSelection.bind(browser),
      CSS: { escape: (value: string) => value.replace(/["\\]/g, "\\$&") },
      getComputedStyle: browser.getComputedStyle.bind(browser),
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
    (browser.HTMLElement.prototype as any).scrollIntoView = () => {};

    const React = await import("react");
    const { act } = React;
    const { bridge } = await import("../api");
    const review = await import("../review");

    // The effort, read again after a rebase: new shas, the same keys.
    let rebased = false;
    const commits = () =>
      Array.from({ length: 20 }, (_, i) => ({
        key: `k${i}`,
        sha: `${(rebased ? 0x9000 : 0) + i}`.padStart(4, "0") + "b".repeat(36),
        patchId: `p${i}`,
        subject: `pool: change ${i}`,
        author: "me",
        authorDate: 1,
        files: [`pool/f${i}.c`],
        dir: "pool",
        disposition: "unsorted",
      }));
    const detail = () => ({
      effort: { id: "e1", name: "Big" },
      summary: {
        id: "e1",
        name: "Big",
        group: "g1",
        source: "big",
        target: "origin/main",
        total: 20,
        counts: { unsorted: 20 },
        notReady: 0,
        overlaps: [],
      },
      commits: commits(),
      feeders: [],
      daily: [],
      journal: [],
      plans: [
        {
          id: "p1",
          name: "Pool base",
          commits: ["k3", "k4"],
          dependsOn: [],
          state: "accepted",
          at: "",
          by: "user",
        },
      ],
    });

    // The server's effort review: made by the first comment, kept after.
    let session: any = null;
    const threads: any[] = [];
    const snapshot = () => ({ session, threads: structuredClone(threads) });
    const calls: [string, Record<string, unknown>][] = [];
    (bridge as any).call = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push([method, params]);
      if (method === "bridge.mr_reviews.effort.get") return detail();
      if (method === "bridge.mr_reviews.effort.threads") {
        if (!session && params.open === true)
          session = {
            id: "rs-effort",
            connectionId: "local",
            workspaceId: "w1",
            root: "/big",
            title: "Effort Big",
            target: { kind: "effort", effort: "e1" },
            gitlab: false,
            summary: "",
            agent: { name: "Claude" },
            createdAt: "2026-11-17T10:00:00Z",
            updatedAt: "2026-11-17T10:00:00Z",
          };
        return { snapshot: session ? snapshot() : null };
      }
      return { ok: true };
    };
    const reviewCalls: [string, Record<string, unknown>][] = [];
    // A review is read and written on its own connection.
    (bridge as any).callConnection = async (
      _connectionId: string,
      method: string,
      params: Record<string, unknown>,
    ) => {
      reviewCalls.push([method, params]);
      if (method === "review.thread.add") {
        const at = new Date().toISOString();
        threads.push({
          id: params.new_thread_id,
          sessionId: session.id,
          kind: params.kind,
          anchor: params.anchor,
          comments: [
            {
              id: `${params.new_thread_id}c`,
              author: "you",
              body: params.text,
              createdAt: at,
              updatedAt: at,
            },
          ],
          resolved: false,
          createdAt: at,
          updatedAt: at,
        });
      } else if (method === "review.resolve") {
        const thread = threads.find((each) => each.id === params.comment_id);
        thread.resolved = params.resolved;
      }
      return snapshot();
    };

    const { createRoot } = await import("react-dom/client");
    const { EditorView } = await import("@codemirror/view");
    const { MrEffortView } = await import("./MrEffortView");
    const host = document.createElement("div");
    document.body.append(host);
    const wait = (ms: number) =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    const mount = async () => {
      const root = createRoot(host);
      await act(async () =>
        root.render(
          <MrEffortView
            id="e1"
            onBack={() => {}}
            onLeader={() => {}}
            say={() => {}}
          />,
        ),
      );
      await wait(30);
      return root;
    };
    let root = await mount();
    const view = () => host.querySelector<HTMLElement>(".mr-effort-view")!;
    const press = async (key: string) =>
      act(async () => {
        (document.activeElement ?? view()).dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 15));
      });
    /** Writes in the comment box being written, then sends it. */
    const writeComment = async (text: string) => {
      for (
        let i = 0;
        i < 50 && !host.querySelector(".is-draft .cm-content");
        i++
      )
        await wait(10);
      const editor = EditorView.findFromDOM(
        host.querySelector<HTMLElement>(".is-draft .cm-content")!,
      )!;
      await act(async () =>
        editor.dispatch({ changes: { from: 0, insert: text } }),
      );
      const send = [...host.querySelectorAll(".is-draft button")].find(
        (button) => button.textContent === "Send",
      ) as HTMLButtonElement;
      await act(async () => send.click());
      await wait(30);
    };

    // Plans: a click points at the plan card, c comments on it.
    view().focus();
    await press("R");
    const card = () =>
      host.querySelector<HTMLElement>('[data-effort-item="plan"]')!;
    expect(card().dataset.effortKey).toBe("p1");
    await act(async () => card().click());
    expect(card().dataset.pointed).toBe("true");
    view().focus();
    await press("c");
    expect(card().querySelector(".is-draft")).not.toBeNull();
    await writeComment("Split the API out of this one?");
    expect(
      calls.some(
        ([method, params]) =>
          method === "bridge.mr_reviews.effort.threads" && params.open === true,
      ),
    ).toBe(true);
    const added = reviewCalls.find(
      ([method]) => method === "review.thread.add",
    )!;
    expect(added[1].anchor).toEqual({
      effort: {
        tab: "plans",
        item: { kind: "plan", key: "p1", label: "Pool base" },
      },
    });
    expect(card().querySelector(".mr-effort-thread")?.textContent).toContain(
      "Split the API out of this one?",
    );
    expect(view().textContent).toContain("1 open thread");

    // Ledger: j moves the cursor, c comments on that row's commit.
    await press("L");
    await press("j");
    await press("j");
    await press("c");
    await writeComment("Is this one upstream already?");
    const onRow = reviewCalls.filter(
      ([method]) => method === "review.thread.add",
    )[1]!;
    expect((onRow[1].anchor as any).effort).toEqual({
      tab: "ledger",
      item: {
        kind: "commit",
        key: "k2",
        label: `0002${"b".repeat(6)} pool: change 2`,
      },
    });
    expect(
      host.querySelector('[data-effort-key="k2"] .mr-effort-thread-count')
        ?.textContent,
    ).toBe("1");
    expect(view().textContent).toContain("Is this one upstream already?");
    expect(view().textContent).toContain("2 open threads");

    // A refresh after a rebase: a new page, new shas, the threads where
    // they were.
    await act(async () => root.unmount());
    review.acceptReviewPush({
      type: "removed",
      sessionId: "rs-effort",
      connectionId: "local",
    });
    rebased = true;
    root = await mount();
    view().focus();
    await press("R");
    expect(card().querySelector(".mr-effort-thread")?.textContent).toContain(
      "Split the API out of this one?",
    );
    await press("L");
    expect(
      host.querySelector('[data-effort-key="k2"] .mr-effort-thread-count')
        ?.textContent,
    ).toBe("1");
    // gn goes to the next open thread, in the order of the tabs: the
    // ledger's first, then the plan's.
    await press("g");
    await press("n");
    await wait(30);
    const focused = document.activeElement as HTMLElement;
    expect(focused.classList.contains("mr-effort-thread")).toBe(true);
    expect(focused.textContent).toContain("Is this one upstream already?");
    // r resolves it, from the thread.
    await press("r");
    await wait(30);
    expect(
      reviewCalls.filter(([method]) => method !== "review.get").pop(),
    ).toEqual([
      "review.resolve",
      { session_id: "rs-effort", comment_id: threads[1].id, resolved: true },
    ]);
    expect(view().textContent).toContain("1 open thread");
    await act(async () => root.unmount());
  });
}
