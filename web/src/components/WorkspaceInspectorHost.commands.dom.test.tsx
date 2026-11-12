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
  /** What the inspector gave Changes' diff, last. */
  let diffProps: { reviewCursor?: boolean } | null = null;
  mock.module("./DiffContentView", () => ({
    DiffContentView: (props: { reviewCursor?: boolean }) => {
      diffProps = props;
      return null;
    },
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
          "vim",
          "set",
          "help",
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

    test(":vim, :novim and :set vim / novim switch the Vim keys; :set reviewin= picks where reviews open; another :set is unknown", async () => {
      const { readReviewPrefs, writeReviewPrefs } = await import(
        "../reviewPrefs"
      );
      const { setVimKeys, vimKeys } = await import("../vimKeys");
      writeReviewPrefs({ reviewIn: undefined });
      setVimKeys(true);
      const inspector = await mountInspector({ view: "changes" });
      try {
        const place = () => inspector.place("changes");
        told.length = 0;
        await inspector.command(place(), "vim");
        expect(vimKeys()).toBe(false);
        await inspector.command(place(), "vim");
        expect(vimKeys()).toBe(true);
        await inspector.command(place(), "novim");
        expect(vimKeys()).toBe(false);
        await inspector.command(place(), "set vim");
        expect(vimKeys()).toBe(true);
        expect(told).toEqual([
          "Vim keys off",
          "Vim keys on",
          "Vim keys off",
          "Vim keys on",
        ]);
        told.length = 0;
        await inspector.command(place(), "set reviewin");
        await inspector.command(place(), "set reviewin=changes");
        expect(readReviewPrefs().reviewIn).toBe("changes");
        await inspector.command(place(), "set reviewin=classic");
        expect(readReviewPrefs().reviewIn).toBe("classic");
        expect(told).toEqual([
          "Reviews open in the review pane (reviewin=classic)",
          "Reviews open in Changes (reviewin=changes)",
          "Reviews open in the review pane (reviewin=classic)",
        ]);
        told.length = 0;
        await inspector.command(place(), "set number");
        expect(told[0]).toStartWith("Not a command here: :set number (try ");
        // Tab completes what :set takes.
        place().focus();
        await inspector.press(place(), ":");
        await inspector.type("set rev");
        expect(inspector.completions()).toEqual([
          "set reviewin=classic",
          "set reviewin=changes",
        ]);
        await inspector.press(inspector.prompt()!, "Escape");
      } finally {
        await inspector.unmount();
        writeReviewPrefs({ reviewIn: undefined });
        setVimKeys(true);
      }
    });

    test("? and :help list the view's commands and the inspector's keys, filtered by :help WORD; Esc closes it; ? in a field is text", async () => {
      const inspector = await mountInspector({ view: "files" });
      const list = () =>
        inspector.host.querySelector(".review-keys.inspector-keys");
      const rows = () =>
        [...inspector.host.querySelectorAll(".inspector-keys .keys-row")].map(
          (row) =>
            [...row.querySelectorAll("kbd")]
              .map((key) => key.textContent)
              .join(" "),
        );
      try {
        const item = inspector.place("tree");
        item.focus();
        await inspector.press(item, "?");
        expect(list()?.querySelector("h2")?.textContent).toBe(
          "Inspector shortcuts",
        );
        expect(rows()).toEqual([
          "gt gT",
          ":",
          "?",
          "← → Home End",
          ":refresh",
          ":reload :refresh",
          ":view :v",
          ":dock",
          ":expand",
          ":vim",
          ":set",
          ":help",
          ":q :quit :close",
        ]);
        const filter = list()!.querySelector<HTMLInputElement>("input")!;
        expect(document.activeElement).toBe(filter);
        await inspector.press(filter, "Escape");
        expect(list()).toBeNull();
        await inspector.command(inspector.tab("Files"), "help dock");
        expect(filter.isConnected).toBe(false);
        expect(list()!.querySelector("input")!.value).toBe("dock");
        expect(rows()).toEqual([":dock"]);
        // The close button too, the focus back on the view's tab.
        await act(async () =>
          list()!
            .querySelector<HTMLButtonElement>("[title='Close (Esc)']")!
            .click(),
        );
        expect(list()).toBeNull();
        expect(document.activeElement).toBe(inspector.tab("Files"));
        // In a text field, ? is text.
        await inspector.press(
          inspector.host.querySelector("[aria-label='Search checkout']")!,
          "?",
        );
        expect(list()).toBeNull();
      } finally {
        await inspector.unmount();
      }
    });

    test("in Changes, :files hides the changed files' tree and :only shows the diff alone; Esc, :only and Show all bring all back", async () => {
      const inspector = await mountInspector({ view: "changes" });
      const changes = () =>
        inspector.host.querySelector(".inspector-changes-resource")!;
      const hint = () =>
        inspector.host.querySelector<HTMLButtonElement>(
          ".inspector-review-only-hint button",
        );
      try {
        const place = () => inspector.place("changes");
        expect(changes().classList.contains("files-tree-hidden")).toBe(false);
        await inspector.command(place(), "files");
        expect(changes().classList.contains("files-tree-hidden")).toBe(true);
        await inspector.command(place(), "files");
        expect(changes().classList.contains("files-tree-hidden")).toBe(false);
        await inspector.command(place(), "only");
        expect(changes().classList.contains("is-review-only")).toBe(true);
        expect(hint()?.textContent).toBe("Show all");
        await inspector.press(document.body, "Escape");
        expect(changes().classList.contains("is-review-only")).toBe(false);
        await inspector.command(place(), "o");
        expect(changes().classList.contains("is-review-only")).toBe(true);
        await inspector.command(place(), "only");
        expect(changes().classList.contains("is-review-only")).toBe(false);
        await inspector.command(place(), "only");
        await act(async () => hint()!.click());
        expect(changes().classList.contains("is-review-only")).toBe(false);
        // Another view has its own :files, none of Changes' :only.
        told.length = 0;
        await inspector.command(inspector.tab("Changes"), "view commits");
        await inspector.command(inspector.place("commits"), "only");
        expect(told[0]).toStartWith("Not a command here: :only");
      } finally {
        await inspector.unmount();
      }
    });

    test("every word of the inspector's own commands reaches the source view's Vim `:` too", async () => {
      const { INSPECTOR_COMMAND_WORDS } = await import("../inspectorCommands");
      const { PREVIEW_COMMAND_WORDS } = await import("./FilePreviewContent");
      const forwarded = new Set([
        ...INSPECTOR_COMMAND_WORDS,
        ...PREVIEW_COMMAND_WORDS,
      ]);
      for (const view of ["files", "changes", "commits"] as const) {
        const inspector = await mountInspector({ view });
        try {
          const tab = inspector.tab(view[0]!.toUpperCase() + view.slice(1));
          tab.focus();
          await inspector.press(tab, "?");
          const words = [
            ...inspector.host.querySelectorAll(".inspector-keys .keys-row kbd"),
          ]
            .map((key) => key.textContent ?? "")
            .filter((key) => key.startsWith(":") && key.length > 1)
            .map((key) => key.slice(1));
          // The stand-ins' own words aside, every word is forwarded; but
          // `:set`, which stays CodeMirror Vim's own options there.
          for (const word of words.filter(
            (word) =>
              !["refresh", "reload", "scope", "commit", "set"].includes(word),
          ))
            expect([word, forwarded.has(word)]).toEqual([word, true]);
          expect(words).toContain("help");
        } finally {
          await inspector.unmount();
        }
      }
    });

    test("gt and gT go to the next and previous view, 2gt to the second; never in a text field", async () => {
      const inspector = await mountInspector({ view: "files" });
      try {
        const item = inspector.place("tree");
        item.focus();
        await inspector.press(item, "g");
        await inspector.press(item, "t");
        expect(inspector.views.slice(-1)[0]).toBe("changes");
        expect(document.activeElement).toBe(inspector.tab("Changes"));
        const tab = inspector.tab("Changes");
        await inspector.press(tab, "g");
        await inspector.press(tab, "t");
        expect(inspector.views.slice(-1)[0]).toBe("commits");
        // Past the last view, the first.
        await inspector.press(inspector.tab("Commits"), "g");
        await inspector.press(inspector.tab("Commits"), "t");
        expect(inspector.views.slice(-1)[0]).toBe("files");
        await inspector.press(inspector.tab("Files"), "g");
        await inspector.press(inspector.tab("Files"), "T");
        expect(inspector.views.slice(-1)[0]).toBe("commits");
        await inspector.press(inspector.tab("Commits"), "2");
        await inspector.press(inspector.tab("Commits"), "g");
        await inspector.press(inspector.tab("Commits"), "t");
        expect(inspector.views.slice(-1)[0]).toBe("changes");
        // g then another key is the view's: no view change.
        const count = inspector.views.length;
        await inspector.press(inspector.tab("Changes"), "g");
        await inspector.press(inspector.tab("Changes"), "g");
        expect(inspector.views.length).toBe(count);
        // Typed in a field, g and t are text.
        const field = inspector.host.querySelector<HTMLElement>(
          "[aria-label='changes field']",
        )!;
        await inspector.press(field, "g");
        await inspector.press(field, "t");
        expect(inspector.views.length).toBe(count);
      } finally {
        await inspector.unmount();
      }
    });

    test("Changes gets the review's cursor only on `:set reviewin=changes` with Vim keys on", async () => {
      const { writeReviewPrefs } = await import("../reviewPrefs");
      writeReviewPrefs({ vim: undefined, reviewIn: undefined });
      const inspector = await mountInspector({ view: "changes" });
      try {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        // On classic (the default), Changes keeps its own keys.
        expect(diffProps?.reviewCursor).toBe(false);
        await inspector.command(
          inspector.place("changes"),
          "set reviewin=changes",
        );
        expect(diffProps?.reviewCursor).toBe(true);
        await inspector.command(inspector.place("changes"), "novim");
        expect(diffProps?.reviewCursor).toBe(false);
        await inspector.command(inspector.place("changes"), "vim");
        expect(diffProps?.reviewCursor).toBe(true);
        await inspector.command(
          inspector.place("changes"),
          "set reviewin=classic",
        );
        expect(diffProps?.reviewCursor).toBe(false);
      } finally {
        await inspector.unmount();
        writeReviewPrefs({ vim: undefined, reviewIn: undefined });
      }
    });
  });
}
