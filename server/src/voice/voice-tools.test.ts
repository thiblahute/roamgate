import { describe, expect, test } from "bun:test";
import { createVoiceRoutes, toolRoute } from "../http/voice";
import type { VoiceHelper } from "./voice-helper";
import { parseFrontReply } from "./voice-front";
import {
  askRules,
  type CompanionMcpConfig,
  canonicalJson,
  configuredTools,
  confirmedPrompt,
  HELD_MESSAGE,
  matchesTool,
  saysYes,
  startsSpotify,
  toolArgs,
  toolCallLog,
  toolDecision,
  toolsContext,
  type ToolProcess,
  VoiceTools,
  writesByName,
  YOUTUBE_PROMPT,
  type YoutubeControls,
} from "./voice-tools";
import { YoutubeError, type YoutubeStatus } from "./voice-youtube";

const SEND = "mcp__claude_ai_WhatsApp__send_message";
const LIST = "mcp__claude_ai_WhatsApp__list_chats";

const POLICY: CompanionMcpConfig = {
  allow: ["mcp__spotify", "mcp__claude_ai_Youtube__*", LIST],
  confirm: [SEND],
};

describe("matching tools", () => {
  test("a name, a whole server, or a prefix", () => {
    expect(matchesTool(LIST, LIST)).toBe(true);
    expect(matchesTool("mcp__spotify", "mcp__spotify__pause")).toBe(true);
    expect(matchesTool("mcp__spotify", "mcp__spotify_other__pause")).toBe(
      false,
    );
    expect(
      matchesTool("mcp__claude_ai_Youtube__*", "mcp__claude_ai_Youtube__x"),
    ).toBe(true);
    expect(matchesTool("mcp__spotify__pause", "mcp__spotify__play")).toBe(
      false,
    );
    expect(matchesTool("", "mcp__spotify__pause")).toBe(false);
    // A star anywhere: the same tool on servers named alike.
    expect(
      matchesTool(
        "mcp__claude_ai_Spotify*__pause",
        "mcp__claude_ai_Spotify__home___pause",
      ),
    ).toBe(true);
    expect(
      matchesTool(
        "mcp__claude_ai_Spotify*__pause",
        "mcp__claude_ai_Spotify__play",
      ),
    ).toBe(false);
    expect(matchesTool("mcp__a.b*", "mcp__aXb__c")).toBe(false);
  });

  test("case does not count", () => {
    expect(
      matchesTool(
        "mcp__claude_ai_Spotify*__devices",
        "mcp__claude_ai_spotify__devices",
      ),
    ).toBe(true);
    expect(matchesTool("MCP__Spotify", "mcp__spotify__pause")).toBe(true);
    expect(matchesTool(LIST.toLowerCase(), LIST)).toBe(true);
    expect(
      matchesTool(
        "mcp__claude_ai_Spotify*__devices",
        "mcp__claude_ai_spotify__play",
      ),
    ).toBe(false);
  });

  test("a tool's own name says when it writes", () => {
    expect(writesByName(SEND)).toBe(true);
    expect(writesByName("mcp__claude_ai_Gmail__create_draft")).toBe(true);
    expect(writesByName("mcp__claude_ai_Google_Drive__trash_file")).toBe(true);
    expect(writesByName("mcp__claude_ai_WhatsApp__react")).toBe(true);
    expect(writesByName("mcp__claude_ai_WhatsApp__mark_read")).toBe(true);
    // Playback and reading are not writing.
    for (const tool of [
      "mcp__spotify__pause",
      "mcp__spotify__resume",
      "mcp__spotify__next",
      "mcp__spotify__volume",
      "mcp__spotify__play",
      "mcp__spotify__now_playing",
      LIST,
      "mcp__claude_ai_Youtube__get_transcript",
      // A server's name is not the tool's.
      "mcp__send_server__list",
    ])
      expect(writesByName(tool)).toBe(false);
  });
});

describe("a job's log", () => {
  test("each tool called, with its input, and each call that failed", () => {
    expect(
      toolCallLog("t4", {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Moving it." },
            {
              type: "tool_use",
              name: "mcp__spotify__transfer",
              input: { device: "amd-desktop", play: true },
            },
          ],
        },
      }),
    ).toEqual([
      '[voice] tool job t4: mcp__spotify__transfer {"device":"amd-desktop","play":true}',
    ]);
    expect(
      toolCallLog("t4", {
        type: "user",
        message: {
          content: [
            { type: "tool_result", content: "ok" },
            {
              type: "tool_result",
              is_error: true,
              content: [{ type: "text", text: "No active device" }],
            },
          ],
        },
      }),
    ).toEqual(["[voice] tool job t4: a call failed: No active device"]);
    const long = toolCallLog("t5", {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "x", input: { a: "b".repeat(500) } },
        ],
      },
    });
    expect(long[0]?.endsWith("...")).toBe(true);
    expect(long[0]!.length).toBeLessThan(340);
    expect(toolCallLog("t6", { type: "result", result: "done" })).toEqual([]);
  });
});

