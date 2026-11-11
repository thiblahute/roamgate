import { describe, expect, mock, test } from "bun:test";

/*
 * The inspector's one `:` prompt: `:` opens it wherever the inspector has
 * the focus (the Files tree, Changes, Commits, History, the tab strip),
 * never in a text field; the shown view's commands come first, then the
 * inspector's own (`:view NAME`, `:dock`, `:expand`, `:q`); Esc, Backspace
 * on nothing and Enter give the focus back. The views are stand-ins that
 * give commands as the real ones do (useInspectorCommands).
 */
if (process.env.ROAMGATE_INSPECTOR_COMMANDS_DOM_TEST !== "1") {
  test("the inspector's command line in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_INSPECTOR_COMMANDS_DOM_TEST: "1" },
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
  const { installChangesDom } = await import("./changesSurface.testkit");
  await installChangesDom();
  const { useInspectorCommands } = await import("../useInspectorCommands");
  const ran: string[] = [];
  /** A view's stand-in: a focusable place, a text field, one command. */
  const part =
    (name: string, command: string, field = "input") =>
    () => {
      useInspectorCommands({
        commands: [
          {
            name: command,
            description: `${name}'s ${command}`,
            run: (argument) =>
              ran.push(`${name} ${command}${argument ? ` ${argument}` : ""}`),
          },
        ],
      });
      return (
        <div data-stub={name}>
          <button type="button" data-place={name}>
            {name}
          </button>
          {field === "textarea" ? (
            <textarea aria-label={`${name} field`} />
          ) : field === "editable" ? (
            <div aria-label={`${name} field`} contentEditable />
          ) : (
            <input aria-label={`${name} field`} />
          )}
        </div>
      );
    };
  mock.module("./FileExplorerDialog", () => ({
    FileExplorerPanel: () => {
      useInspectorCommands({
        commands: [
          {
            name: "refresh",
            description: "refresh the file tree",
            run: () => ran.push("tree refresh"),
          },
        ],
      });
      return (
        <div role="tree" aria-label="Workspace files">
          <div role="treeitem" tabIndex={0} data-place="tree">
            a.md
          </div>
          <input aria-label="Search checkout" />
        </div>
      );
    },
  }));
  mock.module("./AgentHistoryDrawer", () => ({
    AgentHistoryDrawer: part("history", "timeline", "textarea"),
  }));
  mock.module("./FilePreviewTabs", () => ({ FilePreviewTabs: () => null }));
  mock.module("./PullRequestCard", () => ({ PullRequestCard: () => null }));
  const diffPanel = await import("./DiffViewerPanel");
  mock.module("./DiffViewerPanel", () => ({
    ...diffPanel,
    DiffViewerPanel: part("changes", "scope", "editable"),
  }));
  const preview = await import("./FilePreviewContent");
  const { useRef } = await import("react");
  mock.module("./FilePreviewContent", () => ({
    ...preview,
    // The preview's `:reload`, `:refresh` too, drawn where its focus is.
    FilePreviewContent: () => {
      const section = useRef<HTMLElement | null>(null);
      useInspectorCommands({
        commands: [
          {
            name: "reload",
            aliases: ["refresh"],
            description: "read the file again",
            run: () => ran.push("preview reload"),
          },
        ],
        root: () => section.current,
      });
      return (
        <section ref={section} aria-label="File preview">
          <div tabIndex={0} data-place="preview">
            a.md
          </div>
        </section>
      );
    },
  }));
  mock.module("./DiffContentView", () => ({
    DiffContentView: () => null,
  }));
  mock.module("./GitCommitHistory", () => ({
    GitCommitHistory: part("commits", "commit"),
  }));
  const { store } = await import("../store");
  const told: string[] = [];
  store.notify = ((notice: { message: string }) => {
    told.push(notice.message);
  }) as typeof store.notify;

  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceInspectorHost } = await import("./WorkspaceInspectorHost");
  type Props = Parameters<typeof WorkspaceInspectorHost>[0];
  type View = Props["state"]["view"];
  type Workspace = NonNullable<Props["workspace"]>;

  const workspace = {
    workspace_id: "w1",
    number: 1,
    label: "Repo",
    focused: true,
    pane_count: 1,
    tab_count: 1,
    agent_status: "",
    worktree: { repo_name: "repo", checkout_path: "/repo" },
  } as unknown as Workspace;

  async function mountInspector(options: { view?: View; agentPane?: boolean }) {
    let view: View = options.view ?? "files";
    let dock: Props["state"]["dock"] = "right";
    let expanded = false;
    const views: View[] = [];
    const closed: string[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const client = {
      connectionId: "local",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
      call: async () => ({}),
    } as unknown as Props["connectionClient"];
    const empty = { entry: null, preview: null, loading: false, error: null };
    const render = (): Promise<void> =>
      act(async () =>
        root.render(
          <WorkspaceInspectorHost
            state={{
              scope: {
                kind: "workspace",
                connectionId: "local",
                workspaceId: "w1",
              } as Props["state"]["scope"],
              open: true,
              view,
              dock,
              size: 480,
              expanded,
            }}
            visible
            workspace={workspace}
            historyPane={
              options.agentPane
                ? ({ pane_id: "p1", agent: "claude" } as Props["historyPane"])
                : undefined
            }
            fileSelection={empty as Props["fileSelection"]}
            onSelectFileTab={() => {}}
            previewRequestRef={{ current: 0 }}
            diffSelection={
              {
                entry: null,
                file: null,
                loading: false,
                error: null,
                entries: [],
                files: {},
                fileErrors: {},
              } as unknown as Props["diffSelection"]
            }
            connectionClient={client}
            onFileSelectionChange={() => {}}
            onDiffSelectionChange={() => {}}
            onOpenDiffFile={() => {}}
            annotations={[]}
            onCreateAnnotation={() => {}}
            onReanchorFileAnnotations={() => {}}
            onReanchorDiffAnnotations={() => {}}
            onEditAnnotation={() => {}}
            onOpenDocument={() => {}}
            onRefreshFile={() => {}}
            onViewChange={(next) => {
              views.push(next);
              view = next;
              void render();
            }}
            onDockChange={(next) => {
              dock = next;
              void render();
            }}
            onExpandedChange={(next) => {
              expanded = next;
              void render();
            }}
            onClose={() => closed.push("inspector")}
            onBack={() => {}}
          />,
        ),
      );
    await render();
    const inspector = host.querySelector<HTMLElement>(".workspace-inspector")!;
    const prompt = () =>
      host.querySelector<HTMLInputElement>(".review-cmdline input");
    const place = (name: string) =>
      host.querySelector<HTMLElement>(`[data-place="${name}"]`)!;
    const tab = (name: string) =>
      [...host.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((each) =>
        each.textContent?.trim().startsWith(name),
      )!;
    const press = (target: Element, key: string, init = {}) =>
      act(async () => {
        target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
      });
    const type = (text: string) =>
      act(async () => {
        const input = prompt()!;
        Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(input),
          "value",
        )!.set!.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    /** `:` on `from` (focused), `text`, Enter. */
    const command = async (from: HTMLElement, text: string) => {
      from.focus();
      await press(from, ":");
      expect(prompt()).not.toBeNull();
      await type(text);
      await press(prompt()!, "Enter");
      await act(async () => {});
    };
    const completions = () =>
      [...host.querySelectorAll(".review-cmdline .wild-item")].map(
        (item) => item.firstChild?.textContent ?? "",
      );
    return {
      host,
      inspector,
      views,
      closed,
      dock: () => dock,
      expanded: () => expanded,
      prompt,
      place,
      tab,
      press,
      type,
      command,
      completions,
      async unmount() {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }

  describe("the inspector's `:` prompt", () => {
    test("opens from the Files tree, with the tree's and the inspector's commands, and runs them", async () => {
      const inspector = await mountInspector({ view: "files" });
      try {
        const item = inspector.place("tree");
        item.focus();
        await inspector.press(item, ":");
        expect(inspector.prompt()).not.toBeNull();
        expect(document.activeElement).toBe(inspector.prompt());
        // One prompt, at the inspector's bottom edge.
        expect(inspector.inspector.lastElementChild?.className).toBe(
          "review-cmdline",
        );
        expect(inspector.completions()).toEqual([
          "refresh",
          "reload",
          "view",
          "dock",
          "expand",
          "q",
        ]);
        await inspector.press(inspector.prompt()!, "Escape");
        ran.length = 0;
        await inspector.command(item, "refresh");
        expect(ran).toEqual(["tree refresh"]);
        expect(inspector.prompt()).toBeNull();
        expect(document.activeElement).toBe(item);
        // Another view's commands are not this one's.
        told.length = 0;
        await inspector.command(item, "scope");
        expect(told[0]).toStartWith("Not a command here: :scope (try :refresh");
      } finally {
        await inspector.unmount();
      }
    });

    test("`:refresh` is the preview's with the focus in it, the tree's in the tree", async () => {
      const inspector = await mountInspector({ view: "files" });
      try {
        ran.length = 0;
        await inspector.command(inspector.place("preview"), "refresh");
        expect(ran).toEqual(["preview reload"]);
        ran.length = 0;
        await inspector.command(inspector.place("tree"), "refresh");
        expect(ran).toEqual(["tree refresh"]);
        ran.length = 0;
        await inspector.command(inspector.place("preview"), "reload");
        expect(ran).toEqual(["preview reload"]);
      } finally {
        await inspector.unmount();
      }
    });

    test("opens from Changes, Commits and History, each with its own commands", async () => {
      const inspector = await mountInspector({
        view: "changes",
        agentPane: true,
      });
      try {
        ran.length = 0;
        await inspector.command(inspector.place("changes"), "scope branch");
        await inspector.command(inspector.tab("Changes"), "view commits");
        expect(inspector.views.slice(-1)[0]).toBe("commits");
        await inspector.command(inspector.place("commits"), "commit 2");
        await inspector.command(inspector.place("commits"), "view history");
        expect(inspector.views.slice(-1)[0]).toBe("history");
        await inspector.command(inspector.place("history"), "timeline");
        expect(ran).toEqual([
          "changes scope branch",
          "commits commit 2",
          "history timeline",
        ]);
      } finally {
        await inspector.unmount();
      }
    });

    test("opens from the tab strip and the inspector's buttons", async () => {
      const inspector = await mountInspector({ view: "commits" });
      try {
        const files = inspector.tab("Files");
        files.focus();
        await inspector.press(files, ":");
        expect(inspector.prompt()).not.toBeNull();
        await inspector.press(inspector.prompt()!, "Escape");
        expect(document.activeElement).toBe(files);
        const close = inspector.host.querySelector<HTMLButtonElement>(
          "[aria-label='Close Workspace Inspector']",
        )!;
        close.focus();
        await inspector.press(close, ":");
        expect(inspector.prompt()).not.toBeNull();
        // Backspace on nothing leaves it too, the focus back.
        await inspector.press(inspector.prompt()!, "Backspace");
        expect(inspector.prompt()).toBeNull();
        expect(document.activeElement).toBe(close);
      } finally {
        await inspector.unmount();
      }
    });

    test("never opens in a text field, a comment box or editable text, nor with Ctrl / Cmd", async () => {
      const inspector = await mountInspector({
        view: "commits",
        agentPane: true,
      });
      try {
        for (const field of [
          "[aria-label='Search checkout']",
          "[aria-label='changes field']",
          "[aria-label='commits field']",
          "[aria-label='history field']",
        ]) {
          const target = inspector.host.querySelector<HTMLElement>(field)!;
          await inspector.press(target, ":");
          expect(inspector.prompt()).toBeNull();
        }
        const item = inspector.place("commits");
        await inspector.press(item, ":", { ctrlKey: true });
        await inspector.press(item, ":", { metaKey: true });
        expect(inspector.prompt()).toBeNull();
        // A view that took the key itself keeps it.
        item.addEventListener("keydown", (event) => event.preventDefault(), {
          once: true,
        });
        await inspector.press(item, ":");
        expect(inspector.prompt()).toBeNull();
      } finally {
        await inspector.unmount();
      }
    });

    test(":view NAME goes to a view, a name's start too, completed by Tab", async () => {
      const inspector = await mountInspector({ view: "files" });
      try {
        const item = inspector.place("tree");
        item.focus();
        await inspector.press(item, ":");
        await inspector.type("view ");
        // No History tab without an agent pane: not a view here.
        expect(inspector.completions()).toEqual([
          "view files",
          "view changes",
          "view commits",
        ]);
        await inspector.type("view c");
        expect(inspector.completions()).toEqual([
          "view changes",
          "view commits",
        ]);
        await inspector.press(inspector.prompt()!, "Tab");
        expect(inspector.prompt()!.value).toBe("view changes");
        await inspector.press(inspector.prompt()!, "Tab");
        expect(inspector.prompt()!.value).toBe("view commits");
        await inspector.press(inspector.prompt()!, "Enter");
        expect(inspector.views.slice(-1)[0]).toBe("commits");
        // The view's tab takes the focus.
        expect(document.activeElement).toBe(inspector.tab("Commits"));
        await inspector.command(inspector.tab("Commits"), "v c");
        expect(inspector.views.slice(-1)[0]).toBe("changes");
        told.length = 0;
        await inspector.command(inspector.tab("Changes"), "view history");
        expect(inspector.views.slice(-1)[0]).toBe("changes");
        expect(told).toEqual([
          "Not a view here: history (files, changes, commits)",
        ]);
      } finally {
        await inspector.unmount();
      }
    });

    test(":dock, :expand and :q do what the inspector's buttons do", async () => {
      const inspector = await mountInspector({ view: "commits" });
      try {
        const place = () => inspector.place("commits");
        await inspector.command(place(), "dock");
        expect(inspector.dock()).toBe("bottom");
        await inspector.command(place(), "dock right");
        expect(inspector.dock()).toBe("right");
        await inspector.command(place(), "expand");
        expect(inspector.expanded()).toBe(true);
        await inspector.command(place(), "q");
        expect(inspector.closed).toEqual(["inspector"]);
      } finally {
        await inspector.unmount();
      }
    });
  });
}
