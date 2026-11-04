import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ACTIVITY_SETTINGS,
  type GuiActivitySettings,
} from "../config/gui-settings";
import type { ActivityEvent } from "./protocol";
import {
  type ActivityRecorder,
  type OwnedAgent,
  PRESENCE_TIMEOUT_MS,
  createActivityRecorder,
  parsePresence,
  stableWorkspaceId,
} from "./recorder";
import { subjectResolver, withSubjects } from "./subjects";

/** A Herdr with two workspaces: w1 (a checkout) and w2 (a plain directory). */
function fakeHerdr() {
  const state = {
    workspaces: [
      {
        workspace_id: "w1",
        label: "roamgate",
        focused: true,
        worktree: {
          checkout_path: "/src/roamgate",
          repo_root: "/src/roamgate",
          repo_key: "/src/roamgate/.git",
          repo_name: "roamgate",
          is_linked_worktree: false,
        },
      },
      { workspace_id: "w2", label: "gst", focused: false },
    ] as Array<Record<string, unknown>>,
    panes: [
      {
        pane_id: "w1:p1",
        workspace_id: "w1",
        tab_id: "w1:t1",
        agent: "claude",
        agent_status: "working",
        agent_session: { agent: "claude", kind: "id", value: "s1" },
        title: "Fix the bridge",
        focused: true,
        cwd: "/src/roamgate",
      },
      {
        pane_id: "w1:p2",
        workspace_id: "w1",
        tab_id: "w1:t1",
        agent_status: "unknown",
        focused: false,
        cwd: "/src/roamgate",
      },
      {
        pane_id: "w2:p1",
        workspace_id: "w2",
        tab_id: "w2:t1",
        agent_status: "unknown",
        focused: false,
        cwd: "/src/gst",
      },
    ] as Array<Record<string, unknown>>,
    calls: [] as string[],
    /** The agents conversation mode runs. */
    owned: [] as OwnedAgent[],
    /** What git says per path, for runHostScript. */
    repos: new Map<
      string,
      {
        top: string;
        common: string;
        gitdir: string;
        branch: string;
        remote: string;
      }
    >(),
    hostScripts: [] as string[],
  };
  return {
    state,
    /** Answers repo-info.ts's script from `state.repos`. */
    runHostScript: async (_connectionId: string, script: string) => {
      state.hostScripts.push(script);
      const marker = /printf '(\S+) begin 0/.exec(script)![1]!;
      const paths = [...script.matchAll(/^p='([^']*)'$/gm)].map((m) => m[1]!);
      const lines: string[] = [];
      paths.forEach((path, index) => {
        lines.push(`${marker} begin ${index}`);
        const repo = state.repos.get(path);
        if (repo)
          for (const [key, value] of Object.entries(repo))
            lines.push(`${key === "top" ? "top" : key} ${value}`);
        lines.push(`${marker} end ${index}`);
      });
      return { code: 0, stdout: `${lines.join("\n")}\n` };
    },
    call: async (connectionId: string, method: string) => {
      state.calls.push(`${connectionId} ${method}`);
      if (method === "workspace.list")
        return { type: "workspace_list", workspaces: state.workspaces };
      if (method === "pane.list") return { panes: state.panes };
      throw new Error(`unexpected ${method}`);
    },
  };
}

type Harness = {
  directory: string;
  herdr: ReturnType<typeof fakeHerdr>;
  recorder: ActivityRecorder;
  /** A recorder on the same log, as after a restart. */
  reopen(settings?: Partial<GuiActivitySettings>): ActivityRecorder;
  cleanup(): void;
};

