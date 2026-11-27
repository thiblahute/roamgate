import type { AccountUsage } from "./accountUsage";
import type { UsageViewData } from "./components/UsageView";
import { type LivePane, nameSession, sortSessions } from "./usageView";

/** A Usage view's data as tests and the screenshot harness show it. */
export function usageFixture(now: number): UsageViewData {
  const hour = 3_600_000;
  const at = (offset: number) => new Date(now + offset).toISOString();
  const reading = (
    agent: string,
    id: string,
    windows: [string, number, number][],
    extra: Partial<AccountUsage> = {},
  ): AccountUsage => ({
    agent,
    id,
    status: "fresh",
    read_at: now,
    usage: {
      windows: windows.map(([label, utilization, resets]) => ({
        label,
        utilization,
        resets_at: at(resets * hour),
      })),
      plan: agent === "claude" ? "Max 20x" : "pro",
      email: `${id}@example.com`,
    },
    ...extra,
  });
  const board = new Map<string, AccountUsage>([
    [
      "claude/work",
      reading("claude", "work", [
        ["5h", 61, 3],
        ["7d", 84, 70],
        ["7d opus", 96, 70],
      ]),
    ],
    [
      "claude/perso",
      reading("claude", "perso", [
        ["5h", 12, 4],
        ["7d", 35, 100],
      ]),
    ],
    [
      "codex/codex",
      reading("codex", "codex", [
        ["5h", 3, 2],
        ["7d", 41, 30],
      ]),
    ],
    [
      "agy/second",
      reading("agy", "second", [
        ["5h gemini models", 21, 1],
        ["5h claude and gpt models", 0, 1],
        ["7d gemini models", 23, 150],
      ]),
    ],
  ]);
  const panes: LivePane[] = [
    {
      connectionId: "local",
      runtimeGeneration: 1,
      pane_id: "p1",
      workspace_id: "w1",
      serverLabel: "Desktop",
      workspaceLabel: "roamgate",
      tabLabel: "agents",
      terminal_title_stripped: "Port the account chain",
    },
  ];
  const run = (
    id: string,
    profile: string,
    tokens: [number, number],
    over: Record<string, unknown> = {},
  ) =>
    nameSession(
      {
        session_id: id,
        profile,
        started_at: now - 5 * hour,
        ended_at: null,
        tokens: { input_tokens: tokens[0], output_tokens: tokens[1] },
        ...over,
      },
      panes,
    );
  return {
    profiles: [
      { name: "Claude", agent: "claude" },
      {
        name: "work",
        agent: "claude",
        account: { id: "work", auth: "signed_in", clauth: "work" },
      },
      {
        name: "perso",
        agent: "claude",
        account: { id: "perso", auth: "signed_in" },
      },
      {
        name: "codex",
        agent: "codex",
        account: { id: "codex", auth: "signed_in" },
      },
      {
        name: "Agy 2",
        agent: "agy",
        account: { id: "second", auth: "signed_in" },
      },
    ],
    defaultName: "work",
    chain: {
      accounts: ["work", "perso", "codex", "Agy 2"],
      auto_switch: true,
      five_hour_line: 95,
      weekly_line: 98,
      lines: { work: { five_hour: 90 } },
      walk: "chain",
    },
    board,
    sessions: {
      work: sortSessions([
        run("a1", "work", [182_000, 24_500], {
          pane: { connection_id: "local", pane_id: "p1" },
          pinned: true,
        }),
        run("a2", "work", [1_250_000, 98_000], {
          title: "Review the usage view",
          cwd: "/src/roamgate",
          ended_at: now - hour,
        }),
      ]),
      perso: [
        run("b1", "perso", [44_000, 6_100], {
          title: "Weekend notes",
          cwd: "/home/me/notes",
        }),
      ],
    },
    switches: [
      {
        at: now - 2 * hour,
        kind: "default",
        from: "perso",
        to: "work",
        why: "preferred_day",
        ok: true,
      },
      {
        at: now - 26 * hour,
        kind: "session",
        from: "work",
        to: "perso",
        why: "usage_limit",
        ok: true,
      },
    ],
    period: "week",
    now,
  };
}
