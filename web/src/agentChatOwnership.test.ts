import { describe, expect, test } from "bun:test";
import {
  conversationActivity,
  conversationAgentStatus,
  conversationOwns,
  modeView,
  ownershipLabel,
  paneShownView,
} from "./agentChatOwnership";

describe("one view per mode", () => {
  test("the chat in conversation mode, the terminal in terminal mode", () => {
    expect(modeView({ phase: "conversation" })).toBe("chat");
    expect(modeView({ phase: "terminal" })).toBe("terminal");
  });

  test("between the modes, the view of the mode it goes to", () => {
    // The user's switch shows the chat as it takes the session...
    expect(modeView({ phase: "to_conversation" })).toBe("chat");
    // ...and Open in terminal the terminal as it hands it back.
    expect(modeView({ phase: "to_terminal" })).toBe("terminal");
  });

  test("not known yet: no view decided", () => {
    expect(modeView(null)).toBeNull();
    expect(modeView(undefined)).toBeNull();
  });
});

describe("what an agent pane shows", () => {
  const claude = (
    phase: "terminal" | "conversation" | null,
    patch: Partial<Parameters<typeof paneShownView>[0]> = {},
  ) =>
    paneShownView({
      agent: true,
      claude: true,
      chat: {
        state: phase ? { phase } : null,
        unavailable: false,
      },
      stored: null,
      chosen: "chat",
      ...patch,
    });

  test("no chat over a terminal-mode Claude, whatever view was chosen", () => {
    expect(claude("terminal")).toEqual({ view: "terminal", modeBound: true });
    expect(claude("terminal", { stored: "chat", chosen: "chat" }).view).toBe(
      "terminal",
    );
  });

  test("no terminal under a conversation-mode Claude, whatever view was chosen", () => {
    expect(
      claude("conversation", { stored: "terminal", chosen: "terminal" }),
    ).toEqual({ view: "chat", modeBound: true });
  });

  test("the view kept for the pane until the mode is known, else its terminal", () => {
    expect(claude(null, { stored: "chat" }).view).toBe("chat");
    expect(claude(null, { stored: null, chosen: "chat" }).view).toBe(
      "terminal",
    );
  });

  test("other agents, and a Claude without conversation mode, keep the chosen view", () => {
    expect(
      paneShownView({
        agent: true,
        claude: false,
        chat: null,
        stored: null,
        chosen: "chat",
      }),
    ).toEqual({ view: "chat", modeBound: false });
    expect(
      claude(null, {
        chat: { state: null, unavailable: true },
        chosen: "chat",
      }),
    ).toEqual({ view: "chat", modeBound: false });
  });

  test("a pane without an agent shows its terminal", () => {
    expect(claude("conversation", { agent: false }).view).toBe("terminal");
  });
});

describe("what the chat shows of it", () => {
  test("who owns it", () => {
    expect(conversationOwns(null)).toBe(false);
    expect(conversationOwns({ phase: "terminal" })).toBe(false);
    expect(conversationOwns({ phase: "to_conversation" })).toBe(true);
    expect(conversationOwns({ phase: "conversation" })).toBe(true);
    expect(conversationOwns({ phase: "to_terminal" })).toBe(true);
  });

  test("the owner label, with the refusal's reason", () => {
    expect(
      ownershipLabel({
        chat: { phase: "terminal", status: "stopped" },
        refusal: "The prompt box has a draft",
        handing: null,
      }),
    ).toEqual({
      label: "Terminal mode",
      detail: "The prompt box has a draft",
      tone: "terminal",
    });
    // Simply in conversation mode: nothing to say, the chat says it.
    expect(
      ownershipLabel({
        chat: { phase: "conversation", status: "idle" },
        refusal: null,
        handing: null,
      }),
    ).toBeNull();
    // A refused Open in terminal is said, with why.
    expect(
      ownershipLabel({
        chat: { phase: "conversation", status: "idle" },
        refusal: "The pane holder is not connected",
        handing: null,
      }),
    ).toEqual({
      label: "Still in conversation mode",
      detail: "The pane holder is not connected",
      tone: "conversation",
    });
    expect(
      ownershipLabel({
        chat: { phase: "terminal", status: "stopped" },
        refusal: null,
        handing: "conversation",
      }),
    ).toEqual({
      label: "Switching to conversation mode",
      detail: "Closing Claude in the terminal",
      tone: "busy",
    });
    expect(
      ownershipLabel({
        chat: { phase: "to_terminal", status: "idle" },
        refusal: null,
        handing: null,
      })?.label,
    ).toBe("Opening in the terminal");
  });

  test("status and activity from the stream", () => {
    expect(conversationAgentStatus("starting")).toBe("working");
    expect(conversationAgentStatus("blocked")).toBe("blocked");
    expect(conversationAgentStatus("stopped")).toBe("idle");
    expect(conversationActivity("thinking")).toBe("Thinking\u2026");
    expect(conversationActivity("Bash")).toBe("Running Bash");
    expect(conversationActivity(null)).toBe("Working\u2026");
  });
});