describe("tool decisions", () => {
  test("allowed tools run, unlisted ones are refused", () => {
    expect(toolDecision("mcp__spotify__pause", {}, POLICY).behavior).toBe(
      "allow",
    );
    expect(
      toolDecision("mcp__claude_ai_Youtube__search_videos", {}, POLICY)
        .behavior,
    ).toBe("allow");
    expect(
      toolDecision("mcp__claude_ai_Gmail__search_threads", {}, POLICY).behavior,
    ).toBe("deny");
    // Built-in tools never run through this.
    expect(toolDecision("Bash", { command: "ls" }, POLICY).behavior).toBe(
      "deny",
    );
  });

  test("allowing and confirming ignore case, and confirming still wins", () => {
    const policy = {
      allow: ["mcp__claude_ai_Spotify*__devices", "mcp__claude_ai_Spotify*"],
      confirm: ["mcp__claude_ai_SPOTIFY*__start_playback"],
    };
    expect(
      toolDecision("mcp__claude_ai_spotify__devices", {}, policy).behavior,
    ).toBe("allow");
    expect(
      toolDecision("mcp__claude_ai_spotify__start_playback", {}, policy)
        .behavior,
    ).toBe("hold");
    expect(
      toolDecision(
        "mcp__claude_ai_spotify__devices",
        {},
        {
          allow: ["mcp__claude_ai_Spotify*__devices"],
          confirm: ["mcp__claude_ai_spotify*__DEVICES"],
        },
      ).behavior,
    ).toBe("hold");
    // Anything else is still refused.
    expect(
      toolDecision("mcp__claude_ai_spotifx__devices", {}, policy).behavior,
    ).toBe("deny");
    expect(
      toolDecision("mcp__claude_ai_gmail__search_threads", {}, policy).behavior,
    ).toBe("deny");
  });

  test("a tool to confirm is held, never run as asked", () => {
    expect(toolDecision(SEND, { jid: "a", text: "hi" }, POLICY).behavior).toBe(
      "hold",
    );
  });

  test("a writing tool is held even when a pattern allows it", () => {
    const policy = { allow: ["mcp__claude_ai_WhatsApp__*"] };
    expect(toolDecision(SEND, { text: "hi" }, policy).behavior).toBe("hold");
    expect(toolDecision(LIST, {}, policy).behavior).toBe("allow");
    // Unlisted writing tools are refused, not held.
    expect(
      toolDecision("mcp__claude_ai_Gmail__send_message", {}, policy).behavior,
    ).toBe("deny");
  });

  test("a confirmed call runs once, with its exact input only", () => {
    const approved = {
      tool: SEND,
      input: { jid: "33600@s.whatsapp.net", text: "J'arrive" },
      used: false,
    };
    // Same input, keys in another order, nulls dropped.
    expect(
      toolDecision(
        SEND,
        { text: "J'arrive", jid: "33600@s.whatsapp.net", quoted: null },
        POLICY,
        approved,
      ).behavior,
    ).toBe("allow");
    expect(
      toolDecision(
        SEND,
        { jid: "33600@s.whatsapp.net", text: "J'arrive !" },
        POLICY,
        approved,
      ).behavior,
    ).toBe("deny");
    expect(
      toolDecision(SEND, { jid: "other", text: "J'arrive" }, POLICY, approved)
        .behavior,
    ).toBe("deny");
    expect(
      toolDecision(
        "mcp__claude_ai_WhatsApp__send_media",
        approved.input,
        {
          ...POLICY,
          confirm: [...POLICY.confirm!, "mcp__claude_ai_WhatsApp__send_media"],
        },
        approved,
      ).behavior,
    ).toBe("deny");
    expect(
      toolDecision(SEND, approved.input, POLICY, { ...approved, used: true })
        .behavior,
    ).toBe("deny");
  });

  test("canonical JSON ignores key order and nulls", () => {
    expect(
      canonicalJson({ b: 1, a: { d: null, c: [1, { y: 2, x: 1 }] } }),
    ).toBe(canonicalJson({ a: { c: [1, { x: 1, y: 2 }] }, b: 1 }));
  });
});

