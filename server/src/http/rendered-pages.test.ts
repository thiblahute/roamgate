import { describe, expect, test } from "bun:test";
import { renderedHelperSource } from "./rendered-helper";
import { renderedFileTarget } from "../review/rendered-target";
import {
  RENDERED_STORAGE_MAX_CHARS,
  RENDERED_STORAGE_MAX_KEYS,
} from "../../../shared/renderedPage";
import { createSiteStorage, StorageQuotaError } from "./rendered-storage";
import {
  connectionFileReader,
  connectionRootFinder,
  createRenderedPages,
  injectHelper,
  pagePath,
  RENDERED_BODY_MAX_BYTES,
  type RenderedFile,
  renderedAddress,
  renderedSvgPage,
  renderedCsp,
  renderedStray,
  localizeLoopbackOrigin,
  rewriteRootUrls,
  SITE_ROOT_MAX_LEVELS,
  siteRootCandidates,
  siteRootScript,
} from "./rendered-pages";

const FILES: Record<string, string> = {
  "/site/index.html":
    "<!doctype html><html><head><title>Home</title></head><body><script>alert(1)</script>hi</body></html>",
  "/site/style.css": "body{color:red}",
  "/site/docs/page.html": "<p>no head here</p>",
};

function filePages(now = { at: 1_000 }) {
  const reads: string[] = [];
  const pages = createRenderedPages({
    now: () => now.at,
    readFile: async (_connection, root, path): Promise<RenderedFile> => {
      reads.push(`${root}|${path}`);
      const text = FILES[`${root}/${path}`];
      if (text === undefined) {
        if (`${root}/${path}` === "/site/docs")
          return { body: "", size: 0, contentType: "application/gzip" };
        throw new Error("no such file");
      }
      return {
        body: text,
        size: Buffer.byteLength(text),
        contentType: "application/octet-stream",
      };
    },
  });
  return { pages, reads };
}

function get(
  pages: ReturnType<typeof filePages>["pages"],
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
) {
  const url = new URL(`https://roamgate.example${path}`);
  return pages.handle(new Request(url, { method, headers }), url);
}

describe("tokens", () => {
  test("are 128-bit hex, reused for the same pages, and expire", async () => {
    const now = { at: 1_000 };
    const { pages } = filePages(now);
    const token = pages.mint({
      connectionId: "c",
      mode: "static",
      source: { kind: "files", root: "/site" },
    });
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(
      pages.mint({
        connectionId: "c",
        mode: "static",
        source: { kind: "files", root: "/site" },
      }),
    ).toBe(token);
    // Another mode is another token: a listing must not widen old ones.
    expect(
      pages.mint({
        connectionId: "c",
        mode: "site",
        source: { kind: "files", root: "/site" },
      }),
    ).not.toBe(token);
    expect(pages.entry(token)).not.toBeNull();
    now.at += 12 * 60 * 60 * 1000 + 1;
    expect(pages.entry(token)).toBeNull();
    const expired = await get(pages, `/rendered/${token}/index.html`);
    expect(expired?.status).toBe(404);
  });

  test("are bounded, oldest out first", () => {
    const pages = createRenderedPages({
      maxTokens: 2,
      readFile: async () => {
        throw new Error("unused");
      },
    });
    const mint = (root: string) =>
      pages.mint({
        connectionId: "c",
        mode: "static",
        source: { kind: "files", root },
      });
    const first = mint("/a");
    mint("/b");
    mint("/c");
    expect(pages.entry(first)).toBeNull();
  });

  test("refuse relative roots and non-http sites", () => {
    const { pages } = filePages();
    expect(() =>
      pages.mint({
        connectionId: "c",
        mode: "static",
        source: { kind: "files", root: "site" },
      }),
    ).toThrow();
    expect(() =>
      pages.mint({
        connectionId: "c",
        mode: "static",
        source: { kind: "url", base: "file:///etc/" },
      }),
    ).toThrow();
    expect(() =>
      pages.mint({
        connectionId: "c",
        mode: "static",
        source: { kind: "url", base: "http://u:p@x/" },
      }),
    ).toThrow();
  });

  test("unknown or malformed tokens are 404", async () => {
    const { pages } = filePages();
    expect((await get(pages, "/rendered/nope/index.html"))?.status).toBe(404);
    expect((await get(pages, `/rendered/${"0".repeat(32)}/x`))?.status).toBe(
      404,
    );
    expect(get(pages, "/api/health")).toBeNull();
  });
});

describe("paths", () => {
  test("stay inside their source", () => {
    expect(pagePath("a/b.html")).toBe("a/b.html");
    expect(pagePath("")).toBe("index.html");
    expect(pagePath("docs/")).toBe("docs/index.html");
    expect(pagePath("a%20b.html")).toBe("a b.html");
    for (const bad of [
      "../x",
      "a/../../x",
      "%2e%2e/x",
      "a//b",
      "a/%2Fetc",
      "./x",
      "a%00b",
      "%E0%A4%A",
    ])
      expect(pagePath(bad)).toBeNull();
  });
});

