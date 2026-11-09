import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { build } from "vite";

/** The stylesheets as Vite builds them, in one sheet. */
async function builtCss(files: string[]): Promise<string> {
  const entry = files
    .map((file) => `@import ${JSON.stringify(file)};`)
    .join("\n");
  const result = await build({
    configFile: fileURLToPath(new URL("../../vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "silent",
    plugins: [
      {
        name: "reading-column-entry",
        resolveId: (id) => (id === "reading-column.css" ? id : null),
        load: (id) => (id === "reading-column.css" ? entry : null),
      },
    ],
    build: {
      write: false,
      emptyOutDir: false,
      manifest: false,
      rolldownOptions: { input: "reading-column.css" },
    },
  });
  if (Array.isArray(result) || !("output" in result)) {
    throw new Error("Expected a single stylesheet build");
  }
  const css = result.output.find((file) => file.fileName.endsWith(".css"));
  if (!css || css.type !== "asset") throw new Error("Missing built stylesheet");
  return String(css.source);
}

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

test("a rendered Markdown file reads in the chat's column, HTML pages keep their width", async () => {
  const css = await builtCss([
    here("../styles/tokens.css"),
    here("./AgentHistoryChat.css"),
    here("./markdown.css"),
    here("./FilePreviewContent.css"),
  ]);
  const browser = new JSDOM(`<html><body>
    <div class="agent-history-chat"><div class="agent-history-chat-content" id="chat"></div></div>
    <div class="file-preview-file-content">
      <article class="file-preview-markdown file-preview-reading" id="file">
        <iframe class="md-html-frame" id="block"></iframe>
      </article>
      <article class="file-preview-markdown" id="message"></article>
      <iframe class="file-preview-html" id="page"></iframe>
    </div>
  </body></html>`);
  try {
    const { document, getComputedStyle } = browser.window;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const rules = [...(style.sheet?.cssRules ?? [])].filter(
      (rule): rule is CSSStyleRule => "selectorText" in rule,
    );
    /** Every declaration that applies to the element, as written. */
    const declared = (id: string) => {
      const element = document.getElementById(id)!;
      return rules
        .filter((rule) => {
          try {
            return element.matches(rule.selectorText);
          } catch {
            return false; // a pseudo-element or ::highlight: no element's
          }
        })
        .map((rule) => rule.style.cssText)
        .join(" ");
    };
    const column = "var(--reading-column-width)";

    expect(
      getComputedStyle(document.documentElement)
        .getPropertyValue("--reading-column-width")
        .trim(),
    ).toBe("820px");
    // The chat's column is the token, not a width of its own.
    expect(declared("chat")).toContain(`max-width: ${column}`);
    // The file's margins centre the column in the scroller.
    expect(declared("file")).toMatch(
      /padding-inline: calc\(max\(0px, \(100% - var\(--reading-column-width\)\) \/ 2\) \+ 22px\)/,
    );
    // A chat message's Markdown, a page and an HTML block keep their layout.
    expect(declared("message")).not.toContain(column);
    expect(declared("page")).not.toContain(column);
    expect(declared("block")).not.toContain(column);
  } finally {
    browser.window.close();
  }
});

test("the Files preview gives its Markdown, and only it, the reading column", () => {
  const source = readFileSync(here("./FilePreviewContent.tsx"), "utf8");
  const uses = source.match(/file-preview-reading/g) ?? [];
  expect(uses).toHaveLength(1);
  expect(source).toMatch(/<MarkdownPreview\s+className="file-preview-reading"/);
  // The preview's pages, PDFs and code keep the whole width.
  expect(readFileSync(here("./FilePreviewContent.css"), "utf8")).not.toContain(
    "reading-column",
  );
});
