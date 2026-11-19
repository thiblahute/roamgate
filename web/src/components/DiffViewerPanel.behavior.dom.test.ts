import { describe, expect, jest, spyOn, test } from "bun:test";

/**
 * The inspector's Changes tree and scopes (upstream), at the behavior
 * level: clicks and keys in, rows, scopes, menus and loads out. Pinned
 * before Changes becomes the review (plan: review into the inspector,
 * phase A); read only through changesSurface.testkit.tsx.
 */
if (process.env.ROAMGATE_CHANGES_TREE_DOM_TEST !== "1") {
  test("Changes tree and scopes in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CHANGES_TREE_DOM_TEST: "1" },
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
  const { installChangesDom, mountChangesTree, entry } = await import(
    "./changesSurface.testkit"
  );
  await installChangesDom();
  const { store } = await import("../store");

  describe("Changes tree", () => {
    test("a path changed staged and unstaged is one row, its badges merged; a click loads its first entry", async () => {
      const changes = await mountChangesTree({
        entries: {
          working: [
            entry("src/one.ts", "staged", "M"),
            entry("src/one.ts", "unstaged", "M"),
            entry("src/new.ts", "untracked", "?"),
          ],
        },
      });
      try {
        const rows = changes.rows();
        expect(rows.map((row) => [row.name, row.folder])).toEqual([
          ["src", true],
          ["new.ts", false],
          ["one.ts", false],
        ]);
        expect(rows.find((row) => row.name === "one.ts")?.badges).toEqual([
          "M",
        ]);
        expect(rows.find((row) => row.name === "new.ts")?.badges).toEqual([
          "U",
        ]);
        await changes.clickRow("one.ts");
        const loads = changes.calls.filter(
          (call) => call.method === "git.diff_file",
        );
        // The row's first entry, as the summary lists them: staged.
        expect(loads.slice(-1)[0]?.params).toMatchObject({
          path: "src/one.ts",
          kind: "staged",
          mode: "working",
        });
        expect(changes.selection()?.entry).toMatchObject({
          path: "src/one.ts",
          kind: "staged",
        });
        expect(
          changes.rows().find((row) => row.name === "one.ts")?.selected,
        ).toBe(true);
        // The diff view still gets both entries of the path, apart.
        expect(
          changes
            .selection()
            ?.entries.filter((each) => each.path === "src/one.ts")
            .map((each) => each.kind),
        ).toEqual(["staged", "unstaged"]);
      } finally {
        await changes.unmount();
      }
    });

    test("a folder click folds and unfolds it", async () => {
      const changes = await mountChangesTree({
        entries: { working: [entry("src/a/one.ts"), entry("top.ts")] },
      });
      try {
        expect(changes.rows().map((row) => row.name)).toEqual([
          "src",
          "a",
          "one.ts",
          "top.ts",
        ]);
        await changes.clickRow("src");
        expect(changes.rows().map((row) => row.name)).toEqual([
          "src",
          "top.ts",
        ]);
        await changes.clickRow("src");
        expect(changes.rows().map((row) => row.name)).toContain("one.ts");
      } finally {
        await changes.unmount();
      }
    });

    test("empty states: no changes, no completed step yet, no comparison branch; placeholder rows while loading", async () => {
      const changes = await mountChangesTree({
        entries: { working: [] },
        noBaseline: ["last-step", "branch-main"],
      });
      try {
        expect(changes.skeleton()).toBe(false);
        expect(changes.emptyText()).toBe("No changes");
        await changes.pickScope("last-step");
        expect(changes.emptyText()).toBe("No completed agent step yet");
        await changes.pickScope("branch-main");
        expect(changes.emptyText()).toBe("Choose a comparison branch");
      } finally {
        await changes.unmount();
      }
      // The first summary not answered yet: placeholder rows, no empty text.
      const { bridge } = await import("../api");
      const changesLoading = await mountChangesTree({ entries: {} });
      try {
        const client = bridge.connection(
          "",
        ) as unknown as import("../api").ConnectionClient;
        const pending = spyOn(client, "call").mockImplementation(
          () => new Promise(() => {}),
        );
        await changesLoading.pickScope("branch-main");
        expect(changesLoading.skeleton()).toBe(true);
        expect(changesLoading.emptyText()).toBeNull();
        pending.mockRestore();
      } finally {
        await changesLoading.unmount();
      }
    });
  });

  describe("Changes scopes", () => {
    test("Working, Branch and Last step switch the listing, and the choice is kept across a remount", async () => {
      const changes = await mountChangesTree({
        entries: {
          working: [entry("work.ts")],
          "branch-main": [entry("branch.ts", "branch")],
          "last-step": [entry("step.ts", "last-step")],
        },
      });
      try {
        expect(changes.scope()).toBe("working");
        expect(changes.rows().map((row) => row.name)).toEqual(["work.ts"]);
        await changes.pickScope("branch-main");
        expect(changes.scope()).toBe("branch-main");
        expect(changes.rows().map((row) => row.name)).toEqual(["branch.ts"]);
        await changes.remount();
        expect(changes.scope()).toBe("branch-main");
        expect(changes.rows().map((row) => row.name)).toEqual(["branch.ts"]);
        await changes.pickScope("last-step");
        expect(changes.rows().map((row) => row.name)).toEqual(["step.ts"]);
        await changes.remount();
        expect(changes.scope()).toBe("last-step");
        await changes.pickScope("working");
        await changes.remount();
        expect(changes.scope()).toBe("working");
      } finally {
        await changes.unmount();
      }
    });

    test("Working refreshes on mount, on a scope change, on Refresh and after a git action", async () => {
      const changes = await mountChangesTree({
        entries: {
          working: [entry("work.ts")],
          "branch-main": [entry("branch.ts", "branch")],
        },
      });
      const action = spyOn(store, "runGitFileAction").mockImplementation(
        async () => ({}) as never,
      );
      try {
        expect(changes.summaryModes()).toEqual(["working"]);
        await changes.pickScope("branch-main");
        expect(changes.summaryModes()).toEqual(["working", "branch-main"]);
        await changes.pickScope("working");
        expect(changes.summaryModes().slice(-1)[0]).toBe("working");
        const beforeRefresh = changes.summaryModes().length;
        await changes.refresh();
        expect(changes.summaryModes().length).toBe(beforeRefresh + 1);
        expect(changes.summaryModes().slice(-1)[0]).toBe("working");
        await changes.openMenu("work.ts");
        await changes.chooseMenuItem("Stage changes");
        expect(action).toHaveBeenCalledTimes(1);
        expect(action.mock.calls[0]?.[1]).toBe("stage");
        expect(changes.summaryModes().length).toBe(beforeRefresh + 2);
        expect(changes.summaryModes().slice(-1)[0]).toBe("working");
      } finally {
        action.mockRestore();
        await changes.unmount();
      }
    });

    test("the review shown again on Working with nothing uncommitted shows the branch's changes, Working staying remembered", async () => {
      const { roamgateLocalStorage } = await import("../browserStorage");
      const { connectionStorageKey } = await import("../connectionStorage");
      const remembered = () =>
        roamgateLocalStorage.getItem(
          connectionStorageKey("clean-working", "diffViewerScope:workspace"),
        );
      const changes = await mountChangesTree({
        connectionId: "clean-working",
        review: true,
        scope: "working",
        entries: { working: [], "branch-main": [entry("branch.ts", "branch")] },
      });
      try {
        expect(changes.summaryModes()).toEqual(["working", "branch-main"]);
        expect(changes.scope()).toBe("branch-main");
        expect(changes.rows().map((row) => row.name)).toEqual(["branch.ts"]);
        expect(remembered()).toBe("working");
        // Working picked: shown as it is, empty.
        await changes.pickScope("working");
        expect(changes.scope()).toBe("working");
        expect(changes.rows()).toEqual([]);
        expect(remembered()).toBe("working");
        // Shown again (a reload, the pane brought back): the branch's.
        await changes.remount();
        expect(changes.scope()).toBe("branch-main");
        // The branch picked is remembered as any pick.
        await changes.pickScope("branch-main");
        expect(remembered()).toBe("branch-main");
      } finally {
        await changes.unmount();
      }
    });

    test("Working shown again stays Working with changes, or with none on the branch either", async () => {
      const dirty = await mountChangesTree({
        review: true,
        scope: "working",
        entries: {
          working: [entry("work.ts")],
          "branch-main": [entry("branch.ts", "branch")],
        },
      });
      try {
        expect(dirty.scope()).toBe("working");
        expect(dirty.summaryModes()).toEqual(["working"]);
      } finally {
        await dirty.unmount();
      }
      const nothing = await mountChangesTree({
        review: true,
        scope: "working",
        entries: { working: [], "branch-main": [] },
      });
      try {
        // The branch read, then Working again (read anew, as any switch).
        expect(nothing.summaryModes()).toEqual([
          "working",
          "branch-main",
          "working",
        ]);
        expect(nothing.scope()).toBe("working");
      } finally {
        await nothing.unmount();
      }
      // Not the review: Changes' Working as it was.
      const plain = await mountChangesTree({
        scope: "working",
        entries: { working: [], "branch-main": [entry("branch.ts", "branch")] },
      });
      try {
        expect(plain.scope()).toBe("working");
        expect(plain.summaryModes()).toEqual(["working"]);
      } finally {
        await plain.unmount();
      }
    });

    test("Files' embedded changes (selectWorkingEntries) switch Changes to Working and load those files", async () => {
      const { act } = await import("react");
      const working = [entry("a.ts"), entry("b.ts")];
      const fileLoads = (changes: {
        calls: { method: string; params: Record<string, unknown> }[];
      }) =>
        changes.calls
          .filter((call) => call.method === "git.diff_file")
          .map((call) => [
            call.params.mode,
            call.params.path,
            call.params.automatic,
          ]);
      // Working never shown yet: the summary comes first, then the files asked for.
      const fresh = await mountChangesTree({
        entries: { working, "branch-main": [entry("branch.ts", "branch")] },
        scope: "branch-main",
      });
      try {
        expect(fresh.scope()).toBe("branch-main");
        await act(async () =>
          fresh.handle().selectWorkingEntries([working[1]!]),
        );
        await fresh.settle();
        expect(fresh.scope()).toBe("working");
        expect(fileLoads(fresh)).toContainEqual(["working", "b.ts", false]);
        expect(
          fresh.selections().some((each) => each.files["unstaged:b.ts"]),
        ).toBe(true);
      } finally {
        await fresh.unmount();
      }
      // Working shown earlier: Changes switches back and asks for the file.
      const changes = await mountChangesTree({
        entries: { working, "branch-main": [entry("branch.ts", "branch")] },
      });
      try {
        await changes.pickScope("branch-main");
        await act(async () =>
          changes.handle().selectWorkingEntries([working[1]!]),
        );
        await changes.settle();
        expect(changes.scope()).toBe("working");
        expect(fileLoads(changes)).toContainEqual(["working", "b.ts", false]);
        // The file asked for waits for Working's summary, read anew: it
        // reaches the diff view, selected.
        expect(changes.selection()?.entry?.path).toBe("b.ts");
        expect(
          changes.selections().some((each) => each.files["unstaged:b.ts"]),
        ).toBe(true);
      } finally {
        await changes.unmount();
      }
    });
  });

  describe("Changes menus", () => {
    test("a file's menu: Open file, Copy relative and absolute paths, Reveal, its Git actions and the repository's", async () => {
      const opened: string[] = [];
      const changes = await mountChangesTree({
        entries: {
          working: [entry("src/one.ts"), entry("two.ts", "untracked", "?")],
        },
        canReveal: true,
        onOpenFile: (each) => opened.push(each.path),
      });
      try {
        await changes.openMenu("one.ts");
        const menu = changes.menu();
        expect(menu?.map((group) => group.label)).toEqual([
          "File",
          "Git",
          "Repository",
        ]);
        expect(menu?.[0]?.items.map((item) => item.label)).toEqual([
          "Open file",
          "Copy relative path",
          "Copy absolute path",
          expect.stringMatching(/^(Reveal|Show|Open) /),
        ]);
        expect(menu?.[1]?.items.map((item) => item.label)).toEqual([
          "Stage changes",
          "Discard unstaged changes\u2026",
        ]);
        // The repository's actions with their counts, none disabled here.
        expect(
          menu?.[2]?.items.map((item) => [item.label, item.detail]),
        ).toEqual([
          ["Stage All Changes", "2"],
          ["Unstage All Changes", "0"],
          ["Discard All Unstaged Changes\u2026", "1"],
          ["Delete All Untracked Files\u2026", "1"],
        ]);
        expect(menu?.[2]?.items.map((item) => item.disabled)).toEqual([
          false,
          true,
          false,
          false,
        ]);
        await changes.chooseMenuItem("Open file");
        expect(opened).toEqual(["src/one.ts"]);
        expect(changes.menu()).toBeNull();
        // A folder's menu: no Open file, the folder's Git actions.
        await changes.openMenu("src");
        expect(
          changes.menu()?.[0]?.items.map((item) => item.label),
        ).not.toContain("Open file");
      } finally {
        await changes.unmount();
      }
    });

    test("menus open by right click and the ContextMenu key, only in Working", async () => {
      const changes = await mountChangesTree({
        entries: {
          working: [entry("work.ts")],
          "branch-main": [entry("branch.ts", "branch")],
          "last-step": [entry("step.ts", "last-step")],
        },
      });
      try {
        await changes.openMenu("work.ts", "keyboard");
        expect(changes.menu()).not.toBeNull();
        await changes.closeMenu();
        expect(changes.menu()).toBeNull();
        await changes.openMenu("work.ts");
        expect(changes.menu()).not.toBeNull();
        await changes.closeMenu();
        await changes.pickScope("branch-main");
        expect(changes.menu()).toBeNull();
        await changes.openMenu("branch.ts");
        expect(changes.menu()).toBeNull();
        await changes.openMenu("branch.ts", "keyboard");
        expect(changes.menu()).toBeNull();
        await changes.pickScope("last-step");
        await changes.openMenu("step.ts");
        expect(changes.menu()).toBeNull();
      } finally {
        await changes.unmount();
      }
    });

    test("a touch held 550 ms opens the menu, and the click it ends with does not load the file", async () => {
      const changes = await mountChangesTree({
        entries: { working: [entry("work.ts")] },
      });
      const { act } = await import("react");
      try {
        const loadsBefore = changes.calls.filter(
          (call) => call.method === "git.diff_file",
        ).length;
        jest.useFakeTimers();
        try {
          await changes.openMenu("work.ts", "longpress");
          act(() => jest.advanceTimersByTime(549));
          expect(changes.menu()).toBeNull();
          act(() => jest.advanceTimersByTime(1));
          expect(changes.menu()).not.toBeNull();
        } finally {
          jest.useRealTimers();
        }
        await changes.settle();
        // The release's click is eaten by the long press.
        const row = [
          ...document.querySelectorAll<HTMLButtonElement>(".diff-tree-row"),
        ].find(
          (each) =>
            each.querySelector(".diff-tree-name")?.textContent === "work.ts",
        )!;
        await act(async () => row.click());
        await changes.settle();
        expect(
          changes.calls.filter((call) => call.method === "git.diff_file")
            .length,
        ).toBe(loadsBefore);
      } finally {
        await changes.unmount();
      }
    });

    test("discarding a file asks first, and only a yes runs it", async () => {
      const changes = await mountChangesTree({
        entries: { working: [entry("work.ts")] },
      });
      const action = spyOn(store, "runGitFileAction").mockImplementation(
        async () => ({}) as never,
      );
      try {
        await changes.openMenu("work.ts");
        await changes.chooseMenuItem("Discard unstaged changes");
        expect(action).not.toHaveBeenCalled();
        expect(changes.confirmation()?.title).toMatch(/Discard/);
        expect(changes.confirmation()?.message).toContain("work.ts");
        await changes.confirm();
        expect(action).toHaveBeenCalledTimes(1);
        expect(action.mock.calls[0]?.[1]).toBe("discard_unstaged");
        expect(changes.confirmation()).toBeNull();
      } finally {
        action.mockRestore();
        await changes.unmount();
      }
    });
  });

  describe("Changes as the review", () => {
    test("on SSH the review loads the files near the view and the next blocks after them, at most 16 per request", async () => {
      const files = Array.from({ length: 40 }, (_, index) =>
        entry(`src/f${String(index).padStart(2, "0")}.ts`, "branch", "M"),
      );
      const changes = await mountChangesTree({
        entries: { "branch-main": files },
        scope: "branch-main",
        connectionType: "ssh",
        review: true,
      });
      try {
        const { act } = await import("react");
        await act(async () =>
          changes.handle().loadNearbyEntries(files.slice(0, 4)),
        );
        await changes.settle();
        const batches = changes.calls.filter(
          (call) => call.method === "git.diff_files",
        );
        const asked = batches.flatMap((call) =>
          (call.params.entries as { path: string }[]).map((each) => each.path),
        );
        // The 4 near the view and those after them to the end of the next
        // block of 16 (32 here), none twice.
        expect(new Set(asked).size).toBe(asked.length);
        // (The first file may come alone, as the picked one.)
        expect(asked.length).toBeGreaterThanOrEqual(31);
        for (const each of files.slice(0, 32))
          if (!changes.selection()?.files[`branch:${each.path}`])
            expect(asked).toContain(each.path);
        expect(asked).not.toContain(files[32].path);
        // Few round trips: at most 16 files each.
        expect(batches.length).toBeLessThanOrEqual(3);
        for (const call of batches) {
          expect((call.params.entries as unknown[]).length).toBeLessThanOrEqual(
            16,
          );
          expect(call.params).toMatchObject({ mode: "branch-main" });
        }
        for (const each of files.slice(0, 32))
          expect(
            changes.selection()?.files[`branch:${each.path}`]?.diff,
          ).toBeTruthy();
      } finally {
        await changes.unmount();
      }
    });

    test("upstream Changes on SSH still loads only what is picked, one file per request", async () => {
      const files = Array.from({ length: 6 }, (_, index) =>
        entry(`src/f${index}.ts`, "branch", "M"),
      );
      const changes = await mountChangesTree({
        entries: { "branch-main": files },
        scope: "branch-main",
        connectionType: "ssh",
      });
      try {
        const { act } = await import("react");
        await act(async () =>
          changes.handle().loadNearbyEntries(files.slice(0, 4)),
        );
        await changes.settle();
        expect(
          changes.calls.filter((call) => call.method === "git.diff_files"),
        ).toHaveLength(0);
        expect(
          changes.calls.filter((call) => call.method === "git.diff_file")
            .length,
        ).toBeLessThanOrEqual(1);
      } finally {
        await changes.unmount();
      }
    });
  });
}