describe("policies", () => {
  test("never allow the same origin, and frame only in Roamgate", () => {
    for (const mode of ["static", "site"] as const) {
      const csp = renderedCsp(mode, "N");
      expect(csp).toStartWith("sandbox allow-scripts");
      expect(csp).not.toContain("allow-same-origin");
      expect(csp).not.toContain("allow-top-navigation");
      expect(csp).not.toContain("allow-popups-to-escape-sandbox");
      expect(csp).toContain("frame-ancestors 'self'");
    }
  });

  test("static runs only Roamgate's script and reaches nothing", () => {
    const csp = renderedCsp("static", "N0nce");
    expect(csp).toContain("script-src 'nonce-N0nce'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain("allow-forms");
    expect(csp).not.toContain("unsafe-inline' 'unsafe-eval");
  });

  test("a listed site runs its scripts and forms", () => {
    const csp = renderedCsp("site", "N");
    expect(csp).toContain("allow-forms");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    // A nonce would turn 'unsafe-inline' off.
    expect(csp).not.toContain("nonce-");
  });
});

describe("serving files", () => {
  test("HTML gets the helper under a nonce, the page's scripts blocked", async () => {
    const { pages } = filePages();
    const token = pages.mint({
      connectionId: "c",
      mode: "static",
      source: { kind: "files", root: "/site" },
    });
    const response = (await get(pages, `/rendered/${token}/`))!;
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy")!;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
    const html = await response.text();
    expect(html).toContain(`<head><script nonce="${nonce}">`);
    expect(html).toContain(JSON.stringify(`/rendered/${token}/`));
    // The page's own script has no nonce: the policy blocks it.
    expect(html).toContain("<script>alert(1)</script>");
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("other files keep their type and the sandbox", async () => {
    const { pages } = filePages();
    const token = pages.mint({
      connectionId: "c",
      mode: "static",
      source: { kind: "files", root: "/site" },
    });
    const response = (await get(pages, `/rendered/${token}/style.css`))!;
    expect(response.headers.get("content-type")).toBe(
      "text/css; charset=utf-8",
    );
    expect(response.headers.get("content-security-policy")).toStartWith(
      "sandbox allow-scripts",
    );
    expect(await response.text()).toBe("body{color:red}");
  });

  test("says which file was not found, and why", async () => {
    const { pages } = filePages();
    const token = pages.mint({
      connectionId: "c",
      mode: "static",
      source: { kind: "files", root: "/site/" },
    });
    const response = await get(pages, `/rendered/${token}/out/casa.html`);
    expect(response?.status).toBe(404);
    expect(await response?.text()).toBe(
      "not found: /site/out/casa.html\nno such file",
    );
  });

  test("refuses escapes, writes, and sends directories to their index", async () => {
    const { pages, reads } = filePages();
    const token = pages.mint({
      connectionId: "c",
      mode: "static",
      source: { kind: "files", root: "/site" },
    });
    // The URL parser already folds the dot segments: never the file.
    expect(
      (await get(pages, `/rendered/${token}/%2e%2e/etc/passwd`))!.status,
    ).toBe(404);
    expect(
      (await get(pages, `/rendered/${token}/a%2f..%2f..%2fetc`))!.status,
    ).toBe(400);
    expect(
      (await get(pages, `/rendered/${token}/index.html`, {}, "POST"))!.status,
    ).toBe(405);
    expect(reads).toEqual([]);
    const dir = (await get(pages, `/rendered/${token}/docs`))!;
    expect(dir.status).toBe(308);
    expect(dir.headers.get("location")).toBe(`/rendered/${token}/docs/`);
    expect((await get(pages, `/rendered/${token}/missing.html`))!.status).toBe(
      404,
    );
  });

  test("a page without <head> still gets the helper first", () => {
    expect(injectHelper("<p>x</p>", "n", "/p/")).toStartWith(
      '<script nonce="n">',
    );
    expect(injectHelper("<!DOCTYPE html><p>x</p>", "n", "/p/")).toStartWith(
      '<!DOCTYPE html><script nonce="n">',
    );
    expect(injectHelper('<html lang="en"><body>', "n", "/p/")).toStartWith(
      '<html lang="en"><script',
    );
    // The prefix cannot close the script.
    expect(injectHelper("", "n", "</script>")).not.toContain(
      "</script></script>",
    );
  });
});

describe("the helper and links", () => {
  test("a link neither drags nor swallows a selection, Point mode keeps its crosshair", () => {
    const source = injectHelper("<p>x</p>", "n", "/p/");
    expect(source).toContain("-webkit-user-drag: none");
    expect(source).toContain("user-select: text");
    expect(source).toContain("a:empty { pointer-events: none; }");
    expect(source).toContain("data-roamgate-point");
    expect(source).toContain("cursor: crosshair !important");
    expect(source).toContain("selection.isCollapsed");
  });

  test("a click on a card follows its empty link after a delay, mousemove shows a pointer", () => {
    const source = injectHelper("<p>x</p>", "n", "/p/");
    expect(source).toContain('"a:empty[href]"');
    expect(source).toContain("event.detail > 1");
    expect(source).toContain("}, 250)");
    expect(source).toContain("[role=button], [contenteditable]");
    expect(source).toContain('style.cursor = over ? "pointer" : ""');
  });

  describe("following a card", () => {
    async function setup() {
      const { Window } = await import("happy-dom");
      const win = new Window({
        settings: {
          disableJavaScriptEvaluation: true,
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
        },
      });
      const timers = new Map<number, () => void>();
      let next = 1;
      const view = win as unknown as {
        setTimeout: (fn: () => void) => number;
        clearTimeout: (id: number) => void;
        getSelection: () => unknown;
        parent: unknown;
      };
      view.setTimeout = (fn) => {
        timers.set(next, fn);
        return next++;
      };
      view.clearTimeout = (id) => {
        timers.delete(id);
      };
      let selected = "";
      view.getSelection = () => ({
        isCollapsed: !selected,
        toString: () => selected,
      });
      Object.defineProperty(win, "parent", { value: {} });
      win.document.body.innerHTML =
        '<article><p id="t">Card text</p><a class="entry-link" href="/post/"></a>' +
        '<button id="b">b</button></article>';
      const link = win.document.querySelector("a") as unknown as HTMLElement;
      link.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          right: 100,
          bottom: 100,
          width: 100,
          height: 100,
        }) as DOMRect;
      let follows = 0;
      link.addEventListener("click", () => {
        follows++;
      });
      const script = renderedHelperSource("/p/");
      new Function("window", `with (window) { ${script} }`)(win);
      const click = (target: Element, init: Record<string, unknown> = {}) =>
        (
          target as unknown as { dispatchEvent(e: unknown): void }
        ).dispatchEvent(
          new win.MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            clientX: 10,
            clientY: 10,
            button: 0,
            detail: 1,
            ...init,
          }) as never,
        );
      const fire = () => {
        for (const [id, fn] of [...timers]) {
          timers.delete(id);
          fn();
        }
      };
      return {
        win,
        text: win.document.getElementById("t") as unknown as Element,
        button: win.document.getElementById("b") as unknown as Element,
        click,
        fire,
        select: (text: string) => {
          selected = text;
        },
        follows: () => follows,
        point: (on: boolean) =>
          win.dispatchEvent(
            Object.assign(new win.Event("message"), {
              source: (win as unknown as { parent: unknown }).parent,
              data: { roamgate: "rendered", type: "pointMode", on },
            }),
          ),
      };
    }

    test("a plain click follows the card after the delay", async () => {
      const s = await setup();
      s.click(s.text);
      expect(s.follows()).toBe(0);
      s.fire();
      expect(s.follows()).toBe(1);
      await s.win.happyDOM.close();
    });

    test("a double click does not", async () => {
      const s = await setup();
      s.click(s.text, { detail: 1 });
      s.click(s.text, { detail: 2 });
      s.fire();
      expect(s.follows()).toBe(0);
      await s.win.happyDOM.close();
    });

    test("a click with text selected, or on a button, does not", async () => {
      const s = await setup();
      s.select("Card");
      s.click(s.text);
      s.fire();
      expect(s.follows()).toBe(0);
      s.select("");
      s.click(s.button);
      s.fire();
      expect(s.follows()).toBe(0);
      await s.win.happyDOM.close();
    });

    test("a selection made during the delay stops it", async () => {
      const s = await setup();
      s.click(s.text);
      s.select("Card");
      s.fire();
      expect(s.follows()).toBe(0);
      await s.win.happyDOM.close();
    });

    test("Point mode and modifier clicks do not", async () => {
      const s = await setup();
      s.click(s.text, { ctrlKey: true });
      s.click(s.text, { button: 1 });
      s.fire();
      expect(s.follows()).toBe(0);
      s.point(true);
      s.click(s.text);
      s.fire();
      expect(s.follows()).toBe(0);
      await s.win.happyDOM.close();
    });
  });
});

describe("large files", () => {
  /**
   * Pages serving one HTML file, plan.html, of about `pageBytes`; its read
   * says `claimedBytes` instead when given, as a stat would.
   */
  function sizedPages(pageBytes: number, claimedBytes?: number) {
    const page = `<!doctype html><html><head></head><body>${"x".repeat(
      pageBytes - 50,
    )}</body></html>`;
    return createRenderedPages({
      readFile: async (_connection, _root, path): Promise<RenderedFile> => {
        if (path !== "plan.html") throw new Error("no such file");
        return {
          body: page,
          size: claimedBytes ?? Buffer.byteLength(page),
          contentType: "application/octet-stream",
        };
      },
    });
  }

  test("a 600 KB page is served whole, past the text preview's 512 KiB", async () => {
    const pages = sizedPages(600 * 1000);
    const token = pages.mint({
      connectionId: "c",
      mode: "static",
      source: { kind: "files", root: "/site" },
    });
    const response = (await get(pages, `/rendered/${token}/plan.html`))!;
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<head><script nonce=");
    expect(html.length).toBeGreaterThan(600 * 1000);
  });

  test("a 17 MB page is served whole", async () => {
    const pages = sizedPages(17 * 1000 * 1000);
    const token = pages.mint({
      connectionId: "c",
      mode: "static",
      source: { kind: "files", root: "/site" },
    });
    const response = (await get(pages, `/rendered/${token}/plan.html`))!;
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<head><script nonce=");
    expect(html.length).toBeGreaterThan(17 * 1000 * 1000);
  });

  test("a page over its limit is refused with the reason", async () => {
    // Said by its size, refused before a byte of it is read.
    const pages = sizedPages(100, RENDERED_BODY_MAX_BYTES + 1);
    const token = pages.mint({
      connectionId: "c",
      mode: "static",
      source: { kind: "files", root: "/site" },
    });
    const response = (await get(pages, `/rendered/${token}/plan.html`))!;
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await response.text()).toBe(
      "This page is too large to render here (512 MiB maximum). Use Source or Download from the file menu.",
    );
  });

  test("a model over the SSH cache's limit is served, read each time", async () => {
    const reads: string[] = [];
    const model = new Uint8Array(2048).fill(7);
    const readFile = connectionFileReader({
      cacheBytes: 1024,
      sshHost: () => "mac",
      readLocal: async () => {
        throw new Error("local");
      },
      readRemote: async (_host, _root, path) => {
        reads.push(path);
        if (path !== "casa.glb") throw new Error("no such file");
        return {
          body: model.slice(),
          size: model.byteLength,
          contentType: "application/octet-stream",
        };
      },
    });
    const pages = createRenderedPages({ readFile });
    const token = pages.mint({
      connectionId: "mac",
      mode: "site",
      source: { kind: "files", root: "/Users/me/casa" },
    });
    for (let i = 0; i < 2; i += 1) {
      const response = (await get(pages, `/rendered/${token}/casa.glb`))!;
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(
        String(model.byteLength),
      );
      expect((await response.arrayBuffer()).byteLength).toBe(model.byteLength);
    }
    expect(reads).toEqual(["casa.glb", "casa.glb"]);
  });

  test("a file the SSH read refuses as too large says so", async () => {
    const pages = createRenderedPages({
      readFile: async () => {
        throw Object.assign(new Error("File is too large"), { status: 413 });
      },
    });
    const token = pages.mint({
      connectionId: "mac",
      mode: "site",
      source: { kind: "files", root: "/Users/me/casa" },
    });
    const response = (await get(pages, `/rendered/${token}/huge.glb`))!;
    expect(response.status).toBe(413);
    expect(await response.text()).toBe(
      `huge.glb is too large to read here (${RENDERED_BODY_MAX_BYTES / 1024 / 1024} MiB maximum).`,
    );
  });
});

