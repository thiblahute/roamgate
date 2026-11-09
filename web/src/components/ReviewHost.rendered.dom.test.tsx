import { describe, expect, mock, test } from "bun:test";

/**
 * ReviewHost with the rendered-file reviews and Show in code review
 * (up/rendered-review): characterization tests of today's behavior (plan:
 * review into the inspector, phase A); the review itself is replaced by a
 * stand-in recording what it is given.
 */
if (process.env.ROAMGATE_REVIEW_HOST_RENDERED_DOM_TEST !== "1") {
  test("review host with rendered reviews in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_REVIEW_HOST_RENDERED_DOM_TEST: "1" },
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
  const { installReviewDom } = await import("./reviewSurface.testkit");
  await installReviewDom();
  const { act, useEffect } = await import("react");
  const { createRoot } = await import("react-dom/client");
  type Snapshot = import("../../../shared/review").ReviewSnapshot;
  type Props = Record<string, unknown> & { snapshot: Snapshot };

  /** What each mounted review was last given, and how often it mounted. */
  const given = new Map<string, Props>();
  const mounts: string[] = [];
  mock.module("./ReviewOverlay", () => {
    return {
      ReviewOverlay: (props: Props) => {
        const id = props.snapshot.session.id;
        given.set(id, props);
        useEffect(() => {
          mounts.push(id);
        }, [id]);
        return null;
      },
    };
  });
  const sessions = new Map<string, Snapshot>();
  mock.module("../review", () => ({
    useReviewState: () => ({ sessions, openRequest: null }),
  }));
  const opens: unknown[] = [];
  const remembered: string[] = [];
  const openAnswer: string | null = "opened";
  mock.module("../reviewOpen", () => ({
    openWorkspaceReview: async (
      _sessions: unknown,
      request: Record<string, unknown>,
    ) => {
      opens.push(request);
      return openAnswer;
    },
    rememberWorkspaceReview: (snapshot: Snapshot) => {
      remembered.push(snapshot.session.id);
    },
  }));
  const { ReviewHost } = await import("./ReviewHost");

  const review = (
    id: string,
    workspaceId?: string,
    paneId?: string,
    kind = "worktree",
  ) =>
    ({
      session: {
        id,
        connectionId: "desktop",
        ...(workspaceId === undefined ? {} : { workspaceId }),
        root: "/repo",
        title: id,
        target: { kind },
        gitlab: false,
        summary: "",
        agent: paneId ? { paneId } : {},
        reviewed: {},
        createdAt: "2026-11-10",
        updatedAt: "2026-11-10",
      },
      threads: [],
    }) as unknown as Snapshot;

  async function mount(props: {
    pinned: Snapshot[];
    shownId: string | null;
    panes?: import("../types").Pane[];
    goTo?: { sessionId: string; path: string; line?: number; at: number };
  }) {
    given.clear();
    mounts.length = 0;
    opens.length = 0;
    remembered.length = 0;
    const calls: { name: string; args: unknown[] }[] = [];
    const record =
      (name: string) =>
      (...args: unknown[]) =>
        calls.push({ name, args });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const render = (next: typeof props) =>
      act(async () =>
        root.render(
          <ReviewHost
            connectionId="desktop"
            pinned={next.pinned}
            shownId={next.shownId}
            panes={next.panes ?? []}
            onClose={record("close")}
            onShow={record("show")}
            onShowList={record("list")}
            onFocusAgentPane={record("focusPane")}
            onOpenFile={record("openFile")}
            goTo={next.goTo ?? null}
          />,
        ),
      );
    await render(props);
    return {
      calls,
      render,
      unmount: async () => {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }

  describe("ReviewHost with rendered reviews", () => {
    test("a rendered file's or site's review is not mounted: it is discussed in the Files preview", async () => {
      const view = await mount({
        pinned: [
          review("r1", "w1"),
          review("doc", "w1", undefined, "rendered"),
          review("r2", "w2"),
        ],
        shownId: "doc",
      });
      expect([...given.keys()]).toEqual(["r1", "r2"]);
      expect(given.get("r1")?.hidden).toBe(true);
      expect(given.get("r2")?.hidden).toBe(true);
      await view.unmount();
    });

    test("Show in code review goes to its review only; a file opened rendered says so", async () => {
      const goTo = { sessionId: "r2", path: "a.ts", line: 4, at: 1 };
      const view = await mount({
        pinned: [review("r1", "w1"), review("r2", "w1")],
        shownId: "r2",
        goTo,
      });
      expect(given.get("r1")?.goTo).toBeUndefined();
      expect(given.get("r2")?.goTo).toEqual(goTo);
      const open = given.get("r2")?.onOpenFile as (
        path: string,
        line?: number,
        rendered?: boolean,
      ) => void;
      open("/repo/README.md", 3, true);
      open("/repo/a.ts");
      expect(view.calls).toEqual([
        { name: "openFile", args: ["w1", "/repo/README.md", 3, true] },
        { name: "openFile", args: ["w1", "/repo/a.ts", undefined, undefined] },
      ]);
      await view.unmount();
    });
  });
}
