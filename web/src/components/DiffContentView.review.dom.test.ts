import { inIsolatedChild } from "../testIsolated";
import { describe, expect, test } from "bun:test";

/**
 * What the review in Changes does that its behavior tests
 * (reviewBehavior.*) cannot see through the review surface: a step's note
 * of the files left out, and the renders typing a comment costs. Without
 * the review (a commit's diff, Files' changes), the diff keeps its popover
 * and its keys (DiffContentView.cursor.dom).
 */
if (
  inIsolatedChild(
    import.meta.path,
    "Changes' review editor and steps in an isolated DOM runtime",
    "ROAMGATE_CHANGES_REVIEW_DOM_TEST",
    60_000,
  )
) {
  const { installChangesDom, mountChangesDiff, entry } = await import(
    "./changesSurface.testkit"
  );
  await installChangesDom();
  const { act } = await import("react");
  const { EditorView } = await import("@codemirror/view");
  const { roamgateLocalStorage } = await import("../browserStorage");
  roamgateLocalStorage.setItem("diffViewMode", "unified");

  const a = entry("a.ts", "unstaged", "M");
  const patches = {
    "unstaged:a.ts":
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,4 +1,4 @@\n one\n-two\n+deux\n three\n four\n",
  };

  const view = () => document.querySelector<HTMLElement>(".diff-content-view")!;
  const press = async (key: string) => {
    const target = view();
    target.focus();
    await act(async () => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
  };
  const editor = () => {
    const content = document.querySelector<HTMLElement>(
      ".diff-review-composer .cm-content",
    );
    return content ? EditorView.findFromDOM(content) : null;
  };
  const waitForEditor = async (diff: { settle: () => Promise<void> }) => {
    for (let i = 0; i < 50 && !editor(); i++) await diff.settle();
    return editor();
  };

  describe("the Last step in Changes (plan D15)", () => {
    test("a step's untracked files left out of its snapshots are named above its diff", async () => {
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: true,
        reviewScope: {
          kind: "step",
          step: {
            step: "1763200000000-abcdef01",
            before: "a".repeat(40),
            after: "b".repeat(40),
            skipped: ["huge.bin", "dump.sql"],
          },
        },
      });
      try {
        expect(
          document.querySelector(".diff-review-views [role=note]")?.textContent,
        ).toBe(
          "Left out of this step (untracked, over 50 MB): huge.bin, dump.sql",
        );
      } finally {
        await diff.unmount();
      }
      // A step with nothing left out says nothing.
      const whole = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: true,
        reviewScope: {
          kind: "step",
          step: {
            step: "1763200000000-abcdef01",
            before: "a".repeat(40),
            after: "b".repeat(40),
          },
        },
      });
      try {
        expect(
          document.querySelector(".diff-review-views [role=note]"),
        ).toBeNull();
      } finally {
        await whole.unmount();
      }
    });
  });

  describe("the review's comment editor in Changes, as you type", () => {
    test("typing a comment renders the editor alone, not the review", async () => {
      const big = entry("big.ts", "unstaged", "A");
      const added = Array.from(
        { length: 40 },
        (_, i) => `+const line${i} = ${i};`,
      );
      let commits = 0;
      const diff = await mountChangesDiff({
        entries: [big],
        patches: {
          "unstaged:big.ts": `diff --git a/big.ts b/big.ts\n--- /dev/null\n+++ b/big.ts\n@@ -0,0 +1,40 @@\n${added.join("\n")}\n`,
        },
        reviewCursor: true,
        onCreateAnnotation: () => {},
        onRender: () => {
          commits++;
        },
      });
      try {
        expect(diff.lines("unstaged:big.ts").length).toBeGreaterThanOrEqual(40);
        await press("c");
        const box = await waitForEditor(diff);
        expect(box).not.toBeNull();
        await diff.settle();
        // The Profiler sees the diff's renders: opening the editor was one.
        expect(commits).toBeGreaterThan(0);
        commits = 0;
        for (const key of "Looks good")
          await act(async () =>
            box!.dispatch({
              changes: { from: box!.state.doc.length, insert: key },
            }),
          );
        await diff.settle();
        // Each key re-rendered every diff line and thread before.
        expect(commits).toBe(0);
        // What was typed is still what the editor keeps and saves.
        expect(editor()?.state.doc.toString()).toBe("Looks good");
      } finally {
        await diff.unmount();
      }
    });
  });
}
