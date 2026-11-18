import { expect, test } from "bun:test";
import { watchAgentsSeen } from "./agentSeen";
import type { store } from "./store";

type Snapshot = ReturnType<typeof store.get>;

const rect = { x: 0, y: 0, width: 80, height: 24 };
const pane = (id: string, status: string, seq?: number) => ({
  pane_id: id,
  terminal_id: `t-${id}`,
  workspace_id: id === "c" ? "w2" : "w1",
  agent: "claude",
  agent_status: status,
  ...(seq === undefined ? {} : { state_change_seq: seq }),
});

// a and b are in the workspace on screen (b in another tab when `zoomed`, as
// on a phone, which shows one pane); c is in another workspace.
function harness(zoomed = false) {
  let snapshot = {
    selectedPaneId: "a",
    panes: [pane("a", "working"), pane("b", "done", 4), pane("c", "idle", 2)],
    layout: {
      zoomed,
      panes: [
        { pane_id: "a", focused: true, rect },
        ...(zoomed ? [] : [{ pane_id: "b", focused: false, rect }]),
      ],
    },
  } as unknown as Snapshot;
  const seenLocally: { paneId: string; seq?: number }[][] = [];
  const listeners = new Set<() => void>();
  const calls: Record<string, unknown>[] = [];
  let answer: (params: Record<string, unknown>) => Promise<unknown> = async (
    params,
  ) => ({ marked: params.seq !== undefined });
  let refreshes = 0;
  let focused = true;
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
    hasFocus: () => focused,
  });
  const stop = watchAgentsSeen({
    client: {
      call: (method: string, params?: Record<string, unknown>) => {
        expect(method).toBe("agent_seen.mark");
        calls.push(params!);
        return answer(params!);
      },
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: () => refreshes++,
    win: win as unknown as Window,
    doc: doc as unknown as Document,
    seenLocally: (looks) =>
      seenLocally.push(
        looks.map(({ paneId, seq }) => ({
          paneId,
          ...(seq === undefined ? {} : { seq }),
        })),
      ),
  });
  return {
    calls,
    seenLocally,
    stop,
    win,
    doc,
    listeners,
    refreshes: () => refreshes,
    setFocused: (value: boolean) => {
      focused = value;
    },
    answer: (value: typeof answer) => {
      answer = value;
    },
    update: (change: (value: Snapshot) => Snapshot) => {
      snapshot = change(snapshot);
      for (const listener of listeners) listener();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("agents on screen are marked as they come, finish and leave", async () => {
  const page = harness();
  // Both panes of the layout; c is not on screen. The finished one is
  // marked in the state seen, and its Done goes at once.
  expect(page.calls).toEqual([
    { pane_id: "a", terminal_id: "t-a" },
    { pane_id: "b", terminal_id: "t-b", seq: 4 },
  ]);
  await settle();
  expect(page.refreshes()).toBe(1);
  // Unchanged snapshot: nothing new to say.
  page.update((snapshot) => ({ ...snapshot }));
  expect(page.calls).toHaveLength(2);
  // The working agent finishes on screen (idle: no refresh needed).
  page.update((snapshot) => ({
    ...snapshot,
    panes: snapshot.panes.map((each) =>
      each.pane_id === "a" ? { ...each, ...pane("a", "idle", 9) } : each,
    ),
  }));
  expect(page.calls[page.calls.length - 1]).toEqual({
    pane_id: "a",
    terminal_id: "t-a",
    seq: 9,
  });
  await settle();
  expect(page.refreshes()).toBe(1);
  // Another workspace comes on screen: its agent is seen in its finished
  // state, and a and b were looked at until now.
  page.update((snapshot) => ({
    ...snapshot,
    selectedPaneId: "c",
    layout: {
      ...snapshot.layout!,
      panes: [{ pane_id: "c", focused: true, rect }],
    },
  }));
  expect(page.calls.slice(3)).toEqual([
    { pane_id: "c", terminal_id: "t-c", seq: 2 },
    { pane_id: "a", terminal_id: "t-a" },
    { pane_id: "b", terminal_id: "t-b" },
  ]);
  // Each check hands its marks over at once, for the page's own lists.
  expect(page.seenLocally).toEqual([
    [{ paneId: "a" }, { paneId: "b", seq: 4 }],
    [{ paneId: "a", seq: 9 }],
    [{ paneId: "c", seq: 2 }, { paneId: "a" }, { paneId: "b" }],
  ]);
  page.stop();
  expect(page.listeners.size).toBe(0);
});

test("nothing is seen while the window is hidden or unfocused", () => {
  const page = harness();
  page.calls.length = 0;
  page.setFocused(false);
  page.win.dispatchEvent(new Event("blur"));
  // Both leave the screen.
  expect(page.calls).toEqual([
    { pane_id: "a", terminal_id: "t-a" },
    { pane_id: "b", terminal_id: "t-b" },
  ]);
  page.update((snapshot) => ({
    ...snapshot,
    panes: snapshot.panes.map((each) =>
      each.pane_id === "a" ? { ...each, ...pane("a", "done", 11) } : each,
    ),
  }));
  expect(page.calls).toHaveLength(2);
  page.setFocused(true);
  page.win.dispatchEvent(new Event("focus"));
  expect(page.calls.slice(2)).toEqual([
    { pane_id: "a", terminal_id: "t-a", seq: 11 },
    { pane_id: "b", terminal_id: "t-b" },
  ]);
  page.calls.length = 0;
  page.doc.visibilityState = "hidden";
  page.doc.dispatchEvent(new Event("visibilitychange"));
  expect(page.calls).toHaveLength(2);
  page.stop();
  page.win.dispatchEvent(new Event("focus"));
  expect(page.calls).toHaveLength(2);
});

test("every agent of the workspace on screen is seen, even in a tab not shown", async () => {
  // A phone, or a zoomed pane, shows a alone: b, in the same workspace, is
  // seen too, as Herdr sees its focused Space.
  const page = harness(true);
  expect(page.calls).toEqual([
    { pane_id: "a", terminal_id: "t-a" },
    { pane_id: "b", terminal_id: "t-b", seq: 4 },
  ]);
  await settle();
  expect(page.refreshes()).toBe(1);
  page.stop();
});

test("a failed mark is sent again", async () => {
  const page = harness();
  await settle();
  expect(page.refreshes()).toBe(1);
  page.answer(() => Promise.reject(new Error("offline")));
  page.update((snapshot) => ({
    ...snapshot,
    panes: snapshot.panes.map((each) =>
      each.pane_id === "b" ? { ...each, state_change_seq: 5 } : each,
    ),
  }));
  expect(page.calls[page.calls.length - 1]).toEqual({
    pane_id: "b",
    terminal_id: "t-b",
    seq: 5,
  });
  await settle();
  expect(page.refreshes()).toBe(1);
  page.answer(async () => ({ marked: true }));
  page.update((snapshot) => ({ ...snapshot }));
  expect(page.calls[page.calls.length - 1]).toEqual({
    pane_id: "b",
    terminal_id: "t-b",
    seq: 5,
  });
  await settle();
  expect(page.refreshes()).toBe(2);
  page.stop();
});

test("an agent retained across a Herdr restart is marked in its lower finished state", () => {
  const page = harness();
  page.calls.length = 0;
  page.update((snapshot) => ({
    ...snapshot,
    panes: snapshot.panes.map((each) =>
      each.pane_id === "b" ? { ...each, state_change_seq: 1 } : each,
    ),
  }));
  expect(page.calls).toContainEqual({
    pane_id: "b",
    terminal_id: "t-b",
    seq: 1,
  });
  page.stop();
});
