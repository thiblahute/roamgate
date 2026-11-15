import {
  RENDERED_STORAGE_MAX_CHARS,
  RENDERED_STORAGE_MAX_KEYS,
  RENDERED_THREAD_KEYS,
  type RenderedRootMap,
} from "../../../shared/renderedPage";
import { svgAsDrawn } from "../../../shared/svgAsDrawn";

/**
 * The script Roamgate injects in each page of a rendered review (under a
 * per-response CSP nonce): it tells the parent what the user selects or
 * points at, and shows a thread's place when the parent asks. It runs in
 * the page's opaque origin and holds nothing secret: what it posts is
 * untrusted to the parent (shared/renderedPage.ts parseFrameMessage).
 *
 * Plain ES2017, no dependencies; `PREFIX` is the token's path prefix, and
 * `ROOT` where the page's root-absolute URLs go: a path under `base` is
 * written under `to` instead (rendered-pages.ts rootPath). `STORE`: for a
 * listed site's pages, what the site stored in `localStorage` (the page's
 * sandbox has none of its own), `LIMITS` its bounds; null for any other.
 */
function renderedHelper(
  PREFIX: string,
  asDrawn: (svg: SVGSVGElement) => string,
  KEYS: readonly string[],
  ROOT: RenderedRootMap,
  STORE: Record<string, string> | null,
  LIMITS: { chars: number; keys: number },
) {
  const w = window;
  const d = document;
  if ((w as unknown as { __roamgateRendered?: boolean }).__roamgateRendered)
    return;
  (w as unknown as { __roamgateRendered?: boolean }).__roamgateRendered = true;
  const parentWindow = w.parent;
  // A listed site's pages get a `localStorage` and a `sessionStorage`
  // before any of their scripts run: the sandbox refuses the real ones. The
  // first is held in memory, seeded by the server, every write handed to
  // the parent to keep; the second lives as long as the page.
  if (STORE) {
    const makeStorage = (seed: Record<string, string>, persist: boolean) => {
      const items = new Map<string, string>(Object.entries(seed));
      const chars = () => {
        let total = 0;
        items.forEach((value, key) => {
          total += key.length + value.length;
        });
        return total;
      };
      const send = (write: Record<string, unknown>) => {
        if (!persist || !parentWindow || parentWindow === w) return;
        try {
          parentWindow.postMessage(
            { roamgate: "rendered", type: "storage", ...write },
            "*",
          );
        } catch {
          /* The parent is gone. */
        }
      };
      const quota = () => {
        const message = "The quota has been exceeded.";
        if (typeof DOMException === "function")
          return new DOMException(message, "QuotaExceededError");
        const error = new Error(message);
        error.name = "QuotaExceededError";
        return error;
      };
      const api = {
        getItem(key: unknown) {
          const value = items.get(String(key));
          return value === undefined ? null : value;
        },
        setItem(key: unknown, value: unknown) {
          const name = String(key);
          const text = String(value);
          const before = items.get(name);
          if (before === text) return;
          const grown =
            chars() - (before === undefined ? 0 : name.length + before.length);
          if (
            name.length === 0 ||
            grown + name.length + text.length > LIMITS.chars ||
            (before === undefined && items.size >= LIMITS.keys)
          )
            throw quota();
          items.set(name, text);
          send({ op: "set", key: name, value: text });
        },
        removeItem(key: unknown) {
          const name = String(key);
          if (!items.delete(name)) return;
          send({ op: "remove", key: name });
        },
        clear() {
          if (!items.size) return;
          items.clear();
          send({ op: "clear" });
        },
        key(index: unknown) {
          const found = Array.from(items.keys())[Number(index)];
          return found === undefined ? null : found;
        },
      };
      const target: Record<string, unknown> = {};
      for (const name of Object.keys(api))
        Object.defineProperty(target, name, {
          value: api[name as keyof typeof api],
          configurable: true,
          writable: true,
        });
      Object.defineProperty(target, "length", {
        get: () => items.size,
        configurable: true,
      });
      return new Proxy(target, {
        get(self, name, receiver) {
          if (typeof name === "symbol") {
            return name === Symbol.toStringTag
              ? "Storage"
              : Reflect.get(self, name, receiver);
          }
          if (Object.prototype.hasOwnProperty.call(self, name))
            return Reflect.get(self, name, receiver);
          return items.get(name);
        },
        set(_self, name, value) {
          if (typeof name === "symbol") return false;
          api.setItem(name, value);
          return true;
        },
        deleteProperty(_self, name) {
          if (typeof name === "symbol") return false;
          api.removeItem(name);
          return true;
        },
        has(self, name) {
          return (typeof name === "string" && items.has(name)) || name in self;
        },
        ownKeys() {
          return Array.from(items.keys());
        },
        getOwnPropertyDescriptor(self, name) {
          if (typeof name === "string" && items.has(name))
            return {
              value: items.get(name),
              writable: true,
              enumerable: true,
              configurable: true,
            };
          return Reflect.getOwnPropertyDescriptor(self, name);
        },
      });
    };
    const install = (name: string, storage: object) => {
      try {
        Object.defineProperty(w, name, {
          get: () => storage,
          configurable: true,
          enumerable: true,
        });
      } catch {
        /* Not replaceable here: the page keeps what the browser gives. */
      }
    };
    install("localStorage", makeStorage(STORE, true));
    install("sessionStorage", makeStorage({}, false));
  }
  if (!parentWindow || parentWindow === w) return;
  let pointMode = false;
  let selected = false;
  const post = (message: Record<string, unknown>) => {
    try {
      parentWindow.postMessage({ roamgate: "rendered", ...message }, "*");
    } catch {
      /* The parent is gone. */
    }
  };
  const pageUrl = () => {
    const path = location.pathname;
    const rest = path.indexOf(PREFIX) === 0 ? path.slice(PREFIX.length) : path;
    return (rest + location.search).slice(0, 2048);
  };
  const cssEscape = (value: string) =>
    w.CSS && CSS.escape
      ? CSS.escape(value)
      : value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  const selectorOf = (start: Element | null) => {
    const parts: string[] = [];
    let el: Element | null = start;
    while (el && el.nodeType === 1 && parts.length < 12) {
      if (el.id && d.querySelectorAll(`#${cssEscape(el.id)}`).length === 1) {
        parts.unshift(`#${cssEscape(el.id)}`);
        break;
      }
      const tag = el.tagName.toLowerCase();
      if (tag === "html" || tag === "body") {
        parts.unshift(tag);
        break;
      }
      let index = 1;
      let sibling = el.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === el.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${tag}:nth-of-type(${index})`);
      el = el.parentElement;
    }
    return parts.join(" > ").slice(0, 1000);
  };
  const rectOf = (r: DOMRect) => ({
    x: r.left,
    y: r.top,
    w: r.width,
    h: r.height,
  });
  const size = () =>
    post({
      type: "size",
      // The body's own height: the document's is at least the frame's.
      height: d.body ? d.body.getBoundingClientRect().height : 0,
    });
  // Root-absolute URLs the page makes itself (a menu built by its script,
  // a fetch) would leave the token for Roamgate's root: written under it
  // as the server writes those of the markup. Navigations no script can
  // catch (`location.href = "/x"`) come back from the server as a stray
  // page the parent sends here (RenderedFrame).
  const ORIGIN = `${location.protocol}//${location.host}`;
  const mapUrl = (url: unknown): unknown => {
    if (typeof url !== "string") return url;
    let path = url.trim();
    if (path.indexOf(`${ORIGIN}/`) === 0) path = path.slice(ORIGIN.length);
    if (path.charAt(0) !== "/" || /^\/[/\\]/.test(path)) return url;
    if (path.indexOf("/rendered/") === 0 || path.indexOf(ROOT.base) !== 0)
      return url;
    return ROOT.to + path.slice(ROOT.base.length);
  };
  const URL_ATTRIBUTES = [
    "href",
    "src",
    "action",
    "formaction",
    "poster",
    "data",
  ];
  const fixElement = (el: Element) => {
    for (const name of URL_ATTRIBUTES) {
      if (name === "data" && el.tagName !== "OBJECT") continue;
      const value = el.getAttribute(name);
      if (value === null) continue;
      const mapped = mapUrl(value);
      if (mapped !== value) el.setAttribute(name, mapped as string);
    }
    const set = el.getAttribute("srcset");
    if (set !== null) {
      const mapped = set
        .split(",")
        .map((part) =>
          part.replace(
            /^(\s*)(\S+)/,
            (_m, space: string, url: string) => space + mapUrl(url),
          ),
        )
        .join(",");
      if (mapped !== set) el.setAttribute("srcset", mapped);
    }
  };
  const fixTree = (node: Node) => {
    if (node.nodeType !== 1) return;
    const el = node as Element;
    fixElement(el);
    const inner = el.querySelectorAll(
      "[href],[src],[action],[formaction],[poster],[data],[srcset]",
    );
    for (let i = 0; i < inner.length; i += 1) fixElement(inner[i]!);
  };
  if (w.MutationObserver) {
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") fixElement(record.target as Element);
        else
          for (let i = 0; i < record.addedNodes.length; i += 1)
            fixTree(record.addedNodes[i]!);
      }
    }).observe(d.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: URL_ATTRIBUTES.concat("srcset"),
    });
  }
  // A link changed since: fixed when it is followed.
  d.addEventListener(
    "click",
    (event) => {
      const target = event.target as Element | null;
      const link = target?.closest
        ? target.closest("a[href], area[href]")
        : null;
      if (link) fixElement(link);
    },
    true,
  );
  d.addEventListener(
    "submit",
    (event) => {
      if (event.target instanceof Element) fixElement(event.target);
    },
    true,
  );
  if (typeof w.fetch === "function") {
    const fetchPage = w.fetch;
    w.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      return fetchPage.call(
        w,
        typeof input === "string" ? (mapUrl(input) as string) : input,
        init,
      );
    } as typeof w.fetch;
  }
  if (w.XMLHttpRequest) {
    const open = w.XMLHttpRequest.prototype.open as (
      ...args: unknown[]
    ) => void;
    w.XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      ...args: unknown[]
    ) {
      args[1] = mapUrl(args[1]);
      return open.apply(this, args);
    } as typeof XMLHttpRequest.prototype.open;
  }
  const openWindow = w.open;
  if (typeof openWindow === "function")
    w.open = function (url?: string | URL, ...rest: unknown[]) {
      return (openWindow as (...args: unknown[]) => Window | null).call(
        w,
        mapUrl(url),
        ...rest,
      );
    } as typeof w.open;
  for (const name of ["pushState", "replaceState"] as const) {
    const original = w.history?.[name];
    if (typeof original !== "function") continue;
    w.history[name] = function (
      this: History,
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ) {
      return original.call(this, data, unused, mapUrl(url) as string);
    };
  }

  const ready = () => {
    post({ type: "ready", url: pageUrl(), title: d.title, root: ROOT });
    size();
    if (w.ResizeObserver && d.body) new ResizeObserver(size).observe(d.body);
  };
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", ready);
  else ready();

  let pending = 0;
  const reportSelection = () => {
    clearTimeout(pending);
    pending = w.setTimeout(() => {
      const selection = w.getSelection();
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
        if (selected) post({ type: "clear" });
        selected = false;
        return;
      }
      const quote = selection.toString().trim().slice(0, 4000);
      if (!quote) return;
      const range = selection.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const element =
        node.nodeType === 1 ? (node as Element) : node.parentElement;
      selected = true;
      post({
        type: "select",
        url: pageUrl(),
        quote,
        selector: selectorOf(element),
        rect: rectOf(range.getBoundingClientRect()),
      });
    }, 120);
  };
  d.addEventListener("mouseup", reportSelection);
  d.addEventListener("keyup", reportSelection);

  // The threads' keys, for Roamgate while the page has the focus: not
  // while typing in the page, nor one the page itself handled.
  d.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
    if (event.altKey || KEYS.indexOf(event.key) < 0) return;
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ""))
    )
      return;
    event.preventDefault();
    post({ type: "key", key: event.key });
  });

  // Pointing at a graphic: Alt+click (or any click in point mode), or a
  // drag for a box. The region is in fractions of the graphic's box.
  const graphicOf = (target: Element) => {
    let graphic: Element | null = target.closest("svg, img, canvas, video");
    while (graphic && graphic.parentElement?.closest("svg"))
      graphic = graphic.parentElement.closest("svg");
    return graphic ?? target;
  };
  // Paused animations, let go when the parent says the comment is done.
  let held: Array<() => void> = [];
  const seconds = (value: number) => `${Math.round(value * 10) / 10} s`;
  const hold = (graphic: Element): string | undefined => {
    let moment: string | undefined;
    const svg =
      graphic.tagName.toLowerCase() === "svg"
        ? (graphic as SVGSVGElement)
        : null;
    if (
      svg &&
      svg.querySelector("animate, animateTransform, animateMotion, set")
    ) {
      if (!svg.animationsPaused()) {
        svg.pauseAnimations();
        held.push(() => svg.unpauseAnimations());
      }
      moment = seconds(svg.getCurrentTime());
    }
    const animations =
      typeof (graphic as HTMLElement).getAnimations === "function"
        ? (graphic as HTMLElement).getAnimations({ subtree: true })
        : [];
    for (const animation of animations) {
      if (animation.playState !== "running") continue;
      animation.pause();
      held.push(() => animation.play());
      if (moment === undefined && typeof animation.currentTime === "number")
        moment = seconds(animation.currentTime / 1000);
    }
    if (graphic.tagName.toLowerCase() === "video") {
      const video = graphic as HTMLVideoElement;
      if (!video.paused) {
        video.pause();
        held.push(() => {
          video.play().catch(() => undefined);
        });
      }
      moment = moment ?? seconds(video.currentTime);
    }
    return moment;
  };
  const picture = (
    graphic: Element,
    region: { x: number; y: number; w: number; h: number },
  ): Promise<string | undefined> =>
    new Promise((resolve) => {
      const box = graphic.getBoundingClientRect();
      const draw = (
        source: CanvasImageSource,
        width: number,
        height: number,
      ) => {
        try {
          const whole = !region.w || !region.h;
          const sx = whole ? 0 : region.x * width;
          const sy = whole ? 0 : region.y * height;
          const sw = whole ? width : Math.max(1, region.w * width);
          const sh = whole ? height : Math.max(1, region.h * height);
          const scale = Math.min(1600 / Math.max(sw, sh), 2);
          const canvas = d.createElement("canvas");
          canvas.width = Math.max(1, Math.round(sw * scale));
          canvas.height = Math.max(1, Math.round(sh * scale));
          const context = canvas.getContext("2d");
          if (!context) return resolve(undefined);
          context.fillStyle = "#fff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(
            source,
            sx,
            sy,
            sw,
            sh,
            0,
            0,
            canvas.width,
            canvas.height,
          );
          const url = canvas.toDataURL("image/png");
          resolve(url.length <= 4 * 1024 * 1024 ? url : undefined);
        } catch {
          // A picture from another origin taints the canvas: no snapshot.
          resolve(undefined);
        }
      };
      const tag = graphic.tagName.toLowerCase();
      if (tag === "img") {
        const image = graphic as HTMLImageElement;
        return draw(
          image,
          image.naturalWidth || box.width,
          image.naturalHeight || box.height,
        );
      }
      if (tag === "canvas" || tag === "video") {
        const media = graphic as HTMLCanvasElement | HTMLVideoElement;
        const width =
          tag === "video"
            ? (media as HTMLVideoElement).videoWidth
            : (media as HTMLCanvasElement).width;
        const height =
          tag === "video"
            ? (media as HTMLVideoElement).videoHeight
            : (media as HTMLCanvasElement).height;
        return draw(media, width || box.width, height || box.height);
      }
      if (tag !== "svg" || !box.width || !box.height) return resolve(undefined);
      try {
        const markup = asDrawn(graphic as SVGSVGElement);
        const image = new Image();
        image.onload = () => draw(image, box.width, box.height);
        image.onerror = () => resolve(undefined);
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
      } catch {
        resolve(undefined);
      }
    });
  let start: { x: number; y: number; target: Element } | null = null;
  d.addEventListener(
    "mousedown",
    (event) => {
      if (!(event.altKey || pointMode) || event.button !== 0) return;
      if (!(event.target instanceof Element)) return;
      start = { x: event.clientX, y: event.clientY, target: event.target };
      event.preventDefault();
    },
    true,
  );
  d.addEventListener(
    "mouseup",
    (event) => {
      const begun = start;
      start = null;
      if (!begun) return;
      event.preventDefault();
      const graphic = graphicOf(begun.target);
      const box = graphic.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const clamp = (value: number) => Math.min(1, Math.max(0, value));
      const x1 = clamp((begun.x - box.left) / box.width);
      const y1 = clamp((begun.y - box.top) / box.height);
      const x2 = clamp((event.clientX - box.left) / box.width);
      const y2 = clamp((event.clientY - box.top) / box.height);
      const dragged =
        Math.abs(event.clientX - begun.x) > 4 ||
        Math.abs(event.clientY - begun.y) > 4;
      const region = dragged
        ? {
            x: Math.min(x1, x2),
            y: Math.min(y1, y2),
            w: Math.abs(x2 - x1),
            h: Math.abs(y2 - y1),
          }
        : { x: x1, y: y1, w: 0, h: 0 };
      const named = begun.target.closest("[id]");
      const element =
        (named && graphic.contains(named) && named.id) ||
        (begun.target.textContent ?? "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 80);
      // What the user saw: its animations stop where they are, and a
      // picture of the region is made when the browser allows it.
      const moment = hold(graphic);
      const send = (snapshot?: string) =>
        post({
          type: "point",
          url: pageUrl(),
          selector: selectorOf(graphic),
          region,
          rect: rectOf(box),
          ...(element ? { element } : {}),
          ...(moment ? { moment } : {}),
          ...(snapshot ? { snapshot } : {}),
        });
      picture(graphic, region).then(send, () => send());
    },
    true,
  );
  // A link or card must not get in the way of commenting: text inside it
  // selects by dragging (a link is not dragged away), and the click that
  // ends such a selection does not follow the link. Point mode shows its
  // crosshair over everything, the page's own pointer cursors included. An
  // empty link stretched over a card as its click target must not hide the
  // text under it from selection and commenting, so it ignores the mouse.
  const style = d.createElement("style");
  style.textContent =
    "a, a * { -webkit-user-drag: none; user-select: text; }" +
    "a:empty { pointer-events: none; }" +
    "html[data-roamgate-point], html[data-roamgate-point] * { cursor: crosshair !important; }";
  (d.head ?? d.documentElement).appendChild(style);
  d.addEventListener(
    "click",
    (event) => {
      if (event.altKey || pointMode) {
        event.preventDefault();
        return;
      }
      const selection = w.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim())
        event.preventDefault();
    },
    true,
  );
  // The empty overlay link ignores the mouse (above), so a plain click on a
  // card follows it here instead: the smallest empty link under the point,
  // after a short delay, so a double or triple click keeps selecting a word
  // or paragraph for a comment, and only while nothing is selected.
  const INTERACTIVE =
    "a, button, input, select, textarea, summary, label, [role=button], [contenteditable]";
  let followTimer = 0;
  const cardLinkAt = (x: number, y: number) => {
    let best: HTMLElement | null = null;
    let bestArea = Infinity;
    const links = d.querySelectorAll<HTMLElement>("a:empty[href]");
    for (let i = 0; i < links.length; i++) {
      const rect = links[i].getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom)
        continue;
      const area = rect.width * rect.height;
      if (area < bestArea) {
        best = links[i];
        bestArea = area;
      }
    }
    return best;
  };
  const hasSelectedText = () => {
    const selection = w.getSelection();
    return (
      !!selection && !selection.isCollapsed && !!selection.toString().trim()
    );
  };
  d.addEventListener(
    "click",
    (event) => {
      if (event.detail > 1 && followTimer) {
        w.clearTimeout(followTimer);
        followTimer = 0;
      }
      if (event.altKey || pointMode) return;
      if (
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      if (hasSelectedText() || event.detail > 1) return;
      const target = event.target as Element | null;
      if (target && target.closest && target.closest(INTERACTIVE)) return;
      const link = cardLinkAt(event.clientX, event.clientY);
      if (!link) return;
      if (followTimer) w.clearTimeout(followTimer);
      followTimer = w.setTimeout(() => {
        followTimer = 0;
        if (!hasSelectedText()) link.click();
      }, 250);
    },
    true,
  );
  // A pointer over a followable card, unless the mouse is down (dragging a
  // selection), text is selected, or Point mode has its crosshair.
  let cardCursor = false;
  d.addEventListener(
    "mousemove",
    (event) => {
      if (pointMode) return;
      const over =
        event.buttons === 0 &&
        !hasSelectedText() &&
        !!cardLinkAt(event.clientX, event.clientY);
      if (over === cardCursor) return;
      cardCursor = over;
      d.documentElement.style.cursor = over ? "pointer" : "";
    },
    true,
  );

  const flash = (element: Element) => {
    element.scrollIntoView({ block: "center" });
    const html = element as HTMLElement;
    if (!html.style) return;
    const before = html.style.outline;
    html.style.outline = "3px solid rgba(255, 170, 0, 0.9)";
    w.setTimeout(() => {
      html.style.outline = before;
    }, 1600);
  };
  const findQuote = (quote: string) => {
    const needle = quote.replace(/\s+/g, " ").trim().slice(0, 60);
    if (!needle) return null;
    const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = (node.nodeValue ?? "").replace(/\s+/g, " ");
      if (text.includes(needle.slice(0, 30))) return node.parentElement;
    }
    return null;
  };
  w.addEventListener("message", (event) => {
    if (event.source !== parentWindow) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || data.roamgate !== "rendered") return;
    if (data.type === "pointMode") {
      pointMode = data.on === true;
      d.documentElement.style.cursor = pointMode ? "crosshair" : "";
      if (pointMode) d.documentElement.setAttribute("data-roamgate-point", "");
      else d.documentElement.removeAttribute("data-roamgate-point");
      return;
    }
    if (data.type === "resume") {
      for (const resume of held.splice(0)) resume();
      held = [];
      return;
    }
    if (data.type !== "show") return;
    let element: Element | null = null;
    if (typeof data.selector === "string" && data.selector) {
      try {
        element = d.querySelector(data.selector);
      } catch {
        element = null;
      }
    }
    if (typeof data.quote === "string" && data.quote) {
      const found = findQuote(data.quote);
      if (found && (!element || element.contains(found))) element = found;
    }
    if (element) flash(element);
  });
}

/** The helper, called with its prefix, as the body of a `<script>`. */
export function renderedHelperSource(
  prefix: string,
  root: RenderedRootMap = { base: "/", to: prefix },
  storage: Record<string, string> | null = null,
): string {
  // `<` cannot occur in the prefix (a token path), so the script cannot be
  // closed early; escape it anyway.
  const quoted = JSON.stringify(prefix).replace(/</g, "\\u003c");
  const keys = JSON.stringify(RENDERED_THREAD_KEYS).replace(/</g, "\\u003c");
  const rooted = JSON.stringify(root).replace(/</g, "\\u003c");
  // The items are the page's own, untrusted text: `<` (a `</script>`) and the
  // line separators are escaped so no value can end or break the script.
  const stored = JSON.stringify(storage)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const limits = JSON.stringify({
    chars: RENDERED_STORAGE_MAX_CHARS,
    keys: RENDERED_STORAGE_MAX_KEYS,
  });
  return `(${renderedHelper.toString()})(${quoted}, ${svgAsDrawn.toString()}, ${keys}, ${rooted}, ${stored}, ${limits});`;
}
