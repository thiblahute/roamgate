import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  focusShownOverlay,
  overlayFocusStep,
  overlayHideFocusTarget,
} from "./overlayFocus";

function page() {
  const window = new Window();
  const document = window.document as unknown as Document;
  document.body.innerHTML = `
    <div class="workspace-terminal-surface">
      <div class="xterm"><textarea class="xterm-helper-textarea" id="main"></textarea></div>
      <div class="agent-history-composer"><textarea id="chat"></textarea></div>
    </div>
    <section class="overlay-tab" style="visibility: hidden">
      <div class="terminal-view" id="view" tabindex="-1"></div>
    </section>
    <input id="search">`;
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const frame = document.querySelector(".overlay-tab") as HTMLElement;
  let frames: (() => void)[] = [];
  let now = 0;
  let open = true;
  const env = {
    document,
    frame: () => (frame.hasAttribute("data-open") ? frame : null),
    input: () => frame.querySelector<HTMLElement>(".xterm-helper-textarea"),
    open: () => open,
    requestFrame: (callback: () => void) => frames.push(callback),
    cancelFrame: () => {
      frames = [];
    },
    now: () => now,
  };
  return {
    document,
    byId,
    frame,
    env,
    show() {
      frame.setAttribute("data-open", "");
      frame.style.visibility = "visible";
    },
    /** xterm opens in the pane: focusing its view hands over to its input. */
    attach() {
      const view = byId("view");
      view.innerHTML = `<div class="xterm"><textarea class="xterm-helper-textarea" id="overlay"></textarea></div>`;
      view.addEventListener("focus", () => byId("overlay").focus());
    },
    hide() {
      open = false;
    },
    advance(ms = 16) {
      now += ms;
      const run = frames;
      frames = [];
      for (const callback of run) callback();
    },
    pending: () => frames.length,
  };
}

test("focuses the overlay's terminal from a chat's message box", () => {
  const p = page();
  p.attach();
  p.byId("chat").focus();
  p.show();
  focusShownOverlay(p.env);
  p.advance();
  expect(p.document.activeElement?.id).toBe("overlay");
  p.advance();
  expect(p.pending()).toBe(0);
});

test("waits for the frame to show and the first attach", () => {
  const p = page();
  p.byId("main").focus();
  focusShownOverlay(p.env);
  p.advance();
  expect(p.document.activeElement?.id).toBe("main");
  p.show();
  p.advance();
  // The pane has no terminal yet: the keyboard stays where it was.
  expect(p.document.activeElement?.id).toBe("main");
  p.attach();
  p.advance();
  expect(p.document.activeElement?.id).toBe("overlay");
  p.advance();
  expect(p.pending()).toBe(0);
});

test("leaves focus the user moved elsewhere, and stops once hidden", () => {
  const p = page();
  p.byId("main").focus();
  focusShownOverlay(p.env);
  p.byId("search").focus();
  p.show();
  p.attach();
  p.advance();
  expect(p.document.activeElement?.id).toBe("search");
  expect(p.pending()).toBe(0);

  const q = page();
  q.byId("main").focus();
  focusShownOverlay(q.env);
  q.hide();
  q.show();
  q.attach();
  q.advance();
  expect(q.document.activeElement?.id).toBe("main");
});

test("gives up after the timeout and can be cancelled", () => {
  const p = page();
  p.byId("main").focus();
  focusShownOverlay(p.env);
  p.advance(6000);
  expect(p.pending()).toBe(0);
  const q = page();
  const cancel = focusShownOverlay(q.env);
  cancel();
  expect(q.pending()).toBe(0);
});

test("a step is done only once something in the frame takes typing", () => {
  const p = page();
  p.attach();
  const view = p.byId("view");
  const overlay = p.byId("overlay");
  const main = p.byId("main");
  const body = p.document.body;
  expect(overlayFocusStep(p.frame, true, view, view, main, body)).toBe("focus");
  expect(overlayFocusStep(p.frame, true, view, overlay, main, body)).toBe(
    "done",
  );
  expect(overlayFocusStep(p.frame, true, view, main, main, body)).toBe("focus");
  expect(overlayFocusStep(p.frame, true, view, body, main, body)).toBe("focus");
  expect(overlayFocusStep(p.frame, false, view, main, main, body)).toBe("wait");
  expect(
    overlayFocusStep(p.frame, true, view, p.byId("chat"), main, body),
  ).toBe("abandon");
});

test("hiding the overlay gives the keyboard back to the review it was over", () => {
  const window = new Window();
  const document = window.document as unknown as Document;
  document.body.innerHTML = `
    <div class="review-overlay" tabindex="-1" id="review">
      <textarea id="note"></textarea>
    </div>
    <div class="xterm"><textarea id="main"></textarea></div>`;
  const review = document.getElementById("review")!;
  const note = document.getElementById("note")!;
  const main = document.getElementById("main")!;
  // Back where it was in the review.
  expect(overlayHideFocusTarget(review, note, main)).toBe(note);
  // Shown from the review's own keys: the review itself.
  expect(overlayHideFocusTarget(review, null, main)).toBe(review);
  // What it was on is gone: the review.
  note.remove();
  expect(overlayHideFocusTarget(review, note, main)).toBe(review);
  // A focus outside the review (it was opened over the overlay later).
  expect(overlayHideFocusTarget(review, main, main)).toBe(review);
  // No review: the displayed tab's pane.
  expect(overlayHideFocusTarget(null, note, main)).toBe(main);
});
