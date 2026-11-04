import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCommand, createMrClaude } from "./claude";
import { openMrStore } from "./store";

const A = "gitlab:h/g/p#1";
const B = "gitlab:h/g/p#2";

function setup(options: { hookless?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mr-claude-"));
  const store = openMrStore(join(dir, "state.json"));
  store.update((state) => {
    state.projects["h/g/p"] = {
      connectionId: "c",
      clone: "/src/p",
      worktree: "/src/p.worktrees/review",
      workspaceId: "w1",
    };
    state.reviews[A] = {
      connectionId: "c",
      sessionId: "rA",
      workspaceId: "w1",
    };
    state.reviews[B] = {
      connectionId: "c",
      sessionId: "rB",
      workspaceId: "w1",
    };
  });
  // The pane: a shell, or claude on a session, idle or working.
  const pane: { agent: string | null; session: string | null; status: string } =
    {
      agent: null,
      session: null,
      status: "unknown",
    };
  const typed: string[] = [];
  const reviews: unknown[] = [];
  const claude = createMrClaude({
    inbox: {
      item: (key: string) =>
        key === A || key === B
          ? ({ host: "h", project: "g/p" } as any)
          : undefined,
    },
    store,
    connections: () => [
      {
        id: "c",
        label: "C",
        run: async () => ({ code: 0, stdout: "", stderr: "" }),
        dirs: async () => [],
        herdr: async (method, params: any) => {
          if (method === "pane.list")
            return {
              panes: [
                { pane_id: "w1:p1", workspace_id: "w1" },
                { pane_id: "w2:p1", workspace_id: "w2" },
              ],
            };
          if (method === "agent.get") {
            if (!pane.agent) throw new Error("agent_not_found");
            return {
              agent: {
                agent: pane.agent,
                agent_status: pane.status,
                agent_session:
                  pane.session && !options.hookless
                    ? { kind: "id", value: pane.session }
                    : null,
              },
            };
          }
          if (method === "pane.send_text") {
            expect(params.pane_id).toBe("w1:p1");
            typed.push(params.text);
            if (params.text === "/exit\r") {
              if (pane.status === "working")
                throw new Error("typed into a busy Claude");
              pane.agent = null;
              pane.session = null;
            } else {
              const id = /--(?:resume|session-id) ([0-9a-f-]{36})/.exec(
                params.text,
              )?.[1];
              pane.agent = "claude";
              pane.session = id ?? null;
              pane.status = "idle";
            }
          }
          return {};
        },
      },
    ],
    requestReview: async (params) => {
      reviews.push(params);
    },
    sleep: async () => {},
    waitMs: 50,
    pollMs: 10,
  });
  return { dir, store, pane, typed, reviews, claude };
}

describe("one Claude per review workspace, a session per request", () => {
  test("the command stays in the terminal and resumes or starts", () => {
    const id = "0b1c2d3e-0000-4000-8000-000000000001";
    expect(claudeCommand(id, false)).toBe(
      ` env ROAMGATE_CLAUDE_START=terminal claude --session-id ${id}\r`,
    );
    expect(claudeCommand(id, true)).toContain(
      `claude --resume ${id} || claude --session-id ${id}`,
    );
    expect(() => claudeCommand("x; rm -rf ~", true)).toThrow();
  });

  test("Review with Claude starts the request's session and asks the review", async () => {
    const t = setup();
    try {
      const state = await t.claude.review(A, "error paths");
      expect(state.state).toBe("ready");
      const session = t.store.get().reviews[A]!.claudeSession!;
      expect(t.typed).toEqual([claudeCommand(session, false)]);
      expect(t.reviews).toEqual([
        { sessionId: "rA", paneId: "w1:p1", focus: "error paths" },
      ]);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("switching resumes the other request's session; never while busy", async () => {
    const t = setup();
    try {
      await t.claude.ensure(A, { start: true });
      await t.claude.ensure(B, { start: true });
      const a = t.store.get().reviews[A]!.claudeSession!;
      const b = t.store.get().reviews[B]!.claudeSession!;
      expect(t.pane.session).toBe(b);
      // Back to A: /exit then resume A's session.
      t.typed.length = 0;
      expect((await t.claude.ensure(A, { start: false })).state).toBe("ready");
      expect(t.typed).toEqual(["/exit\r", claudeCommand(a, true)]);
      // A busy: only reported; nothing typed.
      t.pane.status = "working";
      t.typed.length = 0;
      expect(await t.claude.ensure(B, { start: false })).toEqual({
        state: "busy",
        paneId: "w1:p1",
        with: A,
      });
      expect(t.typed).toEqual([]);
      // Waiting: still busy at the deadline, still nothing typed.
      expect(
        (await t.claude.ensure(B, { start: false, wait: true })).state,
      ).toBe("busy");
      expect(t.typed).toEqual([]);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("without Claude's session hook, the session started there is known", async () => {
    const t = setup({ hookless: true });
    try {
      await t.claude.ensure(A, { start: true });
      const a = t.store.get().reviews[A]!.claudeSession!;
      t.typed.length = 0;
      expect((await t.claude.ensure(A, { start: false })).state).toBe("ready");
      expect(t.typed).toEqual([]);
      await t.claude.ensure(B, { start: true });
      t.typed.length = 0;
      await t.claude.ensure(A, { start: false });
      expect(t.typed).toEqual(["/exit\r", claudeCommand(a, true)]);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("a Claude that is no request's is left alone", async () => {
    const t = setup();
    try {
      t.pane.agent = "claude";
      t.pane.session = "11111111-1111-4111-8111-111111111111";
      t.pane.status = "idle";
      expect((await t.claude.review(A)).state).toBe("foreign");
      expect(t.typed).toEqual([]);
      expect(t.reviews).toEqual([]);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("a request without a session: nothing started by a switch", async () => {
    const t = setup();
    try {
      expect((await t.claude.ensure(A, { start: false })).state).toBe("none");
      expect(t.typed).toEqual([]);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});
