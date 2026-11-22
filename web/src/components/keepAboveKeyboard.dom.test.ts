import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { keepAboveKeyboard } from "./keepAboveKeyboard";

// A phone held upright: a pane scrolling under a 60px header, a comment box
// 160px tall whose top is 400px down the screen before any scroll.
// Layout is explicit: happy-dom does not lay out.
const SCREEN = 852;
const HEADER = 60;
const KEYBOARD = 352;

function phone({ lifted = true, boxHeight = 160, coarse = true } = {}) {
  const win = new Window({
    url: "http://localhost/",
    width: 393,
    height: SCREEN,
  });
  const state = { coarse, focused: true, boxHeight, keyboard: 0 };
  win.matchMedia = ((query: string) => ({
    matches: query === "(pointer: coarse)" && state.coarse,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof win.matchMedia;
  win.requestAnimationFrame = ((callback: () => void) =>
    setTimeout(callback, 0)) as unknown as typeof win.requestAnimationFrame;
  win.cancelAnimationFrame = ((id: ReturnType<typeof setTimeout>) =>
    clearTimeout(id)) as unknown as typeof win.cancelAnimationFrame;
  // What Chrome reports as the keyboard opens: the visual viewport shrinks.
  const viewport = Object.defineProperties(new win.EventTarget(), {
    offsetTop: { value: 0 },
    height: { get: () => SCREEN - state.keyboard },
  });
  Object.defineProperty(win, "visualViewport", { value: viewport });
  const observers: (() => void)[] = [];
  Object.defineProperty(win, "ResizeObserver", {
    value: class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  });

  const document = win.document as unknown as Document;
  const pane = document.createElement("div");
  pane.style.overflowY = "auto";
  const box = document.createElement("div");
  const send = document.createElement("button");
  box.append(send);
  pane.append(box);
  document.body.append(pane);

  let scrollTop = 0;
  Object.defineProperty(pane, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, value);
    },
  });
  // The app lifts the pane's bottom above the keyboard, or (lifted: false)
  // it stays under it.
  const paneBottom = () => SCREEN - (lifted ? state.keyboard : 0);
  Object.defineProperty(pane, "clientHeight", {
    get: () => paneBottom() - HEADER,
  });
  pane.getBoundingClientRect = () =>
    ({
      top: HEADER,
      bottom: paneBottom(),
      height: paneBottom() - HEADER,
    }) as DOMRect;
  const boxRect = () => {
    const top = 400 - scrollTop;
    return { top, bottom: top + state.boxHeight, height: state.boxHeight };
  };
  box.getBoundingClientRect = () => boxRect() as DOMRect;
  const scrolled: unknown[] = [];
  // What the browser does: align the box with the pane it scrolls in.
  box.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => {
    scrolled.push(options);
    const block = typeof options === "object" ? options.block : "start";
    const { top, bottom } = boxRect();
    if (block === "end" || (block === "nearest" && bottom > paneBottom()))
      scrollTop += bottom - paneBottom();
    else if (block === "nearest" && top < HEADER) scrollTop -= HEADER - top;
  };

  const stop = keepAboveKeyboard(
    () => box,
    () => state.focused,
    win as unknown as typeof window,
  );
  stops.push(stop);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  const openKeyboard = async () => {
    state.keyboard = KEYBOARD;
    viewport.dispatchEvent(new win.Event("resize"));
    await settle();
  };
  return {
    win,
    viewport,
    state,
    pane,
    box,
    scrolled,
    observers,
    settle,
    openKeyboard,
    boxBottom: () => boxRect().bottom,
    stop,
  };
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

test("the keyboard opening brings the whole box, Send too, above it", async () => {
  const phoneView = phone();
  // Open: 560 is above the screen's bottom, nothing moves.
  phoneView.viewport.dispatchEvent(new phoneView.win.Event("resize"));
  await phoneView.settle();
  expect(phoneView.scrolled).toEqual([]);

  await phoneView.openKeyboard();
  expect(phoneView.scrolled).toEqual([{ block: "nearest" }]);
  expect(phoneView.boxBottom()).toBe(SCREEN - KEYBOARD);
});

test("where the app does not lift the pane, it scrolls by what the keyboard covers", async () => {
  const phoneView = phone({ lifted: false });
  await phoneView.openKeyboard();
  expect(phoneView.boxBottom()).toBe(SCREEN - KEYBOARD);
});

test("a box taller than what the keyboard leaves shows its bottom, where Send is", async () => {
  const phoneView = phone({ boxHeight: 600 });
  await phoneView.openKeyboard();
  expect(phoneView.scrolled).toEqual([{ block: "end" }]);
  expect(phoneView.boxBottom()).toBe(SCREEN - KEYBOARD);
});

test("text growing the box, or the lift landing, brings it back above the keyboard", async () => {
  const phoneView = phone();
  await phoneView.openKeyboard();
  phoneView.scrolled.length = 0;
  phoneView.state.boxHeight = 220;
  for (const resized of phoneView.observers) resized();
  await phoneView.settle();
  expect(phoneView.scrolled).toEqual([{ block: "nearest" }]);
  expect(phoneView.boxBottom()).toBe(SCREEN - KEYBOARD);
});

test("focusing a box under the open keyboard brings it up", async () => {
  const phoneView = phone();
  phoneView.state.focused = false;
  await phoneView.openKeyboard();
  expect(phoneView.scrolled).toEqual([]);
  phoneView.state.focused = true;
  phoneView.win.document.dispatchEvent(new phoneView.win.Event("focusin"));
  await phoneView.settle();
  expect(phoneView.boxBottom()).toBe(SCREEN - KEYBOARD);
});

test("with a mouse, or once stopped, nothing scrolls", async () => {
  const mouse = phone({ coarse: false });
  await mouse.openKeyboard();
  expect(mouse.scrolled).toEqual([]);

  const stopped = phone();
  stopped.stop();
  await stopped.openKeyboard();
  expect(stopped.scrolled).toEqual([]);
});
