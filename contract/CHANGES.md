# Contract changes

Each change of the server's observable surface after the freeze is logged
here, newest first, in the same commit as the change: a section per contract
version with the inventory digest the check computes (`inventory: <sha256>`,
also in `contract.json`), what changed, and the family it concerns, so the
Rust owner of that family can take it over.

## 1.13

inventory: d1974dc1f1c8441606395df22b7df0530f55309e459f6b7aaa742d9c09dfc00b

The host family served by the Rust core (Phase 5, S16; wire/core-channel.md,
The host family), while the owners table gives it to Rust.

- owners: `owners/families.json` gives `host` the eight profile methods by
  name (`connections.list`, `.create`, `.update`, `.remove`, `.set_default`,
  `.connect`, `.disconnect`, `.test`) instead of the `connections.` prefix:
  `connections.agent_sessions` and `connections.agent_tasks` read agent
  sessions and stay with the agent_sessions family. `host` keeps
  `connections.json` alone; `agent_profile.` and `session-profiles.json`
  move to a new `agent_profiles` family (Phase 9, with conversation mode);
  `data:profiles` (the `--profile` CPU profiles) moves to `front`.
- wire: the front's `internal.host.start`, `.stop`, `.herdr_call`, `.run`,
  `.ssh_hold` and `.ssh_release`; the reverse targets `host.runtime_start`,
  `host.runtime_stop`, `host.events`, `host.status` and `host.master_ready`;
  the handover of the connections in each direction without two processes
  holding SSH masters or session slots at once.

## 1.11

inventory: d1974dc1f1c8441606395df22b7df0530f55309e459f6b7aaa742d9c09dfc00b

Disk writes off the server's event loop (`up/loop-stall`):

- storage: reviews.sqlite and tasks.sqlite run with `PRAGMA synchronous =
  NORMAL` in WAL mode (FULL before), as activity.sqlite does: a crash never
  corrupts them, a power loss can take the last commits. roamgate-assistant
  opens tasks.sqlite the same way.
- The JSON stores, the contract recorder and the Work history write behind
  their changes, off the event loop; their files and formats are unchanged.

## 1.10

inventory: d1974dc1f1c8441606395df22b7df0530f55309e459f6b7aaa742d9c09dfc00b

The Herdr relay on SSH tunnels (Work item 3c813194): Herdr sleeps 100 ms
when a control connection's request is not there yet, which through an ssh
`-L` forward it never is, so every call to an SSH host took about 105 ms.

- exec, connections: the Herdr tunnel of a POSIX SSH host runs
  contract/assets/python/herdr-relay.py as its remote command instead of
  `-N`, and forwards the control socket to the relay's
  `~/.cache/roamgate/herdr-relay-<token>.sock`; the tunnel is ready once
  the relay prints `roamgate-herdr-relay ready`. A host where it does not
  start gets the direct forward for the rest of the runtime.
- env, connections: `ROAMGATE_DISABLE_HERDR_RELAY=1` (legacy
  `HERDR_GUI_DISABLE_HERDR_RELAY`) always forwards directly.

## 1.9

inventory: 858ef95c89ead36eee2dfeab1288e69afcb4fe9363a8f263bd97d5706ba06107

Fixed in the server and the contract together (Work items d2560b86 and
adbda23a):

- schemas, work: a work item's `title` and `source` are at most 300
  characters and a stored `ask` read back at most 400, the "..." of a cut
  included (`oneLine` kept `max - 1` characters plus "...": 302 and 402).
- push, agent_chat: a conversation's process started for a message, or
  warmed up with messages queued, stays `starting` until the message is
  written, then `working`; it no longer reports `idle` in between, which
  told the browsers and Herdr a turn had ended.

## 1.8

inventory: 858ef95c89ead36eee2dfeab1288e69afcb4fe9363a8f263bd97d5706ba06107

The Pi sidecar (Phase 12, S24; wire/pi-sidecar.md): Ranger's Pi driver
served over a child's stdin and stdout, for the Rust server at the cut-over
and for the Bun server when asked. Nothing changes without the variable.

- env: `ROAMGATE_PI_SIDECAR`, the sidecar Ranger runs Pi in; unset, Pi
  runs in the Bun server as before.
- exec: `spawn assistant/pi-sidecar-client.ts#defaultSpawnSidecar`, that
  sidecar, started on the first Pi call and closed after five idle minutes.
