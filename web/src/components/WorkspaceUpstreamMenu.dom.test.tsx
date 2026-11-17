import { expect, test } from "bun:test";

if (process.env.ROAMGATE_WORKSPACE_UPSTREAM_DOM_TEST !== "1") {
  test("a workspace's Headed upstream items, in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_WORKSPACE_UPSTREAM_DOM_TEST: "1" },
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
  test("Headed upstream and Declare an upstreaming effort on a workspace's own menu", async () => {
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
      HTMLSelectElement: browser.HTMLSelectElement,
      Element: browser.Element,
      Node: browser.Node,
      NodeFilter: browser.NodeFilter,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      MutationObserver: browser.MutationObserver,
      ResizeObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      Event: browser.Event,
      CustomEvent: browser.CustomEvent,
      KeyboardEvent: browser.KeyboardEvent,
      MouseEvent: browser.MouseEvent,
      getComputedStyle: browser.getComputedStyle.bind(browser),
      requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
      cancelAnimationFrame: (id: number) => clearTimeout(id),
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
    const calls: [string, Record<string, unknown>][] = [];
    (bridge as any).call = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push([method, params]);
      if (method === "bridge.mr_reviews.upstream.marks")
        return { groups: [], skip: [], workspaces: [] };
      return { ok: true };
    };
    const { createRoot } = await import("react-dom/client");
    const { ContextMenu } = await import("./ContextMenu");
    const { MrEffortDeclare } = await import("./MrEffortView");
    const { workspaceUpstreamItems } = await import("../mrUpstream");
    const { upstreamWorkspaceHome } = await import("../../../shared/mrReviews");
    const { WORKSPACE_TREE_VERSION } = await import(
      "../../../shared/workspaceTree"
    );

    const workspace = {
      workspace_id: "w1",
      number: 1,
      label: "roamgate",
      focused: true,
      pane_count: 1,
      tab_count: 1,
      agent_status: "idle",
      cwd: "/src/roamgate",
      worktree: {
        repo_key: "roamgate",
        repo_name: "roamgate",
        repo_root: "/src/roamgate",
        checkout_path: "/src/roamgate",
        is_linked_worktree: false,
        git_status: {
          branch: "dogfood",
          ahead: 0,
          behind: 0,
          staged: 0,
          unstaged: 0,
          untracked: 0,
          conflicted: 0,
          dirty: false,
        },
      },
    };
    const ref = {
      connection_id: "local",
      path: "/src/roamgate",
      label: "roamgate",
      workspace_id: "w1",
    };
    const tree: import("../../../shared/workspaceTree").WorkspaceTree = {
      version: WORKSPACE_TREE_VERSION,
      nodes: [{ id: "g1", kind: "group", parent: null, label: "Upstream" }],
    };
    const declared: unknown[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const show = async (
      marks: { groups: string[]; skip: any[]; workspaces: any[] },
      parent: string | null,
    ) =>
      act(async () =>
        root.render(
          <ContextMenu
            state={{ x: 10, y: 10, workspace: workspace as any }}
            pinnedWorkspaceKeys={new Set()}
            onPinnedChange={() => {}}
            onClose={() => {}}
            arrangeItems={workspaceUpstreamItems({
              tree,
              marks,
              ref,
              parent,
              branch: workspace.worktree.git_status.branch,
              declare: (prefill) => declared.push(prefill),
            })}
          />,
        ),
      );
    const item = (label: string) =>
      [...host.querySelectorAll<HTMLButtonElement>(".context-menu-item")].find(
        (button) => button.textContent === label,
      );
    const click = async (button: HTMLButtonElement) =>
      act(async () => {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

    // In no marked group, not marked: the toggle, unchecked, no effort.
    await show({ groups: [], skip: [], workspaces: [] }, null);
    const toggle = item("Headed upstream")!;
    expect(toggle).toBeDefined();
    expect(toggle.getAttribute("role")).toBe("menuitemcheckbox");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(item("Declare an upstreaming effort…")).toBeUndefined();
    await click(toggle);
    expect(
      calls.find(
        ([method]) => method === "bridge.mr_reviews.upstream.workspace",
      ),
    ).toEqual(["bridge.mr_reviews.upstream.workspace", { ref, headed: true }]);

    // Marked by itself: checked, and an effort declared on it, prefilled.
    calls.length = 0;
    await show({ groups: [], skip: [], workspaces: [ref] }, null);
    expect(item("Headed upstream")!.getAttribute("aria-checked")).toBe("true");
    await click(item("Declare an upstreaming effort…")!);
    expect(declared).toEqual([
      { home: upstreamWorkspaceHome(ref), source: "dogfood" },
    ]);
    await click(item("Headed upstream")!);
    expect(
      calls.find(
        ([method]) => method === "bridge.mr_reviews.upstream.workspace",
      ),
    ).toEqual(["bridge.mr_reviews.upstream.workspace", { ref, headed: false }]);

    // In a marked group: headed as the group, not a toggle of its own.
    declared.length = 0;
    await show({ groups: ["g1"], skip: [], workspaces: [] }, "g1");
    const inherited = item("Headed upstream (as Upstream)")!;
    expect(inherited.getAttribute("aria-checked")).toBe("true");
    expect(inherited.disabled).toBe(true);
    expect(item("Not headed upstream")).toBeDefined();
    await click(item("Declare an upstreaming effort…")!);
    expect(declared).toEqual([{ home: "g1", source: "dogfood" }]);
    // Skipped there: not headed, no effort.
    await show({ groups: ["g1"], skip: [ref], workspaces: [] }, "g1");
    expect(
      item("Headed upstream (as Upstream)")!.getAttribute("aria-checked"),
    ).toBe("false");
    expect(item("Headed upstream again")).toBeDefined();
    expect(item("Declare an upstreaming effort…")).toBeUndefined();
    await act(async () => root.render(<></>));

    // The declaring opens on the workspace with its branch as the source.
    const form = document.createElement("div");
    document.body.append(form);
    const formRoot = createRoot(form);
    await act(async () =>
      formRoot.render(
        <MrEffortDeclare
          groups={[]}
          workspaces={[ref]}
          initial={{ home: upstreamWorkspaceHome(ref), source: "dogfood" }}
          onDone={() => {}}
          onCancel={() => {}}
        />,
      ),
    );
    const select = form.querySelector("select")!;
    expect(select.value).toBe(upstreamWorkspaceHome(ref));
    expect(select.textContent).toBe("roamgate");
    const source = form.querySelector<HTMLInputElement>(
      "input[placeholder^='the branch followed']",
    )!;
    expect(source.value).toBe("dogfood");
    // Nothing headed upstream: the hint names both menus.
    await act(async () =>
      formRoot.render(
        <MrEffortDeclare
          groups={[]}
          workspaces={[]}
          onDone={() => {}}
          onCancel={() => {}}
        />,
      ),
    );
    expect(form.textContent).toContain(
      "Mark a workspace or a group of the Workspaces tree as Headed upstream first (the workspace or group menu)",
    );
    await act(async () => {
      formRoot.unmount();
      root.unmount();
    });
  });
}
