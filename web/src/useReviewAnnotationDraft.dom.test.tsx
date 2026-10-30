import { describe, expect, test } from "bun:test";

/**
 * The inspector's comment drafts kept in this browser
 * (`useReviewAnnotationDraft`, upstream): one draft per resource owner,
 * memory first, storage behind it. Characterization tests of today's
 * behavior (plan: review into the inspector, phase A).
 */
if (process.env.ROAMGATE_ANNOTATION_DRAFT_DOM_TEST !== "1") {
  test("review annotation drafts in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_ANNOTATION_DRAFT_DOM_TEST: "1" },
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
  const { installReviewDom } = await import(
    "./components/reviewSurface.testkit"
  );
  await installReviewDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { annotationDraftStorageKey, readReviewAnnotations } = await import(
    "./annotations"
  );
  const { roamgateLocalStorage } = await import("./browserStorage");
  const { store } = await import("./store");
  const { useReviewAnnotationDraft } = await import(
    "./useReviewAnnotationDraft"
  );
  type Note = import("./annotations").ReviewAnnotation;
  type Scope = import("./workspaceResource").ResourceScope;

  const workspace = (workspaceId: string, connectionId = "desktop"): Scope => ({
    kind: "workspace",
    connectionId,
    workspaceId,
  });
  const checkout = (workspaceId: string, checkoutKey: string): Scope => ({
    kind: "worktree",
    connectionId: "desktop",
    repoKey: "repo",
    checkoutKey,
    checkoutPath: `/repo/${checkoutKey}`,
    workspaceId,
  });
  const note = (id: string, comment: string): Note => ({
    id,
    source: "diff",
    path: "a.ts",
    kind: "unstaged",
    side: "new",
    line: 3,
    quote: "x",
    hunk: "@@ -1 +1 @@",
    comment,
    createdAt: 1,
  });
  const stored = (scope: Scope) =>
    readReviewAnnotations(
      roamgateLocalStorage,
      annotationDraftStorageKey(scope),
    ).map((each) => each.comment);

  type Draft = ReturnType<typeof useReviewAnnotationDraft>;
  async function mount(runtimeKey = "r1") {
    let current: Draft | null = null;
    let renders = 0;
    function Host({ runtime }: { runtime: string }) {
      current = useReviewAnnotationDraft(runtime);
      renders++;
      return null;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Host runtime={runtimeKey} />));
    return {
      get draft() {
        return current!;
      },
      renders: () => renders,
      comments: () => current!.annotations.map((each) => each.comment),
      rerender: (runtime: string) =>
        act(async () => root.render(<Host runtime={runtime} />)),
      act: (run: () => unknown) =>
        act(async () => {
          run();
        }),
      unmount: async () => {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }

  describe("review annotation drafts", () => {
    test("no scope, no notes; a scope picked shows its draft, read from storage once", async () => {
      localStorage.clear();
      const w1 = workspace("w1");
      roamgateLocalStorage.setItem(
        annotationDraftStorageKey(w1),
        JSON.stringify([note("n1", "kept from before")]),
      );
      const view = await mount();
      expect(view.draft.scope).toBeNull();
      expect(view.comments()).toEqual([]);
      await view.act(() => view.draft.select(w1));
      expect(view.draft.scope).toEqual(w1);
      expect(view.comments()).toEqual(["kept from before"]);
      // Memory holds it now: storage changed behind its back is not read.
      roamgateLocalStorage.setItem(
        annotationDraftStorageKey(w1),
        JSON.stringify([note("n2", "written elsewhere")]),
      );
      await view.act(() => view.draft.select(workspace("w2")));
      await view.act(() => view.draft.select(w1));
      expect(view.comments()).toEqual(["kept from before"]);
      await view.unmount();
    });

    test("an update is drawn and stored under its owner's key; an empty draft removes the stored one", async () => {
      localStorage.clear();
      const w1 = workspace("w1");
      const view = await mount();
      await view.act(() => view.draft.select(w1));
      await view.act(() => view.draft.update(w1, [note("n1", "first")]));
      expect(view.comments()).toEqual(["first"]);
      expect(stored(w1)).toEqual(["first"]);
      await view.act(() =>
        view.draft.update(w1, (current) => [...current, note("n2", "second")]),
      );
      expect(view.comments()).toEqual(["first", "second"]);
      expect(stored(w1)).toEqual(["first", "second"]);
      await view.act(() => view.draft.update(w1, []));
      expect(view.comments()).toEqual([]);
      expect(
        roamgateLocalStorage.getItem(annotationDraftStorageKey(w1)),
      ).toBeNull();
      await view.unmount();
    });

    test("an update names its owner: a hidden view's update changes its own draft, not the one shown", async () => {
      localStorage.clear();
      const w1 = workspace("w1");
      const w2 = workspace("w2");
      const view = await mount();
      await view.act(() => view.draft.select(w1));
      await view.act(() => view.draft.update(w2, [note("n1", "for w2")]));
      expect(view.comments()).toEqual([]);
      expect(stored(w2)).toEqual(["for w2"]);
      expect(view.draft.read(w2).map((each) => each.comment)).toEqual([
        "for w2",
      ]);
      await view.unmount();
    });

    test("an update that changes nothing (the same notes) neither stores nor draws again", async () => {
      localStorage.clear();
      const w1 = workspace("w1");
      const view = await mount();
      await view.act(() => view.draft.select(w1));
      const notes = [note("n1", "same")];
      await view.act(() => view.draft.update(w1, notes));
      const renders = view.renders();
      localStorage.clear();
      await view.act(() => view.draft.update(w1, [...notes]));
      await view.act(() => view.draft.update(w1, (current) => current));
      expect(view.renders()).toBe(renders);
      expect(stored(w1)).toEqual([]);
      await view.unmount();
    });

    test("select says whether the owner changed: another workspace, another checkout or another connection; the session object is new only then", async () => {
      localStorage.clear();
      const view = await mount();
      let changed: boolean | undefined;
      const w1 = workspace("w1");
      await view.act(() => {
        changed = view.draft.select(w1);
      });
      expect(changed).toBe(true);
      const session = view.draft.sessionRef.current;
      expect(session).not.toBeNull();
      await view.act(() => {
        changed = view.draft.select({ ...w1 });
      });
      expect(changed).toBe(false);
      expect(view.draft.sessionRef.current).toBe(session);
      await view.act(() => {
        changed = view.draft.select(workspace("w1", "laptop"));
      });
      expect(changed).toBe(true);
      expect(view.draft.sessionRef.current).not.toBe(session);
      // Two checkouts of one workspace are two owners.
      const a = checkout("w1", "a");
      await view.act(() => view.draft.select(a));
      const onA = view.draft.sessionRef.current;
      await view.act(() => {
        changed = view.draft.select(checkout("w1", "b"));
      });
      expect(changed).toBe(true);
      expect(view.draft.sessionRef.current).not.toBe(onA);
      // No scope: changed, and no session.
      await view.act(() => {
        changed = view.draft.select(null);
      });
      expect(changed).toBe(true);
      expect(view.draft.sessionRef.current).toBeNull();
      expect(view.draft.scope).toBeNull();
      expect(view.draft.scopeRef.current).toBeNull();
      await view.unmount();
    });

    test("a new runtime key forgets the scope and the session, the drafts in memory kept", async () => {
      localStorage.clear();
      const w1 = workspace("w1");
      const view = await mount("r1");
      await view.act(() => view.draft.select(w1));
      await view.act(() => view.draft.update(w1, [note("n1", "kept")]));
      await view.rerender("r1");
      expect(view.draft.scope).toEqual(w1);
      await view.rerender("r2");
      expect(view.draft.scope).toBeNull();
      expect(view.draft.scopeRef.current).toBeNull();
      expect(view.draft.sessionRef.current).toBeNull();
      localStorage.clear();
      await view.act(() => view.draft.select(w1));
      expect(view.comments()).toEqual(["kept"]);
      await view.unmount();
    });

    test("storage that refuses a write keeps the draft in memory and says so once, until a write succeeds again", async () => {
      localStorage.clear();
      store.clearNotice();
      const w1 = workspace("w1");
      const view = await mount();
      await view.act(() => view.draft.select(w1));
      const real = globalThis.localStorage;
      const refusing = {
        get length() {
          return real.length;
        },
        key: (index: number) => real.key(index),
        getItem: (key: string) => real.getItem(key),
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: (key: string) => real.removeItem(key),
        clear: () => real.clear(),
      };
      Object.defineProperty(globalThis, "localStorage", {
        value: refusing,
        configurable: true,
        writable: true,
      });
      try {
        await view.act(() => view.draft.update(w1, [note("n1", "unsaved")]));
        expect(view.comments()).toEqual(["unsaved"]);
        expect(store.get().notice).toMatchObject({
          kind: "error",
          message: "Review draft could not be saved",
          detail:
            "Browser storage is unavailable. Keep this page open or copy the feedback now.",
        });
        store.clearNotice();
        await view.act(() =>
          view.draft.update(w1, [note("n1", "unsaved"), note("n2", "again")]),
        );
        expect(view.comments()).toEqual(["unsaved", "again"]);
        expect(store.get().notice).toBeNull();
      } finally {
        Object.defineProperty(globalThis, "localStorage", {
          value: real,
          configurable: true,
          writable: true,
        });
      }
      await view.act(() => view.draft.update(w1, [note("n3", "saved")]));
      expect(stored(w1)).toEqual(["saved"]);
      expect(store.get().notice).toBeNull();
      await view.unmount();
    });
  });
}
