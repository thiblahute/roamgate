import { expect, setSystemTime, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_VOICE_TUCK_DOM_TEST !== "1") {
  test("the call card swipes down into a bar and back in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_VOICE_TUCK_DOM_TEST: "1" },
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
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost/" });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    PointerEvent: browser.PointerEvent,
    matchMedia: () => ({ matches: false }),
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const { VoiceChatOverlay } = await import("./VoiceChatOverlay");
  const { voiceCallHungUp, voiceCallLeft } = await import("./voiceChatControl");
  const { createRoot } = await import("react-dom/client");

  type Props = Parameters<typeof VoiceChatOverlay>[0];
  let clock = 1_000_000;

  const setup = (extra: Partial<Props> = {}, newCall = true) => {
    if (newCall) voiceCallHungUp();
    setSystemTime(new Date(clock));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const calls = { toggle: 0, mute: 0, end: 0 };
    const props: Props = {
      state: "listening",
      level: 0.4,
      muted: false,
      heard: "what I am saying",
      agent: "claude",
      place: "Roamgate",
      speechRate: 1,
      onCycleSpeechRate: () => {},
      onToggle: () => calls.toggle++,
      onToggleMute: () => calls.mute++,
      onEnd: () => calls.end++,
      ...extra,
    };
    const render = (more: Partial<Props> = {}) =>
      React.act(async () =>
        root.render(<VoiceChatOverlay {...props} {...more} />),
      );
    const card = () =>
      container.querySelector(".voice-chat-overlay") as HTMLElement;
    const who = () =>
      container.querySelector(".voice-chat-overlay-who") as HTMLElement;
    const pointer = async (
      target: HTMLElement,
      type: string,
      y: number,
      { x = 100, after = 16, pointerType = "touch" } = {},
    ) => {
      clock += after;
      setSystemTime(new Date(clock));
      await React.act(async () => {
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 7,
            pointerType,
            isPrimary: true,
            clientX: x,
            clientY: y,
          }),
        );
      });
    };
    /** A finger from `from` to `to` in `steps` moves `after` ms apart. */
    const swipe = async (
      target: HTMLElement,
      from: number,
      to: number,
      { steps = 4, after = 16, pointerType = "touch", up = true } = {},
    ) => {
      await pointer(target, "pointerdown", from, { pointerType });
      for (let step = 1; step <= steps; step++) {
        await pointer(
          target,
          "pointermove",
          from + ((to - from) * step) / steps,
          { after, pointerType },
        );
      }
      if (up) await pointer(target, "pointerup", to, { after, pointerType });
    };
    const click = (target: HTMLElement) =>
      React.act(async () => {
        target.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
    const unmount = () =>
      React.act(async () => {
        root.unmount();
        container.remove();
      });
    return { calls, render, card, who, swipe, pointer, click, unmount };
  };

  test("a slow swipe down past the distance tucks the card into a bar that keeps mute and hang up", async () => {
    const view = setup();
    await view.render();
    expect(view.card().classList.contains("is-tucked")).toBe(false);
    expect(view.card().querySelector(".voice-chat-overlay-heard")).not.toBe(
      null,
    );
    await view.swipe(view.who(), 300, 380, { steps: 8, after: 120, up: false });
    // The card follows the finger while it drags.
    expect(view.card().classList.contains("is-dragging")).toBe(true);
    expect(view.card().style.getPropertyValue("--voice-tuck-drag")).toBe(
      "80px",
    );
    await view.pointer(view.who(), "pointerup", 380, { after: 120 });
    // The click that ends the drag on the button is not a tap.
    await view.click(view.who());
    expect(view.calls.toggle).toBe(0);
    const card = view.card();
    expect(card.classList.contains("is-tucked")).toBe(true);
    expect(card.classList.contains("is-dragging")).toBe(false);
    expect(card.style.getPropertyValue("--voice-tuck-drag")).toBe("");
    expect(card.querySelector(".voice-chat-overlay-heard")).toBe(null);
    expect(card.querySelector(".voice-chat-overlay-rate")).toBe(null);
    expect(card.querySelector(".voice-chat-overlay-mute")).not.toBe(null);
    expect(card.querySelector(".voice-chat-overlay-hangup")).not.toBe(null);
    expect(view.who().getAttribute("aria-expanded")).toBe("false");
    // Mute still works from the bar.
    await view.click(
      card.querySelector(".voice-chat-overlay-mute") as HTMLElement,
    );
    expect(view.calls.mute).toBe(1);
    // A tap on the bar brings the card back.
    await view.click(view.who());
    expect(view.card().classList.contains("is-tucked")).toBe(false);
    expect(view.calls.toggle).toBe(0);
    await view.unmount();
  });

  test("a short slow drag snaps back, a short flick tucks, a flick up brings it back", async () => {
    const view = setup();
    await view.render();
    await view.swipe(view.card(), 300, 330, { after: 120 });
    expect(view.card().classList.contains("is-tucked")).toBe(false);
    await view.swipe(view.card(), 300, 330, { after: 5 });
    expect(view.card().classList.contains("is-tucked")).toBe(true);
    // Down on the bar: held back, and it stays a bar.
    await view.swipe(view.card(), 300, 360, { after: 120 });
    expect(view.card().classList.contains("is-tucked")).toBe(true);
    await view.swipe(view.card(), 300, 285, { after: 5 });
    expect(view.card().classList.contains("is-tucked")).toBe(false);
    await view.unmount();
  });

  test("a mouse, a sideways move or a cancelled touch leave the card as it is", async () => {
    const view = setup();
    await view.render();
    await view.swipe(view.card(), 300, 400, { pointerType: "mouse" });
    expect(view.card().classList.contains("is-tucked")).toBe(false);
    expect(view.card().classList.contains("is-dragging")).toBe(false);
    // Sideways first: not a swipe of the card.
    await view.pointer(view.card(), "pointerdown", 300);
    await view.pointer(view.card(), "pointermove", 302, { x: 140 });
    await view.pointer(view.card(), "pointermove", 400, { x: 140 });
    await view.pointer(view.card(), "pointerup", 400, { x: 140 });
    expect(view.card().classList.contains("is-tucked")).toBe(false);
    await view.swipe(view.card(), 300, 400, { up: false });
    await view.pointer(view.card(), "pointercancel", 400);
    expect(view.card().classList.contains("is-tucked")).toBe(false);
    expect(view.card().classList.contains("is-dragging")).toBe(false);
    // A tap after all that is a tap.
    await view.pointer(view.who(), "pointerdown", 300);
    await view.pointer(view.who(), "pointerup", 301);
    await view.click(view.who());
    expect(view.calls.toggle).toBe(1);
    await view.unmount();
  });

  test("a touch on words scrolled inside the card scrolls them, not the card", async () => {
    const view = setup();
    await view.render();
    const heard = view
      .card()
      .querySelector(".voice-chat-overlay-heard") as HTMLElement;
    Object.defineProperty(heard, "scrollHeight", { value: 200 });
    Object.defineProperty(heard, "clientHeight", { value: 40 });
    heard.scrollTop = 30;
    await view.swipe(heard, 300, 400);
    expect(view.card().classList.contains("is-tucked")).toBe(false);
    // At their top, the words swipe the card like the rest of it.
    heard.scrollTop = 0;
    await view.swipe(heard, 300, 400);
    expect(view.card().classList.contains("is-tucked")).toBe(true);
    await view.unmount();
  });

  test("the bar stays a bar when the card comes back for the same call, a question brings the card back, a new call comes whole", async () => {
    const view = setup();
    await view.render();
    await view.swipe(view.card(), 300, 400);
    expect(view.card().classList.contains("is-tucked")).toBe(true);
    await view.unmount();
    voiceCallLeft();

    // A reconnect rebuilds the chat: the same call's card comes back a bar.
    const back = setup({ state: "speaking", heard: "" }, false);
    await back.render();
    expect(back.card().classList.contains("is-tucked")).toBe(true);
    // A question to answer brings the card back.
    await back.render({
      moveQuestion: "Move to roamgate?",
      onAnswerMove: () => {},
    });
    expect(back.card().classList.contains("is-tucked")).toBe(false);
    expect(back.card().querySelector(".voice-chat-overlay-move")).not.toBe(
      null,
    );
    // Hanging up: the next call's card comes whole.
    await back.render();
    expect(back.card().classList.contains("is-tucked")).toBe(true);
    await back.click(
      back.card().querySelector(".voice-chat-overlay-hangup") as HTMLElement,
    );
    expect(back.calls.end).toBe(1);
    await back.unmount();
    voiceCallLeft();
    const next = setup({}, false);
    await next.render();
    expect(next.card().classList.contains("is-tucked")).toBe(false);
    await next.unmount();
  });
}
