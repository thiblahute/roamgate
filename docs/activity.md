# Activity log

When enabled, the bridge records coarse, timestamped activity per connection:
which workspace (and pane) had the user's attention, from which device, and
what state the agents were in. It records nothing from terminals: no output,
no input, no keystrokes. Recording is off by default; see
[the settings](./DEPLOYMENT.md#activity-log).

The log is a local file, `activity.sqlite` in Roamgate's data directory
(`~/.config/roamgate`, `%APPDATA%\roamgate` on Windows). Events read back in the
shapes of [`activity.schema.json`](./activity.schema.json) (`$defs`: `Event`,
`EventKind`, `Workspace`, `Repo`, `AgentState`, `ActivityPage`,
`RecordingGap`, `Status`). Read it with the [timeline](#timeline) in the web
UI or with [`roamgate activity`](#command-line).

## What is recorded

- **Agent states** (`agent.state`), from Herdr's per-pane status events:
  `working`, `idle`, `blocked`, `unknown`. Herdr's `done` (finished, not yet
  seen) is recorded as `idle`. A state is recorded when it changes, not again
  while it holds. The bridge's periodic `pane.list` catches changes it missed;
  a listing never overrides an event newer than it. An agent whose pane closes
  or whose process ends goes to `unknown`, once; an agent never seen in a
  known state is not recorded. After a connection gap every agent's state is recorded
  again. `agent.session_id` is Herdr's session id (a session file's name for
  agents that keep sessions as files). `agent.task` is the session title, and
  only with `record_agent_titles`. A Claude that conversation mode runs in a
  pane is recorded in the state conversation mode knows (working only while
  a turn runs; background tasks alone leave it idle), never Herdr's: Herdr's
  Claude integration claims the pane when the headless claude starts, and
  Herdr's state for it no longer follows.
- **Attention spans** (`workspace.focus` and `workspace.blur`). Every focus
  gets a blur with a `reason`:
  - `switch`: another workspace or pane, another connection, or none;
  - `hidden`: the page was hidden or lost the focus;
  - `idle`: no input for `idle_seconds`;
  - `disconnect`: the browser's socket closed, or the connection stopped being
    ready;
  - `timeout`: no presence report for 150 seconds;
  - `recorder_stop`: the bridge stopped, or died (see below).

  A span still open when read has `open: true`. Only focus and blur events
  carry a `source`. Spans from browsers carry `source: "browser"` and the
  `client`. Herdr's own TUI focus is recorded too,
  as spans with `source: "herdr"` and no client: a low-confidence signal, since
  Herdr cannot tell whether anyone looks at its TUI. These change only with the
  focused workspace, and run whether or not anyone is attached.
- **The UI in front of the user** (`ui.visibility`): `visible` is true while a
  page is visible and has the focus (visible AND focused), per client.
- **Idle and back** (`session.idle`, `session.active`), per client.
  `session.idle` is dated at the threshold and carries `idle_after_seconds`.
- **Gaps**: the periods a connection was not ready, and those the recorder was
  not running (no connection), so that "nothing happened" can be told from "not
  recorded".

No heartbeat events are stored.

## Ids and ordering

Event ids are a zero-padded sequence, never reused: they are the order of the
log, and resume cursors are ids, never times. A `ts` is not monotonic in id
order: a `timeout` blur is dated at the last presence report, and an `idle`
blur and `session.idle` at the last input plus `idle_seconds`, so a later id
can carry an earlier `ts`. Place spans by `ts`; use ids for order and ties.

Gaps read back as `RecordingGap`: `connection_id` null when the whole recorder
was down, `end` null while the gap is open. `excluded` is never set in the log,
which records excluded connections as usual; it is for exports to other
tools.

## Presence

Each open page reports to its connection with the `activity.presence` RPC:

```json
{
  "client_id": "4b0f9c6e-...",
  "client_kind": "desktop",
  "workspace_id": "w2",
  "tab_id": "w2:t1",
  "pane_id": "w2:p1",
  "visible": true,
  "focused": true,
  "input_age_ms": 12000
}
```

`client_id` is a random id the browser keeps in local storage; `client_kind`
is `phone` on mobile browsers, else `desktop`. `pane_id` is null on a phone
showing another view than the pane. `input_age_ms` is how long ago the last key,
pointer, wheel or touch event was, never what it was; bringing the page to the
front counts as input. The reply is `{"recording": bool, "idle_seconds": int}`;
a page stops reporting once `recording` is false.

A page reports each change of where it looks, of visibility and focus, the
moment it becomes idle, and input after idle. While it is visible, focused and
not idle, it reports again every 60 seconds. The bridge stamps every report
with its own clock. Reading (visible and focused, no input) counts as attention
until `idle_seconds`. A span whose reports stop ends with `timeout` 150 seconds
after the last one, dated at that last report.

## Workspaces

`workspace_id` in events is a stable key: a hash of the connection and the
workspace's checkout path, so it survives Herdr restarts (Herdr's ids do not).
The path is Herdr's worktree checkout, else the directory of the workspace's
first pane when first seen; a workspace with neither is keyed by its name.
Workspaces sharing a path share the key. Each workspace keeps its name, path,
repository root, whether it is a linked worktree, and Herdr's current id as
`herdr_workspace_id`.

