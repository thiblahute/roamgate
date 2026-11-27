import { describe, expect, test } from "bun:test";
import type { AccountUsage } from "./accountUsage";
import {
  chipText,
  nameSession,
  nextInChain,
  periodStart,
  shortCount,
  sortSessions,
  tightestWindow,
  warnLevel,
  type LivePane,
  type SessionRun,
} from "./usageView";

const NOW = Date.parse("2026-11-27T12:00:00Z");
const later = "2026-11-27T15:00:00Z";
const past = "2026-11-27T10:00:00Z";

function reading(
  agent: string,
  id: string,
  windows: [string, number, string?][],
): AccountUsage {
  return {
    agent,
    id,
    status: "fresh",
    usage: {
      windows: windows.map(([label, utilization, resets_at]) => ({
        label,
        utilization,
        resets_at: resets_at ?? later,
      })),
    },
  };
}

const profiles = [
  { name: "Work", agent: "claude", account: { id: "work", auth: "signed_in" } },
  {
    name: "Perso",
    agent: "claude",
    account: { id: "perso", auth: "signed_in" },
  },
  { name: "Codex", agent: "codex", account: { id: "c", auth: "signed_out" } },
  { name: "GLM", agent: "claude" },
];

describe("usage view", () => {
  test("the tightest window is the most used of the live ones", () => {
    const usage = reading("claude", "work", [
      ["5h", 40],
      ["7d", 61],
      ["7d opus", 99, past],
    ]);
    expect(tightestWindow(usage, NOW)?.label).toBe("7d");
    expect(tightestWindow(undefined, NOW)).toBeNull();
    expect(warnLevel(79)).toBe("ok");
    expect(warnLevel(80)).toBe("warn");
    expect(warnLevel(95)).toBe("high");
  });

  test("the chip names the default account and its tightest window", () => {
    const board = new Map([
      ["claude/work", reading("claude", "work", [["5h", 82]])],
    ]);
    expect(chipText(profiles, "Work", board, NOW)).toEqual({
      name: "Work",
      window: { label: "5h", utilization: 82, resets_at: later },
      level: "warn",
    });
    expect(chipText(profiles, "GLM", board, NOW)).toBeNull();
    expect(chipText(profiles, "Perso", board, NOW)?.window).toBeNull();
  });

  test("the chain's next account has headroom and is signed in", () => {
    const board = new Map([
      ["claude/work", reading("claude", "work", [["5h", 96]])],
      ["claude/perso", reading("claude", "perso", [["7d", 98.5]])],
    ]);
    const chain = {
      accounts: ["Work", "Perso", "Codex"],
      auto_switch: true,
      five_hour_line: 95,
      weekly_line: 98,
      walk: "chain" as const,
    };
    expect(nextInChain(chain, profiles, "Work", board, NOW)).toBeNull();
    const roomy = new Map([
      ["claude/perso", reading("claude", "perso", [["7d", 50]])],
    ]);
    expect(nextInChain(chain, profiles, "Work", roomy, NOW)).toBe("Perso");
    expect(
      nextInChain(
        { ...chain, lines: { Perso: { weekly: 40 } } },
        profiles,
        "Work",
        roomy,
        NOW,
      ),
    ).toBeNull();
    expect(nextInChain(undefined, profiles, "Work", roomy, NOW)).toBeNull();
  });

  test("sessions are named by their pane, else their title, never their id", () => {
    const panes: LivePane[] = [
      {
        connectionId: "local",
        runtimeGeneration: 1,
        pane_id: "p1",
        workspace_id: "w1",
        serverLabel: "Desktop",
        workspaceLabel: "roamgate",
        tabLabel: "agents",
        terminal_title_stripped: "Fix the usage chip",
      },
    ];
    const run = (over: Partial<SessionRun>): SessionRun => ({
      session_id: "11111111-2222-4333-8444-555555555555",
      profile: "Work",
      started_at: NOW,
      ended_at: null,
      tokens: { input_tokens: 10, output_tokens: 2 },
      ...over,
    });
    const live = nameSession(
      run({ pane: { connection_id: "local", pane_id: "p1" } }),
      panes,
    );
    expect([live.name, live.place, !!live.live]).toEqual([
      "Fix the usage chip",
      "roamgate · Desktop",
      true,
    ]);
    const gone = nameSession(
      run({ title: "Port the chain", cwd: "/src/roamgate" }),
      panes,
    );
    expect([gone.name, gone.place, gone.live]).toEqual([
      "Port the chain",
      "roamgate",
      null,
    ]);
    expect(nameSession(run({}), panes).name).toBe("Session 11111111");
    const sorted = sortSessions([
      nameSession(
        run({ tokens: { input_tokens: 1, output_tokens: 1 } }),
        panes,
      ),
      nameSession(
        run({ tokens: { input_tokens: 500, output_tokens: 9 } }),
        panes,
      ),
    ]);
    expect(sorted[0]!.tokensIn).toBe(500);
    expect(shortCount(12_345)).toBe("12.3k");
    expect(shortCount(2_500_000)).toBe("2.5M");
  });

  test("a week starts on Monday", () => {
    const thursday = new Date(2026, 10, 26, 15, 0);
    expect(new Date(periodStart("week", thursday)).getDay()).toBe(1);
    expect(new Date(periodStart("today", thursday)).getDate()).toBe(26);
  });
});
