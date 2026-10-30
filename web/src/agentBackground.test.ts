import { expect, test } from "bun:test";
import {
  type BackgroundTaskLike,
  agentPresence,
  backgroundCountLabel,
  backgroundTooltip,
  backgroundWork,
  showsBackground,
} from "./agentBackground";

const subagent: BackgroundTaskLike = {
  kind: "agent",
  status: "running",
  title: "Explore the server",
  startedAt: "2026-11-01T10:00:00.000Z",
};
const idleTeammate: BackgroundTaskLike = {
  kind: "teammate",
  name: "reviewer",
  status: "completed",
  title: "Review the patch",
};

test("an idle turn with a running subagent works in the background", () => {
  const work = backgroundWork([subagent]);
  expect(work.running).toBe(1);
  expect(agentPresence("idle", work)).toBe("background");
  expect(agentPresence("Idle", work)).toBe("background");
  expect(showsBackground("idle", work)).toBe(true);
});

test("an idle teammate waiting for a message alone leaves the agent idle", () => {
  const work = backgroundWork([idleTeammate]);
  expect(work.running).toBe(0);
  expect(agentPresence("idle", work)).toBe("idle");
  expect(showsBackground("idle", work)).toBe(false);
});

test("a running task from a rewound part of the conversation counts", () => {
  const work = backgroundWork([{ ...subagent, rewound: true }]);
  expect(agentPresence("idle", work)).toBe("background");
  expect(backgroundTooltip("idle", work, Date.parse(subagent.startedAt!))).toBe(
    "Idle, 1 subagent running:\nSubagent: Explore the server (0s), from a rewound part",
  );
});

test("commands, monitors and workflows count; ended tasks do not", () => {
  const work = backgroundWork<BackgroundTaskLike>([
    { kind: "command", status: "running", title: "bun test" },
    { kind: "monitor", status: "running", title: "Watch CI" },
    { kind: "workflow", status: "running", title: "Restack" },
    { kind: "agent", status: "completed", title: "Done one" },
    { kind: "agent", status: "lost", title: "Lost one" },
    { kind: "command", status: "failed", title: "make" },
  ]);
  expect(work.running).toBe(3);
  expect(backgroundCountLabel(work)).toBe("3 running in the background");
});

test("the main turn's own state wins", () => {
  const work = backgroundWork([subagent]);
  expect(agentPresence("working", work)).toBe("working");
  expect(agentPresence("blocked", work)).toBe("blocked");
  // Done keeps its state: a finished turn to look at; the count still shows.
  expect(agentPresence("done", work)).toBe("done");
  expect(showsBackground("done", work)).toBe(true);
  expect(showsBackground("working", work)).toBe(false);
  expect(agentPresence("unknown", work)).toBe("unknown");
});

test("the count names the kind when there is one", () => {
  expect(backgroundCountLabel(backgroundWork([subagent, subagent]))).toBe(
    "2 subagents running",
  );
  expect(
    backgroundCountLabel(
      backgroundWork<BackgroundTaskLike>([
        { kind: "command", status: "running", title: "sleep 60" },
      ]),
    ),
  ).toBe("1 background command running");
  expect(
    backgroundTooltip(
      "idle",
      backgroundWork([{ ...idleTeammate, status: "running" }]),
    ),
  ).toBe("Idle, 1 teammate running:\nTeammate: reviewer: Review the patch");
});
