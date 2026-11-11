import { expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

if (process.env.ROAMGATE_COMMIT_HISTORY_DOM_TEST !== "1") {
  test("commit navigation in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_COMMIT_HISTORY_DOM_TEST: "1" },
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
  }, 15_000);
} else {
  test("compact drill-in preserves selection, preview and desktop resizing", async () => {
    const browser = new Window({ url: "http://localhost" });
    for (const key of [
      "window",
      "document",
      "navigator",
      "HTMLElement",
      "Element",
      "Node",
      "Event",
      "MutationObserver",
      "ResizeObserver",
    ] as const) {
      Object.defineProperty(globalThis, key, {
        value: key === "window" ? browser : browser[key],
        configurable: true,
        writable: true,
      });
    }
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    // happy-dom does not implement history traversal.
    let historyIndex = 0;
    let historyEntries: (object | null)[] = [null];
    Object.defineProperty(browser, "history", {
      value: {
        get state() {
          return historyEntries[historyIndex];
        },
        replaceState(state: object | null) {
          historyEntries[historyIndex] = state;
        },
        pushState(state: object | null) {
          historyEntries = historyEntries.slice(0, historyIndex + 1);
          historyEntries.push(state);
          historyIndex++;
        },
        back() {
          queueMicrotask(() => {
            if (historyIndex === 0) return;
            historyIndex--;
            browser.dispatchEvent(
              new browser.PopStateEvent("popstate", {
                state: historyEntries[historyIndex],
              }),
            );
          });
        },
      },
    });
    const { act, createElement, useState } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useSystemBack } = await import("../systemBack");
    const { updateLayoutPreferences } = await import("../layoutPreferences");
    mock.module("./DiffContentView", () => ({
      DiffContentView: ({
        entry,
        showFileSelector,
      }: {
        entry: { path: string } | null;
        showFileSelector: boolean;
      }) =>
        createElement(
          "div",
          { "data-testid": "diff", "data-selector": showFileSelector },
          entry?.path,
        ),
    }));
    const { GitCommitHistory } = await import("./GitCommitHistory");
    const entries = ["src/one.ts", "src/two.ts"].map((path) => ({
      path,
      kind: "branch",
      status: "modified",
    }));
    const author = {
      name: "Author",
      email: "author@example.com",
      date: "2026-10-20T00:00:00Z",
    };
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const client = {
      connectionId: "test",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
      call: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        if (method === "git.commits")
          return {
            head: "abc123",
            commits: [
              {
                sha: "abc123",
                short_sha: "abc123",
                subject: "First commit",
                author: author.name,
                authored_at: author.date,
              },
              {
                sha: "def456",
                short_sha: "def456",
                subject: "Second commit",
                author: author.name,
                authored_at: author.date,
              },
            ],
            has_more: false,
            shallow: false,
          };
        if (method === "git.commit")
          return {
            sha: params.sha,
            parents: [],
            base: null,
            message:
              params.sha === "abc123"
                ? "First commit\n\nFull message"
                : "Second commit",
            author,
            committer: author,
            entries,
          };
        if (method === "git.commit_file")
          return {
            path: params.path,
            kind: "branch",
            diff: "",
            truncated: false,
          };
        if (method === "git.commit_preview")
          return {
            path: params.path,
            text: "Historical content",
            binary: false,
            truncated: false,
          };
        throw new Error(method);
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    function Inspector({ compact }: { compact: boolean }) {
      const [active, setActive] = useState(true);
      const [popup, setPopup] = useState(false);
      useSystemBack(active, () => setActive(false), "panel");
      useSystemBack(popup, () => setPopup(false), "popup");
      return createElement(
        "section",
        { "data-active": active, "data-popup": popup },
        createElement(
          "button",
          { id: "toggle-inspector", onClick: () => setActive(!active) },
          "Toggle Inspector",
        ),
        createElement(
          "button",
          { id: "open-popup", onClick: () => setPopup(true) },
          "Open popup",
        ),
        createElement(GitCommitHistory, {
          client,
          compact,
          active,
          workspaceId: "workspace",
          resourceKey: "test",
        }),
      );
    }
    const render = async (compact: boolean) => {
      await act(async () => root.render(createElement(Inspector, { compact })));
    };
    const click = async (selector: string) => {
      const button = container.querySelector<HTMLElement>(selector);
      expect(button).not.toBeNull();
      await act(async () => button!.click());
    };
    const page = () =>
      container.querySelector<HTMLElement>(".git-commit-history")!;
    try {
      await render(true);
      expect(page().dataset.page).toBe("commits");
      await click(".git-commit-row");
      expect(page().dataset.page).toBe("files");
      expect(document.activeElement?.textContent).toContain("Commits");
      expect(container.textContent).toContain("Full message");
      await click(".git-commit-file:nth-child(2) > button");
      expect(page().dataset.page).toBe("diff");
      expect(
        container
          .querySelector('[data-testid="diff"]')
          ?.getAttribute("data-selector"),
      ).toBe("false");
      expect(container.querySelector('[data-testid="diff"]')?.textContent).toBe(
        "src/two.ts",
      );
      expect(document.activeElement?.textContent).toContain("Changed files");
      await click(".git-commit-content .git-commit-back");
      expect(page().dataset.page).toBe("files");
      expect(
        container.querySelector(".git-commit-file.is-selected")?.textContent,
      ).toContain("src/two.ts");
      await click(".git-commit-file:nth-child(2) .git-commit-preview-button");
      expect(page().dataset.page).toBe("diff");
      expect(
        container.querySelector(".git-commit-preview pre")?.textContent,
      ).toBe("Historical content");
      expect(
        calls.find((call) => call.method === "git.commit_preview")?.params,
      ).toEqual({
        workspace_id: "workspace",
        sha: "abc123",
        path: "src/two.ts",
      });
      await click(".git-commit-preview-head button");
      expect(container.querySelector('[data-testid="diff"]')?.textContent).toBe(
        "src/two.ts",
      );
      await render(false);
      expect(
        container
          .querySelector('[data-testid="diff"]')
          ?.getAttribute("data-selector"),
      ).toBe("false");
      expect(container.querySelector("select")).toBeNull();
      page().getBoundingClientRect = () =>
        new browser.DOMRect(0, 0, 1200, 800) as DOMRect;
      const resizer =
        container.querySelector<HTMLElement>('[role="separator"]')!;
      await act(async () =>
        resizer.dispatchEvent(
          new browser.KeyboardEvent("keydown", {
            key: "ArrowRight",
            bubbles: true,
          }) as unknown as KeyboardEvent,
        ),
      );
      expect(
        Number.parseFloat(
          page().style.getPropertyValue("--git-commit-navigation-width"),
        ),
      ).toBeCloseTo(26.333);
      await act(async () =>
        resizer.dispatchEvent(
          new browser.KeyboardEvent("keydown", {
            key: "End",
            bubbles: true,
          }) as unknown as KeyboardEvent,
        ),
      );
      expect(
        Number.parseFloat(
          page().style.getPropertyValue("--git-commit-navigation-width"),
        ),
      ).toBeCloseTo(55.333);
      await act(async () =>
        resizer.dispatchEvent(
          new browser.MouseEvent("dblclick", {
            bubbles: true,
          }) as unknown as MouseEvent,
        ),
      );
      expect(
        page().style.getPropertyValue("--git-commit-navigation-width"),
      ).toBe("25%");
      await click(".git-commit-row:nth-child(2)");
      await render(true);
      expect(page().dataset.page).toBe("files");
      expect(container.querySelector('[data-testid="diff"]')?.textContent).toBe(
        "src/one.ts",
      );
      await click(".git-commit-files-pane .git-commit-back");
      expect(page().dataset.page).toBe("commits");
      expect(document.activeElement?.textContent).toContain("Second commit");

      await act(async () => updateLayoutPreferences({ mode: "mobile" }));
      const back = () => act(async () => browser.history.back());
      const inspectorActive = () =>
        container.querySelector("section")?.dataset.active;
      await click(".git-commit-row:nth-child(2)");
      await click(".git-commit-file:nth-child(2) > button");
      await click("#toggle-inspector");
      expect(inspectorActive()).toBe("false");
      await click("#toggle-inspector");
      expect(page().dataset.page).toBe("diff");
      expect(container.querySelector('[data-testid="diff"]')?.textContent).toBe(
        "src/two.ts",
      );
      await click("#open-popup");
      await back();
      expect(container.querySelector("section")?.dataset.popup).toBe("false");
      expect(page().dataset.page).toBe("diff");
      expect(inspectorActive()).toBe("true");
      await back();
      expect(page().dataset.page).toBe("files");
      expect(inspectorActive()).toBe("true");
      expect(
        container.querySelector(".git-commit-file.is-selected")?.textContent,
      ).toContain("src/two.ts");
      await click("#toggle-inspector");
      await click("#toggle-inspector");
      expect(page().dataset.page).toBe("files");
      await back();
      expect(page().dataset.page).toBe("commits");
      expect(inspectorActive()).toBe("true");
      await back();
      expect(inspectorActive()).toBe("false");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await browser.happyDOM.close();
    }
  });

  test("commits the lost connection failed load again with the client that comes back, and Retry reads them", async () => {
    const browser = new Window({ url: "http://localhost" });
    for (const key of [
      "window",
      "document",
      "navigator",
      "HTMLElement",
      "Element",
      "Node",
      "Event",
      "MutationObserver",
      "ResizeObserver",
    ] as const) {
      Object.defineProperty(globalThis, key, {
        value: key === "window" ? browser : browser[key],
        configurable: true,
        writable: true,
      });
    }
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const { act, createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");
    mock.module("./DiffContentView", () => ({
      DiffContentView: ({ entry }: { entry: { path: string } | null }) =>
        createElement("div", { "data-testid": "diff" }, entry?.path),
    }));
    const { GitCommitHistory } = await import("./GitCommitHistory");
    const author = {
      name: "Author",
      email: "author@example.com",
      date: "2026-10-20T00:00:00Z",
    };
    const commit = (sha: string, subject: string) => ({
      sha,
      short_sha: sha,
      subject,
      author: author.name,
      authored_at: author.date,
    });
    /** The methods failing, and with what; the others answer. */
    const failing = new Map<string, string>();
    const calls: string[] = [];
    const makeClient = () => ({
      connectionId: "test",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
      call: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push(method);
        const failure = failing.get(method);
        if (failure !== undefined) throw new Error(failure);
        if (method === "git.commits")
          return {
            head: "abc123",
            commits: [
              commit("abc123", "First commit"),
              commit("def456", "Second commit"),
            ],
            has_more: false,
            shallow: false,
          };
        if (method === "git.commit")
          return {
            sha: params.sha,
            parents: [],
            base: null,
            message: String(params.sha),
            author,
            committer: author,
            entries: [
              { path: "src/one.ts", kind: "branch", status: "modified" },
            ],
          };
        if (method === "git.commit_file")
          return {
            path: params.path,
            kind: "branch",
            diff: "",
            truncated: false,
          };
        throw new Error(method);
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = async (client: ReturnType<typeof makeClient>) => {
      await act(async () =>
        root.render(
          createElement(GitCommitHistory, {
            client,
            compact: false,
            active: true,
            workspaceId: "workspace",
            resourceKey: "test",
          }),
        ),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const errors = () =>
      [...container.querySelectorAll(".git-commit-state.is-error")].map(
        (state) => state.textContent ?? "",
      );
    const retry = async (index = 0) => {
      const button = [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".git-commit-state.is-error button",
        ),
      ][index];
      expect(button?.textContent).toBe("Retry");
      await act(async () => button!.click());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const selected = () =>
      container.querySelector(".git-commit-row.is-selected")?.textContent ?? "";
    try {
      // The commits read while the connection is down fail.
      failing.set("git.commits", "bridge hello is unavailable");
      const down = makeClient();
      await render(down);
      expect(errors()).toEqual(["bridge hello is unavailableRetry"]);
      // The client that comes with the connection reads them again.
      failing.clear();
      await render(makeClient());
      expect(errors()).toEqual([]);
      expect(container.textContent).toContain("Second commit");
      // A commit read while it is down again: kept selected, read once back.
      const rows = [
        ...container.querySelectorAll<HTMLElement>(".git-commit-row"),
      ].filter((row) => row.textContent?.includes("Second commit"));
      failing.set("git.commit", "bridge disconnected");
      const client = makeClient();
      await render(client);
      await act(async () => rows[0]?.click());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(errors()).toEqual(["bridge disconnectedRetry"]);
      const shown = selected();
      failing.clear();
      await render(makeClient());
      expect(errors()).toEqual([]);
      expect(selected()).toBe(shown);
      expect(container.textContent).toContain("def456");
      // Another error waits for Retry, which reads it again.
      failing.set("git.commits", "fatal: bad revision");
      const refresh = container.querySelector<HTMLButtonElement>(
        "button[aria-label='Refresh commits']",
      );
      await act(async () => refresh!.click());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(errors()).toEqual(["fatal: bad revisionRetry"]);
      const tries = calls.filter((call) => call === "git.commits").length;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(calls.filter((call) => call === "git.commits").length).toBe(tries);
      failing.clear();
      await retry();
      expect(calls.filter((call) => call === "git.commits").length).toBe(
        tries + 1,
      );
      expect(errors()).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await browser.happyDOM.close();
    }
  });
}
