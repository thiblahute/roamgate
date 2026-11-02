import { describe, expect, test } from "bun:test";
import type { VoiceErrands } from "../voice/voice-errands";
import type { VoiceHelper } from "../voice/voice-helper";
import { VoiceError, type VoiceLibrary } from "../voice/voice-library";
import type { VoiceFront } from "../voice/voice-front";
import type { VoiceRouter } from "../voice/voice-router";
import { createVoiceRoutes } from "./voice";

const helper = {
  status: () => ({ available: true }),
  speechRate: () => 1.2,
} as unknown as VoiceHelper;

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://roamgate.test/api/voice/route", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("voice routes", () => {
  test("routing is reported, and asks the router with valid sessions", async () => {
    const asked: unknown[] = [];
    let warmed = 0;
    const router = {
      warm: () => {
        warmed += 1;
      },
      route: async (request: unknown) => {
        asked.push(request);
        return { to: "nobody" };
      },
    } as unknown as VoiceRouter;
    const routes = createVoiceRoutes(helper, () => router);
    const status = await routes(
      new Request("http://roamgate.test/api/voice"),
      "/api/voice",
    );
    expect(await status!.json()).toEqual({
      available: true,
      route: true,
      speech_rate: 1.2,
    });
    expect(warmed).toBe(1);
    const session = {
      id: "local/w2:p2",
      machine: "Mac",
      workspace: "roamgate",
      title: "roamgate",
      folder: "/src",
      agent: "claude",
      status: "idle",
    };
    const routed = await routes(
      post(
        {
          current: "local/w2:p2",
          said: " Who wants pizza? ",
          sessions: [session, { id: 3 }],
        },
        { "x-roamgate-voice": "1" },
      ),
      "/api/voice/route",
    );
    expect(await routed!.json()).toEqual({ to: "nobody" });
    expect(asked).toEqual([
      { current: "local/w2:p2", said: "Who wants pizza?", sessions: [session] },
    ]);
  });

  test("without a router, or the voice header, it is for the agent on screen", async () => {
    const router = {
      warm: () => {},
      route: async () => ({ to: "nobody" }),
    } as unknown as VoiceRouter;
    const body = { current: "local/w2:p2", said: "Hi", sessions: [] };
    const none = createVoiceRoutes(helper);
    expect(
      await (await none(
        post(body, { "x-roamgate-voice": "1" }),
        "/api/voice/route",
      ))!.json(),
    ).toEqual({ to: "current" });
    const headerless = createVoiceRoutes(helper, () => router);
    expect(
      await (await headerless(post(body), "/api/voice/route"))!.json(),
    ).toEqual({ to: "current" });
  });
});