## Recorder sessions and retention

Each bridge run is a recorder session, stamped alive every 60 seconds. A clean
stop ends every open span (`recorder_stop`) and gap. On start, whatever a
previous run left open (it crashed or was killed) is ended at its last alive
stamp, and the time since the previous run ended is recorded as a recorder gap.

Once a day the bridge deletes events, gaps, sessions and unreferenced
workspaces older than `retention_days`, then returns freed space to the file
system a bounded amount at a time.

## Timeline

The bridge-global RPC `bridge.activity.timeline` (`{"from": "YYYY-MM-DD",
"to": "YYYY-MM-DD"}`, both included, at most 92 days; either alone means that
day, neither means today) returns `{"recording": false}` while the bridge does
not record, else the days of the range. A day runs from `day_start` to
`day_start` the next day, in the bridge's local time. Times are ISO 8601 with
the offset; durations are milliseconds. Each day has:

- `focus`: the attention spans clipped to the day, with `workspace_id`,
  `connection_id`, `pane_id`, `source` (`browser`, `phone` or `herdr`),
  `client_id` and the blur `reason` (null while `open`). A span still open ends
  now (`open: true`), or at the recorder's last alive stamp when the recorder
  is not running.
- `attention`: who had the attention, without overlaps. At each instant the
  most recently started browser or phone span wins. Herdr's TUI spans only
  fill the time no browser or phone span covers, and only within
  `idle_seconds` of a sign of a person, since they run whether or not anyone
  looks: Herdr reports no attached client nor input time, and its output
  events cannot tell typing from a program writing. A sign is a browser or
  phone span (while it runs, and `idle_seconds` after it ends unless it ended
  as `idle`), input after idle or a page brought to the front, or a focus
  change in Herdr's TUI (a Herdr span ended with `switch`; one opened when the
  recorder or the connection starts is none). The rest of a Herdr span is in
  `focus` but not in `attention`.
- `idle`: per client, from `session.idle` to the client's next sign of life
  (`session.active`, a visibility change, or a new focus).
- `agents`: lanes per pane and agent, with the `working`, `blocked`, `idle` and
  `unknown` stretches between consecutive `agent.state` events. A lane starts
  from the last state before the range; connection and recorder gaps cut it;
  an agent's last `unknown` (its pane closed) ends the lane.
- `gaps`: `RecordingGap`s clipped to the day, including, while the recorder is
  not running, one from its last stamp (`reason: "recorder"`, `end: null`).
- `totals`: `attended_ms` (the `attention` segments), `idle_ms`,
  `unrecorded_ms` (recorder gaps), and per workspace `attended_ms` split into
  `browser_ms`, `phone_ms` and `herdr_ms` (Herdr's TUI within the attention
  above), plus `working_ms` and `blocked_ms`:
  the time at least one of its agents was in that state.

`workspaces` lists the workspaces the days refer to, with name, connection,
path and Herdr's current id, and `recorder_running` says whether open spans
end now.

## Command line

`roamgate activity` reads `activity.sqlite` read-only, so it works without the
server running:

```sh
roamgate activity today [--json]
roamgate activity day 2026-11-02 [--json]
roamgate activity range 2026-10-26 2026-11-01 [--json]
roamgate activity events [--after ID] [--from T] [--to T] [--connection ID]
                         [--workspace ID] [--kind K[,K...]] [--limit N]
                         [--json | --ndjson]
roamgate activity workspaces [--from T] [--to T] [--connection ID] [--json]
roamgate activity status [--json]
```

- `today`, `day` and `range` print attended time (and how much of it came from
  Herdr's TUI) and agent working and blocked time per workspace; `--json`
  prints the [timeline](#timeline).
- `events` prints events in id order. `--json` prints an `ActivityPage`; when
  more events match, `next_cursor` is the last id, to pass to `--after`.
  `--ndjson` prints one `Event` per line. `--from` and `--to` take dates (day
  boundaries per `day_start`) or ISO 8601 times. `--limit` defaults to 1000, at
  most 5000.
- `workspaces` prints `{"workspaces": [Workspace]}` with `--json`: those with
  events in the range.
- `status` prints a `Status`: whether the log is recording (enabled and the
  recorder stamped alive in the last 150 seconds), the last alive stamp, each
  connection's state, and today's `RecordingGap`s.

Connections in `exclude.connections` are left out of everything but `status`.
Exit codes: 0 on success, 2 for invalid arguments, 1 otherwise. With `--json`
or `--ndjson`, errors are printed on stderr as `{"error": "message"}`.
