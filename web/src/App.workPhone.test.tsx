import { expect, spyOn, test } from "bun:test";

/**
 * The Work board on a phone, at the app level: More options has a Work
 * entry wearing the For you count, which opens the inspector on its Work
 * tab, the phone's screen, and closes the sheet; the rail and its agent
 * message box step aside while it shows; the inspector's close returns
 * to the page.
 */
if (process.env.ROAMGATE_APP_WORK_PHONE_TEST !== "1") {
  test("the Work board on a phone, in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_APP_WORK_PHONE_TEST: "1" },
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
  const { installAppReviewDom, mountAppWithReviews } = await import(
    "./App.review.testkit"
  );
  await installAppReviewDom("http://localhost/?layout=mobile");
  const React = await import("react");
  const { bridge } = await import("./api");
  const item = (id: string, state: string) => ({
    id,
    project: "roamgate",
    title: `Item ${id}`,
    state,
    tags: ["reviews"],
    links: [],
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
    by: "agent",
  });
  const board = {
    projects: [
      {
        id: "roamgate",
        name: "roamgate",
        roots: [{ connectionId: "local", path: "/repo/r1" }],
        done: { kind: "deployed" },
      },
    ],
    items: [
      item("1111111111111111", "you"),
      item("2222222222222222", "you"),
      item("3333333333333333", "doing"),
    ],
  };
  let workPushes: ((push: unknown) => void)[] = [];
  spyOn(bridge, "call").mockImplementation(async (method: string) =>
    method === "bridge.work.board" ? board : {},
  );
  spyOn(bridge, "onWork").mockImplementation((cb: (push: never) => void) => {
    workPushes.push(cb as (push: unknown) => void);
    return () => {
      workPushes = workPushes.filter((each) => each !== cb);
    };
  });
  spyOn(bridge, "onStatus").mockImplementation(() => () => {});

  test("More options' Work wears the For you count, opens the inspector on its Work tab and closes the sheet; the inspector closes back", async () => {
    const app = await mountAppWithReviews({ reviews: [] });
    try {
      const more = () =>
        app.container.querySelector<HTMLButtonElement>(
          'button[aria-label="More options"][aria-controls="mobile-more-options"]',
        )!;
      const work = () =>
        [
          ...app.container.querySelectorAll<HTMLButtonElement>(
            '[aria-label="Workspace view switcher"] button',
          ),
        ].find((button) =>
          button
            .querySelector(".mobile-nav-label")
            ?.textContent?.startsWith("Work"),
        )!;
      await app.settle(50);
      await app.click(more());
      expect(more().getAttribute("aria-expanded")).toBe("true");
      expect(work()).toBeDefined();
      expect(work().getAttribute("aria-label")).toBe("Open the Work board");
      // Next to Review, with the board's icon and the For you count.
      const labels = [
        ...app.container.querySelectorAll<HTMLElement>(
          '[aria-label="Workspace view switcher"] button .mobile-nav-label',
        ),
      ].map((label) => label.textContent);
      expect(labels.indexOf("Work")).toBe(labels.indexOf("Review") + 1);
      // The reviews inbox, the inspector's other board tab, next to it.
      expect(labels.indexOf("Reviews")).toBe(labels.indexOf("Work") + 1);
      expect(work().querySelector("svg")).not.toBeNull();
      expect(work().querySelector(".mobile-nav-badge")?.textContent).toBe("2");
      expect(work().getAttribute("aria-description")).toBe("2 for you");

      await app.click(work());
      await app.settle(100);
      expect(more().getAttribute("aria-expanded")).toBe("false");
      // The inspector on its Work tab, the phone's screen; it wears the
      // For you count on that tab (the board itself: the inspector's tests).
      expect(app.inspector()).toMatchObject({ open: true, view: "work" });
      expect(app.inspectorProps().visible).toBe(true);
      expect(app.inspectorProps().workForYou).toBe(2);
      expect(work().classList.contains("active")).toBe(true);
      // No agent message box under the board: the rail (its composer)
      // steps aside, still mounted, while Work shows.
      const rail = () =>
        app.container.querySelector<HTMLElement>(".mobile-bottom-bar")!;
      expect(rail().hidden).toBe(true);
      expect(rail().querySelector(".mobile-bottom-input")).not.toBeNull();
      // The inspector's close: the board goes, the page stays.
      await React.act(async () => app.inspectorProps().onClose());
      await app.settle(50);
      expect(app.inspector()?.open).toBe(false);
      expect(rail().hidden).toBe(false);
      expect(more()).not.toBeNull();

      // A push changes the count on the entry.
      board.items = [item("1111111111111111", "you")];
      for (const push of workPushes) push({ changed: ["items"], by: "agent" });
      await app.settle(50);
      await app.click(more());
      expect(work().querySelector(".mobile-nav-badge")?.textContent).toBe("1");
      board.items = [];
      for (const push of workPushes) push({ changed: ["items"], by: "agent" });
      await app.settle(50);
      expect(work().querySelector(".mobile-nav-badge")).toBeNull();
      expect(work().hasAttribute("aria-description")).toBe(false);
    } finally {
      await app.unmount();
    }
  });
}
