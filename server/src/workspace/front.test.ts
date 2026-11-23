import { afterEach, describe, expect, test } from "bun:test";
import {
  applyWorkspaceTreeOps,
  createWorkspaceTreePruner,
  onWorkspaceTreeChanged,
  notifyWorkspaceTreeChanged,
  placeCreatedWorkspace,
  readWorkspaceTree,
  setWorkspaceTreeCore,
} from "../config/workspace-tree";
import {
  createWorkspaceFront,
  type WorkspaceCore,
  type WorkspaceRuntimePart,
} from "./front";

type Call = { op: string; params: any };

function fakeCore(owned: { value: boolean }) {
  const calls: Call[] = [];
  const held: (() => void)[] = [];
  let hold = false;
  const core: WorkspaceCore = {
    owned: () => owned.value,
    call: async (op, params) => {
      calls.push({ op, params });
      if (hold && op === "events")
        await new Promise<void>((resolve) => held.push(resolve));
      return { ok: true };
    },
  };
  return {
    core,
    calls,
    holdEvents(on: boolean) {
      hold = on;
    },
    release() {
      for (const resolve of held.splice(0)) resolve();
    },
  };
}

function part(log: string[], id = "local", generation = 1) {
  return {
    connectionId: id,
    generation,
    sshHost: null,
    remotePlatform: null,
    stopOwn: async () => {
      log.push(`stop own ${id}`);
    },
    startOwn: () => {
      log.push(`start own ${id}`);
    },
  } satisfies WorkspaceRuntimePart;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => setWorkspaceTreeCore(null));

describe("the workspace family's front", () => {
  test("without a core, each runtime runs its own parts and nothing is routed", async () => {
    const front = createWorkspaceFront({ core: null });
    const log: string[] = [];
    const link = front.attach(part(log));
    link.ready();
    link.herdrEvent({ event: "pane.agent.status.changed" });
    expect(link.routed()).toBe(false);
    expect(front.owned()).toBe(false);
    front.ownershipChanged();
    await link.stopped();
    expect(log).toEqual(["start own local"]);
    await expect(front.call("enrich", {})).rejects.toThrow(
      "does not serve the workspace family",
    );
  });

  test("with the family on Rust, a ready runtime's own parts stay off and the core gets it, then its events in order", async () => {
    const owned = { value: true };
    const fake = fakeCore(owned);
    const front = createWorkspaceFront({ core: () => fake.core });
    const log: string[] = [];
    const link = front.attach(part(log, "ssh-a", 3));
    link.ready();
    expect(link.routed()).toBe(true);
    // Queued until the core took the runtime.
    link.herdrEvent({ event: "pane.agent.status.changed", data: { n: 1 } });
    const list = link.paneListStart();
    link.paneList({ panes: [] }, list);
    await front.settle();
    await tick();
    expect(log).toEqual(["stop own ssh-a"]);
    expect(fake.calls.map((call) => call.op)).toEqual([
      "runtime_start",
      "events",
    ]);
    expect(fake.calls[0]!.params).toEqual({
      connection_id: "ssh-a",
      generation: 3,
      ssh_host: null,
      remote_platform: null,
    });
    expect(fake.calls[1]!.params.events).toEqual([
      {
        kind: "herdr",
        event: { event: "pane.agent.status.changed", data: { n: 1 } },
      },
      { kind: "pane_list_start", list: 1 },
      { kind: "pane_list", list: 1, result: { panes: [] } },
    ]);
    await link.stopped();
    expect(fake.calls.at(-1)).toEqual({
      op: "runtime_stop",
      params: { connection_id: "ssh-a", generation: 3 },
    });
  });

  test("one batch of events is in flight per runtime; the next carries what came meanwhile", async () => {
    const owned = { value: true };
    const fake = fakeCore(owned);
    const front = createWorkspaceFront({ core: () => fake.core });
    const link = front.attach(part([]));
    link.ready();
    await front.settle();
    fake.holdEvents(true);
    link.herdrEvent({ event: "a" });
    await tick();
    link.herdrEvent({ event: "b" });
    link.herdrEvent({ event: "c" });
    await tick();
    expect(fake.calls.filter((call) => call.op === "events")).toHaveLength(1);
    fake.holdEvents(false);
    fake.release();
    await tick();
    await tick();
    const batches = fake.calls
      .filter((call) => call.op === "events")
      .map((call) => call.params.events.map((event: any) => event.event.event));
    expect(batches).toEqual([["a"], ["b", "c"]]);
  });

  test("a handover stops Bun's parts before the core starts them, and back stops the core's before Bun's start again", async () => {
    const owned = { value: false };
    const fake = fakeCore(owned);
    const front = createWorkspaceFront({ core: () => fake.core });
    const log: string[] = [];
    const link = front.attach(part(log));
    link.ready();
    expect(log).toEqual(["start own local"]);
    owned.value = true;
    front.ownershipChanged();
    await front.settle();
    expect(log).toEqual(["start own local", "stop own local"]);
    expect(fake.calls.map((call) => call.op)).toEqual(["runtime_start"]);
    owned.value = false;
    front.ownershipChanged();
    expect(link.routed()).toBe(false);
    // Bun's own copy hears the events again.
    link.herdrEvent({ event: "ignored by the core" });
    await front.settle();
    expect(fake.calls.map((call) => call.op)).toEqual([
      "runtime_start",
      "runtime_stop",
    ]);
    expect(log.at(-1)).toBe("start own local");
  });

  test("while the core owns the family, the arrangement is read and written there and Bun prunes nothing", async () => {
    const calls: Record<string, unknown>[] = [];
    const tree = { version: 1, nodes: [] };
    setWorkspaceTreeCore({
      owned: () => true,
      call: async (params) => {
        calls.push(params);
        return params.op === "place" ? { changed: true } : { tree };
      },
    });
    expect(await readWorkspaceTree()).toEqual(tree as never);
    expect(await applyWorkspaceTreeOps([{ op: "noop" } as never])).toEqual(
      tree as never,
    );
    expect(
      await placeCreatedWorkspace({
        connectionId: "local",
        workspace: { workspace_id: "w2", label: "two" },
        parent: { workspace_id: "w1", label: "one" },
      }),
    ).toBe(true);
    expect(calls.map((call) => call.op)).toEqual(["get", "apply", "place"]);
    const pruner = createWorkspaceTreePruner({
      list: async () => {
        throw new Error("never listed");
      },
      read: async () => tree as never,
    });
    expect(
      pruner.event("local", {
        event: "workspace.closed",
        data: { workspace_id: "w1" },
      }),
    ).toBeUndefined();
    pruner.ready("local");
    pruner.dispose();
    const heard: unknown[] = [];
    const stop = onWorkspaceTreeChanged((next) => heard.push(next));
    notifyWorkspaceTreeChanged(tree as never);
    stop();
    expect(heard).toEqual([tree]);
  });
});
