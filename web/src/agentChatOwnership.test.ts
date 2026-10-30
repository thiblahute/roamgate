import { describe, expect, test } from "bun:test";
import {
  conversationActivity,
  conversationAgentStatus,
  conversationOwns,
  type OwnershipAttempt,
  type OwnershipInput,
  ownershipLabel,
  ownershipRequest,
  ownershipStep,
} from "./agentChatOwnership";

const input = (patch: Partial<OwnershipInput> = {}): OwnershipInput => ({
  view: "chat",
  visible: true,
  agent: "claude",
  agentStatus: "idle",
  stateSeq: 3,
  viewSeq: 0,
  chat: {
    owner: "terminal",
    phase: "terminal",
    status: "stopped",
    session_id: null,
    queue: 0,
  },
  handing: false,
  ...patch,
});

const owned = {
  owner: "conversation" as const,
  phase: "conversation" as const,
  status: "idle" as const,
  session_id: "s1",
  queue: 0,
};

describe("when to hand a session over", () => {
  test("showing an idle Claude's chat takes the session", () => {
    expect(ownershipRequest(input())?.to).toBe("conversation");
    expect(ownershipRequest(input({ agentStatus: "done" }))?.to).toBe(
      "conversation",
    );
  });

  test("never while a turn runs or a question waits", () => {
    expect(ownershipRequest(input({ agentStatus: "working" }))).toBeNull();
    expect(ownershipRequest(input({ agentStatus: "blocked" }))).toBeNull();
    expect(ownershipRequest(input({ agentStatus: "unknown" }))).toBeNull();
  });

  test("other agents, hidden panes and running handovers ask nothing", () => {
    expect(ownershipRequest(input({ agent: "codex" }))).toBeNull();
    expect(ownershipRequest(input({ visible: false }))).toBeNull();
    expect(ownershipRequest(input({ handing: true }))).toBeNull();
    expect(ownershipRequest(input({ chat: null }))).toBeNull();
  });

  test("showing the terminal hands it back once the turn is over", () => {
    expect(ownershipRequest(input({ view: "terminal", chat: owned }))?.to).toBe(
      "terminal",
    );
    expect(
      ownershipRequest(
        input({ view: "terminal", chat: { ...owned, status: "working" } }),
      ),
    ).toBeNull();
    expect(
      ownershipRequest(
        input({ view: "terminal", chat: { ...owned, status: "blocked" } }),
      ),
    ).toBeNull();
    expect(
      ownershipRequest(
        input({ view: "terminal", chat: { ...owned, queue: 1 } }),
      ),
    ).toBeNull();
  });

  test("nothing while it is being handed over", () => {
    expect(
      ownershipRequest(input({ chat: { ...owned, phase: "to_conversation" } })),
    ).toBeNull();
    expect(
      ownershipRequest(
        input({ view: "terminal", chat: { ...owned, phase: "to_terminal" } }),
      ),
    ).toBeNull();
  });

  test("the terminal owning it and the terminal shown: nothing to do", () => {
    expect(ownershipRequest(input({ view: "terminal" }))).toBeNull();
    expect(ownershipRequest(input({ chat: owned }))).toBeNull();
  });

  test("a refusal stands until something changes", () => {
    const first = ownershipRequest(input())!;
    const refused: OwnershipAttempt = { ...first.attempt, ok: false };
    expect(ownershipRequest(input(), refused)).toBeNull();
    expect(ownershipRequest(input({ stateSeq: 4 }), refused)).not.toBeNull();
    // Showing the chat again asks again.
    expect(ownershipRequest(input({ viewSeq: 2 }), refused)).not.toBeNull();
  });

  test("a refused takeover is asked again on a retry", () => {
    // A dialog closed, or the prompt box emptied: Herdr's state need not
    // change, so the chat retries now and then.
    const first = ownershipRequest(input())!;
    const refused: OwnershipAttempt = { ...first.attempt, ok: false };
    expect(ownershipRequest(input({ retry: 1 }), refused)).not.toBeNull();
    // A hand-back has nothing to retry for.
    const back = ownershipRequest(
      input({ view: "terminal", chat: { ...owned } }),
    )!;
    expect(
      ownershipRequest(
        input({ view: "terminal", chat: { ...owned }, retry: 1 }),
        { ...back.attempt, ok: false },
      ),
    ).toBeNull();
  });

  test("a showing that had its way never asks again", () => {
    const first = ownershipRequest(input())!;
    // Accepted; then another device, or Enter in the holder, takes it back.
    expect(
      ownershipRequest(
        input({ stateSeq: 9, chat: { ...owned, phase: "terminal" } }),
        first.attempt,
      ),
    ).toBeNull();
    // Shown again: it asks.
    expect(
      ownershipRequest(input({ viewSeq: 1, stateSeq: 9 }), first.attempt),
    ).not.toBeNull();
  });

  test("two devices showing different views do not hand it back and forth", () => {
    // The phone shows the chat, the desktop the terminal, both visible.
    type Device = { view: "chat" | "terminal"; last: OwnershipAttempt | null };
    const phone: Device = { view: "chat", last: null };
    const desktop: Device = { view: "terminal", last: null };
    let phase = "terminal" as "terminal" | "conversation";
    let seq = 1;
    let handovers = 0;
    const look = (device: Device) => {
      const step = ownershipStep(
        input({
          view: device.view,
          stateSeq: seq,
          chat:
            phase === "conversation"
              ? { ...owned, status: "idle" }
              : { ...owned, owner: "terminal", phase, status: "stopped" },
        }),
        device.last,
      );
      device.last = step.request ? step.request.attempt : step.last;
      if (!step.request) return;
      handovers += 1;
      phase = step.request.to;
      // Claude exits or resumes: Herdr's state moves on.
      seq += 1;
    };
    for (let round = 0; round < 10; round += 1) {
      look(desktop);
      look(phone);
    }
    expect(handovers).toBe(1);
    expect(phase).toBe("conversation");
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
      label: "Terminal",
      detail: "The prompt box has a draft",
      tone: "terminal",
    });
    expect(
      ownershipLabel({
        chat: { phase: "conversation", status: "idle" },
        refusal: null,
        handing: null,
      }).label,
    ).toBe("Conversation mode");
    expect(
      ownershipLabel({
        chat: { phase: "terminal", status: "stopped" },
        refusal: null,
        handing: "conversation",
      }).tone,
    ).toBe("busy");
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
