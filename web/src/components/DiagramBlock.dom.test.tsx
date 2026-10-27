import { expect, test } from "bun:test";

if (process.env.ROAMGATE_DIAGRAM_DOM_TEST !== "1") {
  test("diagrams in comments and chats in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_DIAGRAM_DOM_TEST: "1" },
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
  // jsdom: DOMPurify's SVG profile (the Mermaid path) needs it.
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const browser = dom.window;
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    Text: browser.Text,
    DOMParser: browser.DOMParser,
    XMLSerializer: browser.XMLSerializer,
    NodeFilter: browser.NodeFilter,
    MutationObserver: browser.MutationObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    getSelection: browser.getSelection.bind(browser),
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
      clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });

  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NoteBody } = await import("./ReviewNoteBody");
  const { MarkdownPreview } = await import("./markdown");
  const { inlineDiagramScale } = await import("./DiagramBlock");
  const { svgImage } = await import("../svgImage");

  const decode = (url: string) =>
    decodeURIComponent(url.slice(url.indexOf(",") + 1));

  test("SVG written for a page gets its namespaces and a size", () => {
    const image = svgImage(
      '<svg viewBox="0 0 200 100"><use xlink:href="#a"/>&nbsp;</svg>',
    );
    if (!image.ok) throw new Error(image.error);
    expect([image.width, image.height]).toEqual([200, 100]);
    const markup = decode(image.url);
    expect(markup).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(markup).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(markup).toContain('width="200"');
    expect(image.themed).toBe(false);
    // One side given: the other from the viewBox's ratio.
    const half = svgImage('<svg width="50" viewBox="0 0 200 100"/>');
    expect(half.ok && [half.width, half.height]).toEqual([50, 25]);
    // No size at all: a viewBox is added so that it scales.
    const bare = svgImage("<svg><rect/></svg>");
    expect(bare.ok && decode(bare.url)).toContain('viewBox="0 0 300 150"');
  });

  test("SVG that is not SVG is refused", () => {
    expect(svgImage("<svg><g></svg>").ok).toBe(false);
    expect(svgImage("<html/>").ok).toBe(false);
  });

  test("a diagram fits a phone's width, elsewhere it stays readable", () => {
    const wide = { width: 800, height: 450 };
    // A phone: to its width, however small.
    expect(inlineDiagramScale(wide, 320, true)).toBe(0.4);
    // A comment: to its width, but not below 0.8 (it scrolls across).
    expect(inlineDiagramScale(wide, 680)).toBe(0.85);
    expect(inlineDiagramScale(wide, 280)).toBe(0.8);
    expect(inlineDiagramScale({ width: 2000, height: 300 }, 700)).toBe(0.8);
    // Never above its size; a tall one down to 640 px high.
    expect(inlineDiagramScale({ width: 200, height: 100 }, 900)).toBe(1);
    expect(inlineDiagramScale({ width: 200, height: 100 }, 900, true)).toBe(1);
    expect(inlineDiagramScale({ width: 400, height: 1280 }, 900)).toBe(0.8);
    expect(inlineDiagramScale({ width: 400, height: 720 }, 900)).toBeCloseTo(
      0.889,
      3,
    );
  });

  /** The user's comment: four sequence diagrams between paragraphs. */
  const SEQUENCE = [
    "sequenceDiagram",
    "    participant Sink",
    "    participant Posts",
    "    participant Loop",
    "    Sink->>Posts: 1. EOS",
    "    Loop->>Posts: read in order",
    "    Posts-->>Loop: 1. EOS (run still on, counts)",
    "    Note over Loop: reply to set_state",
  ].join("\n");
  const fence = (lang: string, code: string) =>
    `\`\`\`${lang}\n${code}\n\`\`\``;

  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  /** The drawn diagram's SVG, not a button's icon. */
  const DIAGRAM_SVG = ".diagram-block-canvas .mermaid-svg > svg";
  async function until(check: () => boolean, what: string) {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (check()) return;
      await act(settle);
    }
    throw new Error(
      `Timed out waiting for ${what}: ${(document.querySelector(".diagram-block-view")?.innerHTML ?? document.body.innerHTML).slice(0, 1500)}`,
    );
  }
  function mount() {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    return {
      container,
      render: (node: React.ReactNode) => act(async () => root.render(node)),
      unmount: async () => {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }

  test("a mermaid block in a comment becomes an SVG diagram", async () => {
    const view = mount();
    await view.render(
      <NoteBody
        text={`**d. (recommended)** one channel\n\n${fence("mermaid", SEQUENCE)}\n\nEverything goes through one channel.`}
      />,
    );
    await until(
      () => !!view.container.querySelector(DIAGRAM_SVG),
      "the diagram",
    );
    const svg = view.container.querySelector(DIAGRAM_SVG)!;
    expect(svg.textContent).toContain("Sink");
    expect(svg.textContent).toContain("read in order");
    // Drawn, not shown as code; its source is a toggle away.
    expect(view.container.querySelector(".diagram-block-source")).toBe(null);
    expect(view.container.querySelector(".note-code")).toBe(null);
    const toggle = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Source",
    )!;
    await act(async () => toggle.click());
    expect(
      view.container.querySelector(".diagram-block-source")?.textContent,
    ).toBe(SEQUENCE);
    // The diagram is one part one can comment on, the paragraphs others.
    expect(view.container.querySelectorAll("[data-part]").length).toBe(3);
    await view.unmount();
  });

  test("a diagram that cannot be drawn shows its source and why", async () => {
    const view = mount();
    const code = "sequenceDiagramm\n    A->>B: typo in the type";
    await view.render(<NoteBody text={fence("mermaid", code)} />);
    await until(
      () => !!view.container.querySelector(".diagram-block-error"),
      "the error note",
    );
    expect(
      view.container.querySelector(".diagram-block-error")?.textContent,
    ).toContain('Unknown diagram type "sequenceDiagramm"');
    expect(
      view.container.querySelector(".diagram-block-source")?.textContent,
    ).toBe(code);
    expect(view.container.querySelector(DIAGRAM_SVG)).toBe(null);
    await view.unmount();
  });

  const HOSTILE_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40">',
    "<script>window.__diagramPwned = 1</script>",
    '<rect width="120" height="40" fill="#fc0" onload="window.__diagramPwned = 2"/>',
    '<image href="https://tracker.example/pixel.png" width="1" height="1"/>',
    '<text x="10" y="25" fill="currentColor">hello</text>',
    "</svg>",
  ].join("");

  for (const [name, text] of [
    ["an ```svg block", `Here it is:\n\n${fence("svg", HOSTILE_SVG)}`],
    ["a message of SVG markup alone", HOSTILE_SVG],
  ] as const)
    test(`${name} is drawn as an image: its script never runs`, async () => {
      const view = mount();
      await view.render(<NoteBody text={text} />);
      await until(
        () => !!view.container.querySelector(".diagram-block img"),
        "the image",
      );
      const image =
        view.container.querySelector<HTMLImageElement>(".diagram-block img")!;
      expect(image.getAttribute("src")).toStartWith(
        "data:image/svg+xml;charset=utf-8,",
      );
      // Sized as it asks, its text in the theme's color.
      const markup = decodeURIComponent(
        image.getAttribute("src")!.split(",").slice(1).join(","),
      );
      expect(markup).toContain('width="120"');
      expect(markup).toMatch(/color="[^"]+"/);
      // None of its markup is in the page.
      expect(document.querySelector("script")).toBe(null);
      expect(document.querySelector("[onload]")).toBe(null);
      expect(document.querySelector("svg image")).toBe(null);
      expect(
        (globalThis as { __diagramPwned?: number }).__diagramPwned,
      ).toBeUndefined();
      await view.unmount();
    });

  test("a chat message streamed: a diagram waits for its block to close, then stays", async () => {
    const view = mount();
    const intro = "The race, step by step:\n\n";
    const half = `${intro}\`\`\`mermaid\n${SEQUENCE.split("\n").slice(0, 4).join("\n")}`;
    await view.render(<MarkdownPreview text={half} breaks />);
    await act(settle);
    // Still being written: shown as code, not drawn.
    expect(view.container.querySelector(".markdown-diagram-slot")).toBe(null);
    expect(
      view.container.querySelector("pre > code.language-mermaid"),
    ).not.toBe(null);

    const closed = `${intro}${fence("mermaid", SEQUENCE)}\n\nSo the`;
    await view.render(<MarkdownPreview text={closed} breaks />);
    await until(
      () =>
        !!view.container.querySelector(`.markdown-diagram-slot ${DIAGRAM_SVG}`),
      "the diagram",
    );
    expect(view.container.querySelector("pre > code.language-mermaid")).toBe(
      null,
    );
    const slot = view.container.querySelector(".markdown-diagram-slot")!;
    const svg = slot.querySelector(DIAGRAM_SVG)!;

    // More text streams in, and a second diagram starts: the first one is
    // the same element, not drawn again; the second is code until closed.
    await view.render(
      <MarkdownPreview
        text={`${closed} EOS counts.\n\n\`\`\`mermaid\nsequenceDiagram\n    A->>B`}
        breaks
      />,
    );
    await act(settle);
    expect(
      view.container.querySelectorAll(".markdown-diagram-slot").length,
    ).toBe(1);
    expect(view.container.querySelector(".markdown-diagram-slot")).toBe(slot);
    expect(slot.querySelector(DIAGRAM_SVG)).toBe(svg);
    expect(view.container.textContent).toContain("EOS counts.");
    expect(
      view.container.querySelector("pre > code.language-mermaid")?.textContent,
    ).toContain("A->>B");
    await view.unmount();
  });

  test("SVG markup streamed alone is code until closed, then an image", async () => {
    const view = mount();
    await view.render(
      <MarkdownPreview text={HOSTILE_SVG.slice(0, 80)} breaks />,
    );
    await act(settle);
    expect(view.container.querySelector(".markdown-diagram-slot")).toBe(null);
    expect(view.container.querySelector("pre > code.language-svg")).not.toBe(
      null,
    );
    await view.render(<MarkdownPreview text={HOSTILE_SVG} breaks />);
    await until(
      () =>
        !!view.container.querySelector(
          ".markdown-diagram-slot .diagram-block img",
        ),
      "the image",
    );
    expect(document.querySelector("script")).toBe(null);
    await view.unmount();
  });
}
