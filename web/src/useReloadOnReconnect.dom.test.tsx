import { expect, mock, test } from "bun:test";

/**
 * Loads made again once the connection is back: after a failure for want
 * of it, once each time it comes back; never on their own for another
 * error. And the client that comes back is a new one, answering the same.
 */
if (process.env.ROAMGATE_RELOAD_ON_RECONNECT_TEST !== "1") {
  test("reloads on reconnect in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_RELOAD_ON_RECONNECT_TEST: "1" },
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
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost" });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const)
    Object.defineProperty(globalThis, key, {
      value: key === "window" ? browser : browser[key],
      configurable: true,
      writable: true,
    });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

  // The connection, up or down, as the tests set it.
  let up = true;
  const listeners = new Set<() => void>();
  mock.module("./connectionReady", () => ({
    connectionReady: () => up,
    onConnectionChange: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  }));
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { failedForConnection, useLiveClient, useReloadOnReconnect } =
    await import("./useReloadOnReconnect");
  type Client = import("./api").ConnectionClient;

  const setUp = async (value: boolean) => {
    await act(async () => {
      up = value;
      for (const listener of [...listeners]) listener();
    });
  };
  const mount = async (element: ReturnType<typeof createElement>) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(element));
    return {
      render: async (next: ReturnType<typeof createElement>) =>
        act(async () => root.render(next)),
      unmount: async () => {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  };

  test("an error is a connection's when the bridge or its runtime was missing", () => {
    expect(failedForConnection("bridge hello is unavailable")).toBe(true);
    expect(failedForConnection(new Error("bridge disconnected"))).toBe(true);
    expect(failedForConnection("connection changed during request")).toBe(true);
    expect(failedForConnection("fatal: bad object")).toBe(false);
    expect(failedForConnection(null)).toBe(false);
    expect(failedForConnection("")).toBe(false);
  });

  test("a load failed for want of the connection is made again once it is back, once", async () => {
    let reloads = 0;
    function View({ error }: { error: string | null }) {
      useReloadOnReconnect(error, "c1", () => reloads++);
      return null;
    }
    await setUp(true);
    const view = await mount(createElement(View, { error: null }));
    await setUp(false);
    await view.render(
      createElement(View, { error: "bridge hello is unavailable" }),
    );
    expect(reloads).toBe(0);
    await setUp(true);
    expect(reloads).toBe(1);
    // Failing again while it is up: it waits for the next time.
    await view.render(createElement(View, { error: null }));
    await view.render(createElement(View, { error: "bridge disconnected" }));
    await setUp(true);
    expect(reloads).toBe(1);
    await setUp(false);
    await setUp(true);
    expect(reloads).toBe(2);
    await view.unmount();
  });

  test("a load failed for another reason is left to its Retry", async () => {
    let reloads = 0;
    function View({ error }: { error: string | null }) {
      useReloadOnReconnect(error, "c1", () => reloads++);
      return null;
    }
    await setUp(true);
    const view = await mount(
      createElement(View, { error: "fatal: bad object" }),
    );
    await setUp(false);
    await setUp(true);
    expect(reloads).toBe(0);
    await view.unmount();
  });

  test("the client that comes back with the connection is a new one, answering the same", async () => {
    const client = {
      connectionId: "c1",
      generation: 1,
      serverRuntimeGeneration: 1,
      call: async () => "answer",
      isCurrent: () => up,
      acceptsServerGeneration: () => true,
    } as unknown as Client;
    const seen: Client[] = [];
    function View() {
      seen.push(useLiveClient(client));
      return null;
    }
    await setUp(true);
    const view = await mount(createElement(View));
    const first = seen[seen.length - 1]!;
    await setUp(false);
    await setUp(true);
    const back = seen[seen.length - 1]!;
    expect(back).not.toBe(first);
    expect(back.connectionId).toBe("c1");
    expect(back.generation).toBe(1);
    expect(await back.call("anything")).toBe("answer");
    // No change, no new client.
    await view.render(createElement(View));
    expect(seen[seen.length - 1]).toBe(back);
    await view.unmount();
  });
}
