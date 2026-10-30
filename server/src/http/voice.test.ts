import { describe, expect, test } from "bun:test";
import type { VoiceErrands } from "../voice/voice-errands";
import type { VoiceHelper } from "../voice/voice-helper";
import type { VoiceRouter } from "../voice/voice-router";
import { createVoiceRoutes, overviewSessions } from "./voice";

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

describe("questions about another session", () => {
  test("come back with a summary of its conversation's end", async () => {
    const summarized: string[][] = [];
    const router = {
      warm: () => {},
      route: async () => ({
        to: "status",
        pane: "desktop/w1J:p1",
        say: "IGA-184",
      }),
      summarize: async (question: string, session: string, end: string) => {
        summarized.push([question, session, end]);
        return "It waits for you to open the PR.";
      },
    } as unknown as VoiceRouter;
    const read: string[] = [];
    const routes = createVoiceRoutes(
      helper,
      () => router,
      async (connectionId, paneId) => {
        read.push(`${connectionId} ${paneId}`);
        return [{ role: "assistant", text: "Pushed; open the PR." }];
      },
    );
    const response = await routes(
      post(
        { current: "local/w2:p2", said: "What is 184 doing?", sessions: [] },
        { "x-roamgate-voice": "1" },
      ),
      "/api/voice/route",
    );
    expect(await response!.json()).toEqual({
      to: "status",
      pane: "desktop/w1J:p1",
      say: "IGA-184",
      answer: "It waits for you to open the PR.",
    });
    expect(read).toEqual(["desktop w1J:p1"]);
    expect(summarized).toEqual([
      ["What is 184 doing?", "IGA-184", "Agent: Pushed; open the PR."],
    ]);
  });
});

describe("questions about all the sessions", () => {
  const session = (id: string, active?: number) => ({
    id,
    machine: "Mac",
    workspace: id,
    title: `title ${id}`,
    folder: "/src",
    agent: "claude",
    status: "idle",
    ...(active === undefined ? {} : { active }),
  });

  test("cover today's most recently active sessions", () => {
    expect(
      overviewSessions([
        session("local/a", 300),
        session("local/b", 5),
        session("local/c", 3000),
        session("local/d"),
      ]).map((each) => each.id),
    ).toEqual(["local/b", "local/a"]);
  });

  test("are answered from each session's conversation end", async () => {
    let asked: unknown[] = [];
    const router = {
      warm: () => {},
      route: async () => ({ to: "overview" }),
      summarizeAll: async (question: string, ends: unknown[]) => {
        asked = [question, ends];
        return "Two sessions; IGA-184 waits on you.";
      },
    } as unknown as VoiceRouter;
    const routes = createVoiceRoutes(
      helper,
      () => router,
      async (_connectionId, paneId) =>
        paneId === "slow"
          ? new Promise(() => {})
          : [{ role: "assistant", text: `Done in ${paneId}.` }],
    );
    const response = await routes(
      post(
        {
          current: "local/a",
          said: "What did I do today?",
          sessions: [session("local/a", 1), session("desktop/b", 2)],
        },
        { "x-roamgate-voice": "1" },
      ),
      "/api/voice/route",
    );
    expect(await response!.json()).toEqual({
      to: "overview",
      answer: "Two sessions; IGA-184 waits on you.",
    });
    expect(asked).toEqual([
      "What did I do today?",
      [
        {
          name: "title local/a (Mac, idle)",
          conversation: "Agent: Done in a.",
        },
        {
          name: "title desktop/b (Mac, idle)",
          conversation: "Agent: Done in b.",
        },
      ],
    ]);
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
      null,
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