describe("the voice front", () => {
  const session = {
    id: "local/w2:p2",
    machine: "Mac",
    workspace: "roamgate",
    title: "roamgate",
    folder: "/src",
    agent: "claude",
    status: "working",
  };
  const unused = {
    warm: () => {
      throw new Error("the router is not used with a front");
    },
    route: async () => {
      throw new Error("the router is not used with a front");
    },
  } as unknown as VoiceRouter;

  test("decides in the router's place, and says what it does", async () => {
    const turns: unknown[] = [];
    let warmed = 0;
    const front = {
      warm: () => {
        warmed += 1;
      },
      turn: async (request: unknown) => {
        turns.push(request);
        return { to: "current", reply: "Je transmets." };
      },
    } as unknown as VoiceFront;
    const routes = createVoiceRoutes(
      helper,
      () => unused,
      null,
      () => undefined,
      null,
      () => front,
    );
    const status = await routes(
      new Request("http://roamgate.test/api/voice"),
      "/api/voice",
    );
    expect(await status!.json()).toEqual({
      available: true,
      route: true,
      front: true,
      front_mode: "companion",
      speech_rate: 1.2,
    });
    expect(warmed).toBe(1);
    const routed = await routes(
      post(
        {
          current: "local/w2:p2",
          said: " Rebase it, yes, push. ",
          sessions: [session],
          context: "Ranger tasks:\n- Nightly: active",
        },
        { "x-roamgate-voice": "1" },
      ),
      "/api/voice/route",
    );
    expect(await routed!.json()).toEqual({
      to: "current",
      reply: "Je transmets.",
    });
    expect(turns).toEqual([
      {
        current: "local/w2:p2",
        said: "Rebase it, yes, push.",
        sessions: [session],
        context: "Ranger tasks:\n- Nightly: active",
      },
    ]);
  });

  test("keeps the words the front gives a session only when they are what was said", async () => {
    let answer: unknown = {};
    const front = {
      turn: async () => answer,
    } as unknown as VoiceFront;
    const routes = createVoiceRoutes(
      helper,
      () => null,
      null,
      () => undefined,
      null,
      () => front,
    );
    const route = async (said: string) =>
      (await routes(
        post(
          { current: "local/w2:p2", said, sessions: [session] },
          { "x-roamgate-voice": "1" },
        ),
        "/api/voice/route",
      ))!.json();
    answer = {
      to: "current",
      reply: "Je lance ça.",
      words: "rebase sur main.",
    };
    expect(await route("Demande à roamgate de rebaser sur main.")).toEqual({
      to: "current",
      reply: "Je lance ça.",
      words: "rebase sur main.",
    });
    // Reworded: the words said go whole (no words given).
    answer = { to: "current", reply: "Je lance ça.", words: "update main" };
    expect(await route("Demande à roamgate de rebaser sur main.")).toEqual({
      to: "current",
      reply: "Je lance ça.",
    });
    // An approval: as said.
    answer = { to: "current", words: "vas-y" };
    expect(await route("Oui, vas-y.")).toEqual({ to: "current" });
  });

  test("tells an event, and stays quiet without a front", async () => {
    const front = {
      event: async ({ event }: { event: { text: string } }) =>
        `Heard: ${event.text}`,
    } as unknown as VoiceFront;
    const event = (routes: ReturnType<typeof createVoiceRoutes>) =>
      routes(
        new Request("http://roamgate.test/api/voice/event", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-roamgate-voice": "1",
          },
          body: JSON.stringify({
            current: "local/w2:p2",
            sessions: [session],
            event: "IGA-184 needs input",
          }),
        }),
        "/api/voice/event",
      );
    expect(
      await (await event(
        createVoiceRoutes(
          helper,
          () => null,
          null,
          () => undefined,
          null,
          () => front,
        ),
      ))!.json(),
    ).toEqual({ reply: "Heard: IGA-184 needs input" });
    expect(await (await event(createVoiceRoutes(helper)))!.json()).toEqual({
      reply: "",
    });
  });

  test("gives the front an agent's whole answer, and who wrote it", async () => {
    const told: unknown[] = [];
    const front = {
      event: async (request: { event: unknown }) => {
        told.push(request.event);
        return "Roamgate a fini.";
      },
    } as unknown as VoiceFront;
    const routes = createVoiceRoutes(
      helper,
      () => null,
      null,
      () => undefined,
      null,
      () => front,
    );
    const answer = `Done.\n\n${"x".repeat(3000)}`;
    const response = await routes(
      new Request("http://roamgate.test/api/voice/event", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-roamgate-voice": "1",
        },
        body: JSON.stringify({
          current: "local/w2:p2",
          sessions: [session],
          event: answer,
          kind: "answer",
          agent: "Roamgate",
        }),
      }),
      "/api/voice/event",
    );
    expect(await response!.json()).toEqual({ reply: "Roamgate a fini." });
    // An answer is not cut to an event's thousand characters.
    expect(told).toEqual([{ text: answer, kind: "answer", agent: "Roamgate" }]);
  });

  test("starts the companion's work on a session, its words as said", async () => {
    const started: string[] = [];
    const errands = {
      start: async (pane: string, text: string) => {
        started.push(`${pane}: ${text}`);
        return "job-1";
      },
    } as unknown as VoiceErrands;
    const routes = createVoiceRoutes(helper, () => null, errands);
    const forward = (body: unknown, headers = { "x-roamgate-voice": "1" }) =>
      routes(
        new Request("http://roamgate.test/api/voice/forward", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
        "/api/voice/forward",
      );
    const words = "Lance les tests du serveur, et dis-moi.";
    expect(
      await (await forward({ pane: "local/w2:p2", words }))!.json(),
    ).toEqual({ job: "job-1" });
    expect(started).toEqual([`local/w2:p2: ${words}`]);
    // A terminal-mode session takes it as a conversation one does.
    expect(
      await (await forward({ pane: "local/w9:p9", words }))!.json(),
    ).toEqual({ job: "job-1" });
    expect(started).toEqual([`local/w2:p2: ${words}`, `local/w9:p9: ${words}`]);
    expect((await forward({ pane: "local", words }))!.status).toBe(400);
    expect((await forward({ pane: "local/w2:p2", words: " " }))!.status).toBe(
      400,
    );
    expect(
      (await forward({ pane: "local/w2:p2", words }, {} as never))!.status,
    ).toBe(403);
    expect(started).toHaveLength(2);
  });

  test("keeps what the front does with answers, reported with it", async () => {
    let mode: "companion" | "relay" = "companion";
    const front = { warm: () => {} } as unknown as VoiceFront;
    const routes = createVoiceRoutes(
      helper,
      () => null,
      null,
      () => undefined,
      null,
      () => front,
      () => mode,
      (next) => {
        mode = next;
      },
    );
    const settings = (body: unknown) =>
      routes(
        new Request("http://roamgate.test/api/voice/settings", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-roamgate-voice": "1",
          },
          body: JSON.stringify(body),
        }),
        "/api/voice/settings",
      );
    expect((await settings({ front_mode: "aloud" }))!.status).toBe(400);
    expect(await (await settings({ front_mode: "relay" }))!.json()).toEqual({
      front_mode: "relay",
    });
    const status = await routes(
      new Request("http://roamgate.test/api/voice"),
      "/api/voice",
    );
    expect(((await status!.json()) as { front_mode?: string }).front_mode).toBe(
      "relay",
    );
  });

  test("off, the router decides as it always did", async () => {
    const router = {
      warm: () => {},
      route: async () => ({ to: "nobody" }),
    } as unknown as VoiceRouter;
    const routes = createVoiceRoutes(
      helper,
      () => router,
      null,
      () => undefined,
      null,
      () => null,
    );
    expect(
      await (await routes(
        new Request("http://roamgate.test/api/voice"),
        "/api/voice",
      ))!.json(),
    ).toEqual({ available: true, route: true, speech_rate: 1.2 });
    expect(
      await (await routes(
        post(
          { current: "local/w2:p2", said: "Hi", sessions: [] },
          { "x-roamgate-voice": "1" },
        ),
        "/api/voice/route",
      ))!.json(),
    ).toEqual({ to: "nobody" });
  });
});

