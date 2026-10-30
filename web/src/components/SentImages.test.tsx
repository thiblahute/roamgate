import { expect, jest, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_SENT_IMAGES_DOM_TEST !== "1") {
  test("sent images in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_SENT_IMAGES_DOM_TEST: "1" },
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
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost/" });
  // The observers the images made: a test says when one nears the screen.
  const observers = new Set<TestIntersectionObserver>();
  class TestIntersectionObserver {
    targets: Element[] = [];
    constructor(readonly callback: IntersectionObserverCallback) {
      observers.add(this);
    }
    observe(target: Element) {
      this.targets.push(target);
    }
    disconnect() {
      observers.delete(this);
    }
    near() {
      this.callback(
        this.targets.map(
          (target) =>
            ({ target, isIntersecting: true }) as IntersectionObserverEntry,
        ),
        this as unknown as IntersectionObserver,
      );
    }
  }
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const { SentImages, SENT_IMAGE_RETRY_MS, SENT_IMAGE_SLOW_MS } = await import(
    "./AgentHistoryChat"
  );
  const { RpcError } = await import("../api");
  const { createRoot } = await import("react-dom/client");

  const render = async (
    sentImageUrl: (uuid: string, index: number) => Promise<string>,
  ) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(
        <SentImages uuid="message" count={1} sentImageUrl={sentImageUrl} />,
      );
    });
    return {
      container,
      unmount: async () => {
        await React.act(async () => root.unmount());
        container.remove();
      },
    };
  };
  const advance = (ms: number) =>
    React.act(async () => {
      jest.advanceTimersByTime(ms);
      await Promise.resolve();
    });
  const settle = () =>
    React.act(async () => {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });
  const loadingBox = (container: HTMLElement) =>
    container.querySelector(".agent-history-chat-image.is-loading");

  test("an image loads once it nears the screen, not before", async () => {
    Object.defineProperty(globalThis, "IntersectionObserver", {
      value: TestIntersectionObserver,
      configurable: true,
      writable: true,
    });
    const loads: string[] = [];
    const view = await render(async (uuid) => {
      loads.push(uuid);
      return "blob:near";
    });
    try {
      // Far up the conversation: nothing asked yet, a box keeps its place.
      expect(loads).toEqual([]);
      expect(loadingBox(view.container)).not.toBeNull();
      expect(observers.size).toBe(1);
      await React.act(async () => {
        for (const observer of observers) observer.near();
      });
      await settle();
      expect(loads).toEqual(["message"]);
      expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
        "blob:near",
      );
    } finally {
      await view.unmount();
      Reflect.deleteProperty(globalThis, "IntersectionObserver");
    }
  });

  test("a slow image shows a loading box, then says it is still loading", async () => {
    jest.useFakeTimers();
    let tries = 0;
    // The first try times out (a busy lane), the next never answers.
    const view = await render(() => {
      tries += 1;
      return tries === 1
        ? Promise.reject(new Error("timeout: agent_history.image"))
        : new Promise<string>(() => {});
    });
    try {
      await settle();
      expect(loadingBox(view.container)).not.toBeNull();
      expect(view.container.textContent).not.toContain("could not be loaded");
      expect(view.container.textContent).not.toContain("Still loading");
      await advance(SENT_IMAGE_RETRY_MS[0]);
      expect(tries).toBe(2);
      await advance(SENT_IMAGE_SLOW_MS);
      expect(loadingBox(view.container)).not.toBeNull();
      expect(view.container.textContent).toContain("Still loading");
      expect(view.container.textContent).not.toContain("could not be loaded");
    } finally {
      await view.unmount();
      jest.useRealTimers();
    }
  });

  test("timeouts never make an image missing; the bridge saying so does", async () => {
    jest.useFakeTimers();
    let tries = 0;
    const view = await render(() => {
      tries += 1;
      return Promise.reject(
        tries < 6
          ? new Error("timeout: agent_history.image")
          : new RpcError("That image is not in the session", "image_gone"),
      );
    });
    try {
      for (let wait = 0; tries < 6 && wait < 10; wait += 1) {
        await settle();
        expect(view.container.textContent).not.toContain("could not be loaded");
        await advance(30_000);
      }
      await settle();
      expect(tries).toBe(6);
      expect(loadingBox(view.container)).toBeNull();
      expect(view.container.textContent).toContain(
        "[an image that could not be loaded]",
      );
      // A definite answer: no more tries.
      await advance(60_000);
      expect(tries).toBe(6);
    } finally {
      await view.unmount();
      jest.useRealTimers();
    }
  });

  test("a failed image is tried again after a wait, and at once on focus", async () => {
    jest.useFakeTimers();
    let tries = 0;
    const view = await render(() => {
      tries += 1;
      return tries < 3
        ? Promise.reject(new Error("bridge hello is unavailable"))
        : Promise.resolve("blob:back");
    });
    try {
      await settle();
      expect(tries).toBe(1);
      await advance(SENT_IMAGE_RETRY_MS[0]);
      await settle();
      expect(tries).toBe(2);
      // The page comes back: no waiting out the next delay.
      await React.act(async () => {
        window.dispatchEvent(new browser.Event("focus") as unknown as Event);
      });
      await settle();
      expect(tries).toBe(3);
      expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
        "blob:back",
      );
    } finally {
      await view.unmount();
      jest.useRealTimers();
    }
  });
}
