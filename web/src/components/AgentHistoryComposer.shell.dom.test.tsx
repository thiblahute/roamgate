import { inIsolatedChild } from "../testIsolated";
import { expect, mock, test } from "bun:test";
import * as React from "react";

if (
  inIsolatedChild(
    import.meta.path,
    "the message box's shell mode in an isolated DOM runtime",
    "ROAMGATE_COMPOSER_SHELL_DOM_TEST",
    20_000,
  )
) {
  test("a box starting with ! turns into a shell line: label, Run, and back without the !", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      Event: browser.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
      matchMedia: () => ({ matches: false }),
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    const { terminalComposerDraftKey } = await import("../terminalComposer");
    const { AgentHistoryComposer } = await import("./AgentHistoryComposer");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const draftKey = terminalComposerDraftKey("local", 1, "pane-shell");
    const send = mock<(text: string) => Promise<void>>(async () => {});
    const render = (shell?: { host?: string; cwd?: string | null }) =>
      React.act(async () =>
        root.render(
          <AgentHistoryComposer
            draftKey={draftKey}
            agent="claude"
            status="idle"
            onSend={send}
            onUploadImage={async (file) => `/tmp/${file.name}`}
            onError={() => {}}
            vimKeys={false}
            shell={shell}
          />,
        ),
      );
    const input = () => container.querySelector("textarea")!;
    const box = () => container.querySelector(".agent-history-composer")!;
    const label = () =>
      container.querySelector(".agent-history-composer-shell")!;
    const button = () =>
      container.querySelector<HTMLButtonElement>(
        ".agent-history-composer-send",
      )!;
    const fill = (text: string) =>
      React.act(async () => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(input(), text);
        input().dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    try {
      await render({
        host: "desktop",
        cwd: "/Users/me/devel/gstreamer/gstreamer-ocio",
      });
      // A message: no shell mode, the live region there but empty.
      await fill("hello");
      expect(box().classList.contains("is-shell")).toBe(false);
      expect(label().getAttribute("aria-live")).toBe("polite");
      expect(label().textContent).toBe("");
      expect(button().textContent).toBe("Send");
      expect(input().getAttribute("aria-label")).toBe("Message claude");

      // A `!`: shell mode at once, before any command.
      await fill("!");
      expect(box().classList.contains("is-shell")).toBe(true);
      expect(label().textContent).toContain(
        "Shell · runs on desktop in ~/devel/gstreamer/gstreamer-ocio",
      );
      expect(button().textContent).toBe("Run");
      expect(button().getAttribute("aria-label")).toBe(
        "Run the command on desktop in ~/devel/gstreamer/gstreamer-ocio",
      );
      expect(input().getAttribute("aria-label")).toBe("Shell command");
      // Nothing to run yet.
      expect(button().disabled).toBe(true);

      await fill("  ! ls");
      expect(box().classList.contains("is-shell")).toBe(true);
      expect(button().disabled).toBe(false);
      await React.act(async () => button().click());
      expect(send).toHaveBeenCalledWith("  ! ls");

      // Deleting the `!` leaves shell mode.
      await fill("! ls");
      await fill(" ls");
      expect(box().classList.contains("is-shell")).toBe(false);
      expect(label().textContent).toBe("");
      expect(button().textContent).toBe("Send");

      // A `!` further on is text.
      await fill("hi! ls");
      expect(box().classList.contains("is-shell")).toBe(false);

      // Without a shell (not in conversation mode): `!` is plain text.
      await render(undefined);
      await fill("! ls");
      expect(box().classList.contains("is-shell")).toBe(false);
      expect(container.querySelector(".agent-history-composer-shell")).toBe(
        null,
      );
      expect(button().textContent).toBe("Send");

      // No directory known: the host alone.
      await render({ host: "desktop", cwd: null });
      await fill("!pwd");
      expect(label().textContent).toContain("Shell · runs on desktop");
      expect(label().textContent).not.toContain(" in ");
    } finally {
      await React.act(async () => root.unmount());
      await browser.happyDOM.close();
    }
  });
}
