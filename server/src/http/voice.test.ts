import { describe, expect, test } from "bun:test";
import type { VoiceErrands } from "../voice/voice-errands";
import type { VoiceHelper } from "../voice/voice-helper";
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
