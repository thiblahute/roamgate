import { describe, expect, test } from "bun:test";
import type { VoiceErrands } from "../voice/voice-errands";
import type { VoiceHelper } from "../voice/voice-helper";
import { VoiceError, type VoiceLibrary } from "../voice/voice-library";
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
});