describe("serving a site", () => {
  function sitePages(
    answer: (url: string, init: RequestInit) => Response,
    mode: "static" | "site" = "site",
  ) {
    const calls: { url: string; init: RequestInit }[] = [];
    const pages = createRenderedPages({
      readFile: async () => {
        throw new Error("unused");
      },
      fetch: async (url, init) => {
        calls.push({ url, init });
        return answer(url, init);
      },
    });
    const token = pages.mint({
      connectionId: "c",
      mode,
      source: { kind: "url", base: "http://localhost:8080/docs/" },
    });
    return { pages, token, calls };
  }

  test("never forwards credentials, never returns cookies", async () => {
    const { pages, token, calls } = sitePages(
      () =>
        new Response("<html><head></head></html>", {
          headers: {
            "content-type": "text/html",
            "set-cookie": "x=1",
            "access-control-allow-origin": "https://evil.example",
            "content-security-policy": "default-src *",
          },
        }),
    );
    const response = (await get(pages, `/rendered/${token}/a/b.html?q=1`, {
      cookie: "roamgate_session=secret",
      authorization: "Bearer secret",
      origin: "null",
      referer: "https://roamgate.example/x",
      accept: "text/html",
    }))!;
    expect(calls[0]!.url).toBe("http://localhost:8080/docs/a/b.html?q=1");
    const sent = calls[0]!.init.headers as Headers;
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("authorization")).toBeNull();
    expect(sent.get("origin")).toBeNull();
    expect(sent.get("referer")).toBeNull();
    expect(sent.get("accept")).toBe("text/html");
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("content-security-policy")).toStartWith(
      "sandbox allow-scripts allow-forms",
    );
    expect(await response.text()).toContain("<head><script nonce=");
  });

  test("stays on the site", async () => {
    const { pages, token, calls } = sitePages(() => new Response("x"));
    expect((await get(pages, `/rendered/${token}/../secret`))!.status).toBe(
      404,
    );
    expect((await get(pages, `/rendered/${token}/%2e%2e/secret`))!.status).toBe(
      404,
    );
    expect(calls).toEqual([]);
  });

  test("follows redirects within the site only", async () => {
    let hop = 0;
    const { pages, token, calls } = sitePages((url) => {
      hop += 1;
      if (url.endsWith("/old.css"))
        return new Response(null, {
          status: 301,
          headers: { location: "new.css" },
        });
      if (url.endsWith("/away"))
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest" },
        });
      if (url.endsWith("/nav"))
        return new Response(null, {
          status: 302,
          headers: { location: "/docs/there.html" },
        });
      return new Response("body{}", {
        headers: { "content-type": "text/css" },
      });
    });
    const followed = (await get(pages, `/rendered/${token}/old.css`))!;
    expect(followed.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([
      "http://localhost:8080/docs/old.css",
      "http://localhost:8080/docs/new.css",
    ]);
    const off = (await get(pages, `/rendered/${token}/away`))!;
    expect(off.status).toBe(502);
    expect(calls.at(-1)!.url).toBe("http://localhost:8080/docs/away");
    const nav = (await get(pages, `/rendered/${token}/nav`, {
      "sec-fetch-dest": "iframe",
      "sec-fetch-mode": "navigate",
    }))!;
    expect(nav.status).toBe(302);
    expect(nav.headers.get("location")).toBe(`/rendered/${token}/there.html`);
    expect(hop).toBe(4);
  });

  test("static sites only read", async () => {
    const { pages, token } = sitePages(() => new Response("x"), "static");
    expect(
      (await get(pages, `/rendered/${token}/form`, {}, "POST"))!.status,
    ).toBe(405);
  });
});

describe("renderedAddress", () => {
  test("an HTML file is served from its checkout, or its listed folder", () => {
    expect(
      renderedAddress({
        target: { path: "docs/site/index.html" },
        root: "/repo",
        sites: [],
      }),
    ).toEqual({
      mode: "static",
      source: { kind: "files", root: "/repo" },
      rest: "docs/site/index.html",
    });
    expect(
      renderedAddress({
        target: { path: "docs/site/index.html" },
        root: "/repo",
        sites: ["/repo/docs/"],
        page: "sub/p.html?x=1",
      }),
    ).toEqual({
      mode: "site",
      source: {
        kind: "files",
        root: "/repo/docs",
        site: "/repo/docs/",
        walk: true,
      },
      rest: "sub/p.html?x=1",
      site: "/repo/docs/",
    });
  });

  test("refuses escapes and non-HTML files", () => {
    for (const path of ["../x.html", "/etc/x.html", "a/./b.html", "plan.md"])
      expect(() =>
        renderedAddress({ target: { path }, root: "/repo", sites: [] }),
      ).toThrow();
    expect(() =>
      renderedAddress({
        target: { path: "a.html" },
        root: "/repo",
        sites: [],
        page: "../x",
      }),
    ).toThrow();
  });

  test("a URL is served from its directory, or its listed site", () => {
    expect(
      renderedAddress({
        target: { url: "http://localhost:8080/docs/a/b.html?q#frag" },
        root: "/",
        sites: [],
      }),
    ).toEqual({
      mode: "static",
      source: { kind: "url", base: "http://localhost:8080/docs/a/" },
      rest: "b.html?q",
    });
    expect(
      renderedAddress({
        target: { url: "http://localhost:8080/docs/a/b.html" },
        root: "/",
        sites: ["http://localhost:8080/"],
        page: "/docs/c.html",
      }),
    ).toEqual({
      mode: "site",
      source: {
        kind: "url",
        base: "http://localhost:8080/",
        site: "http://localhost:8080/",
      },
      rest: "docs/c.html",
      site: "http://localhost:8080/",
    });
    expect(() =>
      renderedAddress({
        target: { url: "http://localhost:8080/docs/a.html" },
        root: "/",
        sites: [],
        page: "http://evil/",
      }),
    ).toThrow();
    expect(() =>
      renderedAddress({
        target: { url: "javascript:alert(1)" },
        root: "/",
        sites: [],
      }),
    ).toThrow();
  });
});