function activityHarness(settings: Partial<GuiActivitySettings> = {}): Harness {
  const directory = mkdtempSync(join(tmpdir(), "roamgate-activity-"));
  const herdr = fakeHerdr();
  const recorders: ActivityRecorder[] = [];
  const open = (overrides: Partial<GuiActivitySettings>) => {
    const recorder = createActivityRecorder({
      settings: async () => ({
        ...DEFAULT_ACTIVITY_SETTINGS,
        enabled: true,
        ...overrides,
      }),
      directory: () => join(directory, "roamgate"),
      herdrCall: herdr.call,
      ownedAgents: () => herdr.state.owned,
      runHostScript: (connectionId, script) =>
        herdr.runHostScript(connectionId, script),
    });
    recorders.push(recorder);
    return recorder;
  };
  return {
    directory,
    herdr,
    recorder: open(settings),
    reopen: (overrides = settings) => open(overrides),
    cleanup() {
      for (const recorder of recorders) recorder.stopNow();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function presence(
  fields: Partial<{
    client_id: string;
    client_kind: "desktop" | "phone";
    workspace_id: string | null;
    tab_id: string | null;
    pane_id: string | null;
    visible: boolean;
    focused: boolean;
    input_age_ms: number | null;
    cause: string | null;
  }> = {},
) {
  return {
    client_id: "c1",
    client_kind: "desktop",
    workspace_id: "w1",
    tab_id: "w1:t1",
    pane_id: "w1:p1",
    visible: true,
    focused: true,
    input_age_ms: 0,
    cause: "user_input",
    ...fields,
  };
}

function statusEvent(
  paneId: string,
  workspaceId: string,
  status: string,
  extra: Record<string, unknown> = {},
) {
  return {
    event: "pane.agent_status_changed",
    data: {
      type: "pane_agent_status_changed",
      pane_id: paneId,
      workspace_id: workspaceId,
      agent_status: status,
      agent: "claude",
      ...extra,
    },
  };
}

const T0 = Date.parse("2026-11-02T09:00:00Z");
const W1 = stableWorkspaceId("local", "/src/roamgate");
const W2 = stableWorkspaceId("local", "/src/gst");
const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;

let harnesses: Harness[] = [];
function harness(settings: Partial<GuiActivitySettings> = {}): Harness {
  const h = activityHarness(settings);
  harnesses.push(h);
  return h;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
});
afterEach(() => {
  for (const h of harnesses) h.cleanup();
  harnesses = [];
  jest.useRealTimers();
});

function advance(ms: number) {
  jest.advanceTimersByTime(ms);
}

function at(offsetMs: number): number {
  return T0 + offsetMs;
}

function events(recorder: ActivityRecorder): ActivityEvent[] {
  return recorder.store()!.readEvents();
}

function ms(event: ActivityEvent): number {
  return Date.parse(event.ts);
}

/** Attention events as [kind, ms since T0, detail] for compact checks. */
function attention(recorder: ActivityRecorder, source = "browser") {
  return events(recorder)
    .filter(
      (event) =>
        event.kind !== "agent.state" &&
        (event.source === undefined || event.source === source),
    )
    .map((event) => {
      const detail =
        event.kind === "workspace.focus"
          ? `${event.workspace_id === W1 ? "W1" : event.workspace_id === W2 ? "W2" : event.workspace_id} ${event.pane_id}`
          : event.kind === "workspace.blur"
            ? event.reason
            : event.kind === "ui.visibility"
              ? String(event.visible)
              : event.kind === "session.idle"
                ? String(event.idle_after_seconds)
                : "";
      return [event.kind, ms(event) - T0, detail];
    });
}

async function ready(recorder: ActivityRecorder, connectionId = "local") {
  recorder.connectionStatus(connectionId, "ready");
  await recorder.flush();
}

async function report(
  recorder: ActivityRecorder,
  socket: object,
  fields: Parameters<typeof presence>[0] = {},
  connectionId = "local",
) {
  const reply = await recorder.presence(socket, connectionId, presence(fields));
  await recorder.flush();
  return reply;
}

test("agent states are recorded once per change, with done as idle", async () => {
  const { recorder } = harness();
  await ready(recorder);
  recorder.herdrEvent("local", statusEvent("w1:p1", "w1", "working"));
  recorder.herdrEvent("local", statusEvent("w1:p1", "w1", "working"));
  advance(SECOND);
  recorder.herdrEvent("local", statusEvent("w1:p1", "w1", "done"));
  recorder.herdrEvent("local", statusEvent("w1:p1", "w1", "idle"));
  advance(SECOND);
  recorder.herdrEvent("local", statusEvent("w1:p1", "w1", "blocked"));
  await recorder.flush();
  const agents = events(recorder).filter((e) => e.kind === "agent.state");
  expect(agents.map((e) => [e.agent?.state, ms(e) - T0])).toEqual([
    ["working", 0],
    ["idle", 1000],
    ["blocked", 2000],
  ]);
  expect(agents[0]).toMatchObject({
    connection_id: "local",
    workspace_id: W1,
    tab_id: "w1:t1",
    pane_id: "w1:p1",
    agent: { name: "claude", state: "working", task: null, session_id: "s1" },
  });
  expect(agents[0]?.source).toBeUndefined();
});

test("agent titles are recorded only when asked for", async () => {
  const { recorder } = harness({ record_agent_titles: true });
  await ready(recorder);
  recorder.herdrEvent(
    "local",
    statusEvent("w1:p1", "w1", "working", { title: "Fix the bridge" }),
  );
  await recorder.flush();
  const [agent] = events(recorder).filter((e) => e.kind === "agent.state");
  expect(agent?.agent?.task).toBe("Fix the bridge");
});

test("pane listings catch missed changes but never undo a newer event", async () => {
  const { recorder, herdr } = harness();
  await ready(recorder);
  const panes = (status: string) => ({
    panes: herdr.state.panes.map((pane) =>
      pane.pane_id === "w1:p1" ? { ...pane, agent_status: status } : pane,
    ),
  });
  // The first listing is the baseline.
  recorder.paneList("local", panes("working"), at(0));
  advance(SECOND);
  recorder.herdrEvent("local", statusEvent("w1:p1", "w1", "idle"));
  // Started before that event: its "working" is stale.
  recorder.paneList("local", panes("working"), at(500));
  advance(SECOND);
  // Nothing changed: nothing recorded.
  recorder.paneList("local", panes("done"), at(2000));
  advance(SECOND);
  // A change the subscription missed.
  recorder.paneList("local", panes("blocked"), at(3000));
  advance(SECOND);
  // The pane went away.
  recorder.paneList(
    "local",
    { panes: herdr.state.panes.filter((pane) => pane.pane_id !== "w1:p1") },
    at(4000),
  );
  await recorder.flush();
  expect(
    events(recorder)
      .filter((e) => e.kind === "agent.state")
      .map((e) => [e.agent?.state, ms(e) - T0]),
  ).toEqual([
    ["working", 0],
    ["idle", 1000],
    ["blocked", 3000],
    ["unknown", 4000],
  ]);
});

test("an agent Roamgate runs itself is recorded as Roamgate knows it, not as Herdr says", async () => {
  const { recorder, herdr } = harness();
  await ready(recorder);
  // Herdr's state for the pane froze at working: its Claude integration
  // claimed the pane when the headless claude started, and drops
  // conversation mode's reports since. Herdr sees no agent in w1:p2.
  herdr.state.owned = [
    { pane_id: "w1:p1", session_id: "s1", agent_status: "idle" },
    { pane_id: "w1:p2", session_id: "s2", agent_status: "working" },
  ];
  recorder.paneList("local", { panes: herdr.state.panes }, at(0));
  await recorder.flush();
  advance(SECOND);
  recorder.herdrEvent("local", statusEvent("w1:p1", "w1", "working"));
  await recorder.flush();
  advance(SECOND);
  // A turn starts, then ends: conversation mode reports both.
  herdr.state.owned[0]!.agent_status = "working";
  recorder.ownedAgentChanged("local", "w1:p1");
  await recorder.flush();
  advance(60 * SECOND);
  herdr.state.owned[0]!.agent_status = "idle";
  recorder.ownedAgentChanged("local", "w1:p1");
  await recorder.flush();
  advance(SECOND);
  // Herdr's frozen working in the next listing changes nothing.
  recorder.paneList("local", { panes: herdr.state.panes }, at(63_000));
  await recorder.flush();
  expect(
    events(recorder)
      .filter((e) => e.kind === "agent.state")
      .map((e) => [e.pane_id, e.agent?.state, e.agent?.session_id, ms(e) - T0]),
  ).toEqual([
    ["w1:p1", "idle", "s1", 0],
    ["w1:p2", "working", "s2", 0],
    ["w1:p1", "working", "s1", 2000],
    ["w1:p1", "idle", "s1", 62000],
  ]);
});

test("a closed pane's agent ends as unknown, and the state restarts after a gap", async () => {
  const { recorder } = harness();
  await ready(recorder);
  recorder.herdrEvent("local", statusEvent("w1:p1", "w1", "working"));
  // Its workspace goes first: the agent still ends in it.
  recorder.herdrEvent("local", {
    event: "workspace.closed",
    data: { workspace_id: "w1" },
  });
  recorder.herdrEvent("local", {
    event: "pane.closed",
    data: { pane_id: "w1:p1", workspace_id: "w1" },
  });
  recorder.herdrEvent("local", statusEvent("w1:p3", "w1", "working"));
  recorder.connectionStatus("local", "reconnecting");
  recorder.connectionStatus("local", "ready");
  // The same state again after the gap is a new baseline.
  recorder.herdrEvent("local", statusEvent("w1:p3", "w1", "working"));
  await recorder.flush();
  expect(
    events(recorder)
      .filter((e) => e.kind === "agent.state")
      .map((e) => [e.pane_id, e.agent?.state, e.workspace_id === W1]),
  ).toEqual([
    ["w1:p1", "working", true],
    ["w1:p1", "unknown", true],
    ["w1:p3", "working", true],
    ["w1:p3", "working", true],
  ]);
});

test("unknown is recorded once, and not for an agent never seen in a state", async () => {
  const { recorder } = harness();
  await ready(recorder);
  recorder.herdrEvent("local", statusEvent("w1:p3", "w1", "unknown"));
  recorder.herdrEvent("local", statusEvent("w1:p1", "w1", "idle"));
  recorder.herdrEvent("local", statusEvent("w1:p1", "w1", "unknown"));
  // Herdr releases the agent, then still reports it unknown.
  recorder.herdrEvent("local", {
    event: "pane.agent_detected",
    data: { pane_id: "w1:p1", workspace_id: "w1", agent: null },
  });
  recorder.herdrEvent("local", statusEvent("w1:p1", "w1", "unknown"));
  await recorder.flush();
  expect(
    events(recorder)
      .filter((e) => e.kind === "agent.state")
      .map((e) => [e.pane_id, e.agent?.state]),
  ).toEqual([
    ["w1:p1", "idle"],
    ["w1:p1", "unknown"],
  ]);
});

test("connection gaps cover the periods a connection was not ready", async () => {
  const { recorder } = harness();
  const socket = {};
  recorder.connectionStatus("local", "disconnected");
  recorder.connectionStatus("local", "connecting");
  advance(5 * SECOND);
  await ready(recorder);
  await report(recorder, socket);
  advance(60 * SECOND);
  recorder.connectionStatus("local", "error");
  recorder.connectionStatus("local", "reconnecting");
  advance(30 * SECOND);
  await ready(recorder);
  const store = recorder.store()!;
  expect(
    store
      .readGaps()
      .map((gap) => [
        gap.connection_id,
        Date.parse(gap.start) - T0,
        gap.end && Date.parse(gap.end) - T0,
        gap.reason,
        gap.excluded,
      ]),
  ).toEqual([
    ["local", 0, 5000, "disconnected", false],
    ["local", 65_000, 95_000, "error", false],
  ]);
  const blurs = events(recorder).filter((e) => e.kind === "workspace.blur");
  expect(blurs.map((e) => [e.source, e.reason, ms(e) - T0])).toEqual([
    ["browser", "disconnect", 65_000],
    ["herdr", "disconnect", 65_000],
  ]);
  // Herdr's focus is followed again once the connection is back.
  const herdrFocus = events(recorder).filter(
    (e) => e.kind === "workspace.focus" && e.source === "herdr",
  );
  expect(herdrFocus.map((e) => [ms(e) - T0, e.open])).toEqual([
    [5000, false],
    [95_000, true],
  ]);
});

test("presence becomes focus spans that end on a switch or when hidden", async () => {
  const { recorder } = harness();
  await ready(recorder);
  const socket = {};
  expect(await report(recorder, socket)).toEqual({
    recording: true,
    idle_seconds: 300,
    attention: true,
  });
  advance(10 * SECOND);
  // The same place again: nothing new.
  await report(recorder, socket, { input_age_ms: 10_000 });
  await report(recorder, socket, { pane_id: "w1:p2" });
  advance(10 * SECOND);
  await report(recorder, socket, {
    workspace_id: "w2",
    tab_id: "w2:t1",
    pane_id: "w2:p1",
  });
  advance(10 * SECOND);
  const w2 = { workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1" };
  await report(recorder, socket, { ...w2, visible: false });
  advance(10 * SECOND);
  await report(recorder, socket, w2);
  advance(10 * SECOND);
  // Another application has the focus: as good as hidden.
  await report(recorder, socket, { ...w2, focused: false });
  advance(10 * SECOND);
  await report(recorder, socket, w2);
  advance(10 * SECOND);
  // No workspace on screen (no layout yet).
  await report(recorder, socket, {
    workspace_id: null,
    tab_id: null,
    pane_id: null,
  });
  expect(attention(recorder)).toEqual([
    ["ui.visibility", 0, "true"],
    ["workspace.focus", 0, "W1 w1:p1"],
    ["workspace.blur", 10_000, "switch"],
    ["workspace.focus", 10_000, "W1 w1:p2"],
    ["workspace.blur", 20_000, "switch"],
    ["workspace.focus", 20_000, "W2 w2:p1"],
    ["ui.visibility", 30_000, "false"],
    ["workspace.blur", 30_000, "hidden"],
    ["ui.visibility", 40_000, "true"],
    ["workspace.focus", 40_000, "W2 w2:p1"],
    ["ui.visibility", 50_000, "false"],
    ["workspace.blur", 50_000, "hidden"],
    ["ui.visibility", 60_000, "true"],
    ["workspace.focus", 60_000, "W2 w2:p1"],
    ["workspace.blur", 70_000, "switch"],
  ]);
  const [focus] = events(recorder).filter(
    (e) => e.kind === "workspace.focus" && e.source === "browser",
  );
  expect(focus).toMatchObject({
    connection_id: "local",
    tab_id: "w1:t1",
    client: { id: "c1", kind: "desktop" },
    source: "browser",
    open: false,
  });
});

/** Attention events as [kind, ms since T0, detail, cause, input age]. */
function caused(recorder: ActivityRecorder, source = "browser") {
  const rows = attention(recorder, source);
  return events(recorder)
    .filter(
      (event) =>
        event.kind !== "agent.state" &&
        (event.source === undefined || event.source === source),
    )
    .map((event, index) => [
      ...rows[index]!,
      event.cause ?? null,
      event.input_age_ms ?? null,
    ]);
}

test("a page that loads is no attention until an input follows", async () => {
  const { recorder } = harness();
  await ready(recorder);
  const socket = {};
  // Loaded in front of the user: visible and focused, but no input yet.
  const loaded = await report(recorder, socket, {
    input_age_ms: null,
    cause: "page_load",
  });
  expect(loaded.attention).toBe(false);
  advance(60 * SECOND);
  // Its minute report: still nobody.
  await report(recorder, socket, { input_age_ms: null, cause: "repeat" });
  advance(SECOND);
  const typed = await report(recorder, socket, {
    input_age_ms: 0,
    cause: "user_input",
  });
  expect(typed.attention).toBe(true);
  expect(caused(recorder)).toEqual([
    ["ui.visibility", 0, "true", "page_load", null],
    ["workspace.focus", 61_000, "W1 w1:p1", "user_input", 0],
  ]);
});

test("a page reconnecting to a restarted bridge is no attention until an input after it", async () => {
  const h = harness();
  const socket = {};
  await ready(h.recorder);
  await report(h.recorder, socket);
  advance(10 * SECOND);
  await h.recorder.stop();
  // The bridge restarts; the page reconnects on a new socket and reports
  // its input of 20 s ago, before the restart.
  advance(SECOND);
  const recorder = h.reopen();
  await ready(recorder);
  const again = {};
  advance(2 * SECOND);
  expect(
    (
      await report(recorder, again, {
        input_age_ms: 20 * SECOND,
        cause: "repeat",
      })
    ).attention,
  ).toBe(false);
  // Brought to the front without input: the page counts it as input.
  advance(3 * SECOND);
  await report(recorder, again, { input_age_ms: 0, cause: "user_focus" });
  const rows = caused(recorder).filter(([, ts]) => (ts as number) >= 13_000);
  expect(rows).toEqual([
    ["ui.visibility", 13_000, "true", "reconnect", 20_000],
    ["workspace.focus", 16_000, "W1 w1:p1", "user_focus", 0],
  ]);
  // The restart's rows are no person: recorder_stop, no cause.
  expect(caused(recorder).filter(([, ts]) => ts === 10_000)).toEqual([
    ["workspace.blur", 10_000, "recorder_stop", null, null],
    ["ui.visibility", 10_000, "false", null, null],
  ]);
});

test("a view that follows Herdr or moves by itself ends the span and opens none", async () => {
  const { recorder } = harness();
  await ready(recorder);
  const socket = {};
  await report(recorder, socket);
  advance(10 * SECOND);
  const w2 = { workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1" };
  const followed = await report(recorder, socket, {
    ...w2,
    input_age_ms: 10 * SECOND,
    cause: "follow_herdr",
  });
  expect(followed.attention).toBe(false);
  advance(10 * SECOND);
  // Reading on without input: still not attention.
  await report(recorder, socket, {
    ...w2,
    input_age_ms: 20 * SECOND,
    cause: "repeat",
  });
  advance(SECOND);
  await report(recorder, socket, { ...w2, input_age_ms: 0 });
  advance(10 * SECOND);
  await report(recorder, socket, { input_age_ms: 9 * SECOND, cause: "app" });
  expect(caused(recorder)).toEqual([
    ["ui.visibility", 0, "true", "user_input", 0],
    ["workspace.focus", 0, "W1 w1:p1", "user_input", 0],
    ["workspace.blur", 10_000, "switch", "follow_herdr", 10_000],
    ["workspace.focus", 21_000, "W2 w2:p1", "user_input", 0],
    ["workspace.blur", 31_000, "switch", "app", 9_000],
  ]);
});

test("input after idle is session.active, caused by input", async () => {
  const { recorder } = harness({ idle_seconds: 60 });
  await ready(recorder);
  const socket = {};
  await report(recorder, socket);
  advance(70 * SECOND);
  await report(recorder, socket, {
    input_age_ms: 70 * SECOND,
    cause: "repeat",
  });
  advance(SECOND);
  await report(recorder, socket, { input_age_ms: 0 });
  const active = events(recorder).find((e) => e.kind === "session.active");
  expect(active).toMatchObject({ cause: "user_input", input_age_ms: 0 });
});

test("Herdr's focus says where it came from: start, event, listing, reconnect", async () => {
  const { recorder, herdr } = harness();
  await ready(recorder);
  advance(SECOND);
  recorder.herdrEvent("local", {
    event: "workspace.focused",
    data: { workspace_id: "w2" },
  });
  await recorder.flush();
  advance(SECOND);
  // Herdr's focus moves without an event (a browser focused its pane),
  // found by the listing a browser report needs.
  herdr.state.workspaces = herdr.state.workspaces.map((workspace) => ({
    ...workspace,
    focused: workspace.workspace_id === "w1",
  }));
  recorder.herdrEvent("local", {
    event: "workspace.updated",
    data: { workspace_id: "w1" },
  });
  await report(recorder, {});
  advance(SECOND);
  recorder.connectionStatus("local", "reconnecting");
  recorder.connectionStatus("local", "ready");
  await recorder.flush();
  expect(
    caused(recorder, "herdr").filter(([kind]) => kind !== "ui.visibility"),
  ).toEqual([
    ["workspace.focus", 0, "W1 w1:p1", "recorder_start", null],
    ["workspace.blur", 1000, "switch", "herdr_event", null],
    ["workspace.focus", 1000, "W2 null", "herdr_event", null],
    ["workspace.blur", 2000, "switch", "herdr_listing", null],
    ["workspace.focus", 2000, "W1 w1:p1", "herdr_listing", null],
    ["workspace.blur", 3000, "disconnect", null, null],
    ["workspace.focus", 3000, "W1 w1:p1", "connection_ready", null],
  ]);
});

test("Herdr's focus at a recorder start is recorder_start, never null", async () => {
  const h = harness();
  await ready(h.recorder);
  await h.recorder.stop();
  advance(SECOND);
  const recorder = h.reopen();
  await ready(recorder);
  const focuses = events(recorder).filter(
    (e) => e.kind === "workspace.focus" && e.source === "herdr",
  );
  expect(focuses.map((e) => e.cause)).toEqual([
    "recorder_start",
    "recorder_start",
  ]);
});

test("reading counts as attention until the idle threshold", async () => {
  const { recorder } = harness({ idle_seconds: 120 });
  await ready(recorder);
  const socket = {};
  expect((await report(recorder, socket)).idle_seconds).toBe(120);
  advance(60 * SECOND);
  await report(recorder, socket, { input_age_ms: 60_000 });
  advance(60 * SECOND);
  // The browser says so as the threshold passes.
  await report(recorder, socket, { input_age_ms: 120_000 });
  advance(100 * SECOND);
  // Input again.
  await report(recorder, socket, { input_age_ms: 0 });
  advance(140 * SECOND);
  // A report that comes late still ends the span at the threshold.
  await report(recorder, socket, { input_age_ms: 140_000 });
  expect(attention(recorder)).toEqual([
    ["ui.visibility", 0, "true"],
    ["workspace.focus", 0, "W1 w1:p1"],
    ["workspace.blur", 120_000, "idle"],
    ["session.idle", 120_000, "120"],
    ["session.active", 220_000, ""],
    ["workspace.focus", 220_000, "W1 w1:p1"],
    ["workspace.blur", 340_000, "idle"],
    ["session.idle", 340_000, "120"],
  ]);
});

test("a span ends with timeout when the reports stop", async () => {
  const { recorder } = harness();
  await ready(recorder);
  const socket = {};
  await report(recorder, socket);
  advance(60 * SECOND);
  await report(recorder, socket, { input_age_ms: 1000 });
  advance(PRESENCE_TIMEOUT_MS - 1);
  await recorder.flush();
  expect(attention(recorder).at(-1)?.[0]).toBe("workspace.focus");
  advance(1);
  await recorder.flush();
  // Nothing is known after the last report.
  expect(attention(recorder).slice(-2)).toEqual([
    ["workspace.blur", 60_000, "timeout"],
    ["ui.visibility", 60_000, "false"],
  ]);
  advance(10 * SECOND);
  await report(recorder, socket);
  expect(attention(recorder).slice(-2)).toEqual([
    ["ui.visibility", 220_000, "true"],
    ["workspace.focus", 220_000, "W1 w1:p1"],
  ]);
});

test("a span ends at once when the socket closes", async () => {
  const { recorder } = harness();
  await ready(recorder);
  const socket = {};
  await report(recorder, socket);
  advance(5 * SECOND);
  recorder.socketClosed(socket);
  await recorder.flush();
  expect(attention(recorder).slice(-2)).toEqual([
    ["workspace.blur", 5000, "disconnect"],
    ["ui.visibility", 5000, "false"],
  ]);
  // No timeout follows for a closed socket.
  advance(PRESENCE_TIMEOUT_MS);
  await recorder.flush();
  expect(attention(recorder)).toHaveLength(4);
});

test("a browser moving to another connection switches, and phones count", async () => {
  const { recorder } = harness();
  await ready(recorder);
  await ready(recorder, "remote");
  const socket = {};
  await report(recorder, socket, { client_kind: "phone" });
  advance(5 * SECOND);
  await report(recorder, socket, { client_kind: "phone" }, "remote");
  const browser = events(recorder).filter(
    (e) => e.source !== "herdr" && e.kind !== "agent.state",
  );
  expect(
    browser.map((e) => [e.kind, e.connection_id, e.reason ?? e.visible]),
  ).toEqual([
    ["ui.visibility", "local", true],
    ["workspace.focus", "local", undefined],
    ["workspace.blur", "local", "switch"],
    ["ui.visibility", "local", false],
    ["ui.visibility", "remote", true],
    ["workspace.focus", "remote", undefined],
  ]);
  expect(browser.at(-1)?.workspace_id).toBe(
    stableWorkspaceId("remote", "/src/roamgate"),
  );
  expect(browser.at(-1)?.client).toEqual({ id: "c1", kind: "phone" });
});

test("Herdr's own focus is a low-confidence span of its own", async () => {
  const { recorder } = harness();
  await ready(recorder);
  advance(SECOND);
  recorder.herdrEvent("local", {
    event: "pane.focused",
    data: { pane_id: "w1:p2", workspace_id: "w1" },
  });
  recorder.herdrEvent("local", {
    event: "workspace.focused",
    data: { workspace_id: "w2" },
  });
  await recorder.flush();
  expect(attention(recorder, "herdr")).toEqual([
    ["workspace.focus", 0, "W1 w1:p1"],
    ["workspace.blur", 1000, "switch"],
    ["workspace.focus", 1000, "W2 null"],
  ]);
  const herdrEvents = events(recorder);
  expect(herdrEvents.every((e) => e.client === null)).toBe(true);
  expect(herdrEvents.every((e) => e.source === "herdr")).toBe(true);
});

test("a stop ends every span; a restart closes a crashed recorder's at its last sign of life", async () => {
  const h = harness();
  const first = h.recorder;
  await ready(first);
  first.connectionStatus("remote", "error");
  await report(first, {});
  advance(140 * SECOND);
  await first.flush();
  // Gone without a stop: its alive stamp is from T0 + 120 s.
  const crashed = first.store()!;
  jest.clearAllTimers();
  crashed.close();
  jest.setSystemTime(at(600_000));
  const second = h.reopen();
  expect(await second.ready()).toBe(true);
  const log = second.store()!;
  const recovered = log
    .readEvents()
    .filter((e) => ms(e) === at(120_000))
    .map((e) => [e.kind, e.source, e.reason ?? e.visible]);
  expect(recovered).toEqual([
    ["workspace.blur", "herdr", "recorder_stop"],
    ["workspace.blur", "browser", "recorder_stop"],
    ["ui.visibility", undefined, false],
  ]);
  expect(log.readEvents().some((e) => e.open)).toBe(false);
  const gaps = () =>
    log
      .readGaps()
      .map((gap) => [
        gap.connection_id,
        Date.parse(gap.start) - T0,
        gap.end && Date.parse(gap.end) - T0,
        gap.reason,
      ]);
  expect(gaps()).toEqual([
    ["remote", 0, 120_000, "error"],
    [null, 120_000, 600_000, "recorder"],
  ]);
  // A clean stop: the next start records the time in between too.
  await ready(second);
  await report(second, {});
  advance(100 * SECOND);
  await second.stop();
  jest.setSystemTime(at(1_000_000));
  const third = h.reopen();
  await third.ready();
  const after = third.store()!;
  expect(
    after
      .readEvents()
      .filter((e) => e.kind === "workspace.blur" && ms(e) === at(700_000))
      .map((e) => [e.source, e.reason]),
  ).toEqual([
    ["browser", "recorder_stop"],
    ["herdr", "recorder_stop"],
  ]);
  expect(
    after
      .readGaps()
      .filter((gap) => gap.connection_id === null)
      .map((gap) => [Date.parse(gap.start) - T0, Date.parse(gap.end!) - T0]),
  ).toEqual([
    [120_000, 600_000],
    [700_000, 1_000_000],
  ]);
});

test("events past the retention period are deleted every day", async () => {
  const { recorder } = harness({ retention_days: 90 });
  await recorder.ready();
  const store = recorder.store()!;
  const agent = {
    name: "claude",
    state: "idle" as const,
    task: null,
    sessionId: null,
  };
  store.append({
    ts: T0 - 91 * DAY,
    kind: "agent.state",
    connectionId: "local",
    session: 1,
    agent,
  });
  store.append({
    ts: T0 - 80 * DAY,
    kind: "agent.state",
    connectionId: "local",
    session: 1,
    agent,
  });
  store.addGap("local", T0 - 100 * DAY, T0 - 95 * DAY, "error");
  store.upsertWorkspace({
    id: "ws_old",
    connectionId: "local",
    name: "old",
    path: "/old",
    herdrWorkspaceId: "w9",
    repoRoot: null,
    repoIsWorktree: null,
    seenAt: T0 - 100 * DAY,
  });
  advance(DAY);
  await recorder.flush();
  expect(store.readEvents().map((e) => ms(e))).toEqual([T0 - 80 * DAY]);
  expect(store.readGaps()).toEqual([]);
  expect(store.readWorkspaces()).toEqual([]);
});

test("with recording off nothing is recorded, not even a file", async () => {
  const h = harness({ enabled: false });
  const { recorder } = h;
  expect(await recorder.ready()).toBe(false);
  recorder.connectionStatus("local", "ready");
  recorder.herdrEvent("local", statusEvent("w1:p1", "w1", "working"));
  recorder.paneList("local", { panes: h.herdr.state.panes }, T0);
  expect(await recorder.presence({}, "local", presence())).toEqual({
    recording: false,
    idle_seconds: 300,
    attention: false,
  });
  recorder.socketClosed({});
  await recorder.flush();
  await recorder.stop();
  expect(recorder.store()).toBeNull();
  expect(h.herdr.state.calls).toEqual([]);
  expect(existsSync(join(h.directory, "roamgate"))).toBe(false);
});

test("presence reports are checked", () => {
  expect(() => parsePresence(null)).toThrow("invalid presence");
  expect(() => parsePresence({ ...presence(), client_id: "a b" })).toThrow(
    "invalid client_id",
  );
  expect(() => parsePresence({ ...presence(), client_kind: "tv" })).toThrow(
    "invalid client_kind",
  );
  expect(() => parsePresence({ ...presence(), visible: "yes" })).toThrow(
    "invalid visibility",
  );
  expect(() => parsePresence({ ...presence(), input_age_ms: -1 })).toThrow(
    "invalid input_age_ms",
  );
  expect(() => parsePresence({ ...presence(), cause: "agent" })).toThrow(
    "invalid cause",
  );
  expect(parsePresence({ ...presence(), input_age_ms: null })).toMatchObject({
    inputAgeMs: null,
    cause: "user_input",
  });
  // Pages older than causes send none.
  expect(parsePresence({ ...presence(), cause: undefined }).cause).toBeNull();
  expect(() =>
    parsePresence({ ...presence(), pane_id: "x".repeat(200) }),
  ).toThrow("invalid pane_id");
  expect(parsePresence({ ...presence(), input_age_ms: 1e15 }).inputAgeMs).toBe(
    DAY,
  );
});

type Schema = Record<string, unknown>;
const protocol = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../docs/activity.schema.json"),
    "utf8",
  ),
) as { $defs: Record<string, Schema> };

/** The JSON Schema subset activity.schema.json uses; returns the errors. */
function validate(value: unknown, schema: Schema, path = "$"): string[] {
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.replace("#/$defs/", "");
    const target = protocol.$defs[name];
    if (!target) return [`${path}: unknown $ref ${schema.$ref}`];
    return validate(value, target, path);
  }
  if (Array.isArray(schema.anyOf))
    return (schema.anyOf as Schema[]).some(
      (option) => validate(value, option, path).length === 0,
    )
      ? []
      : [`${path}: matches no anyOf option: ${JSON.stringify(value)}`];
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : Number.isInteger(value)
            ? "integer"
            : typeof value;
    if (
      !types.includes(actual) &&
      !(actual === "integer" && types.includes("number"))
    )
      return [`${path}: ${actual} is not ${types.join("|")}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (schema.const !== undefined && schema.const !== value)
    errors.push(`${path}: not ${JSON.stringify(schema.const)}`);
  if (
    schema.format === "date-time" &&
    (typeof value !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(
        value,
      ) ||
      Number.isNaN(Date.parse(value)))
  )
    errors.push(`${path}: not a date-time`);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? [])
      if (!(key in object)) errors.push(`${path}: missing ${key}`);
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const [key, child] of Object.entries(object))
      if (properties[key])
        errors.push(...validate(child, properties[key], `${path}.${key}`));
      // Fields the protocol does not know would be a protocol change.
      else errors.push(`${path}: unknown field ${key}`);
  }
  if (Array.isArray(value) && schema.items)
    value.forEach((item, index) =>
      errors.push(
        ...validate(item, schema.items as Schema, `${path}[${index}]`),
      ),
    );
  return errors;
}

test("stored events, workspaces and a page conform to activity.schema.json", async () => {
  const { recorder } = harness({ record_agent_titles: true });
  recorder.connectionStatus("local", "disconnected");
  await ready(recorder);
  const socket = {};
  recorder.herdrEvent(
    "local",
    statusEvent("w1:p1", "w1", "done", { title: "Fix the bridge" }),
  );
  await report(recorder, socket, { client_kind: "phone" });
  advance(10 * SECOND);
  await report(recorder, socket, {
    client_kind: "phone",
    workspace_id: "w2",
    tab_id: "w2:t1",
    pane_id: "w2:p1",
  });
  advance(300 * SECOND);
  await report(recorder, socket, {
    client_kind: "phone",
    input_age_ms: 300_000,
  });
  await report(recorder, socket, { client_kind: "phone" });
  await report(recorder, socket, { client_kind: "phone", visible: false });
  recorder.socketClosed(socket);
  await recorder.flush();
  const store = recorder.store()!;
  const all = store.readEvents();
  expect(new Set<string>(all.map((e) => e.kind))).toEqual(
    new Set(protocol.$defs.EventKind!.enum as string[]),
  );
  for (const event of all)
    expect(validate(event, { $ref: "#/$defs/Event" })).toEqual([]);
  const workspaces = store.readWorkspaces();
  expect(
    workspaces
      .map((w) => [w.name, w.path, w.repo?.root ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ).toEqual([
    ["gst", "/src/gst", null],
    ["roamgate", "/src/roamgate", "/src/roamgate"],
  ]);
  for (const workspace of workspaces)
    expect(validate(workspace, { $ref: "#/$defs/Workspace" })).toEqual([]);
  // With subjects, both sources.
  const subjectOf = subjectResolver({
    roots: ["/src"],
    explicit: (workspace) =>
      workspace.name === "gst"
        ? [
            { id: "tree:g1", label: "upstream" },
            { id: "tree:g2", label: "ocio" },
          ]
        : null,
  });
  const withSubject = withSubjects(workspaces, subjectOf);
  expect(withSubject.map((w) => w.subject?.source).sort()).toEqual([
    "directory",
    "explicit",
  ]);
  for (const workspace of withSubject)
    expect(validate(workspace, { $ref: "#/$defs/Workspace" })).toEqual([]);
  expect(
    validate(
      {
        ...withSubject[0],
        subject: { id: "x", label: "x", source: "repo", groups: [] },
      },
      { $ref: "#/$defs/Workspace" },
    ),
  ).not.toEqual([]);
  expect(
    validate(
      { events: all, workspaces, next_cursor: null },
      { $ref: "#/$defs/ActivityPage" },
    ),
  ).toEqual([]);
  // Ids are opaque strings that sort the way the log is ordered.
  const ids = all.map((e) => e.id);
  expect([...ids].sort()).toEqual(
    [...all].sort((a, b) => Number(a.id) - Number(b.id)).map((e) => e.id),
  );
  // The validator does catch a wrong shape.
  expect(
    validate({ ...all[0], reason: "bored" }, { $ref: "#/$defs/Event" }),
  ).not.toEqual([]);
});

test("branches and remotes are read from the host, now and then, and kept", async () => {
  const { recorder, herdr } = harness();
  herdr.state.repos.set("/src/roamgate", {
    top: "/src/roamgate",
    common: "/src/roamgate/.git",
    gitdir: "/src/roamgate/.git",
    branch: "main",
    remote: "https://u:token@example.com/roamgate.git",
  });
  herdr.state.repos.set("/src/gst", {
    top: "/src/gst",
    common: "/src/gstreamer/.git",
    gitdir: "/src/gstreamer/.git/worktrees/gst",
    branch: "ocio",
    remote: "git@example.com:gst/gstreamer.git",
  });
  await ready(recorder);
  const byName = () =>
    Object.fromEntries(
      recorder
        .store()!
        .readWorkspaces()
        .map((workspace) => [workspace.name, workspace.repo]),
    );
  expect(byName()).toEqual({
    roamgate: {
      root: "/src/roamgate",
      remote_url: "https://example.com/roamgate.git",
      branch: "main",
      is_worktree: false,
    },
    gst: {
      root: "/src/gstreamer",
      remote_url: "git@example.com:gst/gstreamer.git",
      branch: "ocio",
      is_worktree: true,
    },
  });
  expect(herdr.state.hostScripts).toHaveLength(1);
  // Herdr listing again keeps what git said; the branch is not read again soon.
  herdr.state.repos.get("/src/roamgate")!.branch = "next";
  recorder.paneList("local", { panes: herdr.state.panes }, Date.now());
  await recorder.flush();
  expect(herdr.state.hostScripts).toHaveLength(1);
  expect(byName().roamgate?.branch).toBe("main");
  advance(10 * 60 * SECOND);
  recorder.paneList("local", { panes: herdr.state.panes }, Date.now());
  await recorder.flush();
  expect(herdr.state.hostScripts).toHaveLength(2);
  expect(byName().roamgate?.branch).toBe("next");
  expect(byName().roamgate?.root).toBe("/src/roamgate");
});

test("a failing host read leaves the log as Herdr says", async () => {
  const h = harness();
  h.herdr.state.repos.set("/src/roamgate", {
    top: "/src/roamgate",
    common: "/src/roamgate/.git",
    gitdir: "/src/roamgate/.git",
    branch: "main",
    remote: "x",
  });
  h.herdr.runHostScript = async () => {
    throw new Error("ssh down");
  };
  await ready(h.recorder);
  const roamgate = h.recorder
    .store()!
    .readWorkspaces()
    .find((workspace) => workspace.name === "roamgate");
  expect(roamgate?.repo).toEqual({
    root: "/src/roamgate",
    remote_url: null,
    branch: null,
    is_worktree: false,
  });
});
