import { expect, test } from "bun:test";
import {
  parseFrameMessage,
  RENDERED_THREAD_KEYS,
} from "../../shared/renderedPage";

if (process.env.ROAMGATE_RENDERED_KEYS_DOM_TEST !== "1") {
  test("a page's frame hands the threads' keys in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_RENDERED_KEYS_DOM_TEST: "1" },
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

  test("Roamgate takes only the threads' keys from a frame", () => {
    for (const key of RENDERED_THREAD_KEYS)
      expect(
        parseFrameMessage({ roamgate: "rendered", type: "key", key }),
      ).toEqual({ roamgate: "rendered", type: "key", key });
    for (const key of ["x", "Enter", "Tab", "F5", 1, undefined])
      expect(
        parseFrameMessage({ roamgate: "rendered", type: "key", key }),
      ).toBeNull();
  });
} else {
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost/rendered/x/" });
  const posted: unknown[] = [];
  Object.defineProperty(browser, "parent", {
    value: { postMessage: (message: unknown) => posted.push(message) },
    configurable: true,
  });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    location: browser.location,
    getSelection: browser.getSelection.bind(browser),
    ResizeObserver: browser.ResizeObserver,
    KeyboardEvent: browser.KeyboardEvent,
    MutationObserver: browser.MutationObserver,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const { renderedHelperSource } = await import(
    "../../server/src/http/rendered-helper"
  );
  const page = browser.document as unknown as Document;
  page.body.innerHTML = '<p>Text</p><input id="field"><div id="own"></div>';
  const fetched: unknown[] = [];
  (browser as unknown as { fetch: unknown }).fetch = (input: unknown) => {
    fetched.push(input);
    return Promise.resolve(new Response(""));
  };
  new Function(
    renderedHelperSource("/rendered/x/", {
      base: "/",
      to: "/rendered/x/.roamgate-root/",
    }),
  )();

  test("what the page's script builds stays under the token", async () => {
    // A menu inserted by the page's script, as gst-docs' is.
    const nav = page.createElement("nav");
    nav.innerHTML =
      '<a id="abs" href="/documentation/installing/on-linux.html">l</a>' +
      '<a id="rel" href="on-mac.html">m</a>' +
      '<a id="ext" href="https://example.com/x">e</a>' +
      '<a id="net" href="//example.com/x">n</a>' +
      '<img id="img" srcset="/a.png 1x, b.png 2x">' +
      '<form id="form" action="/search"></form>';
    page.body.appendChild(nav);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const attr = (id: string, name: string) =>
      page.getElementById(id)!.getAttribute(name);
    expect(attr("abs", "href")).toBe(
      "/rendered/x/.roamgate-root/documentation/installing/on-linux.html",
    );
    expect(attr("rel", "href")).toBe("on-mac.html");
    expect(attr("ext", "href")).toBe("https://example.com/x");
    expect(attr("net", "href")).toBe("//example.com/x");
    expect(attr("img", "srcset")).toBe(
      "/rendered/x/.roamgate-root/a.png 1x, b.png 2x",
    );
    expect(attr("form", "action")).toBe("/rendered/x/.roamgate-root/search");
    // Changed later, too; and never twice.
    page.getElementById("rel")!.setAttribute("href", "/b.html");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attr("rel", "href")).toBe("/rendered/x/.roamgate-root/b.html");
    await (
      window as unknown as { fetch: (u: string) => Promise<unknown> }
    ).fetch("/data.json");
    expect(fetched).toEqual(["/rendered/x/.roamgate-root/data.json"]);
    const ready = posted.find(
      (message) => (message as { type?: string }).type === "ready",
    );
    expect(ready).toMatchObject({
      root: { base: "/", to: "/rendered/x/.roamgate-root/" },
    });
  });

  test("the frame hands the threads' keys, and only those, to Roamgate", () => {
    const press = (target: EventTarget, key: string, init = {}) => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      });
      target.dispatchEvent(event);
      return event;
    };
    const keys = () =>
      posted
        .filter((message) => (message as { type?: string }).type === "key")
        .map((message) => (message as { key: string }).key);
    const body = page.body;
    for (const key of RENDERED_THREAD_KEYS)
      expect(press(body, key).defaultPrevented).toBe(true);
    expect(keys()).toEqual([...RENDERED_THREAD_KEYS]);
    posted.length = 0;
    // Other keys, typing in the page, a modifier, or a key the page
    // handled: the page's.
    press(body, "x");
    press(body, "Enter");
    press(page.getElementById("field")!, "j");
    press(body, "j", { ctrlKey: true });
    const own = page.getElementById("own")!;
    own.addEventListener("keydown", (event) => event.preventDefault());
    press(own, "n");
    expect(keys()).toEqual([]);
  });
}