- wire: `wire/pi-sidecar.md`, its JSON-RPC methods both ways, held to
  `vectors/pi-sidecar.json`.

## 1.7

inventory: 7a9f4c37bd29ddf5c043740889e556fd1781240a2b911221336c08bed223a3a3

Bugs the parity suite found in the Bun server, fixed in the server and the
contract together (Work item a7b37023):

- rpc, activity: `bridge.activity.timeline` leaves out the connections in
  `activity.exclude.connections`, as `roamgate activity` does (it kept their
  focus spans).
- http, auth: `POST /api/logout` ends the cookie on the server too: a copy
  of it no longer logs in, even after a restart. storage:
  `data:session-secret.revoked.json` and `data:session-secret-*.revoked.json`
  (version 1, the SHA-256 of each ended cookie with its expiry in epoch
  seconds, dropped once expired, 10000 at most, 0600).
  `roamgate-base::revoked_sessions` reads and writes it (for the front's
  port, Phase 7).
- ws: a reply made after its browser left is skipped (debug log `send after
  close skipped`) instead of logged as `websocket send dropped during
  <context>`.
- http, voice: `POST /api/voice/settings` with no usable voice.json answers
  the `speech_rate` or `max_pause_ms` it kept, and `GET /api/voice` reports
  them, instead of the defaults.
