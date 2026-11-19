import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  contentMayTakeFocus,
  filePreviewContent,
  focusContentOnArrival,
  inspectorViewContent,
} from "./contentFocus";

let browser: Window | null = null;
function page(html: string) {
  browser = new Window({ url: "http://localhost/" });
  const document = browser.document as unknown as Document;
  document.body.innerHTML = html;
  return document;
}
afterEach(() => {
  void browser?.happyDOM.close();
  browser = null;
});

describe("the content a view gives the keys to", () => {
  test("a file: its page's frame, its text's editor, its rendered Markdown; nothing while it is read", () => {
    const document = page(`
      <section class="file-preview">
        <div class="file-preview-head"><button>Source</button></div>
        <div class="file-preview-file-content"></div>
      </section>`);
    const preview = document.querySelector(".file-preview")!;
    const content = preview.querySelector(".file-preview-file-content")!;
    content.innerHTML = `<span class="file-loading-spinner"></span>`;
    expect(filePreviewContent(preview)).toBeNull();
    content.innerHTML = `<iframe title="page"></iframe>`;
    expect(filePreviewContent(preview)?.tagName).toBe("IFRAME");
    content.innerHTML = `<div class="file-preview-code"><div class="cm-scroller"><div class="cm-content"></div></div></div>`;
    expect(filePreviewContent(preview)?.className).toBe("cm-content");
    content.innerHTML = `<article class="file-preview-markdown"></article>`;
    expect(filePreviewContent(preview)?.className).toBe(
      "file-preview-markdown",
    );
    content.innerHTML = `<img alt="">`;
    expect(filePreviewContent(preview)).toBe(content as HTMLElement);
  });

  test("Changes: the review's diff once drawn, its tree on a phone; Files without a file: its tree", () => {
    const document = page(`
      <aside class="workspace-inspector">
        <div class="inspector-files-resource is-hidden">
          <div class="file-row" role="treeitem" tabindex="-1">a</div>
          <div class="file-row" role="treeitem" tabindex="0">b</div>
        </div>
        <div class="inspector-changes-resource">
          <div class="workspace-inspector-navigation">
            <button class="diff-tree-row diff-tree-file">a</button>
            <button class="diff-tree-row diff-tree-file is-selected">b</button>
          </div>
          <div class="workspace-inspector-detail">
            <div class="diff-content-view"><span class="file-loading-spinner"></span></div>
          </div>
        </div>
      </aside>`);
    const host = document.querySelector("aside")!;
    const changes = () =>
      inspectorViewContent(host, "changes", { file: false });
    // Its view still loading: nothing yet.
    expect(changes()).toBeNull();
    const detail = host.querySelector(".workspace-inspector-detail")!;
    detail.innerHTML = `<section class="diff-content-view" data-review-cursor=""></section>`;
    expect(changes()?.matches("[data-review-cursor]")).toBe(true);
    // A phone's Changes without a file picked: the file picked in its tree.
    detail.setAttribute("hidden", "");
    expect(changes()?.textContent).toBe("b");
    // A hidden view gives nothing.
    expect(inspectorViewContent(host, "files", { file: false })).toBeNull();
    host.querySelector(".inspector-files-resource")!.className =
      "inspector-files-resource";
    expect(
      inspectorViewContent(host, "files", { file: false })?.textContent,
    ).toBe("b");
  });
});

describe("where the keys may be taken from", () => {
  test("the page, the inspector and a header bar's button; not typed text, a menu, a dialog or an open menu's button", () => {
    const document = page(`
      <header><button id="top">Files</button>
        <button id="open" aria-expanded="true">More</button></header>
      <div class="sidebar"><button id="side">Workspace</button></div>
      <aside id="scope"><button id="tool">Refresh</button>
        <div class="cm-content" contenteditable="true" id="editor"></div></aside>
      <input id="field"><textarea id="terminal"></textarea>
      <div role="menu"><button id="item">Item</button></div>
      <div role="dialog"><button id="ok">OK</button></div>`);
    const scope = document.getElementById("scope");
    const may = (id: string) =>
      contentMayTakeFocus(document.getElementById(id), scope);
    expect(contentMayTakeFocus(document.body, scope)).toBe(true);
    expect(contentMayTakeFocus(null, scope)).toBe(true);
    expect(may("top")).toBe(true);
    expect(may("tool")).toBe(true);
    expect(may("side")).toBe(false);
    expect(may("open")).toBe(false);
    expect(may("editor")).toBe(false);
    expect(may("field")).toBe(false);
    expect(may("terminal")).toBe(false);
    expect(may("item")).toBe(false);
    expect(may("ok")).toBe(false);
  });
});

describe("focusContentOnArrival", () => {
  function frames() {
    const queue: (() => void)[] = [];
    return {
      requestFrame: (callback: () => void) => queue.push(callback),
      cancelFrame: () => {},
      run(count: number) {
        for (let i = 0; i < count; i += 1) queue.shift()?.();
      },
    };
  }

  test("waits for the content, focuses it, and gives up on a press", () => {
    const document = page(`<header><button id="tab">Changes</button></header>
      <aside id="scope"></aside>`);
    const scope = document.getElementById("scope")!;
    const tab = document.getElementById("tab")!;
    tab.focus();
    const clock = frames();
    let now = 0;
    focusContentOnArrival({
      document,
      scope: () => scope,
      target: () => scope.querySelector<HTMLElement>(".diff-content-view"),
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
      now: () => now,
    });
    clock.run(3);
    expect(document.activeElement).toBe(tab);
    scope.innerHTML = `<section class="diff-content-view"></section>`;
    clock.run(1);
    const diff = scope.firstElementChild as HTMLElement;
    expect(document.activeElement).toBe(diff);
    expect(diff.tabIndex).toBe(-1);

    // Another arrival, the user pressing elsewhere meanwhile: no focus.
    tab.focus();
    scope.innerHTML = "";
    focusContentOnArrival({
      document,
      scope: () => scope,
      target: () => scope.querySelector<HTMLElement>(".diff-content-view"),
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
      now: () => (now += 10),
    });
    document.dispatchEvent(
      new (browser!.PointerEvent as unknown as typeof PointerEvent)(
        "pointerdown",
      ),
    );
    scope.innerHTML = `<section class="diff-content-view"></section>`;
    clock.run(3);
    expect(document.activeElement).toBe(tab);
  });

  test("a page's frame focused before its page loaded gives the page the keys once loaded", () => {
    const document = page(
      `<aside id="scope"><iframe title="page"></iframe></aside>`,
    );
    const scope = document.getElementById("scope")!;
    const frame = scope.querySelector("iframe")!;
    let given = 0;
    Object.defineProperty(frame, "contentWindow", {
      value: { focus: () => (given += 1) },
    });
    const clock = frames();
    focusContentOnArrival({
      document,
      scope: () => scope,
      target: () => frame,
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
      now: () => 0,
    });
    clock.run(3);
    expect(document.activeElement).toBe(frame);
    expect(given).toBe(0);
    frame.dispatchEvent(
      new (browser!.Event as unknown as typeof Event)("load"),
    );
    expect(given).toBe(1);
  });
});
