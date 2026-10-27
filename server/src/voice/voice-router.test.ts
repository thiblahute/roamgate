import { describe, expect, test } from "bun:test";
import type { ClaudeProcess } from "./voice-cleaner";
import {
  parseVoiceRoute,
  type VoiceSessionInfo,
  VoiceRouter,
} from "./voice-router";

const ids = new Set(["local/w2:p2", "desktop/w1J:p1"]);

describe("parseVoiceRoute", () => {
  test("reads each kind of answer", () => {
    expect(parseVoiceRoute('{"to": "current"}', ids)).toEqual({
      to: "current",
    });
    expect(parseVoiceRoute('Sure: {"to": "nobody"}', ids)).toEqual({
      to: "nobody",
    });
    expect(
      parseVoiceRoute(
        '{"to": "send", "pane": "desktop/w1J:p1", "say": "IGA-184"}',
        ids,
      ),
    ).toEqual({ to: "send", pane: "desktop/w1J:p1", say: "IGA-184" });
    expect(
      parseVoiceRoute(
        '{"to": "ask", "panes": ["local/w2:p2", "nope"], "question": "Which?"}',
        ids,
      ),
    ).toEqual({ to: "ask", panes: ["local/w2:p2"], question: "Which?" });
  });

  test("reads a question for Ranger", () => {
    expect(parseVoiceRoute('{"to": "ranger"}', ids)).toEqual({ to: "ranger" });
    expect(
      parseVoiceRoute('{"to": "status", "pane": "desktop/w1J:p1"}', ids),
    ).toEqual({ to: "current" });
  });

  test("anything unclear goes to the agent on screen", () => {
    expect(parseVoiceRoute("no idea", ids)).toEqual({ to: "current" });
    expect(
      parseVoiceRoute('{"to": "open", "pane": "local/w9:p9"}', ids),
    ).toEqual({ to: "current" });
    expect(parseVoiceRoute('{"to": "ask", "panes": []}', ids)).toEqual({
      to: "current",
    });
  });

  test("reads an answer given as a tool call", () => {
    expect(
      parseVoiceRoute(
        '<invoke name="open">\n<parameter name="pane">desktop/w1J:p1</parameter>\n<parameter name="say">IGA-184</parameter>\n</invoke>',
        ids,
      ),
    ).toEqual({ to: "open", pane: "desktop/w1J:p1", say: "IGA-184" });
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
    status: "idle",
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
function fakeClaude(answer: (content: string) => string) {
  const started: { written: string[]; exit: () => void }[] = [];
  const spawn = (): ClaudeProcess => {
    const written: string[] = [];
    const lines: string[] = [];
    let wake: (() => void) | null = null;
    let exit: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    started.push({ written, exit: () => exit() });
    return {
      write: (line) => {
        const content = JSON.parse(line).message.content as string;
        written.push(content);
        lines.push(JSON.stringify({ type: "result", result: answer(content) }));
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
      kill: () => exit(),
      exited,
    };
  };
  return { spawn, started };
}

describe("VoiceRouter", () => {
  test("gives the session list once, and again when it changes", async () => {
    const claude = fakeClaude(() => '{"to": "current"}');
    const router = new VoiceRouter(claude.spawn);
    const ask = (said: string, list = sessions) =>
      router.route({ current: "local/w2:p2", said, sessions: list });
    expect(await ask("Push it.")).toEqual({ to: "current" });
    await ask("Run the tests.");
    await ask("Okay.", sessions.slice(0, 1));
    const written = claude.started[0]!.written;
    expect(written[0]).toStartWith("Sessions:\nlocal/w2:p2 | Mac |");
    expect(written[0]).toEndWith('Current: local/w2:p2\nSaid: "Push it."');
    expect(written[1]).toBe('Current: local/w2:p2\nSaid: "Run the tests."');
    expect(written[2]).toStartWith("Sessions:\nlocal/w2:p2 | Mac |");
  });

  test("a new background session gets the list again", async () => {
    const claude = fakeClaude(
      () => '{"to": "open", "pane": "desktop/w1J:p1", "say": "IGA-184"}',
    );
    const router = new VoiceRouter(claude.spawn);
    const ask = () =>
      router.route({ current: "local/w2:p2", said: "Go to 184.", sessions });
    await ask();
    // The session ends: the next request starts another one.
    claude.started[0]!.exit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await ask()).toEqual({
      to: "open",
      pane: "desktop/w1J:p1",
      say: "IGA-184",
    });
    expect(claude.started[1]!.written[0]).toStartWith("Sessions:\n");
  });

  test("a router too slow to answer leaves it to the agent on screen", async () => {
    const router = new VoiceRouter(() => ({
      write: () => {},
      lines: (async function* () {
        // Never answers.
        yield* await new Promise<string[]>(() => {});
      })(),
      kill: () => {},
      exited: new Promise(() => {}),
    }));
    expect(
      await router.route({
        current: "local/w2:p2",
        said: "Go to 184.",
        sessions,
        timeoutMs: 20,
      }),
    ).toEqual({ to: "current" });
  });
});