- push, agent_chat: `agent_chat.session` carries the new `session_id` (the
  lease's old one before).
- http: `GET /api/voice/companion/memories` and `DELETE
  /api/voice/companion/memories/{file}`, served but missing, are listed;
  the inventory reads routes told apart by `pathname.match`.
- rpc: `bridge.mr_reviews.effort.*` and `bridge.mr_reviews.ledger.*` (16
  methods handed to `handleEffortRpc`), served but missing, are listed.
- env: `ROAMGATE_TEST_VOICE_HARDWARE` and `ROAMGATE_TEST_VOICE_MODELS_URL`,
  a test server's voice hardware and model download mirror, honoured from
  source only.
- `scripts/contract/scaffold.ts` writes only what it adds into an existing
  YAML file (anchors, flow mappings, quoting and comments kept; any other
  change is refused), pads appended Markdown rows to the table, and writes
  JSON as biome formats it, so `--regenerate` leaves no churn.
- cli, storage, archive: the contract follows the archive as the server
  keeps it since its search moved to the text repo: `roamgate archive`
  lost `--index` and `rebuild-index` (`rebuild-db` remains); its database is
  `archive.sqlite` (`DB_VERSION` 2, pinned in place of `INDEX_VERSION`, the
  `files` and `meta` tables only), the old `index.sqlite` with its FTS5
  tables is read as is and migrated by a writer, then deleted; the search
  results' `source` is `text` or `raw`. The inventory follows string
  constants through imports in `join(...)` storage paths, which adds
  `owner.pid`, `owners.json`, `roamgate-pass.lock`, `roamgate-status.json`
  and `shadow.jsonl`, served but missing.

## 1.6

inventory: e8d2775b8d2d0d084c05cd3b9614c25f53df62090f92d05dd69d596b212ede72

The data families served by the Rust core (Phase 3, S13 and S14;
wire/core-channel.md), each while the owners table gives it to Rust.

- settings (S13): the core is settings.json's one writer while it owns the
  family; the front reads and writes through it. owners: the family's `rpc`
  names the methods whose answer is settings.json alone (`settings.get`, the
  agent auto rename, claude start, conversation, limit resume and terminal
  transport settings, `bridge.ui_settings.*`), no longer the `settings.`
  prefix: the profile, worktree, repository and workspace auto-sync settings
  stay with their families. wire: `internal.settings.get`,
  `internal.settings.update` (error code `stale`), the reverse target
  `settings.changed`, and The settings family. vectors: `settings.json`,
  `normalizeGuiSettings` for every section.
- mr_cache (S14): `owners/families.json` gives the family no RPC any more
  (`forge.status`, `forge.session` and the PR card of `git.pull_request` stay
  answered by Bun, whose forge reads go with the host layer); it keeps
  `mr-cache/state.json`. Wire: the front's `internal.mr_cache.get` and
  `internal.mr_cache.flush`, the reverse targets `mr_cache.load` (a reader's
  forge read or pause, by token) and `mr_cache.release` (Bun writes and drops
  its own cache before the core reads the file).
- notifications (S14): `owners/families.json` gives the family the `push`
  command; the front's internal calls `internal.notifications.state`,
  `.publish`, `.clear_tag`, `.clear_pane`, `.clear_blocked_pane` and
  `.clear_prompt`; reverse targets `notifications.feed` (the feed's events
  after a change, and those to send to the notification sockets, which the
  front keeps until Phase 7), `notifications.clients` and
  `notifications.current`. http: `/api/notifications/push` describes its
  403 (`Forbidden`, text), which a recording now captures when the core
  answers. notifications.json, web-push.json and the feed's messages are
  unchanged.
- activity (S13): `owners/families.json` gives the family its CLI
  (`activity`, `roamgate activity` passed through to the core while Rust
  owns it). wire: the front's `internal.activity.start`,
  `internal.activity.signals` (what only the front sees in stage 1, each
  stamped with its arrival time: connection states, the Herdr events and
  listings the recorder reads, the agents conversation mode runs, closed
  browser sockets), `internal.activity.flush` (asked before each advance
  of a test clock) and `internal.activity.stop`, the handover of
  activity.sqlite without two writers, and the signals held while the
  table names Rust and the core has not connected (15 s at most); the
  reverse target `activity.hostScript` (the recorder's read-only git
  script on a connection's host); `activity.dayInput` is asked only while
  Bun owns the activity family (the core builds the day itself while it
  owns it). At shutdown the activity log stops before the core.

## 1.5

inventory: e8d2775b8d2d0d084c05cd3b9614c25f53df62090f92d05dd69d596b212ede72

The leaf families served by the Rust core (Phase 2, S12; wire/core-channel.md,
Families in the core, CLI pass-through): limit_resume, time_report, update
and herdr_setup, each while the owners table gives it to Rust.

- owners: `owners/families.json` gains `cli`, the commands of a family
  (`herdr` for herdr_setup, `update` and `rollback` for update); herdr_setup
  no longer lists `/api/herdr-info` (a connection endpoint, moving with the
  host family); the owners table gains `core`, written by the Rust binary's
  hidden `roamgate owners`.
- exec: `spawn core-channel/cli.ts#defaultRunCore`, the core binary running
  such a command while Rust owns its family.
- storage: `data:runtime`, the channel's runtime directory, now named by the
  CLI too.
- wire: `welcome.clock` and `internal.clock.advance`, the front's test clock
  followed by the core's families; `internal.<family>.<op>`, the front's own
  calls to a Rust-owned family (`internal.limit_resume.poke`); the core's
  variables `ROAMGATE_CORE_SERVED_LOG`, `ROAMGATE_CLI_EXEC`,
  `ROAMGATE_CLI_VERSION`, `ROAMGATE_CLI_STANDALONE` (the executable an update
  replaces, set by the CLI pass-through and by the Bun server for its core).
- wire, reverse targets: limit_resume's `connections.ready`,
  `settings.limit_resume.get`, `conversation.owned_panes`,
  `conversation.prompt`, `claude_mod.panes`, `claude_mod.deliver`,
  `agent.transcript_tail` and `herdr.call`'s `timeout_ms`; time_report's
  `activity.dayInput` (until the activity family moves, S13); herdr_setup's
  `herdr.setupGuard` and `herdr.ping`; update's `server.scheduleExit`. The
  update and herdr_setup families are routed to the core at their own
  routes, keeping the front's method match and idle budget.
- rpc: `limit_resume.resume_now` and `limit_resume.skip` replies list
  `reason` (both servers always sent it; the schema was typed from
  recordings that lacked it).

## 1.4

inventory: d5e5059d19561624ff411e94d84f54be73194cd192816f98f826e21ea0a5e78b

The internal channel to a Rust core (wire/core-channel.md), off unless
`ROAMGATE_CORE_BIN` names one (the channel itself, no family):

- env: `ROAMGATE_CORE_BIN`, `ROAMGATE_CORE_TEST`.
- exec: `spawn core-channel/supervisor.ts#defaultSpawn`, the core.
- constants: the voice helper's frame codec moved to
  `server/src/utils/frames.ts` (`MAX_FRAME` unchanged); the channel's
  `PROTOCOL` 1, body chunk kind 2 and 64 MiB frame cap are pinned.
- wire: `core-channel.md`; owners: `owners/families.json`, the families, their
  methods, paths, files and shadowed reads; vectors: `core-channel.json`.

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
