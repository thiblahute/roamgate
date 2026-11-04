import { describe, expect, test } from "bun:test";
import type { ConversationAgent } from "../../../../shared/agentChat";
import {
  conversationDriver,
  conversationDrivers,
  driverForHerdrAgent,
} from ".";
import { IDLE_SCREEN } from "../testing";
import type { DriverEvent, PromptRequest } from "./types";

/**
 * What every conversation driver must do, run against each one with lines
 * recorded from its agent: the core (session, service, handover, holder)
 * relies on exactly this.
 */
type Fixture = {
  /** A whole turn: session id, status, a streamed reply, its result. */
  turn: string[];
  sessionId: string;
  /** A permission the process asks (not a question), with "always". */
  permission: string;
  /** A structured question the process asks. */
  question: string;
  /** What confirms the interrupt `requestId`. */
  interruptConfirmed(requestId: string): string[];
  /** What answers the agent's own request `requestId`. */
  requestAnswered(requestId: string): string[];
  /** A request of the agent's own (its rewind's step), if it has one. */
  request?: { kind: string; params: Record<string, unknown> };
  /** The TUI idle, its prompt box empty: ready to hand over. */
  idleScreen: string;
};

const json = (value: unknown) => JSON.stringify(value);
const claudeStream = (event: unknown) =>
  json({
    type: "stream_event",
    event,
    session_id: "s1",
    parent_tool_use_id: null,
    uuid: "u",
  });

const FIXTURES: Record<ConversationAgent, Fixture> = {
  claude: {
    sessionId: "s1",
    turn: [
      json({ type: "system", subtype: "init", session_id: "s1", cwd: "/w" }),
      json({ type: "system", subtype: "status", status: "requesting" }),
      claudeStream({ type: "message_start", message: { id: "msg_1" } }),
      claudeStream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      claudeStream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hel" },
      }),
      claudeStream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "lo" },
      }),
      claudeStream({ type: "content_block_stop", index: 0 }),
      json({
        type: "assistant",
        message: { id: "msg_1", content: [{ type: "text", text: "Hello" }] },
        parent_tool_use_id: null,
      }),
      json({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Hello",
        session_id: "s1",
        duration_ms: 900,
      }),
    ],
    permission: json({
      type: "control_request",
      request_id: "p1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "toolu_1",
        permission_suggestions: [{ type: "addRules" }],
      },
    }),
    question: json({
      type: "control_request",
      request_id: "q1",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Which one?",
              header: "Pick",
              options: [{ label: "A" }, { label: "B" }],
              multiSelect: false,
            },
          ],
        },
        tool_use_id: "toolu_q",
      },
    }),
    interruptConfirmed: (requestId) => [
      json({
        type: "control_response",
        response: { subtype: "success", request_id: requestId },
      }),
    ],
    requestAnswered: (requestId) => [
      json({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: { rewound: true },
        },
      }),
    ],
    request: {
      kind: "rewind_conversation",
      params: { target_message_uuid: "m1" },
    },
    idleScreen: IDLE_SCREEN,
  },
};

