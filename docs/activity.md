# Activity log

When enabled, the bridge records coarse, timestamped activity per connection:
which workspace (and pane) had the user's attention, from which device, and
what state the agents were in. It records nothing from terminals: no output,
no input, no keystrokes. Recording is off by default; see
[the settings](./DEPLOYMENT.md#activity-log).

The log is a local file, `activity.sqlite` in Roamgate's data directory
(`~/.config/roamgate`, `%APPDATA%\roamgate` on Windows). Events read back in the
shapes of [`activity.schema.json`](./activity.schema.json) (`$defs`: `Event`,
`EventKind`, `Workspace`, `Repo`, `AgentState`, `ActivityPage`).

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
  only with `record_agent_titles`.
- **Attention spans** (`workspace.focus` and `workspace.blur`). Every focus
  gets a blur with a `reason`:
  - `switch`: another workspace or pane, another connection, or none;
  - `hidden`: the page was hidden or lost the focus;
  - `idle`: no input for `idle_seconds`;
  - `disconnect`: the browser's socket closed, or the connection stopped being
    ready;
  - `timeout`: no presence report for 150 seconds;
  - `recorder_stop`: the bridge stopped, or died (see below).

  A span still open when read has `open: true`. Spans from browsers carry
  `source: "browser"` and the `client`. Herdr's own TUI focus is recorded too,
  as spans with `source: "herdr"` and no client: a low-confidence signal, since
  Herdr cannot tell whether anyone looks at its TUI. These change only with the
  focused workspace.
- **The UI in front of the user** (`ui.visibility`): `visible` is true while a
  page is visible and has the focus, per client.
- **Idle and back** (`session.idle`, `session.active`), per client.
  `session.idle` is dated at the threshold and carries `idle_after_seconds`.
- **Gaps**: the periods a connection was not ready, and those the recorder was
  not running (no connection), so that "nothing happened" can be told from "not
  recorded".

No heartbeat events are stored.

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
