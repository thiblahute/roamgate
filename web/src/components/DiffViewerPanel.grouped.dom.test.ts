import { describe, expect, test } from "bun:test";

/**
 * Changes' tree "in Changes" (plan: review into the inspector, phase 5,
 * D8): the working changes in status groups, a path changed staged and
 * unstaged in both, the reviewed chunks of a file beside its name.
 */
if (process.env.ROAMGATE_CHANGES_GROUPED_DOM_TEST !== "1") {
  test("Changes' status-grouped tree in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CHANGES_GROUPED_DOM_TEST: "1" },
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
  const { act } = await import("react");
  const { combineWorkingEntries, orderByStatus } = await import(
    "./DiffViewerPanel"
  );

  const working = [
    entry("src/one.ts", "unstaged", "M"),
    entry("src/one.ts", "staged", "M"),
    entry("src/new.ts", "untracked", "?"),
    entry("a.ts", "unstaged", "M"),
  ];

  describe("the status-grouped tree", () => {
    test("the working changes are listed in Staged, Changes and Untracked, a path in both when it is staged and changed again", async () => {
      const changes = await mountChangesTree({
        entries: { working },
        groupByStatus: true,
      });
      try {
        const names = changes.rows().map((row) => row.name);
        expect(names.filter((name) => name === "one.ts")).toHaveLength(2);
        expect(names.indexOf("Staged")).toBeLessThan(names.indexOf("Changes"));
        expect(names.indexOf("Changes")).toBeLessThan(
          names.indexOf("Untracked"),
        );
        // Each group's own files only: one.ts under Staged is staged.
        const staged = names.indexOf("Staged");
        expect(names.slice(staged + 1, names.indexOf("Changes"))).toContain(
          "src",
        );
      } finally {
        await changes.unmount();
      }
    });

    test("without it the tree is one, as upstream's: a path changed twice is one row", async () => {
      const changes = await mountChangesTree({ entries: { working } });
      try {
        const names = changes.rows().map((row) => row.name);
        expect(names).not.toContain("Staged");
        expect(names.filter((name) => name === "one.ts")).toHaveLength(1);
      } finally {
        await changes.unmount();
      }
    });

    test("a file shows its reviewed chunks, and a check once it is reviewed", async () => {
      const changes = await mountChangesTree({
        entries: { working },
        groupByStatus: true,
      });
      try {
        await act(async () =>
          changes.handle().markReviewProgress(
            new Map([
              ["a.ts", { done: 1, total: 3, reviewed: false }],
              ["src/new.ts", { done: 2, total: 2, reviewed: true }],
            ]),
          ),
        );
        const text = document.body.textContent ?? "";
        expect(text).toContain("1/3");
        expect(text).toContain("✓ 2/2");
      } finally {
        await changes.unmount();
      }
    });

    test("a file staged and changed again is one combined diff: either of its rows shows it, read as kind combined", async () => {
      const changes = await mountChangesTree({
        entries: { working },
        groupByStatus: true,
      });
      try {
        const rows = () =>
          [
            ...document.querySelectorAll<HTMLButtonElement>(".diff-tree-file"),
          ].filter(
            (row) =>
              row.querySelector(".diff-tree-name")?.textContent === "one.ts",
          );
        expect(rows()).toHaveLength(2);
        // The one under Staged.
        await act(async () => rows()[0]!.click());
        await changes.settle();
        const picked = changes.selection();
        expect(picked?.entry).toMatchObject({
          kind: "combined",
          path: "src/one.ts",
        });
        // One section per file in the diff, a conflict kept as it is.
        expect(
          picked?.entries.map((each) => `${each.kind}:${each.path}`).sort(),
        ).toEqual([
          "combined:a.ts",
          "combined:src/new.ts",
          "combined:src/one.ts",
        ]);
        // Both of its rows are the file shown.
        expect(rows().map((row) => row.getAttribute("aria-current"))).toEqual([
          "true",
          "true",
        ]);
        const asked = changes.calls
          .filter((call) => call.method === "git.diff_file")
          .map((call) => `${call.params.kind}:${call.params.path}`);
        expect(asked).toContain("combined:src/one.ts");
        expect(asked.some((each) => /^(staged|unstaged):/.test(each))).toBe(
          false,
        );
        // The one under Changes shows the same diff.
        await act(async () => rows()[1]!.click());
        await changes.settle();
        expect(changes.selection()?.entry).toMatchObject({
          kind: "combined",
          path: "src/one.ts",
        });
        // Its menus act on the entry it stands for: unstage under Staged.
        await changes.openMenu("one.ts");
        const labels = (changes.menu() ?? []).flatMap((group) =>
          group.items.map((item) => item.label),
        );
        expect(labels.some((label) => /^Unstage/.test(label))).toBe(true);
        await changes.closeMenu();
      } finally {
        await changes.unmount();
      }
    });

    test("upstream's Changes (no status groups) still reads each entry's own diff", async () => {
      const changes = await mountChangesTree({ entries: { working } });
      try {
        await changes.clickRow("one.ts");
        expect(changes.selection()?.entry?.kind).not.toBe("combined");
        const asked = changes.calls
          .filter((call) => call.method === "git.diff_file")
          .map((call) => String(call.params.kind));
        expect(asked).not.toContain("combined");
      } finally {
        await changes.unmount();
      }
    });

    test("combineWorkingEntries: one entry per file, its status entries kept as parts, in the groups' order", () => {
      const combined = combineWorkingEntries([
        ...working,
        entry("c.ts", "conflicted", "U"),
        entry("gone.ts", "unstaged", "deleted"),
        entry("gone.ts", "staged", "modified"),
      ]);
      expect(
        combined.map((each) => [each.kind, each.path, each.status]),
      ).toEqual([
        ["combined", "src/one.ts", "M"],
        ["combined", "src/new.ts", "untracked"],
        ["combined", "a.ts", "M"],
        ["conflicted", "c.ts", "U"],
        ["combined", "gone.ts", "deleted"],
      ]);
      expect(combined[0]!.parts?.map((part) => part.kind)).toEqual([
        "unstaged",
        "staged",
      ]);
      // Two diffs' counts do not add up to the combined one's.
      expect(combined[0]!.additions).toBeUndefined();
      expect(combined[2]!.additions).toBe(1);
      expect(
        orderByStatus(combined).map((each) => `${each.kind}:${each.path}`),
      ).toEqual([
        "conflicted:c.ts",
        // Staged, in the tree's order (folders first).
        "combined:src/one.ts",
        "combined:gone.ts",
        "combined:a.ts",
        "combined:src/new.ts",
      ]);
    });

    test("orderByStatus keeps each group's tree order and leaves other scopes' entries as they are", () => {
      const ordered = orderByStatus(working).map(
        (each) => `${each.kind}:${each.path}`,
      );
      expect(ordered).toEqual([
        "staged:src/one.ts",
        "unstaged:src/one.ts",
        "unstaged:a.ts",
        "untracked:src/new.ts",
      ]);
      const branch = [
        entry("z.ts", "branch", "M"),
        entry("a.ts", "branch", "M"),
      ];
      expect(orderByStatus(branch)).toEqual(branch);
    });
  });
}
