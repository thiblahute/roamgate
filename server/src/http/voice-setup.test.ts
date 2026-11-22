import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { recommendedChoices } from "../voice/voice-models";
import { VoiceSetupRunner } from "../voice/voice-setup";
import {
  CPU_LAPTOP,
  type SetupHome,
  serveModels,
  setupHome,
} from "../voice/voice-setup-testing";
import { VOICE_REQUEST_HEADER } from "./voice";
import { createVoiceSetupRoute } from "./voice-setup";

const server = serveModels();
afterAll(() => server.stop());

let home: SetupHome;
let runner: VoiceSetupRunner;
let route: ReturnType<typeof createVoiceSetupRoute>;
beforeEach(() => {
  home = setupHome(server, CPU_LAPTOP);
  runner = new VoiceSetupRunner(home.deps, () => "not-running");
  route = createVoiceSetupRoute(runner);
});
afterEach(() => home.cleanup());

const json = (response: Response | null) => {
  if (!response) throw new Error("no response");
  return response.json();
};

const post = (path: string, body: unknown, header = true) =>
  route(
    new Request(`http://roamgate${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(header ? { [VOICE_REQUEST_HEADER]: "1" } : {}),
      },
      body: JSON.stringify(body),
    }),
    path,
  );

describe("/api/voice/setup", () => {
  test("GET is the assistant's state, not cached", async () => {
    const response = await route(
      new Request("http://roamgate/api/voice/setup"),
      "/api/voice/setup",
    );
    expect(response?.headers.get("cache-control")).toBe("no-store");
    const state = await json(response);
    expect(state.tier).toBe("light");
    expect(state.job).toBeNull();
  });

  test("POST starts the download, followed by GET until done", async () => {
    const choices = recommendedChoices(CPU_LAPTOP).light;
    const response = await post("/api/voice/setup", { choices });
    expect(response?.status).toBe(202);
    expect((await json(response)).job.state).toBe("downloading");
    expect((await post("/api/voice/setup", { choices }))?.status).toBe(409);
    while (runner.running) await Bun.sleep(5);
    const state = await json(
      await route(
        new Request("http://roamgate/api/voice/setup"),
        "/api/voice/setup",
      ),
    );
    expect(state.job.state).toBe("done");
    expect(state.current.tts).toBe(choices.tts);
  });

  test("changes need the voice header and valid choices", async () => {
    expect(
      (await post("/api/voice/setup", { choices: {} }, false))?.status,
    ).toBe(403);
    expect(
      (await post("/api/voice/setup", { choices: { tts: 3 } }))?.status,
    ).toBe(400);
    expect(
      (await post("/api/voice/setup", { choices: { wings: "x" } }))?.status,
    ).toBe(400);
    const unknown = await post("/api/voice/setup", {
      choices: { tts: "nope" },
    });
    expect(unknown?.status).toBe(400);
    expect((await json(unknown)).error).toContain("nope");
    expect((await post("/api/voice/setup/remove", { ids: 3 }))?.status).toBe(
      400,
    );
  });

  test("remove answers what it freed; cancel with nothing running is fine", async () => {
    const removed = await post("/api/voice/setup/remove", { ids: "all" });
    expect((await json(removed)).freedBytes).toBe(0);
    expect((await post("/api/voice/setup/cancel", {}))?.status).toBe(200);
  });

  test("other paths are not its", async () => {
    expect(
      await route(new Request("http://roamgate/api/voice"), "/api/voice"),
    ).toBeNull();
  });
});
