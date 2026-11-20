import { expect, spyOn, test } from "bun:test";

/**
 * The Work board on a phone, at the app level: More options has a Work
 * entry wearing the For you count, which opens the board full screen and
 * closes the sheet; the board's close returns to the page.
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

  test("More options' Work wears the For you count, opens the board full screen and closes the sheet; the board closes back", async () => {
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
      expect(work().querySelector("svg")).not.toBeNull();
      expect(work().querySelector(".mobile-nav-badge")?.textContent).toBe("2");
      expect(work().getAttribute("aria-description")).toBe("2 for you");

      await app.click(work());
      await app.settle(100);
      expect(more().getAttribute("aria-expanded")).toBe("false");
      const panel = () =>
        document.querySelector<HTMLElement>(".work-root .work-panel");
      expect(panel()).not.toBeNull();
      expect(panel()!.classList.contains("is-mobile")).toBe(true);
      expect(panel()!.getAttribute("aria-label")).toBe("Work");
      // Scoped to the page's workspace: its checkout is the project's root.
      expect(panel()!.querySelector(".work-scope-name")?.textContent).toBe(
        "Workspace 1",
      );
      expect(panel()!.querySelector(".work-status")?.textContent).toBe(
        "2 for you · 3 open",
      );
      // The board's close: the panel goes, the page stays.
      await app.click(
        panel()!.querySelector<HTMLButtonElement>(
          'button[aria-label="Close (Esc)"]',
        )!,
      );
      await app.settle(50);
      expect(panel()).toBeNull();
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
