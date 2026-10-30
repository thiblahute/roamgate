import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

if (process.env.ROAMGATE_REWIND_SHEET_DOM_TEST !== "1") {
  test("rewind sheet interactions in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_REWIND_SHEET_DOM_TEST: "1" },
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
  }, 15_000);
} else {
  await registerTests();
}

async function registerTests() {
  const browser = new Window({ url: "http://localhost" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "KeyboardEvent",
    "MouseEvent",
    "PointerEvent",
  ] as const) {
    Object.defineProperty(globalThis, key, {
      value: key === "window" ? browser : browser[key],
      writable: true,
      configurable: true,
    });
  }
  Object.assign(globalThis, {
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  // happy-dom has no layout: nothing to scroll to.
  Object.defineProperty(browser.HTMLElement.prototype, "scrollIntoView", {
    value: () => {},
    configurable: true,
  });
  const { act, createElement: h } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { AgentRewindSheet } = await import("./AgentRewindSheet");
  type Check = import("../../../shared/agentChat").AgentChatRewindCheck;

  let root: Root | null = null;
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    await browser.happyDOM.whenAsyncComplete();
  });
  afterAll(async () => browser.happyDOM.close());

  const entry = {
    id: "m1",
    kind: "message",
    role: "user",
    text: "make it so",
    sent_at: "2026-10-31T10:00:00.000Z",
    uuid: "u1",
  } as unknown as import("./agentHistory").HistoryEntry;

  async function open(check?: (entry: unknown) => Promise<Check>) {
    const onRewind = mock(() => {});
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        h(AgentRewindSheet, {
          entries: [entry],
          onRewind,
          onClose: () => {},
          ...(check ? { check } : {}),
        }),
      ),
    );
    const pick = container.querySelector(
      "[data-rewind-index='0']",
    ) as HTMLButtonElement;
    await act(async () => pick.click());
    await act(async () => browser.happyDOM.whenAsyncComplete());
    const modes = [
      ...container.querySelectorAll<HTMLButtonElement>(".agent-rewind-mode"),
    ];
    const press = async (key: string) =>
      act(async () => {
        container
          .querySelector(".agent-rewind-sheet")!
          .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
    return { container, modes, onRewind, press };
  }

  test("nothing to restore: the code choices are off, with why and the Bash caveat", async () => {
    const check = mock(async () => ({ code: "none" }) as Check);
    const { container, modes, onRewind, press } = await open(check);
    expect(check).toHaveBeenCalledWith(entry);
    expect(modes.map((mode) => mode.disabled)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(
      container.querySelector(".agent-rewind-note")?.textContent,
    ).toContain("No code changes to restore");
    expect(
      container.querySelector(".agent-rewind-help")?.textContent,
    ).toContain("Bash");
    await press("1");
    expect(onRewind).not.toHaveBeenCalled();
    await press("2");
    expect(onRewind).toHaveBeenCalledWith(entry, "conversation");
  });

  test("edits with no checkpoint: off, naming the files", async () => {
    const { container, modes } = await open(async () => ({
      code: "no_checkpoint",
      files: ["/w/a.ts"],
    }));
    expect(modes[0]!.disabled).toBe(true);
    expect(modes[2]!.disabled).toBe(true);
    expect(
      container.querySelector(".agent-rewind-note")?.textContent,
    ).toContain(
      "no code checkpoint for these changes (made before checkpoints were on): /w/a.ts",
    );
  });

  test("restorable, or no check: everything offered", async () => {
    for (const check of [
      async () => ({ code: "restorable", files: ["/w/a.ts"] }) as Check,
      undefined,
    ]) {
      const { container, modes, onRewind } = await open(check);
      expect(modes.some((mode) => mode.disabled)).toBe(false);
      expect(container.querySelector(".agent-rewind-note")).toBeNull();
      await act(async () => modes[0]!.click());
      expect(onRewind).toHaveBeenCalledWith(entry, "both");
      await act(async () => root?.unmount());
      root = null;
      document.body.replaceChildren();
    }
  });
}