describe("errands", () => {
  test("go to the session in the errand folder, followed by a job", async () => {
    let listed: { id: string; errands?: boolean }[] = [];
    const router = {
      warm: () => {},
      route: async (request: { sessions: typeof listed }) => {
        listed = request.sessions;
        return { to: "errand", pane: "local/wF:p5", say: "tasks" };
      },
    } as unknown as VoiceRouter;
    const started: string[] = [];
    const errands = {
      start: async (pane: string, text: string) => {
        started.push(`${pane} ${text}`);
        return "job-1";
      },
      state: (job: string) =>
        job === "job-1"
          ? { done: true, answer: "Sunny.", stalled: false }
          : null,
    } as unknown as VoiceErrands;
    const routes = createVoiceRoutes(
      helper,
      () => router,
      errands,
      () => "/docs/tasks/",
    );
    const session = (id: string, folder: string) => ({
      id,
      machine: "Mac",
      workspace: id,
      title: id,
      folder,
      agent: "claude",
      status: "idle",
    });
    const response = await routes(
      post(
        {
          current: "local/w2:p2",
          said: "Weather tomorrow?",
          sessions: [
            session("local/wF:p5", "/docs/tasks"),
            session("local/wX:p1", "/docs/tasks/subtasks/mails"),
            session("local/w2:p2", "/src/roamgate"),
          ],
        },
        { "x-roamgate-voice": "1" },
      ),
      "/api/voice/route",
    );
    expect(await response!.json()).toEqual({
      to: "errand",
      pane: "local/wF:p5",
      say: "tasks",
      job: "job-1",
    });
    expect(listed.map((each) => [each.id, each.errands ?? false])).toEqual([
      ["local/wF:p5", true],
      ["local/wX:p1", true],
      ["local/w2:p2", false],
    ]);
    expect(started).toEqual(["local/wF:p5 [Voice] Weather tomorrow?"]);
    const state = await routes(
      new Request("http://roamgate.test/api/voice/errand?job=job-1"),
      "/api/voice/errand",
    );
    expect(await state!.json()).toEqual({
      done: true,
      answer: "Sunny.",
      stalled: false,
    });
  });
});