describe("the user's yes", () => {
  test.each([
    "oui",
    "Oui, envoie-le",
    "vas-y",
    "ok",
    "yes, send it",
    "d'accord",
  ])("%p confirms", (said) => expect(saysYes(said)).toBe(true));
  test.each([
    "non",
    "oui mais non",
    "attends",
    "no, don't send it",
    "c'est quoi ce message ?",
    "",
    "ok ok ok ok ok ok ok ok ok ok ok ok ok",
  ])("%p does not", (said) => expect(saysYes(said)).toBe(false));
});

describe("the job's Claude Code", () => {
  test("only ToolSearch built in, no hooks, every call asked of Roamgate", () => {
    const args = toolArgs("sonnet", "claude", POLICY);
    expect(args[args.indexOf("--tools") + 1]).toBe("ToolSearch");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("default");
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("host");
    expect(args[args.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    expect(settings.disableAllHooks).toBe(true);
    expect(settings.permissions.ask).toEqual([
      "mcp__spotify",
      "mcp__claude_ai_Youtube",
      "mcp__claude_ai_WhatsApp",
    ]);
    // Never the user's own permission mode, never bypassed.
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allowedTools");
  });

  test("ask rules name whole servers", () => {
    expect(
      askRules({
        allow: ["mcp__a__b*", "Bash", "mcp__c", "mcp__d*", "mcp__e*__pause"],
      }),
    ).toEqual(["mcp__a", "mcp__c", "mcp__d"]);
  });
});

/** A job process the test drives, answering its control requests. */
function fakeProcess() {
  const queued: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let exit: (value: unknown) => void = () => {};
  const exited = new Promise((resolve) => {
    exit = resolve;
  });
  const process = {
    killed: false,
    written: [] as Record<string, unknown>[],
    lines: (async function* () {
      for (;;) {
        while (queued.length) yield queued.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    })(),
    write(line: string) {
      process.written.push(JSON.parse(line));
    },
    kill() {
      process.killed = true;
      process.end();
    },
    exited,
    push(line: unknown) {
      queued.push(JSON.stringify(line));
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
      exit(0);
    },
    /** The answer it was given to control request `id`. */
    answer(id: string) {
      const found = process.written.find(
        (each) =>
          each.type === "control_response" &&
          (each.response as { request_id?: string }).request_id === id,
      );
      return (found?.response as { response?: Record<string, unknown> })
        ?.response;
    },
  };
  return process;
}

type Fake = ReturnType<typeof fakeProcess>;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const asks = (id: string, tool: string, input: Record<string, unknown>) => ({
  type: "control_request",
  request_id: id,
  request: { subtype: "can_use_tool", tool_name: tool, input },
});

const result = (spoken: string) => ({
  type: "result",
  result: JSON.stringify({ spoken, answer: spoken, sources: [] }),
});

function tools(policy: CompanionMcpConfig = POLICY, held = 60_000) {
  const spawned: Fake[] = [];
  const using = new VoiceTools(
    () => {
      const process = fakeProcess();
      spawned.push(process);
      return process as ToolProcess;
    },
    () => policy,
    { limit: 60_000, kept: 60_000, held },
    () => new Date("2026-11-05T09:30:00Z"),
  );
  return { using, spawned };
}

const MESSAGE = {
  jid: "33600@s.whatsapp.net",
  text: "J'arrive dans dix minutes",
};

describe("tool jobs", () => {
  test("an allowed call runs, and the result is told", async () => {
    const { using, spawned } = tools();
    const job = using.start("Mets la musique en pause")!;
    expect(job.status).toBe("searching");
    const process = spawned[0]!;
    const user = process.written.find((each) => each.type === "user") as {
      message: { content: string };
    };
    expect(user.message.content).toContain("Request: Mets la musique en pause");
    process.push(asks("r1", "mcp__spotify__pause", {}));
    await settle();
    expect(process.answer("r1")).toEqual({
      behavior: "allow",
      updatedInput: {},
    });
    process.push(result("C'est en pause."));
    await settle();
    await settle();
    const done = using.state(job.id)!;
    expect(done.status).toBe("done");
    expect(done.spoken).toBe("C'est en pause.");
    expect(done.steps).toEqual(["Using spotify pause"]);
    expect(done.held).toBeUndefined();
    expect(process.killed).toBe(true);
  });

  test("a refused call is reported refused", async () => {
    const { using, spawned } = tools();
    using.start("Lis mes mails");
    spawned[0]!.push(asks("r1", "mcp__claude_ai_Gmail__search_threads", {}));
    await settle();
    expect(spawned[0]!.answer("r1")?.behavior).toBe("deny");
  });

  test("a send is held, confirmed by a yes, and made once with its exact input", async () => {
    const { using, spawned } = tools();
    const job = using.start("Dis à Marie que j'arrive dans dix minutes")!;
    const first = spawned[0]!;
    first.push(asks("r1", LIST, {}));
    first.push(asks("r2", SEND, MESSAGE));
    await settle();
    expect(first.answer("r1")?.behavior).toBe("allow");
    expect(first.answer("r2")).toEqual({
      behavior: "deny",
      message: HELD_MESSAGE,
    });
    // A second held call in the same job is refused outright.
    first.push(asks("r3", SEND, { ...MESSAGE, text: "autre" }));
    await settle();
    expect(first.answer("r3")?.behavior).toBe("deny");
    first.push(
      result("J'envoie à Marie : « J'arrive dans dix minutes ». Je confirme ?"),
    );
    await settle();
    await settle();
    const held = using.state(job.id)!;
    expect(held.held).toEqual({ tool: SEND, input: MESSAGE });
    expect(held.answer).toContain("Waiting for your OK");
    expect(using.heldJob()?.id).toBe(job.id);

    // Not a yes: nothing runs.
    expect(using.confirm("c'est à qui ?", job.id)).toBeNull();
    expect(spawned).toHaveLength(1);

    const making = using.confirm("oui vas-y", job.id)!;
    expect(making.confirms).toBe(job.id);
    expect(using.heldJob()).toBeNull();
    // Once only: a second yes finds nothing held.
    expect(using.confirm("oui")).toBeNull();
    const second = spawned[1]!;
    const prompt = second.written.find((each) => each.type === "user") as {
      message: { content: string };
    };
    expect(prompt.message.content).toBe(
      confirmedPrompt(
        { tool: SEND, input: MESSAGE },
        new Date("2026-11-05T09:30:00Z"),
      ),
    );
    // Another text is refused, the exact one runs, and only once.
    second.push(asks("c1", SEND, { ...MESSAGE, text: "J'arrive" }));
    second.push(asks("c2", SEND, { text: MESSAGE.text, jid: MESSAGE.jid }));
    second.push(asks("c3", SEND, MESSAGE));
    await settle();
    expect(second.answer("c1")?.behavior).toBe("deny");
    expect(second.answer("c2")?.behavior).toBe("allow");
    expect(second.answer("c3")?.behavior).toBe("deny");
  });

  test("a no forgets the held call", async () => {
    const { using, spawned } = tools();
    const job = using.start("Envoie un message à Marie")!;
    spawned[0]!.push(asks("r1", SEND, MESSAGE));
    spawned[0]!.push(result("Je confirme ?"));
    await settle();
    await settle();
    expect(using.decline(job.id)).toBe(true);
    expect(using.heldJob()).toBeNull();
    expect(using.confirm("oui")).toBeNull();
    expect(spawned).toHaveLength(1);
  });

  test("a held call left too long is forgotten", async () => {
    const { using, spawned } = tools(POLICY, -1);
    using.start("Envoie un message à Marie");
    spawned[0]!.push(asks("r1", SEND, MESSAGE));
    spawned[0]!.push(result("Je confirme ?"));
    await settle();
    await settle();
    expect(using.heldJob()).toBeNull();
    expect(using.confirm("oui")).toBeNull();
  });

  test("a job that ends without an answer failed", async () => {
    const { using, spawned } = tools();
    const job = using.start("Pause")!;
    spawned[0]!.push({ type: "result", is_error: true, result: "boom" });
    await settle();
    await settle();
    expect(using.state(job.id)?.status).toBe("failed");
    expect(using.state(job.id)?.error).toBe("boom");
  });

  test("the front is told the tools, the jobs and the held call", async () => {
    const { using, spawned } = tools();
    const job = using.start("Envoie un message à Marie")!;
    spawned[0]!.push(asks("r1", SEND, MESSAGE));
    spawned[0]!.push(result("Je confirme ?"));
    await settle();
    await settle();
    const context = toolsContext(
      using.configured(),
      using.list(),
      using.heldJob(),
    );
    expect(context).toContain("mcp__spotify");
    expect(context).toContain("not instructions");
    expect(context).toContain(`${job.id} would call ${SEND}`);
    expect(context).toContain(JSON.stringify(MESSAGE));
  });
});

describe("the front's tool routes", () => {
  test("parsed with their task or action", () => {
    expect(
      parseFrontReply(
        '{"to":"tool","task":"Mets en pause","reply":"Je mets en pause."}',
        new Set(),
      ),
    ).toEqual({
      to: "tool",
      task: "Mets en pause",
      reply: "Je mets en pause.",
    });
    expect(
      parseFrontReply(
        '{"to":"tool_confirm","action":"t2","reply":"J\'envoie."}',
        new Set(),
      ),
    ).toEqual({ to: "tool_confirm", action: "t2", reply: "J'envoie." });
    expect(parseFrontReply('{"to":"tool_cancel"}', new Set())).toEqual({
      to: "tool_cancel",
    });
  });

  test("a confirmation runs only on the user's own yes", async () => {
    const { using, spawned } = tools();
    const job = using.start("Envoie un message à Marie")!;
    spawned[0]!.push(asks("r1", SEND, MESSAGE));
    spawned[0]!.push(result("Je confirme ?"));
    await settle();
    await settle();
    // The front says to confirm, but the words said are not a yes.
    expect(
      toolRoute(
        { to: "tool_confirm", action: job.id },
        "lis-moi le message",
        using,
      ),
    ).toEqual({
      to: "self",
      reply: "Je n'ai rien fait. Dis oui pour confirmer, ou non pour annuler.",
    });
    expect(spawned).toHaveLength(1);
    const route = toolRoute(
      { to: "tool_confirm", action: job.id, reply: "J'envoie." },
      "oui",
      using,
    );
    expect(route).toMatchObject({ to: "tool", reply: "J'envoie." });
    expect(spawned).toHaveLength(2);
  });

  test("a change forgets the held call and starts the corrected one", async () => {
    const { using, spawned } = tools();
    const job = using.start("Envoie un message à Marie")!;
    spawned[0]!.push(asks("r1", SEND, MESSAGE));
    spawned[0]!.push(result("Je confirme ?"));
    await settle();
    await settle();
    expect(
      parseFrontReply(
        '{"to":"tool_cancel","action":"t1","task":"Envoie à Marie : vingt minutes"}',
        new Set(),
      ),
    ).toEqual({
      to: "tool_cancel",
      action: "t1",
      task: "Envoie à Marie : vingt minutes",
    });
    const route = toolRoute(
      {
        to: "tool_cancel",
        action: job.id,
        task: "Envoie à Marie : vingt minutes",
      },
      "non, dis plutôt vingt minutes",
      using,
    );
    expect(route).toMatchObject({ to: "tool", job: "t2" });
    expect(using.state(job.id)?.heldOutcome).toBe("declined");
    expect(spawned).toHaveLength(2);
  });

  test("without tools, it says so", () => {
    expect(
      toolRoute(
        { to: "tool", task: "pause" },
        "mets la musique en pause",
        null,
      ),
    ).toEqual({ to: "self", reply: "Je n'ai pas d'outils pour ça d'ici." });
  });

  test("a tool route starts its job", () => {
    const { using } = tools();
    expect(
      toolRoute(
        { to: "tool", task: "Pause the music" },
        "pause the music",
        using,
      ),
    ).toEqual({
      to: "tool",
      task: "Pause the music",
      job: "t1",
      reply: "On it.",
    });
  });
});

describe("configuredTools", () => {
  test("only with a front and companion_mcp", () => {
    const base = { helper: "h", front_model: "opus" };
    expect(
      configuredTools(
        () => base,
        () => fakeProcess(),
      )(),
    ).toBeNull();
    expect(
      configuredTools(
        () => ({ ...base, companion_mcp: POLICY }),
        () => fakeProcess(),
      )(),
    ).not.toBeNull();
    expect(
      configuredTools(
        () => ({ helper: "h", companion_mcp: POLICY }),
        () => fakeProcess(),
      )(),
    ).toBeNull();
  });
});

describe("the call's music device", () => {
  /** The request the job started for `task` was given. */
  function request(
    device: string | undefined,
    onCall: boolean,
    fullVolume?: boolean,
  ): string {
    const spawned: Fake[] = [];
    const using = configuredTools(
      () => ({
        helper: "h",
        front_model: "opus",
        companion_mcp: POLICY,
        ...(device === undefined ? {} : { call_music_device: device }),
        ...(fullVolume === undefined
          ? {}
          : { call_music_full_volume: fullVolume }),
      }),
      () => {
        const process = fakeProcess();
        spawned.push(process);
        return process as ToolProcess;
      },
    )()!;
    using.start("Mets du Miles Davis", onCall);
    const user = spawned[0]!.written.find((each) => each.type === "user") as {
      message: { content: string };
    };
    return user.message.content;
  }

  test("music asked on a call plays on call_music_device", () => {
    const asked = request("amd-desktop", true);
    expect(asked).toContain("Request: Mets du Miles Davis");
    expect(asked).toContain('Spotify Connect device "amd-desktop"');
  });

  test("music on call_music_device is set to full volume, and why", () => {
    const asked = request("amd-desktop", true);
    expect(asked).toContain(
      "set that device's volume to 100: the call sets the music's level",
    );
    expect(request("amd-desktop", true, true)).toContain("volume to 100");
  });

  test("call_music_full_volume false leaves the device's volume", () => {
    const asked = request("amd-desktop", true, false);
    expect(asked).toContain('Spotify Connect device "amd-desktop"');
    expect(asked).not.toContain("volume to 100");
    expect(request("amd-desktop", false)).not.toContain("volume to 100");
  });

  test("off a call, or without a device, the default device stays", () => {
    expect(request("amd-desktop", false)).not.toContain("Spotify Connect");
    expect(request(undefined, true)).not.toContain("Spotify Connect");
    expect(request("  ", true)).not.toContain("Spotify Connect");
  });
});

describe("a click on a held call", () => {
  /** A job holding a send, its read-back done. */
  async function holding() {
    const { using, spawned } = tools();
    const job = using.start("Envoie un message à Marie")!;
    spawned[0]!.push(asks("r1", SEND, MESSAGE));
    spawned[0]!.push(result("J'envoie à Marie : « J'arrive ». Je confirme ?"));
    await settle();
    await settle();
    return { using, spawned, job };
  }

  /** POST /api/voice/tools/answer, with the voice header unless told. */
  function answering(using: VoiceTools) {
    const routes = createVoiceRoutes(
      {} as VoiceHelper,
      () => null,
      null,
      () => undefined,
      null,
      () => null,
      () => null,
      () => {},
      () => null,
      () => null,
      () => using,
    );
    return async (body: unknown, header = true) =>
      (await routes(
        new Request("http://roamgate.test/api/voice/tools/answer", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(header ? { "x-roamgate-voice": "1" } : {}),
          },
          body: JSON.stringify(body),
        }),
        "/api/voice/tools/answer",
      ))!;
  }

  test("makes that call once, with no words to check", async () => {
    const { using, spawned, job } = await holding();
    const making = using.approve(job.id)!;
    expect(making.confirms).toBe(job.id);
    expect(using.state(job.id)?.heldOutcome).toBe("confirmed");
    expect(spawned).toHaveLength(2);
    // Once: nothing is held any more.
    expect(using.approve(job.id)).toBeNull();
    expect(using.confirm("oui", job.id)).toBeNull();
    expect(spawned).toHaveLength(2);
  });

  test("is only the user's, through its own request", async () => {
    const { using, spawned, job } = await holding();
    const answer = answering(using);
    // A page from elsewhere cannot add the voice header.
    expect((await answer({ job: job.id, answer: "yes" }, false)).status).toBe(
      403,
    );
    expect((await answer({ job: job.id, answer: "maybe" })).status).toBe(400);
    expect((await answer({ answer: "yes" })).status).toBe(400);
    // A job holding nothing.
    expect((await answer({ job: "t9", answer: "yes" })).status).toBe(409);
    expect(spawned).toHaveLength(1);

    const yes = await answer({ job: job.id, answer: "yes" });
    expect(yes.status).toBe(200);
    const made = (await yes.json()) as { job: unknown };
    expect(made.job).toMatchObject({ id: "t2", confirms: job.id });
    expect(spawned).toHaveLength(2);
    // Answered: a second click finds nothing waiting.
    expect((await answer({ job: job.id, answer: "yes" })).status).toBe(409);
    expect((await answer({ job: job.id, answer: "no" })).status).toBe(409);
    expect(spawned).toHaveLength(2);
  });

  test("no forgets it, nothing made", async () => {
    const { using, spawned, job } = await holding();
    const declined = await answering(using)({ job: job.id, answer: "no" });
    expect(await declined.json()).toEqual({ declined: job.id });
    expect(using.state(job.id)?.heldOutcome).toBe("declined");
    expect(using.heldJob()).toBeNull();
    expect(spawned).toHaveLength(1);
  });

  test("without tools, nothing waits", async () => {
    const routes = createVoiceRoutes({} as VoiceHelper);
    const answered = await routes(
      new Request("http://roamgate.test/api/voice/tools/answer", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-roamgate-voice": "1",
        },
        body: JSON.stringify({ job: "t1", answer: "yes" }),
      }),
      "/api/voice/tools/answer",
    );
    expect(answered!.status).toBe(409);
  });
});

