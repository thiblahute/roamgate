import { expect, test } from "bun:test";

if (process.env.ROAMGATE_MR_EFFORT_DOM_TEST !== "1") {
  test("an effort's view and ledger, in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_MR_EFFORT_DOM_TEST: "1" },
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
  test("the card, tabs, the ledger keys, :mark, Undo and a commit history", async () => {
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
      NodeFilter: browser.NodeFilter,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      MutationObserver: browser.MutationObserver,
      Event: browser.Event,
      CustomEvent: browser.CustomEvent,
      KeyboardEvent: browser.KeyboardEvent,
      MouseEvent: browser.MouseEvent,
      CSS: { escape: (value: string) => value.replace(/["\\]/g, "\\$&") },
      getComputedStyle: browser.getComputedStyle.bind(browser),
      requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    (browser.HTMLElement.prototype as any).scrollIntoView = () => {};
    localStorage.setItem("roamgate:mrReviewsFilter", "mine");

    const React = await import("react");
    const { act } = React;
    const { bridge } = await import("../api");
    const { store } = await import("../store");
    const review = await import("../review");
    const shown: string[] = [];
    (store as any).jumpToConnectionWorkspace = async (
      connectionId: string,
      workspaceId: string,
    ) => {
      shown.push(`jump ${connectionId} ${workspaceId}`);
    };
    const own = {
      approvedBy: [] as string[],
      approved: false,
      changesRequested: [] as string[],
      unresolved: 0,
      conflicts: false,
      needsRebase: false,
    };
    const key = (n: number) => `gitlab:gitlab.example.org/group/app#${n}`;
    const entry = (number: number, extra: Record<string, unknown> = {}) => ({
      provider: "gitlab",
      host: "gitlab.example.org",
      project: "group/app",
      number,
      key: key(number),
      url: `https://gitlab.example.org/group/app/-/merge_requests/${number}`,
      title: `Change ${number}`,
      author: "me",
      draft: false,
      state: "open",
      updatedAt: new Date().toISOString(),
      headSha: "aaaaaaa1",
      sourceBranch: `topic-${number}`,
      targetBranch: "main",
      pipeline: "success",
      notes: 0,
      reasons: ["authored"],
      section: "authored",
      unread: { newCommits: false, newNotes: 0, changed: false },
      isNew: false,
      own,
      lane: "waiting",
      laneWhy: "in review",
      next: { text: "Waiting for review", from: "rule" },
      ...extra,
    });
    void entry;
    const commits = Array.from({ length: 300 }, (_, i) => ({
      key: `k${i}`,
      sha: `${i.toString(16).padStart(4, "0")}${"a".repeat(36)}`,
      patchId: `p${i}`,
      subject: i === 1 ? "fixup! pool: a" : `pool: change ${i}`,
      author: "me",
      authorDate: 1,
      files: [`pool/f${i}.c`],
      dir: i % 2 ? "pool" : "docs",
      disposition: i < 100 ? "upstream" : "unsorted",
    }));
    const summary = {
      id: "e1",
      name: "Big",
      group: "g1",
      source: "big",
      target: "origin/main",
      total: 300,
      counts: { upstream: 100, unsorted: 200 },
      notReady: 3,
      changed: 2,
      proposals: 1,
      overlaps: [
        {
          with: "other",
          kind: "branch",
          shared: 4,
          relation: "partial",
          proposal: "4 commits shared with other: put them in one part only",
        },
      ],
    };
    const calls: [string, Record<string, unknown>][] = [];
    const lastWrite = () =>
      calls.filter(([m]) => m !== "bridge.mr_reviews.effort.get").pop();
    (bridge as any).call = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push([method, params]);
      if (method === "bridge.mr_reviews.effort.get")
        return {
          effort: { id: "e1", name: "Big" },
          summary,
          commits,
          feeders: [{ ref: "refs/heads/feed", notReady: 3, drift: 2 }],
          daily: [
            { date: "2026-11-15", counts: { unsorted: 250, upstream: 50 } },
            { date: "2026-11-16", counts: { unsorted: 200, upstream: 100 } },
          ],
          journal: [{ id: 4, at: "", by: "agent", summary: "kept" }],
          proposals: {
            k100: [
              {
                sha: "f".repeat(40),
                subject: "bufferpool: lazily",
                author: "me",
                score: 0.8,
                why: "same files, subject",
              },
            ],
          },
          plans: [
            {
              id: "p1",
              name: "Pool base",
              commits: ["k101", "k102"],
              dependsOn: [],
              state: "accepted",
              at: "",
              by: "user",
            },
            {
              id: "p2",
              name: "Pool API",
              commits: ["k103"],
              dependsOn: ["p1"],
              state: "proposed",
              at: "",
              by: "agent",
            },
          ],
          changes: {
            since: "2026-11-15T10:00:00Z",
            unsorted: ["k299"],
            landed: [],
            inReview: [],
            feeders: [{ ref: "refs/heads/feed", landed: 2 }],
            partsMerged: [],
            proposals: ["k100"],
            upstreamAnyway: [],
          },
        };
      if (method === "bridge.mr_reviews.effort.delete")
        return { ok: true, effort: { id: "e1", name: "Big" }, version: 7 };
      if (method === "bridge.mr_reviews.effort.diff")
        return { text: "1:  111 ! 1:  222 old" };
      if (method === "bridge.mr_reviews.effort.open_commit")
        return {
          ok: true,
          connectionId: "local",
          workspaceId: "w1",
          sessionId: `rs-${params.from ? "versions" : "commit"}`,
          snapshot: {
            session: { id: `rs-${params.from ? "versions" : "commit"}` },
            threads: [],
          },
        };
      if (method === "bridge.mr_reviews.ledger.match")
        return { accepted: 1, rejected: 0, journal: 6 };
      if (method === "bridge.mr_reviews.effort.part")
        return {
          ok: false,
          branch: "pool-base",
          picked: 1,
          of: 2,
          conflict: { sha: "c".repeat(40), subject: "x", files: ["pool/a.c"] },
        };
      if (method === "bridge.mr_reviews.ledger.set")
        return { changed: (params.commits as string[]).length, journal: 5 };
      if (method === "bridge.mr_reviews.effort.history")
        return {
          versions: [
            {
              sha: "1".repeat(40),
              subject: "old",
              where: "source",
              seenAt: "2026-11-01T10:00",
            },
            {
              sha: "2".repeat(40),
              subject: "new",
              where: "source",
              seenAt: "2026-11-02T10:00",
            },
          ],
        };
      return { ok: true };
    };
    const { createRoot } = await import("react-dom/client");
    const { MrEffortView, MrEffortCard } = await import("./MrEffortView");
    const host = document.createElement("div");
    document.body.append(host);
    const said: string[] = [];
    let undo: (() => Promise<unknown>) | undefined;
    const leaders: number[] = [];
    const jumps: [string, string][] = [];
    await act(async () =>
      createRoot(host).render(
        <>
          <ul>
            <MrEffortCard
              summary={summary as any}
              onOpen={() => {}}
              onLeader={() => leaders.push(1)}
            />
          </ul>
          <MrEffortView
            id="e1"
            onBack={() => said.push("back")}
            onLeader={() => leaders.push(2)}
            onJump={(connection, workspace) =>
              jumps.push([connection, workspace])
            }
            say={(label, run) => {
              said.push(label);
              undo = run;
            }}
          />
        </>,
      ),
    );
    const wait = (ms: number) =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    await wait(30);
    const card = host.querySelector(".mr-effort-card")!;
    expect(card.textContent).toContain("100 of 300 upstream");
    expect(card.textContent).toContain("3 not ready");
    expect(card.textContent).toContain("overlaps other");
    const view = host.querySelector<HTMLElement>(".mr-effort-view")!;
    const press = async (key: string) =>
      act(async () => {
        (document.activeElement ?? view).dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 15));
      });
    view.focus();
    expect(view.textContent).toContain(
      "300 commits: 100 upstream, 200 unsorted",
    );
    expect(view.textContent).toContain("4 commits also in other");
    expect(view.querySelector(".mr-effort-burndown")).not.toBeNull();
    await press("F");
    expect(view.textContent).toContain(
      "feed: 3 not on the source yet, 2 behind it",
    );
    await press("L");
    // Virtualized: a window of rows, not 300.
    const rows = () => view.querySelectorAll(".mr-ledger-row");
    expect(rows().length).toBeLessThan(80);
    expect(
      view.querySelector(".mr-ledger")!.getAttribute("aria-rowcount"),
    ).toBe("300");
    await press("G");
    await press("g");
    await press("g");
    await press("j");
    await press("V");
    await press("j");
    await press("j");
    expect(view.textContent).toContain("3 selected");
    await press(":");
    const input = document.activeElement as HTMLInputElement;
    expect(input.getAttribute("aria-label")).toBe("Ledger command");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        browser.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "mark not-upstream debug only");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("Enter");
    await wait(30);
    expect(calls.find(([m]) => m === "bridge.mr_reviews.ledger.set")).toEqual([
      "bridge.mr_reviews.ledger.set",
      {
        id: "e1",
        commits: ["k1", "k2", "k3"],
        disposition: "not_for_upstream",
        reason: "debug only",
      },
    ]);
    expect(said).toContain("3 commits not for upstream");
    await act(async () => {
      await undo!();
    });
    expect(calls[calls.length - 1]).toEqual([
      "bridge.mr_reviews.ledger.undo",
      { id: "e1", journal: 5 },
    ]);
    // The filter keeps tokens; Enter shows a commit's versions.
    view.focus();
    await press("/");
    const filter = document.activeElement as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        browser.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(filter, "dir:docs disposition:unsorted");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(view.textContent).toContain("100 of 300");
    await press("Enter");
    view.focus();
    await press("Enter");
    await wait(30);
    expect(
      [...view.querySelectorAll(".mr-effort-history li")].map((li) =>
        li.textContent?.trim().slice(0, 14),
      ),
    ).toEqual(["1111111111 old", "2222222222 new"]);
    // Two versions picked: d compares them in the head workspace's Changes
    // (D32), the page goes there and the Reviews pane hides.
    const boxes = view.querySelectorAll<HTMLInputElement>(
      ".mr-effort-history input[type=checkbox]",
    );
    await act(async () => {
      boxes[0]!.click();
      boxes[1]!.click();
    });
    view.focus();
    await press("d");
    await wait(30);
    expect(calls[calls.length - 1]).toEqual([
      "bridge.mr_reviews.effort.open_commit",
      { id: "e1", sha: "2".repeat(40), from: "1".repeat(40) },
    ]);
    expect(review.getReviewSnapshot("rs-versions")).toBeDefined();
    expect(shown).toEqual(["jump local w1"]);
    expect(jumps).toEqual([["local", "w1"]]);
    expect(view.querySelector(".mr-effort-diff")).toBeNull();
    // Its head workspace not open: the two as text here instead.
    const opened = (bridge as any).call;
    (bridge as any).call = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      if (method === "bridge.mr_reviews.effort.open_commit") {
        calls.push([method, params]);
        throw new Error("its head workspace is not open: open it, or set head");
      }
      return opened(method, params);
    };
    view.focus();
    await press("d");
    await wait(30);
    expect(calls[calls.length - 1]).toEqual([
      "bridge.mr_reviews.effort.diff",
      { id: "e1", from: "1".repeat(40), to: "2".repeat(40) },
    ]);
    expect(view.querySelector(".mr-effort-diff")?.textContent).toBe(
      "1:  111 ! 1:  222 old",
    );
    (bridge as any).call = opened;
    await press("Escape");
    await press("Escape");
    expect(view.querySelector(".mr-effort-history")).toBeNull();
    // d alone: goes to the head workspace with the commit's diff in its
    // Changes, as Enter on a request goes to its home.
    await press("d");
    await wait(30);
    expect(calls[calls.length - 1]).toEqual([
      "bridge.mr_reviews.effort.open_commit",
      { id: "e1", sha: expect.stringMatching(/^[0-9a-f]+$/) },
    ]);
    expect(review.getReviewSnapshot("rs-commit")).toBeDefined();
    expect(shown).toEqual(["jump local w1", "jump local w1"]);
    expect(jumps).toEqual([
      ["local", "w1"],
      ["local", "w1"],
    ]);

    // A proposal shows in the row, :confirm confirms it.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        browser.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(filter, "0064");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    view.focus();
    expect(view.querySelector(".mr-ledger-note.is-proposal")?.textContent).toBe(
      "like ffffffff (0.8)",
    );
    expect(view.querySelector(".mr-effort-proposals")?.textContent).toContain(
      "bufferpool: lazily",
    );
    await press(":");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        browser.HTMLInputElement.prototype,
        "value",
      )!.set!;
      const box = document.activeElement as HTMLInputElement;
      setter.call(box, "confirm");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("Enter");
    await wait(30);
    expect(calls.find(([m]) => m === "bridge.mr_reviews.ledger.match")).toEqual(
      [
        "bridge.mr_reviews.ledger.match",
        {
          id: "e1",
          decisions: [{ commit: "k100", match: "f".repeat(40), accept: true }],
        },
      ],
    );
    expect(said).toContain("1 match confirmed");
    // Plans: accept a proposed one, make the part of an accepted one.
    await press("R");
    const plans = view.querySelector(".mr-effort-plans")!;
    expect(plans.textContent).toContain("Pool API");
    expect(plans.textContent).toContain("after Pool base");
    const buttons = [...plans.querySelectorAll("button")];
    await act(async () => {
      buttons.find((b) => b.textContent === "Accept")!.click();
    });
    await wait(30);
    expect(lastWrite()).toEqual([
      "bridge.mr_reviews.ledger.plans",
      { id: "e1", action: "accept", plan: "p2" },
    ]);
    await act(async () => {
      buttons.find((b) => b.textContent === "Make its part")!.click();
    });
    await wait(30);
    expect(lastWrite()).toEqual([
      "bridge.mr_reviews.effort.part",
      { id: "e1", plan: "p1" },
    ]);
    expect(said[said.length - 1]).toBe(
      "Part pool-base: 1 of 2 picked, stopped at cccccccccc (pool/a.c): resolve it there",
    );
    // What changed, then seen.
    await press("W");
    const changed = view.querySelector(".mr-effort-changes")!;
    expect(changed.textContent).toContain("New unsorted commits (1)");
    expect(changed.textContent).toContain("Feeders landed");
    expect(changed.textContent).toContain("feed: 2 commits reached the source");
    await press(":");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        browser.HTMLInputElement.prototype,
        "value",
      )!.set!;
      const box = document.activeElement as HTMLInputElement;
      setter.call(box, "seen");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("Enter");
    await wait(30);
    expect(calls.some(([m]) => m === "bridge.mr_reviews.effort.seen")).toBe(
      true,
    );
    expect(card.textContent).toContain("2 changed");
    expect(card.textContent).toContain("1 to confirm");
    // gl: its leader session (c comments, as in Changes).
    await press("g");
    await press("l");
    expect(leaders).toEqual([2]);

    // Delete: :delete asks first, naming the effort and what goes with it;
    // Escape keeps it.
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
    await press(":");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        browser.HTMLInputElement.prototype,
        "value",
      )!.set!;
      const box = document.activeElement as HTMLInputElement;
      setter.call(box, "delete");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("Enter");
    expect(dialog()?.getAttribute("aria-label")).toBe("Delete the effort Big?");
    expect(dialog()?.textContent).toContain(
      "Big leaves Reviews with its card, its ledger marks, its plans and its history (300 commits)",
    );
    expect(dialog()?.textContent).toContain(
      "Its parts' branches and worktrees stay as they are",
    );
    expect(dialog()?.textContent).toContain("Undo brings it all back");
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(dialog()).toBeNull();
    expect(calls.some(([m]) => m === "bridge.mr_reviews.effort.delete")).toBe(
      false,
    );
    expect(said).not.toContain("back");
    // The heading's button, then confirmed: deleted, said with Undo, back
    // to the inbox.
    const deleteButton = [...view.querySelectorAll("button")].find(
      (each) => each.textContent?.trim() === "Delete effort\u2026",
    )!;
    await act(async () => {
      deleteButton.click();
    });
    const confirmButton = [...dialog()!.querySelectorAll("button")].find(
      (each) => each.textContent === "Delete effort",
    )!;
    await act(async () => {
      confirmButton.click();
    });
    await wait(30);
    expect(dialog()).toBeNull();
    expect(lastWrite()).toEqual([
      "bridge.mr_reviews.effort.delete",
      { id: "e1" },
    ]);
    expect(said.slice(-2)).toEqual(["Deleted the effort Big", "back"]);
    await act(async () => {
      await undo!();
    });
    expect(calls[calls.length - 1]).toEqual([
      "bridge.mr_reviews.order",
      { op: "undo", version: 7 },
    ]);
  });
}
