import { expect, test } from "bun:test";
import type { EditorView } from "@codemirror/view";
import { Window } from "happy-dom";
import {
  editorRoot,
  imageUploadPending,
  imageUploadToken,
  takeFocus,
} from "./ReviewCommentEditor";

test("a text waits while one of its images uploads", () => {
  expect(imageUploadPending(`Look:\n${imageUploadToken(3)}\nthere`)).toBe(true);
  expect(imageUploadPending("Look:\n![shot](/review/image/a.png)")).toBe(false);
  expect(imageUploadPending("![Adding image soon]()")).toBe(false);
});

test("an editor slotted into the diff's shadow DOM has the page as its root, not the diff's shadow root", async () => {
  const browser = new Window();
  try {
    const document = browser.document;
    const diff = document.createElement("div");
    document.body.append(diff);
    const shadow = diff.attachShadow({ mode: "open" });
    shadow.innerHTML = `<div class="line"></div><slot name="annotation-1"></slot>`;
    const slotted = document.createElement("div");
    slotted.slot = "annotation-1";
    const host = document.createElement("div");
    slotted.append(host);
    diff.append(slotted);
    // CodeMirror would follow `assignedSlot` to the shadow root, whose
    // activeElement never is the editor: the page's focus is its own.
    expect(editorRoot(host as unknown as HTMLElement)).toBe(
      document as unknown as Document,
    );
    // An editor inside a shadow tree keeps that tree.
    const inner = document.createElement("div");
    shadow.append(inner);
    expect(editorRoot(inner as unknown as HTMLElement)).toBe(
      shadow as unknown as ShadowRoot,
    );
  } finally {
    await browser.happyDOM.close();
  }
});

/** A view whose content takes the focus once `ready` (its slot drawn). */
function fakeView(document: import("happy-dom").Document) {
  const dom = document.createElement("div");
  const contentDOM = document.createElement("div");
  contentDOM.tabIndex = 0;
  dom.append(contentDOM);
  document.body.append(dom);
  const state = { ready: false, focusCalls: 0 };
  const view = {
    dom,
    contentDOM,
    get hasFocus() {
      return document.activeElement === contentDOM;
    },
    focus() {
      state.focusCalls += 1;
      if (state.ready) contentDOM.focus();
    },
  };
  return { view: view as unknown as EditorView, state, contentDOM };
}

test("a new editor not drawn yet takes the focus once the commit is done, before the next key", async () => {
  const browser = new Window();
  try {
    const document = browser.document;
    const diff = document.createElement("section");
    diff.tabIndex = -1;
    document.body.append(diff);
    diff.focus();
    const { view, state, contentDOM } = fakeView(document);
    takeFocus(view);
    expect(document.activeElement).toBe(diff);
    // The diff draws its slot in the same commit, after the editor.
    state.ready = true;
    await Promise.resolve();
    expect(document.activeElement).toBe(contentDOM);
  } finally {
    await browser.happyDOM.close();
  }
});

test("a new editor never takes the focus from where it went meanwhile", async () => {
  const browser = new Window();
  try {
    const document = browser.document;
    const diff = document.createElement("section");
    diff.tabIndex = -1;
    const search = document.createElement("input");
    document.body.append(diff, search);
    diff.focus();
    const { view, state } = fakeView(document);
    const stop = takeFocus(view);
    search.focus();
    state.ready = true;
    await Promise.resolve();
    expect(document.activeElement).toBe(search);
    stop();
  } finally {
    await browser.happyDOM.close();
  }
});