describe("YouTube for the call's music", () => {
  const MUSIC = {
    helper: "h",
    front_model: "opus",
    companion_mcp: POLICY,
    call_background: "pulsesrc device=roamgate-music.monitor ! audioconvert",
  };
  const PLAYING: YoutubeStatus = {
    state: "playing",
    position: 3,
    duration: 242,
    volume: 100,
    track: {
      title: "Around the World",
      url: "https://www.youtube.com/watch?v=K0HSD_i2DvA",
      channel: "Daft Punk",
    },
    spotifyPaused: true,
  };

  /** A player recording what it is asked. */
  function fakeYoutube(play?: () => Promise<YoutubeStatus>) {
    const calls: string[] = [];
    const answer = (name: string) => async (arg?: unknown) => {
      calls.push(arg === undefined ? name : `${name} ${JSON.stringify(arg)}`);
      return PLAYING;
    };
    const player: YoutubeControls = {
      play: async (query) => {
        calls.push(`play ${query}`);
        return play ? play() : PLAYING;
      },
      pause: answer("pause"),
      resume: answer("resume"),
      stop: answer("stop"),
      volume: answer("volume"),
      seek: answer("seek"),
      nowPlaying: answer("nowPlaying"),
      spotifyStarted: async () => {
        calls.push("spotifyStarted");
      },
    };
    return { player, calls };
  }

  function configured(
    config: Record<string, unknown>,
    player = fakeYoutube().player,
  ) {
    const spawned: {
      process: Fake;
      policy: CompanionMcpConfig;
      mcpConfig?: string;
    }[] = [];
    const using = configuredTools(
      () => ({ ...MUSIC, ...config }),
      (_model, _command, policy, mcpConfig) => {
        const process = fakeProcess();
        spawned.push({ process, policy, mcpConfig });
        return process as ToolProcess;
      },
      player,
    )()!;
    return { using, spawned };
  }

  /** A JSON-RPC call to the job's YouTube server. */
  async function rpc(mcpConfig: string, body: Record<string, unknown>) {
    const server = JSON.parse(mcpConfig).mcpServers.roamgate_youtube;
    const response = await fetch(server.url, {
      method: "POST",
      headers: { ...server.headers, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
    });
    return response.status === 200 ? response.json() : response.status;
  }

  test("a job gets the player's tools, allowed, and when to use them", async () => {
    const { player, calls } = fakeYoutube();
    const { using, spawned } = configured({}, player);
    using.start("Mets Around the World de Daft Punk sur YouTube", true);
    const { process, policy, mcpConfig } = spawned[0]!;
    expect(askRules(policy)).toContain("mcp__roamgate_youtube");
    expect(
      toolDecision("mcp__roamgate_youtube__play", { query: "x" }, policy)
        .behavior,
    ).toBe("allow");
    expect(toolsContext(using.configured(), [], null)).toContain(
      "mcp__roamgate_youtube",
    );
    const user = process.written.find((each) => each.type === "user") as {
      message: { content: string };
    };
    expect(user.message.content).toContain(YOUTUBE_PROMPT);
    expect(YOUTUBE_PROMPT).toContain("says YouTube");
    expect(YOUTUBE_PROMPT).toContain("Spotify does not have");

    const listed = await rpc(mcpConfig!, { method: "tools/list" });
    expect(
      listed.result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual([
      "play",
      "pause",
      "resume",
      "stop",
      "volume",
      "seek",
      "now_playing",
    ]);
    const played = await rpc(mcpConfig!, {
      method: "tools/call",
      params: { name: "play", arguments: { query: "around the world" } },
    });
    expect(calls).toEqual(["play around the world"]);
    expect(played.result.isError).toBeUndefined();
    expect(played.result.content[0].text).toContain(
      'Playing on YouTube: "Around the World" (Daft Punk), 0:03 of 4:02',
    );
    expect(played.result.content[0].text).toContain("Spotify was paused");
    await rpc(mcpConfig!, {
      method: "tools/call",
      params: { name: "seek", arguments: { by: 30 } },
    });
    expect(calls.at(-1)).toBe('seek {"by":30}');

    // The job's server ends with the job.
    process.push(result("C'est parti sur YouTube."));
    await settle();
    await settle();
    expect(await rpc(mcpConfig!, { method: "tools/list" })).toBe(401);
  });

  test("a video that cannot play is told with its reason", async () => {
    const { player } = fakeYoutube(async () => {
      throw new YoutubeError("Video unavailable");
    });
    const { using, spawned } = configured({}, player);
    using.start("Mets la vidéo sur YouTube");
    const failed = await rpc(spawned[0]!.mcpConfig!, {
      method: "tools/call",
      params: { name: "play", arguments: { query: "x" } },
    });
    expect(failed.result.isError).toBe(true);
    expect(failed.result.content[0].text).toBe(
      "The video could not be played: Video unavailable",
    );
  });

  test("off without call_background, or with youtube_sink false", () => {
    for (const config of [
      { call_background: undefined },
      { youtube_sink: false },
    ]) {
      const { using, spawned } = configured(config);
      using.start("Mets du Daft Punk", true);
      expect(spawned[0]!.mcpConfig).toBeUndefined();
      expect(askRules(spawned[0]!.policy)).not.toContain(
        "mcp__roamgate_youtube",
      );
      const user = spawned[0]!.process.written.find(
        (each) => each.type === "user",
      ) as { message: { content: string } };
      expect(user.message.content).not.toContain("roamgate_youtube");
    }
  });

  test("Spotify starting on the call's device stops YouTube; anything else leaves it", async () => {
    const spawned: { process: Fake; mcpConfig?: string }[] = [];
    let stopped = 0;
    let closed = 0;
    const using = new VoiceTools(
      (mcpConfig) => {
        const process = fakeProcess();
        spawned.push({ process, mcpConfig });
        return process as ToolProcess;
      },
      () => ({ allow: [...POLICY.allow!, "mcp__claude_ai_Spotify*__play"] }),
      { limit: 60_000, kept: 60_000, held: 60_000 },
      undefined,
      () => ({ name: "amd-desktop", fullVolume: true }),
      () => ({
        open: () => ({
          config: '{"mcpServers":{}}',
          close: () => {
            closed += 1;
          },
        }),
        spotifyStarted: () => {
          stopped += 1;
        },
      }),
    );
    using.start("Remets Spotify");
    const { process, mcpConfig } = spawned[0]!;
    expect(mcpConfig).toBe('{"mcpServers":{}}');
    process.push(asks("r1", "mcp__spotify__pause", {}));
    process.push(asks("r2", "mcp__claude_ai_Youtube__x", {}));
    await settle();
    expect(stopped).toBe(0);
    // Someone else's phone on the same account, or no device named (the
    // player itself stops if the desktop's Spotify app starts playing).
    process.push(
      asks("r3", "mcp__spotify__play", { query: "x", device: "Simon's phone" }),
    );
    process.push(asks("r3b", "mcp__spotify__resume", {}));
    await settle();
    expect(stopped).toBe(0);
    process.push(
      asks("r3c", "mcp__spotify__play", { query: "x", device: "amd-desktop" }),
    );
    await settle();
    expect(stopped).toBe(1);
    process.push(
      asks("r4", "mcp__claude_ai_Spotify__play", { device: "AMD-Desktop" }),
    );
    process.push(asks("r5", "mcp__spotify__resume", { device: "amd-desktop" }));
    await settle();
    expect(stopped).toBe(3);
    // A refused Spotify call starts nothing.
    process.push(
      asks("r6", "mcp__claude_ai_Spotify__resume", { device: "amd-desktop" }),
    );
    await settle();
    expect(process.answer("r6")?.behavior).toBe("deny");
    expect(stopped).toBe(3);
    process.push(result("C'est reparti."));
    await settle();
    await settle();
    expect(closed).toBe(1);
  });

  test("which calls start Spotify on the call's music device", () => {
    const here = { device: "amd-desktop" };
    const device = "amd-desktop";
    expect(startsSpotify("mcp__spotify__play", here, device)).toBe(true);
    expect(startsSpotify("mcp__claude_ai_Spotify__resume", here, device)).toBe(
      true,
    );
    expect(startsSpotify("mcp__spotify__transfer", here, device)).toBe(true);
    expect(
      startsSpotify(
        "mcp__spotify__play",
        { device_name: "AMD-desktop" },
        device,
      ),
    ).toBe(true);
    expect(startsSpotify("mcp__spotify__pause", here, device)).toBe(false);
    expect(startsSpotify("mcp__spotify__now_playing", here, device)).toBe(
      false,
    );
    expect(startsSpotify("mcp__roamgate_youtube__play", here, device)).toBe(
      false,
    );
    expect(startsSpotify("mcp__spotify", here, device)).toBe(false);
    // Another device, none named, no call device known, or not playing.
    expect(
      startsSpotify("mcp__spotify__play", { device: "Simon's phone" }, device),
    ).toBe(false);
    expect(startsSpotify("mcp__spotify__resume", {}, device)).toBe(false);
    expect(startsSpotify("mcp__spotify__play", here)).toBe(false);
    expect(
      startsSpotify(
        "mcp__spotify__transfer",
        { device: "amd-desktop", play: false },
        device,
      ),
    ).toBe(false);
  });

  test("Roamgate's servers go to the job's Claude Code", () => {
    const args = toolArgs("sonnet", "claude", POLICY, '{"mcpServers":{}}');
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(args).not.toContain("--strict-mcp-config");
    expect(toolArgs("sonnet", "claude", POLICY)).not.toContain("--mcp-config");
  });
});
