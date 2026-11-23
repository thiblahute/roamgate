# Contract changes

Each change of the server's observable surface after the freeze is logged
here, newest first, in the same commit as the change: a section per contract
version with the inventory digest the check computes (`inventory: <sha256>`,
also in `contract.json`), what changed, and the family it concerns, so the
Rust owner of that family can take it over.

## 1.3

inventory: 7502f4677baf20ae3c3b0888708790b4aad9f3903f373ad9ce31068e3edb5176

No inventory change; the schemas follow shared/ (all families):

- schemas: `shared/agentSession.schema.json` (AgentCommand, AgentTask,
  AgentTaskSummary, PublishedArtifact, SessionArtifact, WorkflowAgentView,
  WorkflowView) and `shared/agentHistory.schema.json` (HistoryCursor,
  HistoryEntry, HistoryUpdate), the session and History wire types the server
  now takes from shared/.
- schemas: `shared/mrEffortBoard.schema.json` is gone with its module, which
  moved into the web app (MrEffortColumn was never on the wire).
- the check fails on a schema file no module of shared/ or the server's
  types makes any more, and `scaffold.ts --regenerate` deletes such files.

## 1.2

inventory: 7502f4677baf20ae3c3b0888708790b4aad9f3903f373ad9ce31068e3edb5176

No inventory change; the parity suite now covers every entry.

- typed from the parity suite's runs: every RPC method but `bridge.ping` and
  the Herdr pass-through, every push but `event:workspace.git_status` and
  `event:workspace.last_step_completed`, every socket message, the agent
  socket's operations (requests name every field the Python client,
  roamgate-hold and the Claude mod send; HolderReply accepts a hold carrying
  `commands` and `output_from`) and 44 of the 78 HTTP operations.
- schemas: `AssistantSource` carries `connection_label` and `label`
  (reconcile.json).
- golden/: goldens of the parity scenarios, recorded from Bun.
- normalize.json: more normalizers (hex and short ids, git shas, tokens,
  opaque stamps, sizes, session file stats, history entry ids).
- the record checkers (TS check.ts and the suite's Rust one) treat a key
  several anyOf branches describe as unknown only when every branch lacks
  it, and ignore schema errors on values the recorder redacted.

## 1.1

inventory: 7502f4677baf20ae3c3b0888708790b4aad9f3903f373ad9ce31068e3edb5176

Found by the parity suite (parity/), no change of the server:

- pushes: `event:roamgate.limit_pauses` (limit_resume), which the inventory
  missed because its name is a constant imported from shared/; the inventory
  now reads such constants.
- typed from the suite's runs (params and replies of what the scenarios
  exercise, against the generated schemas where they exist):
  - pushes `hello`, `event:roamgate.limit_pauses`, `ui_settings`,
    `settings.terminal_transport.updated`;
  - limit_resume: `limit_resume.list`;
  - settings: `settings.get` and get and update of `limit_resume`,
    `agent_auto_rename`, `claude_start`, `conversation` and
    `terminal_transport`; `bridge.ui_settings.get` and `.update`;
  - notifications: `bridge.notifications.status`, and in the HTTP document
    `/api/notifications/push` (GET, POST, DELETE);
  - herdr: `/api/herdr-info` (both), `/api/herdr/setup`, `/api/herdr/status`;
  - update: `/api/update/check`, `/api/update/install`;
  - time_report and activity: `bridge.time_report`,
    `bridge.activity.timeline`, `activity.presence`;
  - archive: `bridge.archive.search` and `.open`;
  - mr_reviews and forge: `bridge.mr_reviews.inbox`, `seen`, `feedback`,
    `pin`, `unpin`, `hide`, `unhide`, `order`, `override`, `view`,
    `settings.get` and `settings.update`; `forge.status`;
  - work: the fifteen `bridge.work.*` methods, and `/v1/work` on the agent
    socket.
- vectors: `vectors/voice-frames.json`, the voice helper's frame codec, read
  by bun test and by the parity suite.
- `normalize.json`: the parity suite's named normalizers.
- http: a last `{static}` or `{path}` segment of a path stands for the rest of
  the path (the app shell at `/`, nested static files, a rendered page's
  files); the record checker matches them so.

## 1.0

inventory: f12917316e11265ca4378b30d1f301b5886c9edeb904e002e3ea02f6e1e8d2ea

The first inventory of the Bun server, frozen: 259 browser RPC entries
(including the Herdr pass-through), 46 pushes, 68 HTTP paths (48 tested with
their method), 52 operations and events of the notification, voice and
signalling sockets, 38 agent socket commands, 164 CLI names (18 commands with
their actions and flags, 18 server flags) with 20 help goldens, 107
environment variables, 90 storage names with the SQL of 5 databases, 65
process names (41 spawn sites, 24 programs), 27 pinned versions and limits,
and 317 JSON Schema definitions generated from shared/ and the server-local
wire and file types.
