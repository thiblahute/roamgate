import { inIsolatedChild } from "../testIsolated";
import { describe, expect, test } from "bun:test";

/*
 * The review's Vim cursor in Changes: Changes takes the review's keys and
 * mouse; a diff without the review (a commit's in Commits, Files' changes)
 * keeps upstream's. The shared behavior tests (reviewBehavior.*) cover the
 * review's keys; these cover the diff without the review, which takes none of
 * them, and Changes' tree marking the cursor's search.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "Changes' review cursor in an isolated DOM runtime",
    "ROAMGATE_CHANGES_CURSOR_DOM_TEST",
    30_000,
  )
) {
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

  describe("the review's cursor in Changes", () => {
    test("without the review (a commit's diff in Commits, Files' changes), the diff keeps its keys: no cursor, j is nothing, Ctrl+F finds, :split and :unified pick, no :N", async () => {
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

    test("in the review, Cmd+F opens its `/` search: no find box, change arrows, :find, :next or :previous", async () => {
      const prompt = inspector();
      const diff = await mountChangesDiff({
        entries: [a, b],
        patches,
        reviewCursor: true,
        onCreateAnnotation: () => {},
        inspectorCommands: prompt.registry,
      });
      try {
        expect(view().querySelector(".diff-search-controls")).toBeNull();
        expect(view().querySelector(".diff-hunk-navigation")).toBeNull();
        const names = prompt
          .sets()
          .flatMap((set) => set.commands.map((command) => command.name));
        expect(names).not.toContain("find");
        expect(names).not.toContain("next");
        expect(names).not.toContain("previous");
        // Ctrl+F here (Cmd+F on a Mac), from outside the diff, whose
        // cursor takes Ctrl-f as a page down.
        (document.activeElement as HTMLElement | null)?.blur();
        await act(async () => {
          document.body.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "f",
              ctrlKey: true,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        await diff.settle();
        expect(document.querySelector(".review-cmdline")).not.toBeNull();
      } finally {
        await diff.unmount();
      }
    });

    test("without the review, c is nothing: no editor, no comment box", async () => {
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        onCreateAnnotation: () => {},
      });
      try {
        await press("c");
        await diff.settle();
        expect(
          document.querySelector(".diff-review-composer .cm-content"),
        ).toBeNull();
        expect(diff.composer()).toBeNull();
      } finally {
        await diff.unmount();
      }
    });

    test("without the review, gs stages nothing", async () => {
      const done: string[] = [];
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        onCreateAnnotation: () => {},
        onGitAction: (action, path) => {
          done.push(`${action} ${path}`);
          return true;
        },
      });
      try {
        await press("g");
        await press("s");
        await diff.settle();
        expect(done).toEqual([]);
      } finally {
        await diff.unmount();
      }
    });

    test("without the review, r, v and gu do nothing and nothing is marked", async () => {
      const { spyOn } = await import("bun:test");
      const { store } = await import("../store");
      const notify = spyOn(store, "notify");
      const diff = await mountChangesDiff({
        entries: [a, b],
        patches,
        onCreateAnnotation: () => {},
      });
      try {
        for (const key of "rvgu") await press(key);
        await diff.settle();
        expect(notify).not.toHaveBeenCalled();
        expect(cursorAt()).toBeNull();
        for (const section of document.querySelectorAll(
          "[data-diff-entry-key]",
        ))
          expect(
            section
              .querySelector("diffs-container")
              ?.shadowRoot?.querySelector(
                "[data-chunk-stage], [data-chunk-reviewed], [data-chunk-folded]",
              ),
          ).toBeNull();
      } finally {
        notify.mockRestore();
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