describe("rewriteRootUrls", () => {
  const map = (path: string) =>
    path.startsWith("/off") ? null : `/rendered/T${path}`;

  test("writes a page's root-absolute URLs under its token", () => {
    expect(
      rewriteRootUrls(
        `<link href="/a.css"><script src='/b.js?v=1'></script><img src=/c.png srcset="/d.png 1x, e.png 2x, /f.png 3x"><a href="//cdn/x">x</a><a href="rel.html">r</a><a href="/off/x">o</a><div style="background:url(/g.png)"></div><form action="/s"></form>`,
        "html",
        map,
      ),
    ).toBe(
      `<link href="/rendered/T/a.css"><script src='/rendered/T/b.js?v=1'></script><img src="/rendered/T/c.png" srcset="/rendered/T/d.png 1x, e.png 2x, /rendered/T/f.png 3x"><a href="//cdn/x">x</a><a href="rel.html">r</a><a href="/off/x">o</a><div style="background:url(/rendered/T/g.png)"></div><form action="/rendered/T/s"></form>`,
    );
  });

  test("and a style sheet's", () => {
    expect(
      rewriteRootUrls(
        `@import "/base.css"; a{background:url("/i.png")} b{background:url(data:x)} c{src:url(//x/y)}`,
        "css",
        map,
      ),
    ).toBe(
      `@import "/rendered/T/base.css"; a{background:url("/rendered/T/i.png")} b{background:url(data:x)} c{src:url(//x/y)}`,
    );
  });

  test("site pages map onto their base", async () => {
    const pages = createRenderedPages({
      readFile: async () => {
        throw new Error("unused");
      },
      fetch: async () =>
        new Response(`<a href="/docs/b.html">b</a><a href="/other">o</a>`, {
          headers: { "content-type": "text/html" },
        }),
    });
    const token = pages.mint({
      connectionId: "c",
      mode: "static",
      source: { kind: "url", base: "http://localhost:8080/docs/" },
    });
    const url = new URL(`https://r.example/rendered/${token}/a.html`);
    const html = await (await pages.handle(new Request(url), url))!.text();
    expect(html).toContain(`href="/rendered/${token}/b.html"`);
    expect(html).toContain(`href="/other"`);
  });
});

describe("a dev server's own origin", () => {
  const page = (canonical: string) =>
    `<!doctype html><html><head>${canonical}<link rel="icon" href="http://localhost:1315/favicon.ico"><link rel="stylesheet" href="http://localhost:1315/css/a.css" integrity="sha256-x" crossorigin="anonymous"><meta property="og:image" content="http://localhost:1315/i.png"></head><body><a class="entry-link" href='http://localhost:1315/2019/04/slug/'>c</a><a href="http://localhost:9999/x/">other</a><a href="https://example.org/y">ext</a><img srcset="http://localhost:1315/a.png 1x, http://localhost:1315/b.png 2x"><div style="background:url(http://localhost:1315/bg.png)"></div></body></html>`;

  async function serve(html: string) {
    const pages = createRenderedPages({
      readFile: async (): Promise<RenderedFile> => ({
        body: html,
        size: Buffer.byteLength(html),
        contentType: "application/octet-stream",
      }),
    });
    const token = pages.mint({
      connectionId: "c",
      mode: "static",
      source: { kind: "files", root: "/site" },
    });
    const url = new URL(`https://r.example/rendered/${token}/index.html`);
    const text = await (await pages.handle(new Request(url), url))!.text();
    return { token, text };
  }

  test("a loopback canonical's URLs go under the token", async () => {
    const { token, text } = await serve(
      page(`<link rel="canonical" href="http://localhost:1315/">`),
    );
    const at = `/rendered/${token}`;
    expect(text).toContain(`href='${at}/2019/04/slug/'`);
    expect(text).toContain(`href="${at}/favicon.ico"`);
    expect(text).toContain(`href="${at}/css/a.css"`);
    expect(text).toContain(`content="${at}/i.png"`);
    expect(text).toContain(`srcset="${at}/a.png 1x, ${at}/b.png 2x"`);
    expect(text).toContain(`url(${at}/bg.png)`);
    // The canonical itself, other ports and other hosts stay.
    expect(text).toContain(`href="${at}/"`);
    expect(text).toContain(`href="http://localhost:9999/x/"`);
    expect(text).toContain(`href="https://example.org/y"`);
  });

  test("og:url counts, with other attribute orders", () => {
    const out = localizeLoopbackOrigin(
      `<meta content="http://127.0.0.1:8080/" property="og:url"><a href=http://127.0.0.1:8080/p>p</a>`,
    );
    expect(out).toContain(`<a href="/p">`);
  });

  test("a canonical elsewhere leaves the page alone", async () => {
    const html = page(`<link rel="canonical" href="https://example.org/">`);
    expect(localizeLoopbackOrigin(html)).toBe(html);
    const { text } = await serve(html);
    expect(text).toContain(`href="http://localhost:1315/favicon.ico"`);
  });

  test("a page without a canonical is unchanged", () => {
    const html = page("");
    expect(localizeLoopbackOrigin(html)).toBe(html);
  });
});

