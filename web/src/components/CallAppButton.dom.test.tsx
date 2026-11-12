import { expect, mock, test } from "bun:test";

if (process.env.ROAMGATE_CALL_APP_DOM_TEST !== "1") {
  test("the call's Roamgate app button in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CALL_APP_DOM_TEST: "1" },
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
  }, 20_000);
} else {
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
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });

  /** A call as the button reads it: where it is, and its handOff. */
  const call = {
    place: "can" as "app" | "opening" | "can" | "none",
    handedOff: 0,
    inApp: () => call.place === "app",
    handingOff: () => call.place === "opening",
    canHandOff: () => call.place === "can",
    handOff: () => {
      call.handedOff += 1;
      call.place = "opening";
      for (const listener of listeners) listener();
    },
  };
  let present = true;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  mock.module("../webrtcCall", () => ({
    activeCall: () => (present ? call : null),
    subscribeActiveCall: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    nextCallOutput: () => null,
  }));
  const { CallAppButton } = await import("./CallOutputButton");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = () => host.querySelector("button");

  test("offers the app, says it opens, then that the call is in it", async () => {
    await act(async () => {
      root.render(<CallAppButton className="call" withLabel />);
    });
    expect(button()?.textContent).toBe("Move to the Roamgate app");
    expect(button()?.disabled).toBe(false);
    await act(async () => {
      button()!.click();
    });
    expect(call.handedOff).toBe(1);
    expect(button()?.textContent).toBe("Opening the Roamgate app");
    expect(button()?.disabled).toBe(true);
    await act(async () => {
      call.place = "app";
      changed();
    });
    expect(button()?.textContent).toBe("In the Roamgate app");
    expect(button()?.getAttribute("aria-pressed")).toBe("true");
  });

  test("shows nothing without the app or without a call", async () => {
    await act(async () => {
      call.place = "none";
      changed();
    });
    expect(button()).toBeNull();
    await act(async () => {
      present = false;
      call.place = "can";
      changed();
    });
    expect(button()).toBeNull();
    await act(async () => root.unmount());
  });
}