describe("errands said over a reading", () => {
  test("carry the sentence cut off in their voice note", async () => {
    const router = {
      warm: () => {},
      route: async () => ({ to: "errand", pane: "local/wF:p5", say: "tasks" }),
    } as unknown as VoiceRouter;
    const started: string[] = [];
    const errands = {
      start: async (pane: string, text: string) => {
        started.push(`${pane} ${text}`);
        return "job-1";
      },
    } as unknown as VoiceErrands;
    const routes = createVoiceRoutes(helper, () => router, errands);
    await routes(
      post(
        {
          current: "local/w2:p2",
          said: "Weather tomorrow?",
          sessions: [],
          interrupted_at: "The build is green.",
        },
        { "x-roamgate-voice": "1" },
      ),
      "/api/voice/route",
    );
    expect(started).toEqual([
      'local/wF:p5 [Voice, interrupted you at: "The build is green."] Weather tomorrow?',
    ]);
  });

  test("words typed to the companion go as typed", async () => {
    const router = {
      warm: () => {},
      route: async () => ({ to: "errand", pane: "local/wF:p5", say: "tasks" }),
    } as unknown as VoiceRouter;
    const started: string[] = [];
    const errands = {
      start: async (pane: string, text: string) => {
        started.push(`${pane} ${text}`);
        return "job-1";
      },
    } as unknown as VoiceErrands;
    const routes = createVoiceRoutes(helper, () => router, errands);
    await routes(
      post(
        {
          current: "local/w2:p2",
          said: "Weather tomorrow?",
          sessions: [],
          typed: true,
        },
        { "x-roamgate-voice": "1" },
      ),
      "/api/voice/route",
    );
    expect(started).toEqual(["local/wF:p5 Weather tomorrow?"]);
  });
});

describe("questions for Ranger", () => {
  test("come back as they are, for the page to send", async () => {
    const router = {
      warm: () => {},
      route: async () => ({ to: "ranger" }),
    } as unknown as VoiceRouter;
    const routes = createVoiceRoutes(helper, () => router);
    const response = await routes(
      post(
        { current: "local/w2:p2", said: "What did I do today?", sessions: [] },
        { "x-roamgate-voice": "1" },
      ),
      "/api/voice/route",
    );
    expect(await response!.json()).toEqual({ to: "ranger" });
  });
});