describe("an SVG as a page of its own", () => {
  test("static: only the helper runs, the SVG is left as it is", async () => {
    const pages = createRenderedPages({
      readFile: async () => {
        throw new Error("not a file");
      },
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><animate attributeName="x"/></svg>`;
    const token = pages.mint({
      connectionId: "c",
      mode: "static",
      source: { kind: "inline", body: renderedSvgPage(svg, "#abc") },
    });
    const response = await pages.handle(
      new Request(`http://x/rendered/${token}/`),
      new URL(`http://x/rendered/${token}/`),
    );
    expect(response?.status).toBe(200);
    const csp = response!.headers.get("content-security-policy")!;
    expect(csp).toStartWith("sandbox allow-scripts;");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("script-src 'nonce-");
    expect(csp).toContain("connect-src 'none'");
    const html = await response!.text();
    const nonce = /nonce-([^']+)'/.exec(csp)![1]!;
    // The helper's script has the nonce; the SVG's own does not.
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain("<script>alert(1)</script>");
    expect(html).toContain("color:#abc;");
  });

  test("other paths under its token are not found", async () => {
    const pages = createRenderedPages({
      readFile: async () => {
        throw new Error("not a file");
      },
    });
    const token = pages.mint({
      connectionId: "c",
      mode: "static",
      source: { kind: "inline", body: renderedSvgPage("<svg/>") },
    });
    const response = await pages.handle(
      new Request(`http://x/rendered/${token}/other.png`),
      new URL(`http://x/rendered/${token}/other.png`),
    );
    expect(response?.status).toBe(404);
  });
});

describe("scripts asked for on one file or site", () => {
  test("a file runs its scripts, served from its folder alone", () => {
    expect(
      renderedAddress({
        target: { path: "docs/site/page.html" },
        root: "/repo",
        sites: [],
        scripts: true,
      }),
    ).toEqual({
      mode: "site",
      source: { kind: "files", root: "/repo/docs/site" },
      rest: "page.html",
    });
  });

  test("a listed folder still serves the folder", () => {
    expect(
      renderedAddress({
        target: { path: "docs/site/page.html" },
        root: "/repo",
        sites: ["/repo/docs/"],
        scripts: true,
      }),
    ).toMatchObject({ mode: "site", source: { root: "/repo/docs" } });
  });

  test("a URL runs its scripts in its own directory", () => {
    expect(
      renderedAddress({
        target: { url: "http://localhost:8080/docs/a.html" },
        root: "/",
        sites: [],
        scripts: true,
      }),
    ).toMatchObject({
      mode: "site",
      source: { kind: "url", base: "http://localhost:8080/docs/" },
    });
  });

  test("off by default", () => {
    expect(
      renderedAddress({
        target: { path: "a.html" },
        root: "/repo",
        sites: [],
      }).mode,
    ).toBe("static");
  });
});

/** A Mac reached over SSH, as the download helpers read it: confined. */
const MAC_FILES: Record<string, string> = {
  "/Users/me/logs/docs/build/index.html":
    '<!doctype html><html><head><link rel="stylesheet" href="css/site.css"></head><body><a href="sub/page.html">p</a></body></html>',
  "/Users/me/logs/docs/build/css/site.css": "body{color:blue}",
  "/Users/me/logs/docs/build/sub/page.html":
    '<html><head><link rel="stylesheet" href="../css/site.css"></head></html>',
  "/Users/me/logs/docs/secret.txt": "not served",
  "/etc/passwd": "root:x:0:0",
};

function sshConnection(now = { at: 1_000 }) {
  const remote: string[] = [];
  const local: string[] = [];
  const readFile = connectionFileReader({
    now: () => now.at,
    sshHost: (connectionId) => (connectionId === "mac" ? "me@mac" : undefined),
    readLocal: async (root, path) => {
      local.push(`${root}|${path}`);
      throw new Error("not on this host");
    },
    readRemote: async (host, root, path) => {
      remote.push(`${host}:${root}|${path}`);
      // As downloadRemoteFile: a relative path stays under the root.
      const target = `${root}/${path}`;
      if (!target.startsWith(`${root}/`) || target.includes("/../"))
        throw new Error("outside the root");
      const text = MAC_FILES[target];
      if (text === undefined) throw new Error("no such file");
      return {
        body: Buffer.from(text),
        size: Buffer.byteLength(text),
        contentType: "application/octet-stream",
      };
    },
  });
  const pages = createRenderedPages({ now: () => now.at, readFile });
  return { pages, readFile, remote, local };
}

describe("files of a connection over SSH", () => {
  test("a page outside any checkout is served with its relative resources", async () => {
    const { pages, remote, local } = sshConnection();
    // Not in a Git checkout on the Mac: the page's directory is the root.
    const place = await renderedFileTarget(async () => {
      throw new Error("not inside a Git repository");
    }, "/Users/me/logs/docs/build/index.html");
    expect(place).toEqual({
      root: "/Users/me/logs/docs/build",
      target: { kind: "rendered", path: "index.html" },
    });
    const address = renderedAddress({
      target: place.target as { path: string },
      root: place.root,
      sites: [],
    });
    expect(address.mode).toBe("static");
    const token = pages.mint({
      connectionId: "mac",
      mode: address.mode,
      source: address.source,
    });
    const page = (await get(pages, `/rendered/${token}/${address.rest}`))!;
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toStartWith(
      "sandbox allow-scripts;",
    );
    expect(await page.text()).toContain('href="css/site.css"');
    const css = (await get(pages, `/rendered/${token}/css/site.css`))!;
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe("body{color:blue}");
    // Another page of the site, and its style sheet one level up.
    expect((await get(pages, `/rendered/${token}/sub/page.html`))!.status).toBe(
      200,
    );
    expect(remote).toEqual([
      "me@mac:/Users/me/logs/docs/build|index.html",
      "me@mac:/Users/me/logs/docs/build|css/site.css",
      "me@mac:/Users/me/logs/docs/build|sub/page.html",
    ]);
    expect(local).toEqual([]);
  });

  test("escapes are refused before anything is read", async () => {
    const { pages, readFile, remote } = sshConnection();
    const token = pages.mint({
      connectionId: "mac",
      mode: "site",
      source: { kind: "files", root: "/Users/me/logs/docs/build" },
    });
    for (const path of [
      "%2e%2e/secret.txt",
      "sub/%2e%2e/%2e%2e/secret.txt",
      "a%2f..%2f..%2fsecret.txt",
      "..%2fsecret.txt",
      "%2fetc%2fpasswd",
      "/etc/passwd",
      "sub%5c..%5c..%5csecret.txt",
    ]) {
      const response = (await get(pages, `/rendered/${token}/${path}`))!;
      expect([400, 404]).toContain(response.status);
      const body = await response.text();
      expect(body).not.toContain("not served");
      expect(body).not.toContain("root:x");
    }
    for (const path of ["../secret.txt", "/etc/passwd", "a/./b", "a//b", ""])
      await expect(
        readFile("mac", "/Users/me/logs/docs/build", path),
      ).rejects.toThrow("invalid path");
    await expect(readFile("mac", "relative", "index.html")).rejects.toThrow(
      "invalid path",
    );
    expect(remote).toEqual([]);
  });

  test("a token is its connection's: the same path elsewhere is another page", async () => {
    const { pages, remote, local } = sshConnection();
    const source = {
      kind: "files",
      root: "/Users/me/logs/docs/build",
    } as const;
    const mac = pages.mint({ connectionId: "mac", mode: "static", source });
    const here = pages.mint({ connectionId: "local", mode: "static", source });
    expect(mac).not.toBe(here);
    expect((await get(pages, `/rendered/${here}/index.html`))!.status).toBe(
      404,
    );
    expect(local).toEqual(["/Users/me/logs/docs/build|index.html"]);
    expect(remote).toEqual([]);
  });

  test("a remote file is kept a few seconds, small ones only", async () => {
    const now = { at: 1_000 };
    const reads: string[] = [];
    const big = "x".repeat(64);
    const readFile = connectionFileReader({
      now: () => now.at,
      cacheMs: 1_000,
      cacheFileBytes: 32,
      sshHost: (id) => (id === "mac" || id === "other" ? "mac" : undefined),
      readLocal: async () => {
        throw new Error("local");
      },
      readRemote: async (_host, root, path) => {
        reads.push(`${root}|${path}`);
        const text = path === "big.js" ? big : `${root}/${path}`;
        return {
          body: Buffer.from(text),
          size: text.length,
          contentType: "application/octet-stream",
        };
      },
    });
    const text = async (file: Promise<RenderedFile>) =>
      new Response((await file).body).text();
    expect(await text(readFile("mac", "/r", "a.css"))).toBe("/r/a.css");
    expect(await text(readFile("mac", "/r", "a.css"))).toBe("/r/a.css");
    expect(reads).toEqual(["/r|a.css"]);
    // Another connection, even to the same host, reads its own.
    await readFile("other", "/r", "a.css");
    expect(reads).toHaveLength(2);
    // Too large to keep.
    expect(await text(readFile("mac", "/r", "big.js"))).toBe(big);
    await readFile("mac", "/r", "big.js");
    expect(reads.filter((read) => read === "/r|big.js")).toHaveLength(2);
    // Read again once its time is up.
    now.at += 1_000;
    await readFile("mac", "/r", "a.css");
    // mac, other, then mac again.
    expect(reads.filter((read) => read === "/r|a.css")).toHaveLength(3);
  });
});

describe("a listed directory's site root", () => {
  const got = async (...args: Parameters<typeof get>) => (await get(...args))!;
  // gst-docs is built for a site rooted at gst-docs/, and the folder
  // listed is gst-docs/documentation/: its links are /documentation/...
  const TREE: Record<string, string> = {
    "/home/me/build/gst-docs/documentation/index.html":
      '<a href="/documentation/libs.html">libs</a><link rel="stylesheet" href="/assets/s.css">',
    "/home/me/build/gst-docs/documentation/libs.html":
      '<a href="gst.html">gst</a>',
    "/home/me/build/gst-docs/documentation/gst.html": "<p>gst</p>",
    "/home/me/build/gst-docs/documentation/start.html":
      '<head></head><a href="/documentation/installing/index.html">installing</a>',
    "/home/me/build/gst-docs/documentation/installing/index.html":
      '<head></head><a href="on-linux.html">linux</a><a href=/documentation/installing/on-mac.html>mac</a>',
    "/home/me/build/gst-docs/documentation/installing/on-linux.html":
      "<p>linux</p>",
    "/home/me/build/gst-docs/documentation/installing/on-mac.html":
      "<p>mac</p>",
    "/home/me/build/gst-docs/assets/s.css": "body{}",
    "/home/me/secret.txt": "key",
  };
  const SITE = "/home/me/build/gst-docs/documentation/";

  function sitePages() {
    const reads: string[] = [];
    const finds: string[] = [];
    const exists = async (path: string) => path in TREE;
    const finder = connectionRootFinder({
      sshHost: () => null,
      home: "/home/me",
      exists,
      runRemote: async () => ({ code: 44, stdout: "" }),
      shQuote: (value) => `'${value}'`,
    });
    const pages = createRenderedPages({
      readFile: async (_connection, root, path) => {
        reads.push(`${root}|${path}`);
        const text = TREE[`${root.replace(/\/+$/, "")}/${path}`];
        if (text === undefined) throw new Error("no such file");
        return {
          body: text,
          size: text.length,
          contentType: "application/octet-stream",
        };
      },
      findRoot: async (connection, from, path) => {
        finds.push(`${from}|${path}`);
        return finder(connection, from, path);
      },
    });
    const open = (rootOf?: Parameters<typeof renderedAddress>[0]["rootOf"]) => {
      const address = renderedAddress({
        target: { path: "build/gst-docs/documentation/index.html" },
        root: "/home/me",
        sites: [SITE],
        rootOf:
          rootOf ??
          ((site) => {
            const found = pages.siteRoot("c1", site);
            return found ? { root: found, explicit: false } : undefined;
          }),
      });
      const token = pages.mint({
        connectionId: "c1",
        mode: address.mode,
        source: address.source,
      });
      return { address, token };
    };
    return { pages, reads, finds, open };
  }

  test("is found above the listed folder from a root-absolute link, then kept", async () => {
    const { pages, finds, open } = sitePages();
    const { address, token } = open();
    expect(address.source).toMatchObject({
      root: SITE.slice(0, -1),
      walk: true,
    });
    const page = await (
      await got(pages, `/rendered/${token}/index.html`)
    ).text();
    // Root-absolute links say they are, so a miss can look above.
    expect(page).toContain(
      `href="/rendered/${token}/.roamgate-root/documentation/libs.html"`,
    );
    const moved = await got(
      pages,
      `/rendered/${token}/.roamgate-root/documentation/libs.html?x=1`,
    );
    expect(moved.status).toBe(307);
    const location = moved.headers.get("location")!;
    const [, next] =
      /^\/rendered\/([0-9a-f]{32})\/documentation\/libs\.html\?x=1$/.exec(
        location,
      )!;
    expect(next).not.toBe(token);
    expect(finds).toEqual([`${SITE.slice(0, -1)}|documentation/libs.html`]);
    expect(pages.siteRoot("c1", SITE)).toBe("/home/me/build/gst-docs");
    expect(pages.siteRoot("c2", SITE)).toBeUndefined();
    // Its relative links work from there, and nothing marks them.
    const libs = await got(pages, `/rendered/${next}/documentation/libs.html`);
    expect(libs.status).toBe(200);
    expect(
      await (
        await got(pages, `/rendered/${next}/documentation/gst.html`)
      ).text(),
    ).toContain("gst");
    expect(
      await (await got(pages, `/rendered/${next}/assets/s.css`)).text(),
    ).toBe("body{}");
    // The next opening starts at the root found: no looking again.
    const again = open();
    expect(again.address.source).toEqual({
      kind: "files",
      root: "/home/me/build/gst-docs",
      site: SITE,
    });
    expect(again.address.rest).toBe("documentation/index.html");
    const other = await got(
      pages,
      `/rendered/${token}/.roamgate-root/assets/s.css`,
    );
    // A style sheet is served from the root at once, not redirected.
    expect(other.status).toBe(200);
    expect(other.headers.get("content-type")).toStartWith("text/css");
    expect(other.headers.get("location")).toBeNull();
    expect(await other.text()).toBe("body{}");
    expect(finds).toHaveLength(1);
  });

  test("a root-absolute style sheet above the folder is served, a page redirects", async () => {
    const { pages, open } = sitePages();
    const { token } = open();
    const css = await got(
      pages,
      `/rendered/${token}/.roamgate-root/assets/s.css`,
    );
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toStartWith("text/css");
    expect(css.headers.get("location")).toBeNull();
    expect(await css.text()).toBe("body{}");
    const page = await got(
      pages,
      `/rendered/${token}/.roamgate-root/documentation/libs.html`,
    );
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toMatch(
      /^\/rendered\/[0-9a-f]{32}\/documentation\/libs\.html$/,
    );
  });

  test("clicking through the site stays under a token, never Roamgate's root", async () => {
    const { pages, open } = sitePages();
    const { token } = open();
    // index -> /documentation/installing/index.html, as written by the server.
    const start = await (
      await got(pages, `/rendered/${token}/start.html`)
    ).text();
    const link = `/rendered/${token}/.roamgate-root/documentation/installing/index.html`;
    expect(start).toContain(`href="${link}"`);
    // Its script sends what it builds the same way.
    expect(start).toContain(
      JSON.stringify({ base: "/", to: `/rendered/${token}/.roamgate-root/` }),
    );
    const moved = await got(pages, link);
    expect(moved.status).toBe(307);
    const location = moved.headers.get("location")!;
    const [, next] =
      /^\/rendered\/([0-9a-f]{32})\/documentation\/installing\/index\.html$/.exec(
        location,
      )!;
    const installing = await got(pages, location);
    expect(installing.status).toBe(200);
    const html = await installing.text();
    // After the root's redirect: its root-absolute links are under the
    // new token's root, plainly, and so is what its script builds.
    expect(html).toContain(
      `href="/rendered/${next}/documentation/installing/on-mac.html"`,
    );
    expect(html).toContain(
      JSON.stringify({ base: "/", to: `/rendered/${next}/` }),
    );
    expect(
      await (
        await got(
          pages,
          `/rendered/${next}/documentation/installing/on-mac.html`,
        )
      ).text(),
    ).toEndWith("<p>mac</p>");
    // A relative link resolves under the same token.
    const relative = new URL("on-linux.html", `https://x${location}`).pathname;
    expect(relative).toBe(
      `/rendered/${next}/documentation/installing/on-linux.html`,
    );
    expect(await (await got(pages, relative)).text()).toEndWith("<p>linux</p>");
  });

  test("a frame's request off its token gets a page saying so, never the login page", async () => {
    const frame = {
      "sec-fetch-site": "cross-site",
      "sec-fetch-dest": "iframe",
      "sec-fetch-mode": "navigate",
    };
    const at = (path: string, headers: Record<string, string>) => {
      const url = new URL(`https://roamgate.example${path}`);
      return renderedStray(new Request(url, { headers }), url);
    };
    const stray = at("/documentation/installing/on-linux.html?a=<b>", frame)!;
    expect(stray.status).toBe(404);
    const csp = stray.headers.get("content-security-policy")!;
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(stray.headers.get("content-type")).toStartWith("text/html");
    const page = await stray.text();
    expect(page).toContain("not part of this site");
    expect(page).not.toContain("<b>");
    expect(page).not.toMatch(/password|login/i);
    // It hands the path to the parent, which knows the token.
    expect(page).toContain('type:"stray"');
    // A fetch from the page's opaque origin: not found.
    const fetched = at("/api/health", {
      "sec-fetch-site": "cross-site",
      "sec-fetch-dest": "empty",
      origin: "null",
    })!;
    expect(fetched.status).toBe(404);
    expect(await fetched.text()).toContain("not part of this site");
    // Roamgate's own requests, a link to Roamgate from elsewhere, and the
    // pages themselves go on to the gate or the pages.
    expect(at("/login", {})).toBeNull();
    expect(
      at("/", { "sec-fetch-site": "same-origin", "sec-fetch-dest": "iframe" }),
    ).toBeNull();
    expect(
      at("/", { "sec-fetch-site": "cross-site", "sec-fetch-dest": "document" }),
    ).toBeNull();
    expect(at("/rendered/x/a.html", frame)).toBeNull();
  });

  test("a root-absolute link found in the folder itself stays there", async () => {
    const { pages, finds, open } = sitePages();
    const { token } = open();
    const css = await got(pages, `/rendered/${token}/.roamgate-root/gst.html`);
    // A page: at its plain address under the same token.
    expect(css.status).toBe(307);
    expect(css.headers.get("location")).toBe(`/rendered/${token}/gst.html`);
    expect(finds).toEqual([]);
  });

  test("an explicit root wins, and nothing is looked for", async () => {
    const { pages, finds, open } = sitePages();
    const { address, token } = open(() => ({
      root: "/home/me/build/gst-docs/",
      explicit: true,
    }));
    expect(address.source).toEqual({
      kind: "files",
      root: "/home/me/build/gst-docs",
      site: SITE,
    });
    expect(address.rest).toBe("documentation/index.html");
    const page = await (
      await got(pages, `/rendered/${token}/documentation/index.html`)
    ).text();
    expect(page).toContain(`href="/rendered/${token}/documentation/libs.html"`);
    expect(
      (await got(pages, `/rendered/${token}/documentation/missing.html`))
        .status,
    ).toBe(404);
    expect(finds).toEqual([]);
    // A root that does not contain the site is not one.
    const { address: ignored } = open(() => ({
      root: "/elsewhere/",
      explicit: true,
    }));
    expect(ignored.source).toMatchObject({
      root: SITE.slice(0, -1),
      walk: true,
    });
  });

  test("never escapes: no step up, nothing at or above home, not twice above", async () => {
    const { pages, reads, finds, open } = sitePages();
    const { token } = open();
    for (const path of [
      ".roamgate-root/../secret.txt",
      ".roamgate-root/%2e%2e/secret.txt",
      ".roamgate-root/a/..%2f..%2fsecret.txt",
      ".roamgate-root/..%2f..%2f..%2fsecret.txt",
    ]) {
      const response = await got(pages, `/rendered/${token}/${path}`);
      expect([400, 404]).toContain(response.status);
    }
    expect(finds).toEqual([]);
    expect(reads.some((read) => read.startsWith("/home/me|"))).toBeFalse();
    // secret.txt is in home: home is never a site's root.
    expect(
      (await got(pages, `/rendered/${token}/.roamgate-root/secret.txt`)).status,
    ).toBe(404);
    expect(finds).toEqual([`${SITE.slice(0, -1)}|secret.txt`]);
    // Missed once: not looked for again for a while.
    await got(pages, `/rendered/${token}/.roamgate-root/secret.txt`);
    expect(finds).toHaveLength(1);
    // Once a root is found, nothing above it is looked for or served.
    await got(
      pages,
      `/rendered/${token}/.roamgate-root/documentation/libs.html`,
    );
    const next = pages.siteRoot("c1", SITE)!;
    expect(next).toBe("/home/me/build/gst-docs");
    const { token: rooted } = open();
    const page = await (
      await got(pages, `/rendered/${rooted}/documentation/index.html`)
    ).text();
    expect(page).not.toContain(".roamgate-root");
    expect(
      (await got(pages, `/rendered/${rooted}/..%2fsecret.txt`)).status,
    ).toBe(400);
    expect(reads.some((read) => read.startsWith("/home/me|"))).toBeFalse();
  });

  test("a finder's answer that is not above the folder is refused", async () => {
    const pages = createRenderedPages({
      readFile: async () => {
        throw new Error("no such file");
      },
      findRoot: async () => "/elsewhere",
    });
    const token = pages.mint({
      connectionId: "c1",
      mode: "site",
      source: { kind: "files", root: "/a/b/c", site: "/a/b/c/", walk: true },
    });
    expect(
      (await got(pages, `/rendered/${token}/.roamgate-root/x.html`)).status,
    ).toBe(404);
    expect(pages.siteRoot("c1", "/a/b/c/")).toBeUndefined();
  });

  test("candidates stop below home and the filesystem's root", () => {
    expect(siteRootCandidates("/home/me/a/b/c", "/home/me")).toEqual([
      "/home/me/a/b",
      "/home/me/a",
    ]);
    expect(siteRootCandidates("/srv/www/docs/", "/home/me")).toEqual([
      "/srv/www",
      "/srv",
    ]);
    expect(siteRootCandidates(`/x${"/d".repeat(20)}`, "/home/me")).toHaveLength(
      SITE_ROOT_MAX_LEVELS,
    );
  });

  test("the host's script tries the same directories", async () => {
    const dir = (await import("node:fs")).mkdtempSync("/tmp/rg-site-root-");
    const fs = await import("node:fs");
    try {
      fs.mkdirSync(`${dir}/home/site/docs/deep`, { recursive: true });
      fs.mkdirSync(`${dir}/home/site/assets`, { recursive: true });
      fs.writeFileSync(`${dir}/home/site/assets/a.css`, "");
      fs.writeFileSync(`${dir}/home/top.css`, "");
      const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
      const run = (path: string) =>
        Bun.spawnSync(
          [
            "sh",
            "-c",
            siteRootScript(`${dir}/home/site/docs/deep/`, path, quote),
          ],
          { env: { HOME: `${dir}/home`, PATH: process.env.PATH ?? "" } },
        );
      const found = run("assets/a.css");
      expect(found.exitCode).toBe(0);
      expect(found.stdout.toString()).toBe(`${dir}/home/site\n`);
      // At home: never.
      expect(run("top.css").exitCode).toBe(44);
      expect(run("nowhere.css").exitCode).toBe(44);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a listed site's localStorage", () => {
  const PAGE =
    "<!doctype html><html><head><title>t</title></head><body>x</body></html>";
  function storagePages(storage = createSiteStorage()) {
    const pages = createRenderedPages({
      storage,
      readFile: async (): Promise<RenderedFile> => ({
        body: PAGE,
        size: PAGE.length,
        contentType: "text/html",
      }),
    });
    return { pages, storage };
  }
  const mintFiles = (
    pages: ReturnType<typeof storagePages>["pages"],
    mode: "static" | "site",
    site?: string,
  ) =>
    pages.mint({
      connectionId: "c",
      mode,
      source: { kind: "files", root: "/site", ...(site ? { site } : {}) },
    });
  const html = async (
    pages: ReturnType<typeof storagePages>["pages"],
    token: string,
  ) => {
    const url = new URL(`https://roamgate.example/rendered/${token}/`);
    const response = await pages.handle(new Request(url), url);
    return response!.text();
  };

  test("is written into the pages of the listed site, with its own items only", async () => {
    const { pages, storage } = storagePages();
    storage.write("/site/", { op: "set", key: "pref-theme", value: "dark" });
    storage.write("/other/", { op: "set", key: "secret", value: "nope" });
    const text = await html(pages, mintFiles(pages, "site", "/site/"));
    expect(text).toContain('{"pref-theme":"dark"}');
    expect(text).not.toContain("secret");
    expect(text).not.toContain("nope");
  });

  test("is not given to a static page, a page with scripts on once, or without storage", async () => {
    const { pages, storage } = storagePages();
    storage.write("/site/", { op: "set", key: "k", value: "VALUE" });
    expect(
      await html(pages, mintFiles(pages, "static", "/site/")),
    ).not.toContain("VALUE");
    // Scripts turned on for a file, its directory not listed: no site.
    const once = await html(pages, mintFiles(pages, "site"));
    expect(once).not.toContain("VALUE");
    expect(once).toContain("null, {");
    const plain = createRenderedPages({
      readFile: async () => ({
        body: PAGE,
        size: PAGE.length,
        contentType: "text/html",
      }),
    });
    const token = plain.mint({
      connectionId: "c",
      mode: "site",
      source: { kind: "files", root: "/site", site: "/site/" },
    });
    expect(await html(plain as never, token)).not.toContain("VALUE");
  });

  test("a value cannot close the script", async () => {
    const { pages, storage } = storagePages();
    const evil = "</script><script>alert(1)</script>\u2028<!--";
    storage.write("/site/", { op: "set", key: "</script>", value: evil });
    const text = await html(pages, mintFiles(pages, "site", "/site/"));
    expect(text.match(/<\/script>/g)?.length).toBe(1);
    expect(text).not.toContain("alert(1)</script>");
    expect(text).not.toContain("\u2028");
    expect(text).toContain("\\u003c/script>");
  });

  test("a url site is keyed by its listed entry", async () => {
    const storage = createSiteStorage();
    storage.write("http://blog.test/", { op: "set", key: "a", value: "b" });
    const pages = createRenderedPages({
      storage,
      readFile: async () => {
        throw new Error("no files");
      },
      fetch: async () =>
        new Response(PAGE, { headers: { "content-type": "text/html" } }),
    });
    const token = pages.mint({
      connectionId: "c",
      mode: "site",
      source: {
        kind: "url",
        base: "http://blog.test/",
        site: "http://blog.test/",
      },
    });
    expect(await html(pages as never, token)).toContain('{"a":"b"}');
  });

  test("writes go to the token's site only, from its connection", () => {
    const { pages, storage } = storagePages();
    const token = mintFiles(pages, "site", "/site/");
    expect(
      pages.writeStorage("c", token, { op: "set", key: "k", value: "v" }),
    ).toBe(true);
    expect(storage.get("/site/")).toEqual({ k: "v" });
    expect(storage.get("/other/")).toEqual({});
    // Another connection, an unknown token, a static or unlisted page.
    expect(
      pages.writeStorage("d", token, { op: "set", key: "x", value: "y" }),
    ).toBe(false);
    expect(
      pages.writeStorage("c", "0".repeat(32), {
        op: "set",
        key: "x",
        value: "y",
      }),
    ).toBe(false);
    expect(
      pages.writeStorage("c", mintFiles(pages, "static", "/site/"), {
        op: "set",
        key: "x",
        value: "y",
      }),
    ).toBe(false);
    expect(
      pages.writeStorage("c", mintFiles(pages, "site"), {
        op: "set",
        key: "x",
        value: "y",
      }),
    ).toBe(false);
    pages.writeStorage("c", token, { op: "remove", key: "k" });
    expect(storage.get("/site/")).toEqual({});
  });

  test("is bounded: too many keys, too many characters", () => {
    const storage = createSiteStorage();
    for (let i = 0; i < RENDERED_STORAGE_MAX_KEYS; i += 1)
      storage.write("/s/", { op: "set", key: `k${i}`, value: "v" });
    expect(() =>
      storage.write("/s/", { op: "set", key: "more", value: "v" }),
    ).toThrow(StorageQuotaError);
    // An existing key can still change, and room comes back with a removal.
    storage.write("/s/", { op: "set", key: "k0", value: "w" });
    storage.write("/s/", { op: "remove", key: "k1" });
    storage.write("/s/", { op: "set", key: "more", value: "v" });
    const big = createSiteStorage();
    big.write("/s/", {
      op: "set",
      key: "a",
      value: "x".repeat(RENDERED_STORAGE_MAX_CHARS - 10),
    });
    expect(() =>
      big.write("/s/", { op: "set", key: "b", value: "y".repeat(20) }),
    ).toThrow(StorageQuotaError);
    big.clear("/s/");
    expect(big.get("/s/")).toEqual({});
  });

  test("survives a restart", async () => {
    const dir = (await import("node:fs")).mkdtempSync("/tmp/rg-rstore-");
    const file = `${dir}/rendered-storage.json`;
    try {
      const first = createSiteStorage(file);
      first.write("/s/", { op: "set", key: "pref-theme", value: "dark" });
      await first.flush();
      expect(createSiteStorage(file).get("/s/")).toEqual({
        "pref-theme": "dark",
      });
    } finally {
      (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the helper's storage shim", () => {
  async function page(seed: Record<string, string> | null) {
    const { Window } = await import("happy-dom");
    const win = new Window({
      settings: {
        disableJavaScriptEvaluation: true,
        disableJavaScriptFileLoading: true,
        disableCSSFileLoading: true,
      },
    });
    const posted: Array<Record<string, unknown>> = [];
    Object.defineProperty(win, "parent", {
      value: { postMessage: (m: Record<string, unknown>) => posted.push(m) },
    });
    new Function(
      "window",
      `with (window) { ${renderedHelperSource("/p/", undefined, seed)} }`,
    )(win);
    const store = (name: "localStorage" | "sessionStorage") =>
      (win as unknown as Record<string, Storage>)[name]!;
    return { win, posted, store };
  }
  const writes = (posted: Array<Record<string, unknown>>) =>
    posted.filter((m) => m.type === "storage");

  test("a synchronous script finds the seeded items", async () => {
    const { store } = await page({ "pref-theme": "dark" });
    expect(store("localStorage").getItem("pref-theme")).toBe("dark");
    expect(store("localStorage").getItem("none")).toBeNull();
    expect(store("localStorage").length).toBe(1);
    expect(store("localStorage").key(0)).toBe("pref-theme");
    expect(store("localStorage").key(1)).toBeNull();
  });

  test("setItem, removeItem and clear post to the parent", async () => {
    const { store, posted } = await page({ a: "1" });
    const local = store("localStorage");
    local.setItem("b", "2");
    local.setItem("b", "2");
    local.removeItem("a");
    local.removeItem("a");
    local.clear();
    local.clear();
    expect(writes(posted)).toEqual([
      {
        roamgate: "rendered",
        type: "storage",
        op: "set",
        key: "b",
        value: "2",
      },
      { roamgate: "rendered", type: "storage", op: "remove", key: "a" },
      { roamgate: "rendered", type: "storage", op: "clear" },
    ]);
    expect(local.length).toBe(0);
  });

  test("values are strings, and properties act as items", async () => {
    const { store, posted } = await page({ a: "1" });
    const local = store("localStorage") as unknown as Record<string, unknown>;
    expect(local.a).toBe("1");
    expect(local.missing).toBeUndefined();
    local.n = 5;
    expect(local.n).toBe("5");
    expect((local as unknown as Storage).getItem("n")).toBe("5");
    expect("n" in local).toBe(true);
    expect(Object.keys(local)).toEqual(["a", "n"]);
    delete local.a;
    expect(local.a).toBeUndefined();
    expect(writes(posted).map((m) => m.op)).toEqual(["set", "remove"]);
  });

  test("a write over the quota is refused", async () => {
    const { store, posted } = await page({});
    const local = store("localStorage");
    expect(() =>
      local.setItem("big", "x".repeat(RENDERED_STORAGE_MAX_CHARS)),
    ).toThrow();
    try {
      local.setItem("big", "x".repeat(RENDERED_STORAGE_MAX_CHARS));
    } catch (error) {
      expect((error as Error).name).toBe("QuotaExceededError");
    }
    for (let i = 0; i < RENDERED_STORAGE_MAX_KEYS; i += 1)
      local.setItem(`k${i}`, "v");
    expect(() => local.setItem("extra", "v")).toThrow();
    expect(local.getItem("extra")).toBeNull();
    expect(writes(posted).length).toBe(RENDERED_STORAGE_MAX_KEYS);
  });

  test("sessionStorage lives in the page and posts nothing", async () => {
    const { store, posted } = await page({ a: "1" });
    const session = store("sessionStorage");
    expect(session.getItem("a")).toBeNull();
    session.setItem("s", "1");
    expect(session.getItem("s")).toBe("1");
    expect(store("localStorage").getItem("s")).toBeNull();
    expect(writes(posted)).toEqual([]);
  });

  test("a page without storage keeps what the browser gives", async () => {
    const { win } = await page(null);
    const desc = Object.getOwnPropertyDescriptor(win, "localStorage");
    expect(desc?.get?.toString() ?? "").not.toContain("storage");
    expect(renderedHelperSource("/p/")).toContain("null, {");
  });
});
