import { Window } from "happy-dom";
import { spyOn } from "bun:test";
import type { ConnectionClient } from "./api";
import type { store as Store } from "./store";

/** Install a browser before dynamically importing React components in DOM tests. */
export function installTestDom(
  options: {
    url?: string;
    pierre?: boolean;
    extra?: Record<string, unknown>;
    width?: number;
    height?: number;
  } = {},
) {
  const browser = new Window({
    url: options.url ?? "http://localhost/",
    width: options.width ?? 1280,
    height: options.height ?? 800,
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals: Record<string, unknown> = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    getSelection: browser.getSelection.bind(browser),
    matchMedia: browser.matchMedia.bind(browser),
    CSS: { escape: (value: string) => value.replace(/["\\]/g, "\\$&") },
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
      clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of [
    "HTMLElement",
    "HTMLDivElement",
    "HTMLButtonElement",
    "HTMLTextAreaElement",
    "HTMLInputElement",
    "HTMLIFrameElement",
    "HTMLFormElement",
    "HTMLTemplateElement",
    "HTMLStyleElement",
    "Element",
    "Node",
    "Text",
    "Document",
    "DocumentFragment",
    "ShadowRoot",
    "CSSStyleSheet",
    "SVGElement",
    "DOMParser",
    "NodeFilter",
    "Range",
    "Event",
    "KeyboardEvent",
    "MouseEvent",
    "FocusEvent",
    "PointerEvent",
    "CustomEvent",
    "MessageEvent",
    "PopStateEvent",
    "WheelEvent",
    "StorageEvent",
    "MutationObserver",
    "ResizeObserver",
    "customElements",
  ])
    globals[key] = browser[key as keyof Window];
  if (options.pierre) {
    class TestWorker extends browser.EventTarget {
      postMessage(request: { id: string; type: string }) {
        this.dispatchEvent(
          new browser.MessageEvent("message", {
            data: {
              id: request.id,
              type: "success",
              requestType: request.type,
            },
          }),
        );
      }
      terminate() {}
    }
    class TestIntersectionObserver {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ target, isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    }
    globals.Worker = TestWorker;
    globals.IntersectionObserver = TestIntersectionObserver;
  }
  Object.assign(globals, options.extra);
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  return {
    browser,
    async restore() {
      await browser.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

/** An in-memory ready connection whose calls can be overridden per suite. */
export function fakeConnection(
  connectionId: string,
  call: ConnectionClient["call"] = async (method) => {
    throw new Error(`no backend here: ${method}`);
  },
): ConnectionClient {
  return {
    connectionId,
    generation: 1,
    serverRuntimeGeneration: 1,
    isCurrent: () => true,
    acceptsServerGeneration: () => true,
    call,
  } as ConnectionClient;
}

/** Make the store report the test connection until mockRestore is called. */
export function spyStoreConnection(
  store: typeof Store,
  connectionId: string,
  options: { label?: string; type?: "local" | "ssh" } = {},
) {
  const base = store.get();
  return spyOn(store, "get").mockImplementation(
    () =>
      ({
        ...base,
        connections: [
          {
            id: connectionId,
            label: options.label ?? "Local",
            source: "test",
            is_default: false,
            state: "ready",
            generation: 1,
            type: options.type ?? "local",
          },
        ],
      }) as ReturnType<typeof store.get>,
  );
}
