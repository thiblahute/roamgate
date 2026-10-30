import { expect, test } from "bun:test";
import type { AgentChatShell } from "../../shared/agentChat";
import type { HistoryEntry } from "./components/agentHistory";
import { withShellOutcomes } from "./shellOutcomes";

const entry = (id: string, command?: string): HistoryEntry => ({
  id,
  role: "user",
  kind: "message",
  text: command ?? "hello",
  sent_at: "2026-11-01T00:00:00Z",
  ...(command !== undefined ? { shell: { command, stdout: "" } } : {}),
});
const run = (id: string, command: string, exit: number): AgentChatShell => ({
  id,
  command,
  status: "done",
  stdout: "",
  stderr: "",
  truncated: false,
  exit_code: exit,
  cwd: "/repo",
  started_at: "2026-11-01T00:00:00Z",
  finished_at: "2026-11-01T00:00:02Z",
  delivered: true,
});

test("the transcript's `!` lines get the host, and how the runs sent from here ended", () => {
  const entries = [
    entry("a", " make"),
    entry("b"),
    entry("c", " make"),
    entry("d", " ls"),
  ];
  const shown = withShellOutcomes(
    entries,
    [run("1", " make", 2), run("2", "ls", 0)],
    "desktop",
  );
  // The newest `make` is the run kept; the older one only gets the host.
  expect(shown.map((each) => each.shell ?? null)).toEqual([
    { command: " make", stdout: "", host: "desktop" },
    null,
    {
      command: " make",
      stdout: "",
      host: "desktop",
      status: "done",
      exit_code: 2,
      started_at: "2026-11-01T00:00:00Z",
      finished_at: "2026-11-01T00:00:02Z",
      cwd: "/repo",
    },
    expect.objectContaining({ command: " ls", exit_code: 0, cwd: "/repo" }),
  ]);
  expect(shown[1]).toBe(entries[1]!);
  // Nothing to add: the same array.
  expect(withShellOutcomes(entries, [], undefined)).toBe(entries);
  const plain = [entry("x")];
  expect(withShellOutcomes(plain, [run("1", "ls", 0)], "desktop")).toBe(plain);
});
