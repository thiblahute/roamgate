import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";
import * as React from "react";

if (
  inIsolatedChild(
    import.meta.path,
    "the Usage view and its header chip in an isolated browser runtime",
    "ROAMGATE_USAGE_VIEW_DOM_TEST",
    30_000,
  )
) {
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost/" });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const { UsageViewBody } = await import("./UsageView");
  const { UsageChipView } = await import("./UsageChip");
  const { usageFixture } = await import("../usageViewFixture");
  const { chipText } = await import("../usageView");
  const { createRoot } = await import("react-dom/client");

  const mount = async (element: React.ReactElement) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () => root.render(element));
    return { container, root };
  };

  test("one card per account, its meters, its sessions by name, the chain and its switches", async () => {
    const now = Date.parse("2026-11-27T12:00:00Z");
    const data = usageFixture(now);
    const calls: string[] = [];
    const { container, root } = await mount(
      <UsageViewBody
        data={data}
        actions={{
          onPeriod: (period) => calls.push(`period ${period}`),
          onMakeDefault: (name) => calls.push(`default ${name}`),
          onOpenSession: (session) => calls.push(`open ${session.name}`),
          onOpenSettings: () => calls.push("settings"),
        }}
      />,
    );
    try {
      const cards = [...container.querySelectorAll(".usage-card")];
      expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
        "work",
        "perso",
        "codex",
        "Agy 2",
      ]);
      const work = cards[0]!;
      expect(work.textContent).toContain("Default");
      expect(work.textContent).toContain("#1 in chain");
      expect(work.textContent).toContain("clauth manages this sign-in");
      const meters = [...work.querySelectorAll('[role="meter"]')];
      expect(meters.map((meter) => meter.getAttribute("aria-label"))).toEqual([
        "work 5h",
        "work 7d",
        "work 7d opus",
      ]);
      expect(meters[2]!.getAttribute("aria-valuenow")).toBe("96");
      expect(
        work.querySelector(".usage-meter[data-level='warn']")?.textContent,
      ).toContain("7d");
      // Sessions by name, the most spent first; never their ids.
      const names = [...work.querySelectorAll(".usage-session-name")].map(
        (each) => each.textContent,
      );
      expect(names).toEqual([
        "Review the usage view",
        "Port the account chain",
      ]);
      expect(work.textContent).not.toContain("a1");
      expect(work.textContent).toContain("pinned");
      // The chain's summary.
      const summary = container.querySelector(".usage-summary")!.textContent;
      expect(summary).toContain("Auto-switch on");
      expect(summary).toContain("next: perso");
      expect(container.querySelector(".usage-switches")?.textContent).toContain(
        "perso → work",
      );
      // Its actions, from the keyboard's buttons.
      const button = (label: string) =>
        [...container.querySelectorAll("button")].find(
          (each) => each.textContent?.trim() === label,
        )!;
      await React.act(async () => {
        button("Port the account chain").click();
        [...container.querySelectorAll("button")]
          .find((each) => each.textContent === "Make default")!
          .click();
        button("Edit the chain").click();
      });
      expect(calls).toEqual([
        "open Port the account chain",
        "default perso",
        "settings",
      ]);
    } finally {
      await React.act(async () => root.unmount());
    }
  });

  test("the chip says the default account's tightest window, and nothing without one", async () => {
    const now = Date.parse("2026-11-27T12:00:00Z");
    const data = usageFixture(now);
    let opened = 0;
    const text = chipText(data.profiles, data.defaultName, data.board, now);
    const { container, root } = await mount(
      <UsageChipView text={text} onOpen={() => opened++} />,
    );
    try {
      const chip = container.querySelector("button")!;
      expect(chip.textContent).toBe("work96% 7d opus");
      expect(chip.getAttribute("data-level")).toBe("high");
      expect(chip.getAttribute("aria-label")).toContain("96% of 7d opus used");
      await React.act(async () => chip.click());
      expect(opened).toBe(1);
      await React.act(async () =>
        root.render(<UsageChipView text={text} compact onOpen={() => {}} />),
      );
      expect(container.textContent).toBe("96%");
      await React.act(async () =>
        root.render(<UsageChipView text={null} onOpen={() => {}} />),
      );
      expect(container.textContent).toBe("");
    } finally {
      await React.act(async () => root.unmount());
    }
  });
}
