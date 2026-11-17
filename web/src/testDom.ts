import { Window } from "happy-dom";

/** Install a browser before dynamically importing React components in DOM tests. */
export function installTestDom(
  options: {
    url?: string;
    pierre?: boolean;
    extra?: Record<string, unknown>;
  } = {},
) {
  const browser = new Window({
    url: options.url ?? "http://localhost/",
    width: 1280,
    height: 800,
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
