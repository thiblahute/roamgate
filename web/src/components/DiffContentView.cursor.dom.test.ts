import { describe, expect, test } from "bun:test";

/*
 * The review's Vim cursor in Changes (plan: review into the inspector,
 * phase 3, D10): on "in Changes" with Vim keys on, Changes takes the
 * review's keys and mouse; on classic it keeps upstream's. The shared
 * behavior tests (reviewBehavior.*) cover the motions on both surfaces;
 * these cover what is Changes' own.
 */
if (process.env.ROAMGATE_CHANGES_CURSOR_DOM_TEST !== "1") {
  test("Changes' review cursor in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CHANGES_CURSOR_DOM_TEST: "1" },
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
  const { installChangesDom, mountChangesDiff, mountChangesTree, entry } =
    await import("./changesSurface.testkit");
  await installChangesDom();
  const { act } = await import("react");
  const { runInspectorCommand } = await import("../inspectorCommands");
  type CommandSet = import("../useInspectorCommands").InspectorCommandSet;

  const a = entry("a.ts", "unstaged", "M");
  const b = entry("b.ts", "unstaged", "M");
  const patches = {
    "unstaged:a.ts":
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+deux\n three\n",
    "unstaged:b.ts":
      "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1,2 +1,2 @@\n-alpha\n+beta\n gamma\n",
  };

  /** The inspector's side: the diff's commands, and the view's `f` / `o`. */
  const inspector = () => {
    const parts = new Map<string, CommandSet>();
    const ran: string[] = [];
    const own = [
      { name: "files", description: "", run: () => ran.push("files") },
      { name: "only", description: "", run: () => ran.push("only") },
    ];
    const sets = () => [...parts.values()];
    return {
      ran,
      sets,
      registry: {
        set: (id: string, _view: string, set: CommandSet | null) => {
          if (set) parts.set(id, set);
          else parts.delete(id);
        },
        run: (input: string) =>
          void runInspectorCommand(
            [...sets().flatMap((set) => set.commands), ...own],
            input,
            sets().find((set) => set.line)?.line,
          ),
      },
    };
  };

  const view = () => document.querySelector<HTMLElement>(".diff-content-view")!;
  const press = async (key: string, init: KeyboardEventInit = {}) => {
    const target = view();
    target.focus();
    await act(async () => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
    });
  };
  /** The line Pierre draws as the cursor's, as "path:side:number". */
  const cursorAt = () => {
    for (const section of document.querySelectorAll<HTMLElement>(
      "[data-diff-entry-key]",
    )) {
      const line = section
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelector(
          "[data-content] [data-line][data-editor-active-line]",
        );
      if (line)
        return `${section.dataset.diffEntryKey}:${line.getAttribute("data-line-type")}:${line.getAttribute("data-line")}`;
    }
    return null;
  };
  const lineElement = (key: string, type: string, number: number) =>
    [
      ...(document
        .querySelector(`[data-diff-entry-key="${key}"] diffs-container`)
        ?.shadowRoot?.querySelectorAll<HTMLElement>(
          "[data-content] [data-line]",
        ) ?? []),
    ].find(
      (line) =>
        line.getAttribute("data-line-type") === type &&
        line.getAttribute("data-line") === String(number),
    )!;
  const click = async (element: HTMLElement, shiftKey = false) => {
    await act(async () => {
      element.dispatchEvent(
        new PointerEvent("click", {
          bubbles: true,
          composed: true,
          pointerType: "mouse",
          button: 0,
          shiftKey,
        }),
      );
    });
  };

  describe("the review's cursor in Changes", () => {
    test("on classic, Changes keeps its keys: no cursor, j is nothing, Ctrl+F finds, :split and :unified pick, no :N", async () => {
      const prompt = inspector();
      const diff = await mountChangesDiff({
        entries: [a, b],
        patches,
        inspectorCommands: prompt.registry,
      });
      try {
        await press("j");
        await diff.settle();
        expect(cursorAt()).toBeNull();
        expect(view().querySelector(".diff-cursor-status")).toBeNull();
        await press("f", { ctrlKey: true });
        await diff.settle();
        expect(document.activeElement?.getAttribute("placeholder")).toBe(
          "Find loaded files",
        );
        expect(prompt.sets().some((set) => set.line)).toBe(false);
        await act(async () => prompt.registry.run("unified"));
        await diff.settle();
        await act(async () => prompt.registry.run("unified"));
        await diff.settle();
        expect(diff.diffStyle("unstaged:a.ts")).toBe("unified");
      } finally {
        await diff.unmount();
      }
    });

    test("in Changes: the cursor starts on the first line, j moves it, :N is row N of all the changes, f and o are :files and :only", async () => {
      const prompt = inspector();
      const diff = await mountChangesDiff({
        entries: [a, b],
        patches,
        inspectorCommands: prompt.registry,
        reviewCursor: true,
      });
      try {
        await diff.update({});
        expect(cursorAt()).toBe("unstaged:a.ts:context:1");
        // Side by side j goes down the added side; unified, the next line.
        await press("j");
        await diff.settle();
        expect(cursorAt()).toBe(
          diff.diffStyle("unstaged:a.ts") === "split"
            ? "unstaged:a.ts:change-addition:2"
            : "unstaged:a.ts:change-deletion:2",
        );
        await act(async () => prompt.registry.run("5"));
        await diff.settle();
        expect(cursorAt()).toBe("unstaged:b.ts:change-deletion:1");
        await press("f");
        await press("o");
        expect(prompt.ran).toEqual(["files", "only"]);
        // :split and :unified are the review's: a toggle.
        const style = diff.diffStyle("unstaged:a.ts");
        await act(async () => prompt.registry.run("split"));
        await diff.settle();
        expect(diff.diffStyle("unstaged:a.ts")).not.toBe(style);
        await act(async () => prompt.registry.run("split"));
        await diff.settle();
        expect(diff.diffStyle("unstaged:a.ts")).toBe(style);
      } finally {
        await diff.unmount();
      }
    });

    test("a click puts the cursor on a line; a second click there opens the comment box at it", async () => {
      const notes: unknown[] = [];
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: true,
        onCreateAnnotation: (note) => notes.push(note),
      });
      try {
        await diff.update({ split: undefined } as never);
        const style = diff.diffStyle("unstaged:a.ts");
        const type = "change-addition";
        await click(lineElement("unstaged:a.ts", type, 2));
        await diff.settle();
        expect(cursorAt()).toBe(`unstaged:a.ts:${type}:2`);
        expect(diff.composer()).toBeNull();
        await click(lineElement("unstaged:a.ts", type, 2));
        await diff.settle();
        expect(diff.composer()?.title).toContain("a.ts");
        expect(style).not.toBeNull();
      } finally {
        await diff.unmount();
      }
    });

    test("the cursor's search marks its files in Changes' tree", async () => {
      const tree = await mountChangesTree({
        entries: { working: [a, b] },
      });
      try {
        await act(async () => tree.handle().markSearchMatches(["b.ts"]));
        await tree.settle();
        const marked = [
          ...document.querySelectorAll(".diff-tree-row.is-search-hit"),
        ].map((row) => row.querySelector(".diff-tree-name")?.textContent);
        expect(marked).toEqual(["b.ts"]);
        expect(
          document.querySelector(".diff-tree-row.is-search-hit mark"),
        ).not.toBeNull();
        await act(async () => tree.handle().markSearchMatches([]));
        await tree.settle();
        expect(
          document.querySelector(".diff-tree-row.is-search-hit"),
        ).toBeNull();
      } finally {
        await tree.unmount();
      }
    });
  });
}
