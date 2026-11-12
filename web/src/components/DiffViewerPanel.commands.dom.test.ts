import { describe, expect, test } from "bun:test";

/*
 * Changes' `:` commands in the inspector's prompt: each does what its
 * toolbar's control does (the scope switch, Refresh, Compare against).
 */
if (process.env.ROAMGATE_CHANGES_COMMANDS_DOM_TEST !== "1") {
  test("Changes' commands in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CHANGES_COMMANDS_DOM_TEST: "1" },
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
  const { inspectorCompletions, runInspectorCommand } = await import(
    "../inspectorCommands"
  );
  type Registry = import("../useInspectorCommands").InspectorCommandRegistry;
  type CommandSet = import("../useInspectorCommands").InspectorCommandSet;

  /** The inspector's side: what the tree gives, run as the prompt runs it. */
  const inspector = () => {
    const parts = new Map<string, { view: string; set: CommandSet }>();
    const commands = () =>
      [...parts.values()].flatMap((part) => part.set.commands);
    const registry: Registry = {
      set: (id, view, set) => {
        if (set) parts.set(id, { view, set });
        else parts.delete(id);
      },
      run: (input) => void runInspectorCommand(commands(), input),
    };
    return {
      registry,
      views: () => [...new Set([...parts.values()].map((part) => part.view))],
      completions: (typed: string) =>
        inspectorCompletions(commands(), typed).map(([name]) => name),
      run: (input: string) =>
        act(async () => {
          expect(runInspectorCommand(commands(), input)).toBeNull();
        }),
    };
  };

  describe("Changes' `:` commands", () => {
    test(":scope working | branch | last, :reload and :base do what the toolbar does", async () => {
      const prompt = inspector();
      const changes = await mountChangesTree({
        entries: {
          working: [entry("a.ts", "unstaged", "M")],
          "branch-main": [entry("b.ts", "branch", "M")],
          "last-step": [entry("c.ts", "last-step", "M")],
        },
        inspectorCommands: prompt.registry,
      });
      try {
        expect(prompt.views()).toEqual(["changes"]);
        expect(prompt.completions("")).toEqual(["scope", "reload"]);
        expect(prompt.completions("scope ")).toEqual([
          "scope working",
          "scope branch",
          "scope last",
        ]);
        await prompt.run("scope branch");
        await changes.settle();
        expect(changes.scope()).toBe("branch-main");
        // Compare against, only on the branch.
        expect(prompt.completions("base ")).toEqual([
          "base auto",
          "base refs/heads/main",
          "base refs/heads/develop",
        ]);
        await prompt.run("base refs/heads/develop");
        await changes.settle();
        expect(
          changes.calls
            .filter((call) => call.method === "git.diff_summary")
            .slice(-1)[0]?.params,
        ).toMatchObject({
          mode: "branch-main",
          base_branch: "refs/heads/develop",
        });
        await prompt.run("scope l");
        await changes.settle();
        expect(changes.scope()).toBe("last-step");
        expect(prompt.completions("ba")).toEqual([]);
        await prompt.run("scope working");
        await changes.settle();
        expect(changes.scope()).toBe("working");
        const before = changes.summaryModes().length;
        await prompt.run("e");
        await changes.settle();
        expect(changes.summaryModes().length).toBe(before + 1);
        expect(changes.summaryModes().slice(-1)[0]).toBe("working");
      } finally {
        await changes.unmount();
      }
      // Gone, its commands go too.
      expect(prompt.views()).toEqual([]);
    });

    test("the Branch scope names Automatic's base; a base picked in Compare against goes with its selection, for its own review", async () => {
      const prompt = inspector();
      const changes = await mountChangesTree({
        entries: { "branch-main": [entry("b.ts", "branch", "M")] },
        scope: "branch-main",
        automaticBase: "refs/remotes/origin/main",
        inspectorCommands: prompt.registry,
      });
      try {
        await changes.settle();
        // Automatic picked origin/main (a stale local main): it says so.
        expect(changes.branchBase()).toEqual({
          scope: "Against origin/main",
          compare: "Automatic (origin/main)",
        });
        expect(changes.selection()?.pickedBase).toBeUndefined();
        await prompt.run("base refs/heads/develop");
        await changes.settle();
        expect(changes.branchBase()).toEqual({
          scope: "Against develop",
          compare: "develop",
        });
        // Its comments go to develop's review (workspaceFeedback's route).
        expect(changes.selection()?.pickedBase).toBe("develop");
        await prompt.run("base auto");
        await changes.settle();
        expect(changes.selection()?.pickedBase).toBeUndefined();
      } finally {
        await changes.unmount();
      }
    });
  });
}
