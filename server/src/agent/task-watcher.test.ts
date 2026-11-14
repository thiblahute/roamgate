import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  realpathSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionFileAccess } from "./session-file-access";
import type { AgentTask } from "./session-tasks";
import { createTaskWatcher } from "./agent-sessions";

const linux = process.platform === "linux";
const MINUTE = 60_000;

function localFiles(remote = false) {
  return {
    remote,
    statFile: async (path: string) => {
      const stat = statSync(path);
      return { mtimeMs: stat.mtimeMs };
    },
  } as unknown as AgentSessionFileAccess;
}

test.skipIf(!linux)(
  "a background command runs while its process writes, and is lost once it is gone",
  async () => {
    let now = Date.parse("2026-11-13T18:00:00.000Z");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "task-watch-")));
    const output = join(dir, "b1.output");
    // A command's shape: a child whose stdout is its output file.
    const fd = openSync(output, "w");
    const child = spawn("sleep", ["60"], { stdio: ["ignore", fd, "ignore"] });
    closeSync(fd);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const silentSince = new Date(now - 30 * MINUTE);
    utimesSync(output, silentSince, silentSince);
    const task: AgentTask = {
      id: "t1",
      kind: "command",
      title: "Build",
      status: "running",
      startedAt: new Date(now - 90 * MINUTE).toISOString(),
      outputFile: output,
    };
    const watch = createTaskWatcher(localFiles(), () => now);
    const session = join(dir, "session.jsonl");
    try {
      // Silent for half an hour, yet held open: still running.
      expect((await watch(session, [task]))[0]!.status).toBe("running");
      child.kill("SIGKILL");
      await exited;
      // Past the watcher's short cache: nothing holds the output now.
      now += 10_000;
      const lost = (await watch(session, [task]))[0]!;
      expect(lost.status).toBe("lost");
      expect(lost.endedAt).toBe(silentSince.toISOString());
      expect(task.status).toBe("running");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
  },
);

test("without a process list, a silent command is lost only after an hour", async () => {
  let now = Date.parse("2026-11-13T18:00:00.000Z");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "task-watch-")));
  const output = join(dir, "b2.output");
  const fd = openSync(output, "w");
  closeSync(fd);
  const silentSince = new Date(now - 30 * MINUTE);
  utimesSync(output, silentSince, silentSince);
  const task: AgentTask = {
    id: "t2",
    kind: "command",
    title: "Remote build",
    status: "running",
    startedAt: new Date(now - 3 * 60 * MINUTE).toISOString(),
    outputFile: output,
  };
  const watch = createTaskWatcher(localFiles(true), () => now);
  const session = join(dir, "session.jsonl");
  expect((await watch(session, [task]))[0]!.status).toBe("running");
  now += 31 * MINUTE;
  expect((await watch(session, [task]))[0]!.status).toBe("lost");
});
