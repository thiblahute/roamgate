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

test("what an agent says the user must do shows until they look at it", () => {
  let clock = 1000;
  const file = path();
  const store = createAgentSeenStore(file, () => clock);
  const list = { agents: [agent("idle", 2)] };
  store.note("local", "w1:p1", { title: "MR !12", text: "A test is asked" });
  const noted = (s = store) =>
    (s.annotate("local", list) as { agents: Record<string, unknown>[] })
      .agents[0]!.attention_note;
  expect(noted()).toBe("MR !12: A test is asked");
  // Kept across a restart.
  expect(noted(createAgentSeenStore(file, () => clock))).toBe(
    "MR !12: A test is asked",
  );
  clock = 2000;
  store.mark("local", "w1:p1", "term-w1:p1");
  expect(noted()).toBeUndefined();
  // A new one after that shows again.
  clock = 3000;
  store.note("local", "w1:p1", { text: "Pipeline failed" });
  expect(noted()).toBe("Pipeline failed");
});

test("a turn Roamgate started does not make the agent Done", () => {
  const clock = 1000;
  const store = createAgentSeenStore(path(), () => clock);
  const done = (status: string, seq: number, pane = "w1:p1") =>
    (
      store.annotate("local", { agents: [agent(status, seq, pane)] }) as {
        agents: Record<string, unknown>[];
      }
    ).agents[0]!;
  // Seen idle at 4, Ranger prompts it there.
  store.mark("local", "w1:p1", "term-w1:p1", 4);
  store.quietTurn("local", "w1:p1", "term-w1:p1", 4, "idle");
  expect(done("working", 5).seen_done).toBeUndefined();
  expect(done("idle", 6).seen_done).toBe(false);
  // Its next turn counts again.
  expect(done("idle", 8).seen_done).toBe(true);

  // Already Done (unseen work) when Ranger prompts it: it stays Done.
  store.mark("local", "w1:p2", "term-w1:p2", 2);
  store.quietTurn("local", "w1:p2", "term-w1:p2", 3, "idle");
  expect(done("idle", 5, "w1:p2").seen_done).toBe(true);

  // Never seen in Roamgate, idle: its Ranger turn is not Done either, and it
  // has no look time.
  store.quietTurn("local", "w1:p3", "term-w1:p3", 7, "idle");
  const fresh = done("idle", 9, "w1:p3");
  expect(fresh.seen_done).toBe(false);
  expect(fresh.seen_at).toBeUndefined();
});
