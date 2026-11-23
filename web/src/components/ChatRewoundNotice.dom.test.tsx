import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";
import * as React from "react";

if (
  inIsolatedChild(
    import.meta.path,
    "a rewind's notice in an isolated browser runtime",
    "ROAMGATE_REWOUND_NOTICE_DOM_TEST",
    20_000,
  )
) {
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
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const { ChatRewoundNotice } = await import("./ChatRewoundNotice");
  const { createRoot } = await import("react-dom/client");

  // As the history has it after the rewind recorded in
  // contract/vectors/session-rewind-fixture.json.
  const entry = {
    id: "n1",
    role: "user" as const,
    kind: "message" as const,
    text: "I think you should check out his last messages.\n\nNo, I'm telling you to look at Romate last messages.",
    sent_at: "2026-11-05T00:27:47.794Z",
    injected: {
      kind: "rewound" as const,
      label: "Rewound: 2 of your messages left the conversation",
    },
    rewound: [
      {
        text: "I think you should check out his last messages.",
        sent_at: "2026-11-05T00:27:47.794Z",
      },
      {
        text: "No, I'm telling you to look at Romate last messages.",
        sent_at: "2026-11-05T00:28:03.746Z",
      },
    ],
  };

  const setup = async (
    props: Partial<Parameters<typeof ChatRewoundNotice>[0]> = {},
  ) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(<ChatRewoundNotice entry={entry} sequence={4} {...props} />);
    });
    const text = () => container.textContent ?? "";
    const buttons = () =>
      [...container.querySelectorAll("button")].map((b) => ({
        label: b.textContent,
        disabled: b.disabled,
      }));
    const click = (label: string, nth = 0) =>
      React.act(async () => {
        const button = [...container.querySelectorAll("button")].filter(
          (b) => b.textContent === label,
        )[nth];
        if (!button) throw new Error(`no ${label} button in: ${text()}`);
        button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    return { root, text, buttons, click };
  };

  test("one line, never a queued or live message; the cut messages a tap away", async () => {
    const { root, text, buttons, click } = await setup();
    try {
      expect(text()).toBe(
        "Rewound: 2 of your messages left the conversationShow them",
      );
      expect(text()).not.toContain("Queued");
      await click("Show them");
      expect(text()).toContain("No, I'm telling you to look at Romate");
      // Without a way to send, nothing is offered.
      expect(buttons().map((each) => each.label)).toEqual(["Hide"]);
    } finally {
      await React.act(async () => root.unmount());
    }
  });

  test("Send again sends a cut message once; Edit puts it back in the box", async () => {
    const sent: string[] = [];
    const edited: string[] = [];
    const { root, buttons, click } = await setup({
      onSendAgain: async (text) => {
        sent.push(text);
      },
      onEditAgain: (text) => edited.push(text),
    });
    try {
      await click("Show them");
      await click("Send again", 1);
      expect(sent).toEqual([
        "No, I'm telling you to look at Romate last messages.",
      ]);
      expect(buttons()).toContainEqual({
        label: "Sent again",
        disabled: true,
      });
      await click("Edit", 0);
      expect(edited).toEqual([
        "I think you should check out his last messages.",
      ]);
    } finally {
      await React.act(async () => root.unmount());
    }
  });

  test("a send that fails can be tried again", async () => {
    const { root, buttons, click } = await setup({
      onSendAgain: async () => {
        throw new Error("offline");
      },
    });
    try {
      await click("Show them");
      await click("Send again");
      expect(buttons().filter((b) => b.label === "Send again").length).toBe(2);
    } finally {
      await React.act(async () => root.unmount());
    }
  });
}