describe("voices", () => {
  const voice = { "x-roamgate-voice": "1" };
  /** A library that records what it is asked; `fail` makes it refuse. */
  function fakeLibrary(fail?: VoiceError) {
    const calls: unknown[][] = [];
    const library = {
      state: () => ({
        voices: [{ id: "lea", name: "Léa", languages: ["fr"] }],
        stock: [
          { id: "qwen3-tts:ryan", speaker: "ryan", name: "Ryan", native: "en" },
        ],
        assignments: { all: "lea", languages: {} },
        kokoro: true,
        can_clone: true,
      }),
      create: async (input: { audio: string }) => {
        calls.push(["create", input, await Bun.file(input.audio).text()]);
        if (fail) throw fail;
        return { voice: { id: "tom" }, heard: "hi", kind: "shown" };
      },
      assign: async (...args: unknown[]) => {
        calls.push(["assign", ...args]);
        return { assigned: true };
      },
      rename: (...args: unknown[]) => {
        calls.push(["rename", ...args]);
        if (fail) throw fail;
        return { id: "lea", name: args[1] };
      },
      delete: (...args: unknown[]) => {
        calls.push(["delete", ...args]);
        if (fail) throw fail;
      },
      sampleModels: (id: string) => [{ model: "qwen3-tts", voice: id }],
    } as unknown as VoiceLibrary;
    return { library, calls };
  }
  const spoken: unknown[][] = [];
  const speaking = {
    ...helper,
    speak: async (...args: unknown[]) => {
      spoken.push(args);
      return {
        audio: new TextEncoder().encode("ogg"),
        language: String(args[1]),
        nativeRate: 1,
      };
    },
  } as unknown as VoiceHelper;
  const routesWith = (library: VoiceLibrary) =>
    createVoiceRoutes(
      speaking,
      () => null,
      null,
      () => undefined,
      library,
    );
  const request = (
    path: string,
    method: string,
    body?: BodyInit,
    headers: Record<string, string> = voice,
  ) => new Request(`http://roamgate.test${path}`, { method, body, headers });

  test("are listed, and changed only with the voice header", async () => {
    const { library, calls } = fakeLibrary();
    const routes = routesWith(library);
    const listed = await routes(
      request("/api/voice/voices", "GET", undefined, {}),
      "/api/voice/voices",
    );
    expect((await listed!.json()).voices[0].name).toBe("Léa");
    const refused = await routes(
      request("/api/voice/voices/lea", "DELETE", undefined, {}),
      "/api/voice/voices/lea",
    );
    expect(refused!.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("a recording is uploaded, cloned, then removed", async () => {
    const { library, calls } = fakeLibrary();
    const form = new FormData();
    form.set("name", "Tom");
    form.set("language", "en");
    form.set("text", "Once upon a time");
    form.set("cut", "1");
    form.set("audio", new Blob(["RIFF"], { type: "audio/wav" }), "rec.wav");
    const response = await routesWith(library)(
      request("/api/voice/voices", "POST", form),
      "/api/voice/voices",
    );
    expect(response!.status).toBe(201);
    expect(await response!.json()).toEqual({
      voice: { id: "tom" },
      heard: "hi",
      kind: "shown",
    });
    const [[op, input, audio]] = calls as [
      [string, Record<string, string>, string],
    ];
    expect(op).toBe("create");
    expect(input).toMatchObject({
      name: "Tom",
      language: "en",
      text: "Once upon a time",
      cut: true,
    });
    expect(audio).toBe("RIFF");
    expect(await Bun.file(input.audio!).exists()).toBe(false);
    const empty = await routesWith(library)(
      request("/api/voice/voices", "POST", new FormData()),
      "/api/voice/voices",
    );
    expect(empty!.status).toBe(400);
  });

  test("a refused change says why, with its status", async () => {
    const { library } = fakeLibrary(
      new VoiceError(409, "Léa reads replies: choose another voice first."),
    );
    const response = await routesWith(library)(
      request("/api/voice/voices/lea", "DELETE"),
      "/api/voice/voices/lea",
    );
    expect(response!.status).toBe(409);
    expect((await response!.json()).error).toContain("choose another voice");
  });

  test("choose, rename, delete and hear voices", async () => {
    const { library, calls } = fakeLibrary();
    const routes = routesWith(library);
    const json = (body: unknown) => JSON.stringify(body);
    await routes(
      request(
        "/api/voice/voices/assign",
        "POST",
        json({ voice: "lea", language: "fr" }),
      ),
      "/api/voice/voices/assign",
    );
    await routes(
      request("/api/voice/voices/l%C3%A9a", "PATCH", json({ name: "Lou" })),
      "/api/voice/voices/l%C3%A9a",
    );
    const deleted = await routes(
      request("/api/voice/voices/lea", "DELETE"),
      "/api/voice/voices/lea",
    );
    expect(deleted!.status).toBe(204);
    expect(calls).toEqual([
      ["assign", "lea", "fr"],
      ["rename", "léa", "Lou"],
      ["delete", "lea"],
    ]);
    const sample = await routes(
      request("/api/voice/voices/sample", "POST", json({ voice: "lea" })),
      "/api/voice/voices/sample",
    );
    expect(await sample!.text()).toBe("ogg");
    expect(sample!.headers.get("x-voice-language")).toBe("fr");
    // In the voice's own language, with its models.
    expect(spoken.at(-1)).toEqual([
      "Bonjour ! Voici ma voix. On part à l'aventure ensemble ?",
      "fr",
      [{ model: "qwen3-tts", voice: "lea" }],
    ]);
  });

  test("a stock voice is heard in its own language, or the one asked", async () => {
    const { library } = fakeLibrary();
    const routes = routesWith(library);
    const hear = (body: object) =>
      routes(
        request("/api/voice/voices/sample", "POST", JSON.stringify(body)),
        "/api/voice/voices/sample",
      );
    await hear({ voice: "qwen3-tts:ryan" });
    expect(spoken.at(-1)).toEqual([
      "Hello! This is my voice. Shall we have an adventure together?",
      "en",
      [{ model: "qwen3-tts", voice: "qwen3-tts:ryan" }],
    ]);
    const french = await hear({ voice: "qwen3-tts:ryan", language: "fr" });
    expect(french!.headers.get("x-voice-language")).toBe("fr");
    expect(spoken.at(-1)?.[1]).toBe("fr");
  });
});

describe("surprise voices", () => {
  const voice = { "x-roamgate-voice": "1" };
  const voices = [
    { id: "elo", name: "Éloïse", languages: ["fr"] },
    { id: "oli", name: "Oli", languages: ["fr"] },
    { id: "tib2", name: "tib2", languages: ["en"] },
  ];
  function setup(on = true) {
    let surprise = on;
    const library = {
      state: () => ({ voices, surprise }),
      setSurprise: (next: boolean) => {
        surprise = next;
        return { voices, surprise };
      },
      surpriseVoices: () => (surprise ? voices : null),
      sampleModels: (id: string) => [{ model: "qwen3-tts", voice: id }],
    } as unknown as VoiceLibrary;
    const spoken: unknown[][] = [];
    const speaking = {
      ...helper,
      speak: async (...args: unknown[]) => {
        spoken.push(args);
        return {
          audio: new TextEncoder().encode("ogg"),
          language: "fr",
          nativeRate: 1,
        };
      },
    } as unknown as VoiceHelper;
    const routes = createVoiceRoutes(
      speaking,
      () => null,
      null,
      () => undefined,
      library,
    );
    const say = (text: string, reading?: string) =>
      routes(
        new Request("http://roamgate.test/api/voice/speak", {
          method: "POST",
          headers: { ...voice, "content-type": "application/json" },
          body: JSON.stringify({ text, ...(reading ? { reading } : {}) }),
        }),
        "/api/voice/speak",
      );
    return { routes, say, spoken };
  }

  test("is reported, and turned on and off with the voice header", async () => {
    const { routes } = setup(false);
    const status = await routes(
      new Request("http://roamgate.test/api/voice"),
      "/api/voice",
    );
    expect((await status!.json()).surprise).toBe(false);
    const toggle = (body: unknown, headers: Record<string, string> = voice) =>
      routes(
        new Request("http://roamgate.test/api/voice/voices/surprise", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        "/api/voice/voices/surprise",
      );
    expect((await toggle({ on: true }, {}))!.status).toBe(403);
    expect((await toggle({ on: "yes" }))!.status).toBe(400);
    expect((await (await toggle({ on: true }))!.json()).surprise).toBe(true);
    const again = await routes(
      new Request("http://roamgate.test/api/voice"),
      "/api/voice",
    );
    expect((await again!.json()).surprise).toBe(true);
  });

  test("a reply is read by one voice, the next by another", async () => {
    const { say, spoken } = setup();
    const first = await say("Bonjour, je suis là.", "r1");
    const name = decodeURIComponent(first!.headers.get("x-voice-name")!);
    const id = voices.find((entry) => entry.name === name)!.id;
    // Any of the voices, whatever the reply's language.
    expect(voices.map((entry) => entry.id)).toContain(id);
    expect(spoken[0]).toEqual([
      "Bonjour, je suis là.",
      undefined,
      [{ model: "qwen3-tts", voice: id }],
    ]);
    const second = await say("Et la suite de la réponse.", "r1");
    expect(second!.headers.get("x-voice-name")).toBe(
      first!.headers.get("x-voice-name"),
    );
    const next = await say("Une autre réponse.", "r2");
    expect(next!.headers.get("x-voice-name")).not.toBe(
      first!.headers.get("x-voice-name"),
    );
  });

  test("off, replies are read as voice.json says", async () => {
    const { say, spoken } = setup(false);
    const response = await say("Bonjour.", "r1");
    expect(response!.headers.get("x-voice-name")).toBeNull();
    expect(spoken[0]).toEqual(["Bonjour.", undefined, undefined]);
  });
});
