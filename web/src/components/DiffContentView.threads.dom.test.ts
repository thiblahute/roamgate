import { describe, expect, test } from "bun:test";

/**
 * Comments written in Changes are threads of their review (the stack's
 * review threads in the inspector, up/rendered-review): drawn under their
 * line as threads. Pinned before Changes becomes the review (plan: review
 * into the inspector, phase A).
 */
if (process.env.ROAMGATE_CHANGES_THREADS_DOM_TEST !== "1") {
  test("Changes review threads in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CHANGES_THREADS_DOM_TEST: "1" },
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
  const { installChangesDom, mountChangesDiff, entry } = await import(
    "./changesSurface.testkit"
  );
  await installChangesDom();
  const unstaged = entry("one.ts", "unstaged");
  const patches = {
    "unstaged:one.ts": [
      "diff --git a/one.ts b/one.ts",
      "--- a/one.ts",
      "+++ b/one.ts",
      "@@ -1,2 +1,2 @@",
      " a",
      "-B",
      "+C",
      "",
    ].join("\n"),
  };

  describe("Changes review threads", () => {
    test("a comment written in Changes is drawn under its line as its thread, once the review has it", async () => {
      const { feedbackNote } = await import("../workspaceFeedback");
      const note = {
        source: "diff",
        path: "one.ts",
        kind: "unstaged",
        side: "new",
        line: 2,
        quote: "C",
        hunk: "@@ -1,2 +1,2 @@",
      } as const;
      const thread = {
        id: "t1",
        sessionId: "s1",
        kind: "discussion",
        anchor: {
          path: "one.ts",
          line: 2,
          side: "new",
          feedback: JSON.stringify(note),
        },
        comments: [
          {
            id: "t1c",
            author: "you",
            body: "Why C?",
            createdAt: "2026-11-10T10:00:00Z",
            updatedAt: "2026-11-10T10:00:00Z",
          },
        ],
        resolved: false,
        createdAt: "2026-11-10T10:00:00Z",
        updatedAt: "2026-11-10T10:00:00Z",
      } as import("../../../shared/review").ReviewThread;
      const view = await mountChangesDiff({
        entries: [unstaged],
        patches,
        onCreateAnnotation: () => {},
        // A note kept in this browser, not a thread yet.
        annotations: [{ ...note, id: "local", comment: "Kept", createdAt: 1 }],
      });
      try {
        expect(view.comments("unstaged:one.ts")).toEqual(["Kept"]);
        await view.update({
          annotations: [feedbackNote(thread)],
          threads: [thread],
        });
        const shown = view.comments("unstaged:one.ts");
        expect(shown).toHaveLength(1);
        expect(shown[0]).toContain("Why C?");
      } finally {
        await view.unmount();
      }
    });
  });
}
