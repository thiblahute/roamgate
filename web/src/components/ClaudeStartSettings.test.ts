import { expect, mock, test } from "bun:test";
if (process.env.ROAMGATE_CLAUDE_START_DOM_TEST !== "1") {
  test("the claude start setting in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CLAUDE_START_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code) throw new Error(`${out}\n${error}`);
    expect(code).toBe(0);
  }, 15000);
} else {
  test("shows the mode and switches it", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost" });
    for (const key of [
      "window",
      "document",
      "navigator",
      "HTMLElement",
      "Element",
      "Node",
      "Event",
      "MouseEvent",
    ] as const)
      Object.defineProperty(globalThis, key, {
        value: key === "window" ? browser : browser[key],
        writable: true,
        configurable: true,
      });
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const requests: Array<{
      method: string;
      params: unknown;
      resolve: (value: any) => void;
    }> = [];
    const client = {
      isCurrent: () => true,
      call: (method: string, params: unknown) =>
        new Promise((resolve) => requests.push({ method, params, resolve })),
    };
    mock.module("../useConnectionClient", () => ({
      useConnectionClient: () => client,
      useConnectionReady: () => true,
    }));
    const { act, createElement: h } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ClaudeStartSettings } = await import("./ClaudeStartSettings");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const toggle = () =>
      container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    try {
      await act(async () => root.render(h(ClaudeStartSettings)));
      expect(requests[0]!.method).toBe("settings.claude_start.get");
      await act(async () => requests[0]!.resolve({ mode: "terminal" }));
      expect(toggle().getAttribute("aria-checked")).toBe("false");
      expect(container.textContent).toContain("stays in the terminal");
      await act(async () => toggle().click());
      expect(requests[1]).toMatchObject({
        method: "settings.claude_start.update",
        params: { mode: "conversation" },
      });
      await act(async () => requests[1]!.resolve({ mode: "conversation" }));
      expect(toggle().getAttribute("aria-checked")).toBe("true");
      expect(container.textContent).toContain("opens in the chat");
      await act(async () => toggle().click());
      expect(requests[2]!.params).toEqual({ mode: "terminal" });
    } finally {
      await act(async () => root.unmount());
      await browser.happyDOM.close();
    }
  });
}
