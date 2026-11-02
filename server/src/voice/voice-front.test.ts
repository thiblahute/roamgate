import { describe, expect, jest, test } from "bun:test";
import type { ClaudeProcess } from "./voice-cleaner";
import {
  configuredFront,
  FRONT_SYSTEM_PROMPT,
  parseFrontReply,
  VoiceFront,
} from "./voice-front";
import type { VoiceSessionInfo } from "./voice-router";

const ids = new Set(["local/w2:p2", "desktop/w1J:p1"]);

describe("parseFrontReply", () => {
  test("a question the state answers is answered, nothing forwarded", () => {
    expect(
      parseFrontReply(
        '{"to": "self", "reply": "Deux sessions travaillent, aucune ne t\'attend."}',
        ids,
      ),
    ).toEqual({
      to: "self",
      reply: "Deux sessions travaillent, aucune ne t'attend.",
    });
  });

  test("work goes to an agent, with what is said about it", () => {
    expect(
      parseFrontReply(
        '{"to": "current", "reply": "OK, je transmets à la session Roamgate."}',
        ids,
      ),
    ).toEqual({
      to: "current",
      reply: "OK, je transmets à la session Roamgate.",
    });
    expect(
      parseFrontReply(
        '{"to": "send", "pane": "desktop/w1J:p1", "say": "IGA-184", "reply": "Passing it to IGA-184."}',
        ids,
      ),
    ).toEqual({
      to: "send",
      pane: "desktop/w1J:p1",
      say: "IGA-184",
      reply: "Passing it to IGA-184.",
    });
  });

  test("an answer to itself with nothing to say goes to the agent", () => {
    expect(parseFrontReply('{"to": "self"}', ids)).toEqual({ to: "current" });
    expect(parseFrontReply('{"to": "self", "reply": "  "}', ids)).toEqual({
      to: "current",
    });
  });

  test("what is not for anyone stays unsaid; anything unclear goes on", () => {
    expect(parseFrontReply('{"to": "nobody", "reply": "Hm."}', ids)).toEqual({
      to: "nobody",
    });
    expect(parseFrontReply("no idea", ids)).toEqual({ to: "current" });
    expect(
      parseFrontReply(
        '{"to": "send", "pane": "local/w9:p9", "reply": "x"}',
        ids,
      ),
    ).toEqual({ to: "current", reply: "x" });
  });

  test("the prompt keeps the front from working or approving", () => {
    expect(FRONT_SYSTEM_PROMPT).toContain("You never do the work");
    expect(FRONT_SYSTEM_PROMPT).toContain("never through you");
    expect(FRONT_SYSTEM_PROMPT).toContain("never for you: route it");
  });
});

const sessions: VoiceSessionInfo[] = [
  {
    id: "local/w2:p2",
    machine: "Mac",
    workspace: "roamgate",
    title: "roamgate",
    folder: "/src/roamgate",
    agent: "claude",
    status: "working",
  },
  {
    id: "desktop/w1J:p1",
    machine: "desktop",
    workspace: "iga-184",
    title: "IGA-184 video direction",
    folder: "/src/cps-iga-184",
    agent: "claude",
    status: "idle",
  },
];

/** Claude Code sessions answering with `answer`; each started is kept. */
function fakeClaude(answer: (content: string) => string | null) {
  const started: { written: string[] }[] = [];
  const spawn = (): ClaudeProcess => {
    const written: string[] = [];
    const lines: string[] = [];
    let wake: (() => void) | null = null;
    started.push({ written });
    return {
      write: (line) => {
        const content = JSON.parse(line).message.content as string;
        written.push(content);
        const result = answer(content);
        // null: never answers.
        if (result === null) return;
        lines.push(JSON.stringify({ type: "result", result }));
        wake?.();
      },
      lines: (async function* () {
        for (;;) {
          while (lines.length) yield lines.shift()!;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      })(),
      kill: () => {},
      exited: new Promise(() => {}),
    };
  };
  return { spawn, started };
}

describe("VoiceFront", () => {
  test("the words said reach the model exactly, the state once", async () => {
    const claude = fakeClaude(
      () => '{"to": "current", "reply": "Je transmets."}',
    );
    const front = new VoiceFront(claude.spawn);
    const said = "Euh, rebase sur main, et oui, tu peux pousser.";
    const context = "Ranger tasks:\n- Nightly CI check: active";
    expect(
      await front.turn({ current: "local/w2:p2", said, sessions, context }),
    ).toEqual({ to: "current", reply: "Je transmets." });
    await front.turn({
      current: "local/w2:p2",
      said: "Merci.",
      sessions,
      context,
    });
    const written = claude.started[0]!.written;
    expect(written[0]).toStartWith("State:\nSessions:\nlocal/w2:p2 | Mac |");
    expect(written[0]).toContain("Ranger tasks:\n- Nightly CI check: active");
    expect(written[0]).toEndWith(`Said: ${JSON.stringify(said)}`);
    expect(written[1]).toBe('Current: local/w2:p2\nSaid: "Merci."');
  });

  test("an event is told, or not", async () => {
    const claude = fakeClaude((content) =>
      content.includes("IGA-184")
        ? '{"reply": "IGA-184 a fini."}'
        : '{"reply": ""}',
    );
    const front = new VoiceFront(claude.spawn);
    const event = (text: string) =>
      front.event({ current: "local/w2:p2", event: { text }, sessions });
    expect(await event("IGA-184 video direction finished")).toBe(
      "IGA-184 a fini.",
    );
    expect(await event("roamgate finished")).toBe("");
    expect(claude.started[0]!.written[1]).toStartWith("EVENT\n");
  });

  test("a front too slow leaves the words to the agent on screen, unsaid", async () => {
    jest.useFakeTimers();
    try {
      const front = new VoiceFront(fakeClaude(() => null).spawn);
      const turn = front.turn({
        current: "local/w2:p2",
        said: "Is it done?",
        sessions,
      });
      const told = front.event({
        current: "local/w2:p2",
        event: { text: "roamgate finished" },
        sessions,
      });
      // Words for another session may take it 10 s: still waited for.
      let decided = false;
      void turn.then(() => {
        decided = true;
      });
      jest.advanceTimersByTime(10_000);
      for (let tick = 0; tick < 10; tick++) await Promise.resolve();
      expect(decided).toBe(false);
      jest.advanceTimersByTime(5000);
      expect(await turn).toEqual({ to: "current" });
      expect(await told).toBe("");
    } finally {
      jest.useRealTimers();
    }
  });

  test("off without front_model; the same front while it stays", () => {
    const spawned: string[] = [];
    let model: string | undefined;
    const get = configuredFront(
      () => ({ helper: "/bin/true", ...(model ? { front_model: model } : {}) }),
      (name) => {
        spawned.push(name);
        return fakeClaude(() => "{}").spawn();
      },
    );
    expect(get()).toBeNull();
    model = "opus";
    const first = get();
    expect(first).not.toBeNull();
    expect(get()).toBe(first);
    model = "haiku";
    expect(get()).not.toBe(first);
  });
});