for (const { protocol, terminal } of conversationDrivers()) {
  const fixture = FIXTURES[protocol.agent];

  describe(`${protocol.agent} driver contract`, () => {
    test("is registered under its agent and Herdr's name", () => {
      expect(conversationDriver(protocol.agent).protocol).toBe(protocol);
      expect(driverForHerdrAgent(terminal.herdrAgent)?.terminal).toBe(terminal);
      expect(terminal.agent).toBe(protocol.agent);
      expect(protocol.displayName).toBeTruthy();
      // Its optional features are there exactly when it says so.
      expect(!!protocol.rewind).toBe(!!protocol.capabilities.rewind);
    });

    test("a turn decodes to the session, its reply and its result", () => {
      const events = protocol.createCodec();
      const items = fixture.turn.flatMap((line) => events.line(line));
      const kinds = items.map((item) => item.kind);
      expect(items[0]).toMatchObject({
        kind: "init",
        session_id: fixture.sessionId,
      });
      expect(kinds).toContain("block_start");
      expect(kinds).toContain("delta");
      expect(kinds.at(-1)).toBe("result");
      const text = items
        .flatMap((item) => (item.kind === "delta" ? [item.text] : []))
        .join("");
      expect(text).toBe("Hello");
      // Garbage is never an event.
      expect(events.line("not json")).toEqual([]);
    });

    test("its state saved mid-turn reads on as one codec would", () => {
      for (let cut = 0; cut <= fixture.turn.length; cut++) {
        const whole = protocol.createCodec();
        const expected = fixture.turn.flatMap((line) => whole.line(line));
        const first = protocol.createCodec();
        const before = fixture.turn
          .slice(0, cut)
          .flatMap((line) => first.line(line));
        // Saved with the lease: it goes through JSON.
        const saved = JSON.parse(JSON.stringify(first.save()));
        const second = protocol.createCodec();
        second.restore(saved);
        const after = fixture.turn
          .slice(cut)
          .flatMap((line) => second.line(line));
        expect([...before, ...after]).toEqual(expected);
      }
    });

    test("a message is written as a user line, and read back if dropped", () => {
      const codec = protocol.createCodec();
      for (const prelude of [[], ["$ ls\nfile"]]) {
        const lines = codec.message({
          text: "hello there",
          images: [],
          uuid: "m-1",
          prelude,
          steer: false,
        });
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) expect(line).not.toContain("\n");
        const user = lines.filter(
          (line) => protocol.inputKind(line).kind === "user",
        );
        expect(user).toHaveLength(1);
        const back = protocol.parseWrittenMessage(user[0]!);
        expect(back?.uuid).toBe("m-1");
        expect(back?.text).toContain("hello there");
      }
      expect(protocol.parseWrittenMessage("not json")).toBeNull();
    });

    test("a message carries its images as the driver takes them", () => {
      const codec = protocol.createCodec();
      const image =
        protocol.capabilities.images === "base64"
          ? { path: "/u/a.png", media_type: "image/png", data: "QUJD" }
          : { path: "/u/a.png" };
      const lines = codec.message({
        text: "",
        images: [image],
        uuid: "m-2",
        prelude: [],
        steer: false,
      });
      const written = lines.join("\n");
      expect(written).toContain(
        protocol.capabilities.images === "base64" ? "QUJD" : "/u/a.png",
      );
    });

    test("an interrupt is confirmed by a response with its id", () => {
      const codec = protocol.createCodec();
      const lines = codec.interrupt("i-1");
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines)
        expect(protocol.inputKind(line).kind).not.toBe("user");
      const confirmed = fixture
        .interruptConfirmed("i-1")
        .flatMap((line) => codec.line(line));
      expect(confirmed).toContainEqual(
        expect.objectContaining({
          kind: "control_response",
          request_id: "i-1",
        }),
      );
    });

    test("prompts are asked, answered, and noted as answers", () => {
      const codec = protocol.createCodec();
      const permission = codec
        .line(fixture.permission)
        .find(
          (item): item is PromptRequest => item.kind === "permission_request",
        );
      expect(permission).toBeDefined();
      const asked = protocol.promptOf(permission!);
      expect(asked.questions ?? []).toEqual([]);
      if (protocol.capabilities.alwaysAllow) expect(asked.canAlways).toBe(true);

      const question = codec
        .line(fixture.question)
        .find(
          (item): item is PromptRequest => item.kind === "permission_request",
        );
      expect(question).toBeDefined();
      const card = protocol.promptOf(question!);
      if (protocol.capabilities.questions) {
        expect(card.questions?.[0]?.question).toBe("Which one?");
        expect(card.canAlways).toBe(false);
      }

      const answers = [
        "allow",
        "always",
        "deny",
        "dismiss",
        null,
        { answers: { "Which one?": "A" } },
      ] as const;
      for (const answer of answers) {
        const request =
          typeof answer === "object" && answer ? question! : permission!;
        const lines = codec.answer(request, answer);
        expect(lines.length).toBeGreaterThan(0);
        const notes = lines.map((line) => protocol.inputKind(line));
        expect(notes).toContainEqual({
          kind: protocol.answerKind,
          request_id: request.request_id,
        });
      }
    });

    test("its own requests are answered by a response with their id", () => {
      if (!fixture.request) return;
      const codec = protocol.createCodec();
      const lines = codec.request(
        fixture.request.kind,
        fixture.request.params,
        "r-1",
      );
      expect(lines?.length).toBeGreaterThan(0);
      const answered: DriverEvent[] = fixture
        .requestAnswered("r-1")
        .flatMap((line) => codec.line(line));
      expect(answered).toContainEqual(
        expect.objectContaining({
          kind: "control_response",
          request_id: "r-1",
        }),
      );
    });

    test("its start command runs headless, without Herdr's pane env", () => {
      const command = protocol.startCommand({
        sessionId: "11111111-2222-3333-4444-555555555555",
        cwd: "/work",
        flags: [],
      }) as {
        argv: string[];
        cwd: string;
        drop: string[];
        set: Record<string, string>;
      };
      expect(command.cwd).toBe("/work");
      expect(command.argv.join(" ")).toContain(
        "11111111-2222-3333-4444-555555555555",
      );
      for (const name of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"])
        expect(command.drop).toContain(name);
      expect(command.set.ROAMGATE_HEADLESS).toBe("1");
    });

    test("the terminal tells its TUI from the headless process", () => {
      const id = "11111111-2222-3333-4444-555555555555";
      const headless = (
        protocol.startCommand({ sessionId: id, cwd: "/work" }) as {
          argv: string[];
        }
      ).argv;
      const tui = terminal.resumeArgv(id, []);
      expect(tui).toContain(id);
      expect(terminal.isAgentProcess({ pid: 1, argv: tui })).toBe(true);
      expect(terminal.isAgentProcess({ pid: 2, argv: headless })).toBe(false);
      const ps = [`  101 ${headless.join(" ")}`, `  102 ${tui.join(" ")}`].join(
        "\n",
      );
      expect(terminal.headlessProbe(ps, [id])).toBe(true);
      expect(terminal.headlessProbe(`  102 ${tui.join(" ")}`, [id])).toBe(
        false,
      );
      expect(terminal.headlessProbe(ps, ["other-session"])).toBe(false);
      expect(terminal.interactiveWriter(ps, [id])).toBe(102);
      expect(terminal.interactiveWriter(ps, [id], [102])).toBeNull();
      expect(terminal.exitCommand).toBeTruthy();
    });

    test("an idle TUI is ready; a screen without its prompt box is not", () => {
      const idle = terminal.readiness(fixture.idleScreen);
      expect(idle.background).toBeNull();
      expect(idle.refusal).toBeNull();
      expect(terminal.readiness("").refusal).toBeTruthy();
    });
  });
}
