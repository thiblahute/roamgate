import { describe, expect, test } from "bun:test";
import type { ConnectionClient } from "./api";
import { profilesUpdate } from "./components/AgentProfilesSettings";
import { profileParts } from "./components/ProfileChip";
import {
  activeLimit,
  refreshSessionProfile,
  resetTime,
  retrySession,
  sessionProfileOf,
  switchSessionProfile,
  usageSummary,
} from "./sessionProfiles";

function client(answer: (method: string, params: any) => unknown) {
  const calls: [string, any][] = [];
  const value = {
    connectionId: "c-profiles",
    generation: 1,
    serverRuntimeGeneration: 1,
    call: async (method: string, params?: any) => {
      calls.push([method, params]);
      return answer(method, params);
    },
    isCurrent: () => true,
    acceptsServerGeneration: () => true,
  } as unknown as ConnectionClient;
  return { client: value, calls };
}

const GET = {
  session_id: "s-1",
  owner: "terminal",
  profile: "Claude",
  default: "Claude",
  profiles: [
    { name: "Claude", agent: "claude", label: "Claude", default: true },
    { name: "Igalia GLM", agent: "claude", label: "GLM 5p3", default: false },
  ],
  limit: null,
};

describe("session profiles", () => {
  test("a switch names the session it saw, and reads the pane again", async () => {
    const { client: c, calls } = client((method) =>
      method === "agent_profile.get" ? GET : { ok: true },
    );
    await refreshSessionProfile(c, "p1");
    expect(sessionProfileOf("c-profiles", "p1").data?.session_id).toBe("s-1");
    expect(await switchSessionProfile(c, "p1", "Igalia GLM", 1234)).toEqual({
      ok: true,
    });
    expect(calls[1]).toEqual([
      "agent_profile.switch",
      {
        pane_id: "p1",
        profile: "Igalia GLM",
        session_id: "s-1",
        resets_at: 1234,
      },
    ]);
    expect(calls[2]![0]).toBe("agent_profile.get");
    expect(sessionProfileOf("c-profiles", "p1").switching).toBeNull();
  });

  test("a refusal is kept as the pane's error", async () => {
    const { client: c } = client((method) =>
      method === "agent_profile.get"
        ? GET
        : { ok: false, reason: "Claude is working" },
    );
    expect(await switchSessionProfile(c, "p2", "Igalia GLM")).toEqual({
      ok: false,
      reason: "Claude is working",
    });
    expect(sessionProfileOf("c-profiles", "p2").error).toBe(
      "Claude is working",
    );
  });

  test("settings send back the user's profiles only, secrets as paths", () => {
    expect(
      profilesUpdate({
        profiles: [
          {
            name: "Claude",
            agent: "claude",
            builtin: true,
            env: [],
            unset: [],
          },
          {
            name: "GLM",
            agent: "claude",
            builtin: false,
            env: [
              { name: "ANTHROPIC_MODEL", value: "glm-5p3" },
              { name: "ANTHROPIC_AUTH_TOKEN", file: "~/t", problem: "x" },
            ],
            unset: [],
          },
        ],
        default: "GLM",
        return_after_reset: false,
      }),
    ).toEqual({
      list: [
        {
          name: "GLM",
          agent: "claude",
          env: [
            { name: "ANTHROPIC_MODEL", value: "glm-5p3" },
            { name: "ANTHROPIC_AUTH_TOKEN", file: "~/t" },
          ],
          unset: [],
        },
      ],
      default: "GLM",
      return_after_reset: false,
    });
  });
});

describe("usage limit notice", () => {
  const limit = {
    kind: "session",
    resets: "5:20pm (America/Santiago)",
    resets_at: Date.UTC(2026, 10, 5, 20, 20),
    zone: "America/Santiago",
    at: Date.UTC(2026, 10, 5, 17, 0),
    message: "You've hit your session limit · resets 5:20pm (America/Santiago)",
  };
  const now = Date.UTC(2026, 10, 5, 18, 0);

  test("shown until retried or past its reset", () => {
    const data = { ...GET, limit } as any;
    expect(activeLimit({ data, retriedAt: null }, now)).toBe(limit);
    expect(activeLimit({ data, retriedAt: limit.at + 1 }, now)).toBeNull();
    // A newer limit after the retry shows again.
    expect(activeLimit({ data, retriedAt: limit.at - 1 }, now)).toBe(limit);
    expect(
      activeLimit({ data, retriedAt: null }, limit.resets_at + 1),
    ).toBeNull();
  });

  test("the reset in local time, its zone only when another", () => {
    const local = resetTime(limit, now, "America/Santiago");
    expect(local).not.toContain("Santiago");
    expect(resetTime(limit, now, "Europe/Paris")).toContain("(Santiago time)");
    expect(resetTime({ ...limit, resets_at: null, resets: "soon" }, now)).toBe(
      "soon",
    );
  });

  test("retry tells the session to go on, then hides the notice", async () => {
    const { client: c, calls } = client(() => ({ ok: true }));
    expect(await retrySession(c, "p3")).toEqual({ ok: true });
    expect(calls).toEqual([["agent_profile.retry", { pane_id: "p3" }]]);
    expect(sessionProfileOf("c-profiles", "p3").retriedAt).not.toBeNull();
  });

  test("a narrow header keeps the icons only, a wide one the words", () => {
    expect(profileParts(0, true, true, true)).toEqual({
      limitLabel: false,
      next: false,
      chipLabel: false,
    });
    expect(profileParts(150, true, true, true)).toEqual({
      limitLabel: true,
      next: false,
      chipLabel: false,
    });
    expect(profileParts(1000, true, true, true)).toEqual({
      limitLabel: true,
      next: true,
      chipLabel: true,
    });
    expect(profileParts(90, false, true, true).chipLabel).toBe(true);
  });
});

test("a Claude mod's usage reads as one short line", () => {
  expect(usageSummary(undefined)).toBeNull();
  expect(usageSummary({ model: "opus" })).toBeNull();
  expect(
    usageSummary({
      context: { percent: 33.6 },
      rate_limits: [
        { kind: "five_hour", percent_used: 61 },
        { kind: "seven_day", percent_used: 15.2 },
        { kind: "spend_limit", percent_used: 3 },
      ],
    }),
  ).toBe("Context 34% · 5-hour 61% · weekly 15% · spend limit 3%");
});
