import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSeenStore } from "./agent-seen";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function path() {
  const directory = mkdtempSync(join(tmpdir(), "roamgate-seen-"));
  directories.push(directory);
  return join(directory, "agent-seen.json");
}
const agent = (status: string, seq: number, pane = "w1:p1") => ({
  pane_id: pane,
  terminal_id: `term-${pane}`,
  agent: "claude",
  agent_status: status,
  state_change_seq: seq,
});

test("an agent is Done when it changed state since it was seen", () => {
  const store = createAgentSeenStore(path());
  const list = {
    agents: [agent("idle", 5), agent("done", 3, "w1:p2"), agent("working", 9)],
  };
  // Never seen in Roamgate: Herdr's states stay.
  expect(store.annotate("local", list)).toEqual(list);
  expect(store.mark("local", "w1:p1", "term-w1:p1", 4)).toBe(true);
  expect(store.mark("local", "w1:p2", "term-w1:p2", 3)).toBe(true);
  const annotated = store.annotate("local", list) as {
    agents: Record<string, unknown>[];
  };
  // Finished after it was seen (Herdr says idle): Done.
  expect(annotated.agents[0]!.seen_done).toBe(true);
  // Herdr says done, but it was seen in this state: not Done.
  expect(annotated.agents[1]!.seen_done).toBe(false);
  // Working agents are not judged.
  expect(annotated.agents[2]!.seen_done).toBeUndefined();
  // Each look is dated.
  expect(annotated.agents[0]!.seen_at).toEqual(expect.any(Number));
  // Another connection's marks are its own.
  expect(store.annotate("desktop", list)).toEqual(list);
});

test("marks only move forward, and survive a restart", () => {
  const file = path();
  const store = createAgentSeenStore(file);
  expect(store.mark("local", "w1:p1", "t1", 7)).toBe(true);
  expect(store.mark("local", "w1:p1", "t1", 6)).toBe(false);
  expect(store.mark("local", "w1:p1", "t1", 7)).toBe(false);
  // A look while it works keeps what was seen finished.
  expect(store.mark("local", "w1:p1", "t1")).toBe(false);
  expect(store.seen("local", "w1:p1", "t1")).toBe(7);
  expect(store.mark("local", "w1:p1", "t1", -1)).toBe(false);
  // A new agent in the same pane is another terminal: not seen yet.
  expect(store.seen("local", "w1:p1", "t2")).toBeNull();
  expect(createAgentSeenStore(file).seen("local", "w1:p1", "t1")).toBe(7);
});

test("a damaged file forgets what was seen rather than failing", () => {
  const file = path();
  writeFileSync(file, "{ not json");
  const store = createAgentSeenStore(file);
  expect(store.seen("local", "w1:p1", "t1")).toBeNull();
  expect(store.mark("local", "w1:p1", "t1", 1)).toBe(true);
});

test("an agent looked at while working is Done once it finishes", () => {
  let clock = 1000;
  const store = createAgentSeenStore(path(), () => clock);
  store.mark("local", "w1:p1", "term-w1:p1");
  expect(store.seen("local", "w1:p1", "term-w1:p1")).toBe(-1);
  clock = 2000;
  const annotated = store.annotate("local", {
    agents: [agent("idle", 0), agent("working", 4, "w1:p2")],
  }) as { agents: Record<string, unknown>[] };
  expect(annotated.agents[0]).toMatchObject({ seen_done: true, seen_at: 1000 });
  expect(annotated.agents[1]!.seen_at).toBeUndefined();
});
