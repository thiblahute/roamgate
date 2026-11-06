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
  toolArgs,
  toolDecision,
  toolsContext,
  type ToolProcess,
  VoiceTools,
  writesByName,
} from "./voice-tools";

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
