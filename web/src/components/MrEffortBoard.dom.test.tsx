import { expect, test } from "bun:test";

if (process.env.ROAMGATE_EFFORT_BOARD_DOM_TEST !== "1") {
  test("an effort's Board, in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_EFFORT_BOARD_DOM_TEST: "1" },
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
  test("the Board: a card per plan in its lane, keys, a comment on a card, one list on a phone", async () => {
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
    const opened: string[] = [];
    (browser as any).open = (url: string) => {
      opened.push(url);
      return null;
    };

    const React = await import("react");
    const { act } = React;
    const { bridge } = await import("../api");

    const own = {
      approvedBy: ["ana"],
      approved: true,
      changesRequested: [] as string[],
      unresolved: 0,
      conflicts: false,
      needsRebase: false,
    };
    const request = (number: number, extra: Record<string, unknown> = {}) => ({
      provider: "gitlab",
      host: "gitlab.example.org",
      project: "media/engine",
      number,
      key: `gitlab:gitlab.example.org/media/engine#${number}`,
      url: `https://gitlab.example.org/media/engine/-/merge_requests/${number}`,
      title: `Request ${number}`,
      author: "me",
      draft: false,
      state: "open",
      updatedAt: new Date().toISOString(),
      headSha: "aaaa",
      sourceBranch: `upstream/r${number}`,
      targetBranch: "main",
      pipeline: "running",
      notes: 0,
      reasons: ["authored"],
      section: "authored",
      unread: null,
      isNew: false,
      own,
      lane: "waiting",
      next: { text: `Wait for review of ${number}`, from: "rule" },
      ...extra,
    });
    const commits = Array.from({ length: 12 }, (_, i) => ({
      key: `k${i}`,
      sha: `${i}`.padStart(4, "0") + "c".repeat(36),
      patchId: `p${i}`,
      subject: `pool: change ${i}`,
      author: "me",
      authorDate: 1,
      files: ["pool/a.c"],
      dir: "pool",
      disposition: i < 2 ? "upstream" : "in_part",
    }));
    const plan = (id: string, keys: string[], extra = {}) => ({
      id,
      name: `Plan ${id}`,
      commits: keys,
      dependsOn: [] as string[],
      state: "accepted",
      at: "",
      by: "agent",
      ...extra,
    });
    const part = (id: string, extra = {}) => ({
      part: {
        connectionId: "local",
        path: `/wt/${id}`,
        branch: `upstream/${id}`,
        workspaceId: `w-${id}`,
        ...extra,
      },
    });
    const plans = [
      plan("idea", ["k10"], { state: "proposed" }),
      plan("base", ["k11"]),
      plan("api", ["k2", "k3"], {
        ...part("api", {
          conflict: { sha: "f".repeat(40), subject: "x", files: ["a.c"] },
        }),
        dependsOn: ["base"],
      }),
      plan("mine", ["k4"], part("mine")),
      plan("wait", ["k5", "k6", "k7"], {
        ...part("wait", { ported: true }),
        dependsOn: ["mine"],
      }),
      plan("landed", ["k0", "k1"], part("landed")),
    ];
    const board = {
      mine: request(11, {
        lane: "your_move",
        next: { text: "Fix the failed pipeline", from: "rule" },
      }),
      wait: request(12),
      landed: request(13, { state: "merged", lane: "done" }),
    };
    const calls: [string, Record<string, unknown>][] = [];
    (bridge as any).call = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push([method, params]);
      if (method === "bridge.mr_reviews.effort.get")
        return {
          effort: { id: "e1", name: "Big" },
          summary: {
            id: "e1",
            name: "Big",
            group: "g1",
            source: "big",
            target: "origin/main",
            total: 12,
            counts: { upstream: 2, in_part: 10 },
            notReady: 0,
            overlaps: [],
          },
          commits,
          feeders: [],
          daily: [],
          journal: [],
          plans,
          board,
        };
      if (method === "bridge.mr_reviews.effort.threads")
        return { snapshot: null };
      return { ok: true };
    };

    const { createRoot } = await import("react-dom/client");
    const { MrEffortView } = await import("./MrEffortView");
    const host = document.createElement("div");
    document.body.append(host);
    const wait = (ms: number) =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    const entered: string[] = [];
    const jumps: string[] = [];
    // The inbox's live entry wins over the one effort.get gave.
    const live = [{ ...board.wait, title: "Request 12, renamed" }];
    const mount = async (wide: boolean) => {
      const root = createRoot(host);
      await act(async () =>
        root.render(
          <MrEffortView
            id="e1"
            onBack={() => {}}
            onLeader={() => {}}
            say={() => {}}
            entries={live as any}
            wide={wide}
            onEnter={(entry) => entered.push(entry.key)}
            onJump={(connection, workspace) =>
              jumps.push(`${connection} ${workspace}`)
            }
            editor={(entry, close) => (
              <div className="test-editor">
                editing {entry.number}
                <button type="button" onClick={close}>
                  close
                </button>
              </div>
            )}
          />,
        ),
      );
      await wait(30);
      return root;
    };
    let root = await mount(true);
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
    const column = (name: string) =>
      host.querySelector<HTMLElement>(`[data-effort-column="${name}"]`);
    const selected = () =>
      host
        .querySelector(".mr-effort-board .mr-reviews-row.is-selected")
        ?.closest("[data-mr-plan], li")
        ?.getAttribute("data-mr-plan") ??
      host
        .querySelector(".mr-effort-board .mr-reviews-row.is-selected")
        ?.getAttribute("data-mr-plan");

    // The Board first: columns side by side, empty ones left out.
    expect(view().querySelector('[aria-pressed="true"]')?.textContent).toBe(
      "Board",
    );
    expect(
      host.querySelector(".mr-effort-board.mr-reviews-board"),
    ).not.toBeNull();
    expect(
      [...host.querySelectorAll("[data-effort-column]")].map((each) =>
        each.getAttribute("data-effort-column"),
      ),
    ).toEqual(["planned", "not_sent", "your_move", "waiting", "done"]);
    const planned = column("planned")!;
    expect(planned.textContent).toContain("Plan idea");
    expect(planned.textContent).toContain("proposed");
    expect(planned.textContent).toContain("Plan base");
    expect(planned.textContent).toContain("accepted");
    const notSent = column("not_sent")!;
    expect(notSent.textContent).toContain("Plan api");
    expect(notSent.textContent).toContain("2 commits");
    expect(notSent.textContent).toContain("after Plan base");
    expect(notSent.textContent).toContain("conflict");
    // A request's card is the inbox's: number, title, chips, next step.
    const yours = column("your_move")!;
    expect(yours.querySelector(".mr-reviews-number")?.textContent).toBe("!11");
    expect(yours.textContent).toContain("Fix the failed pipeline");
    expect(yours.textContent).toContain("approved by ana");
    expect(yours.textContent).toContain("plan Plan mine");
    expect(
      yours.querySelector(".mr-reviews-pipeline.is-running"),
    ).not.toBeNull();
    const waiting = column("waiting")!;
    expect(waiting.textContent).toContain("Request 12, renamed");
    expect(waiting.textContent).toContain("3 commits");
    expect(waiting.textContent).toContain("after Plan mine");
    expect(waiting.textContent).toContain("ported");
    // Done is folded until asked.
    expect(column("done")!.classList.contains("is-folded")).toBe(true);
    expect(column("done")!.textContent).not.toContain("Request 13");

    // Keys: j / k in the column, h / l between columns.
    view().focus();
    await press("j");
    expect(selected()).toBe("idea");
    await press("j");
    expect(selected()).toBe("base");
    await press("l");
    expect(selected()).toBe("api");
    await press("l");
    expect(selected()).toBe("mine");
    await press("Enter");
    expect(entered).toEqual([board.mine.key]);
    await press("o");
    expect(opened).toEqual([board.mine.url]);
    await press("e");
    expect(host.querySelector(".test-editor")?.textContent).toContain(
      "editing 11",
    );
    await press("Escape");
    expect(host.querySelector(".test-editor")).toBeNull();
    // A part with no request: Enter goes to its workspace.
    await press("h");
    expect(selected()).toBe("api");
    await press("Enter");
    expect(jumps).toEqual(["local w-api"]);
    // za unfolds Done (from a card of another column: its own column).
    await press("l");
    await press("l");
    expect(selected()).toBe("wait");
    await press("l");
    expect(selected()).toBe("wait");
    await act(async () =>
      column("done")!
        .querySelector<HTMLElement>(".mr-reviews-lane-title")!
        .click(),
    );
    expect(column("done")!.textContent).toContain("Request 13");
    view().focus();
    await press("l");
    expect(selected()).toBe("landed");

    // c comments on the card: the leader's effort review, by plan id.
    await press("h");
    await press("c");
    const draft = host.querySelector(
      "[data-effort-threads] .is-draft, .mr-effort-card-threads .is-draft",
    );
    expect(draft).not.toBeNull();
    expect(
      draft!
        .closest("[data-effort-threads]")!
        .getAttribute("data-effort-threads"),
    ).toBe(["board", "card", "wait", ""].join("\n"));

    // The tab is remembered.
    view().focus();
    await press("L");
    await act(async () => root.unmount());
    root = await mount(true);
    expect(view().querySelector('[aria-pressed="true"]')?.textContent).toBe(
      "Ledger",
    );
    await press("B");
    await act(async () => root.unmount());

    // A phone: one list under the columns' titles; j goes on through them.
    root = await mount(false);
    expect(view().querySelector('[aria-pressed="true"]')?.textContent).toBe(
      "Board",
    );
    expect(
      host.querySelector(".mr-effort-board.mr-reviews-sections"),
    ).not.toBeNull();
    expect(host.querySelector(".mr-effort-board.mr-reviews-board")).toBeNull();
    view().focus();
    await press("j");
    await press("j");
    expect(selected()).toBe("base");
    await press("j");
    expect(selected()).toBe("api");
    await press("j");
    await press("j");
    expect(selected()).toBe("wait");
    await act(async () => root.unmount());
  });
}
