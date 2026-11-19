import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createAgentSessionHandlers } from "./agent-sessions";
import type { AgentSessionFileAccess } from "./session-file-access";
import type { AgentTask } from "./session-tasks";
import type { SessionFile } from "./session-types";

afterEach(() => setSystemTime());

const assistant = (
  message: string,
  at: string,
  id: string,
  name: string,
  input: Record<string, unknown>,
) => ({
  type: "assistant",
  timestamp: at,
  message: {
    role: "assistant",
    id: message,
    content: [{ type: "tool_use", id, name, input }],
  },
});
const answer = (id: string, at: string, text: string, taskId?: string) => ({
  type: "user",
  timestamp: at,
  toolUseResult: taskId ? { backgroundTaskId: taskId } : {},
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: text }],
  },
});

/** Two sessions, each in its own pane, each with its own background work. */
const sessions: Record<string, Record<string, unknown>[]> = {
  "/tmp/rg-two/aaaa.jsonl": [
    assistant("ma1", "2026-11-19T10:00:00.000Z", "a1", "Bash", {
      command: "gh run list -R someone/else",
      description: "Wait for CI elsewhere",
      run_in_background: true,
    }),
    answer("a1", "2026-11-19T10:00:01.000Z", "Running in background", "ba1"),
  ],
  "/tmp/rg-two/bbbb.jsonl": [
    assistant("mb1", "2026-11-19T11:00:00.000Z", "b1", "Bash", {
      command: "cargo build",
      description: "Build in the background",
      run_in_background: true,
    }),
    answer("b1", "2026-11-19T11:00:01.000Z", "Running in background", "bb1"),
    assistant("mb2", "2026-11-19T11:05:00.000Z", "b2", "Bash", {
      command: "cargo tauri android build",
      description: "Build the Android app",
    }),
  ],
};
const panes: Record<string, string> = {
  p1: "/tmp/rg-two/aaaa.jsonl",
  p2: "/tmp/rg-two/bbbb.jsonl",
};

function handlers() {
  const bytes = (path: string) =>
    Buffer.from(
      `${(sessions[path] ?? []).map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
  const file = (path: string): SessionFile => ({
    path,
    mtimeMs: 1000,
    size: bytes(path).length,
    identity: path,
    changeToken: "1",
  });
  const files: AgentSessionFileAccess = {
    remote: false,
    statFile: async (path) => (sessions[path] ? file(path) : null),
    readText: async (path) => bytes(path).toString("utf8"),
    readPrefix: async (path, limit) => bytes(path).subarray(0, limit),
    readTail: async (path, limit) => {
      const all = bytes(path);
      return all.subarray(Math.max(0, all.length - limit));
    },
    readDownloadBody: async (path) => new Uint8Array(bytes(path)),
    findPiSessionForCwd: async () => null,
    findPiSessionById: async () => null,
    findClaudeSessionById: async () => null,
    findClaudeSuccessor: async () => null,
    findCodexSessionById: async () => null,
  };
  return createAgentSessionHandlers({
    files,
    herdrCall: async (_method, params) => ({
      agent: {
        agent: "claude",
        agent_session: {
          kind: "path",
          value: panes[String(params?.target)],
        },
      },
    }),
  });
}

type Read = { tasks: AgentTask[]; running_now: AgentTask[]; session: string };

test("two sessions' tasks never mix", async () => {
  setSystemTime(new Date("2026-11-19T11:06:00.000Z"));
  const read = handlers();
  const first = (await read.readTasks({
    pane_id: "p1",
    agent: "claude",
  })) as Read;
  const second = (await read.readTasks({
    pane_id: "p2",
    agent: "claude",
  })) as Read;
  expect(first.session).toBe("aaaa");
  expect(first.tasks.map((task) => task.id)).toEqual(["a1"]);
  expect(first.running_now).toEqual([]);
  expect(second.session).toBe("bbbb");
  expect(second.tasks.map((task) => task.id)).toEqual(["b1"]);
  // Read again after the other: still only its own.
  const again = (await read.readTasks({
    pane_id: "p1",
    agent: "claude",
  })) as Read;
  expect(again.tasks.map((task) => task.id)).toEqual(["a1"]);
});

test("the foreground command a session runs shows, apart from its tasks", async () => {
  setSystemTime(new Date("2026-11-19T11:06:00.000Z"));
  const read = handlers();
  const tasks = (await read.readTasks({
    pane_id: "p2",
    agent: "claude",
  })) as Read;
  expect(tasks.running_now).toMatchObject([
    {
      id: "b2",
      title: "Build the Android app",
      detail: "cargo tauri android build",
      status: "running",
      foreground: true,
      startedAt: "2026-11-19T11:05:00.000Z",
    },
  ]);
  expect(tasks.tasks.some((task) => task.foreground)).toBe(false);
  // A call a session that died left with no answer is not running hours on.
  setSystemTime(new Date("2026-11-19T14:00:00.000Z"));
  const later = (await handlers().readTasks({
    pane_id: "p2",
    agent: "claude",
  })) as Read;
  expect(later.running_now).toEqual([]);
});
