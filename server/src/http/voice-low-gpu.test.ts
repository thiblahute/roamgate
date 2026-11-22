import { describe, expect, test } from "bun:test";
import type { VoiceLowGpu } from "../voice/voice-low-gpu";
import { VOICE_REQUEST_HEADER } from "./voice";
import { createVoiceLowGpuRoute } from "./voice-low-gpu";

function stub() {
  const calls: unknown[] = [];
  const profile = {
    status: () => ({ active: calls.length > 0 }),
    hold: async (change: unknown) => {
      calls.push(change);
      return "after-call";
    },
    apply: async (now: boolean) => {
      calls.push({ apply: now });
      return "now";
    },
  };
  return {
    calls,
    route: createVoiceLowGpuRoute(profile as unknown as VoiceLowGpu),
  };
}

const post = (body: unknown, header = true) =>
  new Request("http://x/api/voice/low-gpu", {
    method: "POST",
    headers: header ? { [VOICE_REQUEST_HEADER]: "1" } : {},
    body: JSON.stringify(body),
  });

describe("/api/voice/low-gpu", () => {
  test("GET says its status", async () => {
    const { route } = stub();
    const response = await route(
      new Request("http://x/api/voice/low-gpu"),
      "/api/voice/low-gpu",
    );
    expect(await response?.json()).toEqual({ active: false });
    expect(await route(new Request("http://x/"), "/api/voice")).toBeNull();
  });

  test("POST holds it or lets it go, with the voice header only", async () => {
    const { route, calls } = stub();
    expect(
      (await route(post({ on: true }, false), "/api/voice/low-gpu"))?.status,
    ).toBe(403);
    const held = await route(
      post({ on: true, holder: "gaming", now: true }),
      "/api/voice/low-gpu",
    );
    expect(await held?.json()).toEqual({ active: true, applied: "after-call" });
    await route(post({ on: false }), "/api/voice/low-gpu");
    expect(calls).toEqual([
      { on: true, holder: "gaming", now: true },
      { on: false, now: false },
    ]);
  });

  test("now alone switches a call without holding", async () => {
    const { route, calls } = stub();
    const response = await route(post({ now: true }), "/api/voice/low-gpu");
    expect(await response?.json()).toMatchObject({ applied: "now" });
    expect(calls).toEqual([{ apply: true }]);
  });

  test("refuses a bad request", async () => {
    const { route } = stub();
    expect((await route(post({}), "/api/voice/low-gpu"))?.status).toBe(400);
    expect(
      (await route(post({ on: true, holder: "a b" }), "/api/voice/low-gpu"))
        ?.status,
    ).toBe(400);
  });
});
