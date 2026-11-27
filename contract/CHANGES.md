# Contract changes

Each change of the server's observable surface after the freeze is logged
here, newest first, in the same commit as the change: a section per contract
version with the inventory digest the check computes (`inventory: <sha256>`,
also in `contract.json`), what changed, and the family it concerns, so the
Rust owner of that family can take it over.

## 1.56

inventory: 5482ddde05209b65350da9deb353fea9d3c5f7073f51a1e51493c37adfb2c4c3

The Usage view reads the account chain's moves and names the sessions that
spent an account.

- rpc: `agent_profile.account.switches` (`limit`): the chain's last moves,
  newest first (`at`, `kind`, `from`, `to`, `why`, `reading`,
  `session_id`, `ok`, `error`), kept in `accounts/switches.jsonl`. Family:
  agent_profile.
- rpc: `agent_profile.account.sessions` gives each session's `title`
  (its transcript's summary, else the first thing asked), `cwd`, the
  `pane` it last ran in and whether it is `pinned`. Family: agent_profile.

## 1.55

inventory: ab63cd4214c93ad2124286d8c01895c2c6a6b522812a37f79584261b63e0f4f4

clauth's profiles import as account profiles: each becomes an account
profile of the same name whose sign-in stays clauth's (a link to its
file, never refreshed, signed out or rewritten by Roamgate) until the
user takes it over; clauth's chain, lines, preferred account and days,
last resort, walk order and active profile carry over. Nothing under
`~/.clauth` is ever written.

- rpc: `agent_profile.import.scan` (what `~/.clauth` and the user's own
  agy hold, no secret), `agent_profile.import.apply` (`accounts`,
  `agy_default`), `agent_profile.import.take_over` (`profile`). Family:
  agent_profile.
- rpc: `settings.profiles.get`'s account gives `clauth` (the clauth
  profile) while clauth manages its sign-in. Family: settings.

## 1.54

inventory: 91f572a7a364cb6f8336b0f1ee55b966554e5c724f54fc42c127f19ef9b5c491

Account profiles form a chain that moves sessions along it: the global
default (`profiles.default`) leaves an account past its lines, the live
sessions on it follow (pinned ones only past the hard cap), and a session
stopped by a usage limit goes on with the next account. limit_resume's
fallback first asks the agent_profiles family; when no chain has the
session it keeps the conversation's fallback agent as before.

- types: `ProfilesSettings.chain` (`AccountChain`: `accounts`,
  `auto_switch`, `five_hour_line`, `weekly_line`, `lines`, `preferred`,
  `preferred_days`, `last_resort`, `walk`). Family: settings.
- rpc: `settings.profiles.get` and `.update` carry `chain`; `.update`'s
  refusal of other keys names it. Family: settings.
- rpc: `agent_profile.pin` (`pane_id`, `pinned`); `agent_profile.switch`
  takes `pin`; `agent_profile.get` says `pinned`. Family: agent_profile.
- env: `ROAMGATE_TEST_ACCOUNTS_URL` (from source only): a base URL for the
  account sign-in and usage servers. Family: agent_profile.
- wire: `internal.agent_profiles.chain_switch` (`connection_id`,
  `pane_id`; answers `applies`, `ok`, `unchanged`, `reason`), from
  limit_resume's fallback, retried and skipped as it;
  `internal.conversation.notice`
  (`pane_id`, `kind`, `text`). Family: agent_profiles, conversation.

## 1.53

inventory: b81d7ccb7746834f8fa021ba0cfb5b92d910a2052547ce4353736c0bd3429fee

Each signed-in account's usage is read by one scheduler (about every
90 s, `agy` every 10 minutes by asking `agy` itself) and kept in
`accounts/usage.json`; every browser is told what changed, once.

- rpc: `agent_profile.account.usage` (every account's last reading:
  `agent`, `id`, `status`, `usage` with its `windows`, plan, email,
  `read_at`) and `agent_profile.account.sessions` (`profile`, `since`,
  `until`: the sessions that ran on the account then, with the tokens
  their transcripts record there). Family: agent_profile.
- push: `account_usage` (keyed): `accounts` whose reading changed and
  `removed` keys. Family: agent_profile.

## 1.52

inventory: df089a2e7d64be8b4073b59a2dcd2461cce2eb45f85b4bf9dea7b97daa2d5aeb

An account profile signs in from Roamgate: Claude and Codex through their
own sign-in pages (the link opens in any browser; the code or the address
the page ends on is pasted back), `agy` inside `agy` itself, Roamgate only
asking it whether that works.

- rpc: `agent_profile.account.login.start` (`profile`; answers `kind`
  `link` with `login`, `url` and what to `paste`, or `terminal` with a
  `message`), `agent_profile.account.login.complete` (`profile`, `login`,
  `code`) and `agent_profile.account.logout` (`profile`), each answering
  the account's `auth`. Family: agent_profile.
- rpc: `agent_profile.get` lists an account profile's `account` (`id`,
  `auth`). Family: agent_profile.

## 1.51

inventory: 1ea6e625d343fe9210dc6b762ec9ec0b594918bbce0a3ef4b201ca4b6d1cfdcb

A profile may be an account profile: `account: {"id"}` names one sign-in
of its agent, whose configuration directory is
`<data>/accounts/<agent>/<id>/`. Profiles may name the agents `claude`,
`codex` and `agy`; settings without accounts read as before.

- types: `AgentProfile.account` (`ProfileAccount`), `ProfileView.account`
  (`ProfileAccountView`), `AccountAuthState`; `ProfileAgent` is
  `claude | codex | agy`. Family: settings.
- rpc: `settings.profiles.get` gives an account profile's `account` with
  its `dir` and `auth` (`unknown`, `signed_in`, `signed_out` or
  `needs_relogin`); `settings.profiles.update` keeps `account.id` and
  refuses two profiles on one account. Family: settings.
- storage: `data:accounts`, the account profiles' directories
  (`accounts/<agent>/<id>/`). Family: agent_profiles.

## 1.50

inventory: 70d4b01c5087708a8b0d7a51e7a2eb30bc9dfbafdaae7c453fe4d35ee964af91

A conversation's permission nobody answers in time is denied, and the agent
is told to work around it.

- rpc: `settings.conversation.get` and `.update` carry
  `permission_timeout_seconds` (0, never, to 86400; 900 by default); an
  update takes it alone. Family: settings.
- channel: `conversation.host` op `permission_timeout_seconds` answers the
  setting; `ask`'s `timeout_ms` 0 means no time limit. Family:
  conversation.
- types: `AgentPermissionPrompt.expiresAt` is optional (absent: the prompt
  waits until answered). `InjectedKind` adds `permission`: the
  `<roamgate-permission-timeout tool seconds>` block an agent whose denial
  carries no message (AGY over ACP) is sent. Family: agent_chat.
- behaviour: an unanswered permission is denied with a message saying
  nobody answered within the time, to do the work another way if possible
  and otherwise to say what is needed and go on (Claude: in its `deny`
  control response; AGY: its reject option, then that message after the
  turn). Family: agent_chat.

## 1.49

inventory: 70d4b01c5087708a8b0d7a51e7a2eb30bc9dfbafdaae7c453fe4d35ee964af91

A conversation that hits its usage limit can continue on another agent
instead of waiting for the reset.

- rpc: `settings.conversation.get` and `.update` carry `fallback_agent`
  (`claude` or `agy`; an update's `null` clears it); an update takes either
  key. Family: settings.
- channel: the limit resumer calls `internal.conversation.switch_agent`
  with `reason: usage_limit` when it pauses a conversation and a fallback
  agent is set, then skips that pause. Family: limit_resume.

## 1.48

inventory: 70d4b01c5087708a8b0d7a51e7a2eb30bc9dfbafdaae7c453fe4d35ee964af91

A conversation-mode conversation is a work session kept across agents, and
moves between Claude and AGY in the same chat, one writer at a time.

- rpc: `agent_chat.switch_agent {pane_id, agent, reason?, fresh_session?}`
  answers `AgentChatSwitchResult`. Family: agent_chat.
- push: `agent_chat.backend_switched` (`from_agent`, `to_agent`,
  `work_session_id`, `session_id`, `reason`, the new agent's
  `capabilities`). Family: agent_chat.
- types: `AgentChatLease` and `AgentChatState` carry `work_session_id` and,
  during a switch, `handoff_phase`; the lease keeps the other agents'
  `agent_terminal_args`. `InjectedKind` adds `continuation`: the
  `<roamgate-continuation>` block an agent is given when a conversation
  moves to it. Family: agent_chat.
- storage: `data:conversation-continuity` (`<id>.json`,
  `<id>.events.jsonl`). Family: conversation.
- channel: `internal.conversation.switch_agent`. Family: conversation.

## 1.47

inventory: 049bad51aebad7406098bf2d0ce214d4bce2dba32087ca8791ced7d78d0efc5c

Conversation mode drives the Antigravity CLI (`agy`) as well as Claude
Code: an agy pane is taken over (the holder runs `agy acp --stdio`, ACP's
JSON-RPC) and handed back (`agy --conversation <id>`).

- types: `ConversationAgent` is `claude` or `agy`; `AgentChatCapabilities`'
  `slashCommands` may be `agy`. Family: agent_chat.
- exec: `program agy` (the pane holder's ACP child, the resumed TUI, and
  `agy -p /usage --output-format json` for the chat's /usage). Family:
  agent_chat.

## 1.46

inventory: 0cbf4749be847bf8ab63d58c516a6b1588c42ac164ad0f697ad6308f0cefa09a

A web search the voice companion runs is `searching` until it ends, as the
server and the page have always said; the schema named it `running`.

- http: `GET /api/voice/research` (and `?job=`): a job's `status` is
  `searching`, `done`, `failed` or `cancelled`. Family: voice.

## 1.45

inventory: 0cbf4749be847bf8ab63d58c516a6b1588c42ac164ad0f697ad6308f0cefa09a

A session's background tasks include those its subagents started
themselves, down to their own subagents, each listed once under the agent
that started it; and the agents the session did not start but resumed with
a message or heard end.

- rpc: `agent_tasks.get` and `agent_task.get` give `AgentTask`s (the shared
  type), with `parentAgentId` and `parent` (the agent that started one) and
  `foreign` (one the session only resumed or heard end). A subagent's own
  commands and monitors are listed only while both run. Family:
  agent_sessions.

## 1.44

inventory: 0cbf4749be847bf8ab63d58c516a6b1588c42ac164ad0f697ad6308f0cefa09a

The agents' clients on the server's machine are the roamgate binary itself
(`~/.cache/roamgate/bin/roamgate-review` and `roamgate-hold` link to it;
`roamgate review|hold` run the same); SSH hosts keep the Python clients of
`contract/assets/python`. Their command lines, requests on the agent
socket, output and exit codes are unchanged.

- env: the variables the clients read are listed, now that the crates read
  them: `ROAMGATE_REVIEW_SOCKET` (the agent socket, default
  `~/.cache/roamgate/review.sock`), `ROAMGATE_CLAUDE_START`,
  `ROAMGATE_HEADLESS`, `ROAMGATE_PANE_ID`, `ROAMGATE_HERDR_SOCKET_PATH`,
  and `ROAMGATE_HOLD_GUARD` (set by the holder on its child's guard).
  Family: review, conversation.

## 1.43

inventory: 9742d83183a59ed3e96c6adb4c1198d90ee7f5c1dffc54db23b58e1d83c6fe6c

The Bun server is gone (S25 cut-over, WP9): the server is the Rust binary
alone, `roamgate [server flags]` as the front with its own executable as
the core. The browser surface (RPC, pushes, HTTP, sockets, the agent
socket, the CLI) is unchanged.

- wire: `core-channel.md` describes the front and its core only. The
  owners table leaves: no `<data>/runtime/owners.json` (and no
  `roamgate owners`), no `owner` message, no `owners`, `shadow` or `side`
  in `hello` and `welcome`, no `shadow` flag on `call`, no shadow reads
  (`shadow.jsonl`); every family the core implements serves from the
  `welcome` until the channel closes. The Bun side of the channel leaves
  with the Rust core's link to a Rust front (`ROAMGATE_FRONT_CHANNEL`,
  `ROAMGATE_FRONT_TOKEN`), the Bun core (`ROAMGATE_SIDECAR_BIN`), the Rust
  core beside a Bun server (`ROAMGATE_CORE_BIN`) and the CLI pass-through;
  `ROAMGATE_CORE_STANDALONE` is no longer set or read (the core always
  answers in its own process). The handover targets (`*.release`,
  `review.socketsTaken`, `claude_mod.released`, `history.configure`,
  `activity.dayInput`, `review.addThread`) and the front's
  `internal.settings.get`, `.update`, `internal.history.release`,
  `internal.assistant.release`, `internal.voice.release`,
  `internal.review.mod_release` and `internal.review.close` leave. A socket
  no family serves is refused (`{accepted: false}`) instead of passed on.
  `owners/families.json` moves to `wire/families.json`, without `phase`,
  `shadow` and `cli`. The vectors keep the frames, the family of a method
  or path and the outbound queue.
- wire: `node-link.md`'s node contract is 2: the node link's `hello` and
  `welcome` lose `side` with the core channel's; a home or node of contract
  1 cannot read the other's handshake, a failed start that falls back to
  the SSH tunnel.
- env: the table lists what the Rust crates read, with the files that
  read it; `ROAMGATE_CORE_BIN` leaves, `ROAMGATE_CORE_SERVED_LOG` joins
  it, with the node's (`ROAMGATE_NODE_HOME`, `ROAMGATE_DATA_ROOT`,
  `ROAMGATE_NODE_TITLE_SUFFIX` and the home's `ROAMGATE_NODE_ORIGINS`),
  which no TypeScript read; `ROAMGATE_CLI_VERSION` is no longer read (the
  front and its core are one binary). `OPEN_BROWSER` and `--open` open the browser again once the
  server listens, as the Bun server did.
- storage: `file:owners.json` and `file:shadow.jsonl` leave.
- exec: the core channel's two spawn sites of the Bun server leave.
- schemas: `server.schema.json` is written by hand (its TypeScript source,
  `schemas/server-types.ts`, named the Bun server's types).
- assets: `assets/index.json`'s `used_by` names the crates' sources.
- The inventory digest is now that of the contract's own names
  (`scripts/contract/entries.ts`), not of the names the Bun server's code
  had: the check reads no server code.

## 1.42

inventory: 55a67ea9b2a338ffd4cc48bb11d525829ca22a8477c59286f87c0b7ef869996a

The node link carries terminals and the host's agent socket (family
connections, wire/node-link.md): a node profile's render socket is a proxy
whose streams go over the link while it is up, and the new `node.listen`
call has the node listen on the host's review socket and stream each of its
connections back to the connection's agent socket, instead of the master's
`ssh -O forward -R`, which stays the fallback and is set up again whenever
the link goes down. The inventory is unchanged.

## 1.41

inventory: 55a67ea9b2a338ffd4cc48bb11d525829ca22a8477c59286f87c0b7ef869996a

The node link (Mac node phase 2; family connections, wire/node-link.md): an
SSH profile may carry `"node": true` (refused with `remote_platform`
`windows`; kept by an edit that leaves it out), and the connection replies'
profiles name it (`connections.list`, `.connect`, `.create`, `.update`,
`.disconnect`). Such a profile runs `roamgate node --stdio` on its host over
its command master and sends its Herdr control calls, its event subscription
and its host commands through that link, falling back to the tunnel and the
master when the node is missing or speaks another node contract. The core
channel's `welcome` gains an optional `node` (`version`, `contract`), which
only a node sends. The inventory is unchanged.

## 1.40

inventory: 55a67ea9b2a338ffd4cc48bb11d525829ca22a8477c59286f87c0b7ef869996a

A machine's node (Mac node phase 3; Rust only): `roamgate node --listen
<host:port> --home <origin>` runs the front and its standalone core again
with `ROAMGATE_NODE_HOME` (the home's origin) and `ROAMGATE_DATA_ROOT` (its
own data root, default `~/.config/roamgate-node`, in place of
`<config>/roamgate`, nothing migrated into it) and one local connection,
id `local`, to this machine's Herdr. The hello on its `/ws` carries
`node: {home, connection_id, version}` (push/hello.json) and an authed
`GET /api/node` answers `{node}` (404 outside a node). Its core serves the
front, host, workspace and agent_sessions families; every other family
keeps its name but answers `served_by_home` (calls), 404 with that code
(paths) and runs no background work, and the front refuses the same way
`settings.*`, `bridge.ui_settings.*`, `bridge.workspace_tree.*`,
`forward.*`, the connections' registry changes and `bridge.time_report`.
A node registers no notification feed, Claude mod hub or review agents,
records no activity, installs no Claude start hook, renames no tab,
publishes no task notification and runs no workspace auto-sync or
arrangement; its hello is not followed by the forwards. The server and
the browser surface of a home are unchanged; the inventory too.

## 1.39

inventory: 55a67ea9b2a338ffd4cc48bb11d525829ca22a8477c59286f87c0b7ef869996a

The Pi sidecar in installs and updates (S25 cut-over, WP8; family update,
cli/help/update.txt and rollback.txt, assets/sh/update-install.sh): the
installers (scripts/install-roamgate.sh, install-plugin.sh and .ps1) and
the update installer put the package's `roamgate-pi` (`roamgate-pi.exe` on
Windows) beside `roamgate` when the archive has one, with the binary's
checks (regular files, mode 0755, rename into place); an archive without
it is still accepted. The replaced `roamgate-pi` is kept as
`roamgate-pi.previous` beside `roamgate.previous` (none when the replaced
release had none), and `roamgate rollback` swaps that pair with the
executables; a `roamgate-pi` or `roamgate-pi.previous` that is not a
regular file makes it refuse before changing anything. `roamgate update`
on the latest release whose `roamgate-pi` is missing runs the update
installer, which then keeps the executable and `roamgate.previous` and adds
`roamgate-pi` (`Installed roamgate-pi <version> at <path>.`). The
inventory is unchanged.

## 1.38

inventory: 55a67ea9b2a338ffd4cc48bb11d525829ca22a8477c59286f87c0b7ef869996a

The core channel's frame kind 3 (S25 cut-over, WP6; wire/core-channel.md,
Frames): a `ws_send` of 4 KiB or more goes with its `data` apart,
unescaped, to a front whose `welcome` says `raw_data` (the Rust front's);
a Bun front gets kind 0 as before. A core built with
`roamgate-base/test-clock` follows the front's test clock as a debug one
does. Hybrid modes and the browser surface are unchanged; the inventory
too.

## 1.37

inventory: 55a67ea9b2a338ffd4cc48bb11d525829ca22a8477c59286f87c0b7ef869996a

A standalone core builds each connection generation's composition root
(S25 cut-over, WP4; wire/core-channel.md, The standalone core): the
terminal bridge answers `terminal.*` and creation from a browser
terminal, which no longer fail with `standalone_unported`; the task
events reach the feed and the pages (`roamgate.task_notification`) from
Herdr's semantic notifications or the status tracker; tabs are renamed
after their agents; `host.master_ready` sets an SSH host's review client
up over the connection's master. Hybrid modes and the browser surface are
unchanged; the inventory too.

## 1.36

inventory: 55a67ea9b2a338ffd4cc48bb11d525829ca22a8477c59286f87c0b7ef869996a

The Rust binary's default server path (S25 cut-over, WP5):
`roamgate [server flags]` and `roamgate service run <file>` run the Rust
front with its standalone core (`roamgate front` stays a hidden alias),
`--help` prints the top-level help as the Bun server did, and a release
binary serves the web build it carries. On the standalone core
(wire/core-channel.md, The standalone core): the front sets
`ROAMGATE_PROFILE`, `ROAMGATE_PROFILE_DURATION` and `ROAMGATE_PROFILE_DIR`
(the CPU profile is the core's, ended on its clock) and
`ROAMGATE_CONTRACT_RECORD` (the front records requests and sockets, the
core its processes, in Bun's file format), passes `service run`'s
variables on, and sends one `internal.clock.advance` once the core is
started on a test clock. Hybrid modes and the browser surface are
unchanged; the inventory too.

## 1.35

inventory: 55a67ea9b2a338ffd4cc48bb11d525829ca22a8477c59286f87c0b7ef869996a

A standalone core answers the browser RPCs and routes Bun answered with
its own code (S25 cut-over, WP3; wire/core-channel.md, The standalone
core): Herdr's topology and input methods with Bun's overlays,
`workspace.path`, `workspace.create`, `agent.list`,
`connections.agent_sessions`, `connections.agent_tasks`,
`integration.list`, `forge.status`, `forge.session`, `forward.*` (the
port forwards' registry, pushed to every browser), `settings.profiles.*`,
the uploads and the notification feed's socket. `internal.front.start`
carries `tls`, the scheme of the URLs the front was reached on, and
`port`, the port it listens on (never exposed by a remote forward).
Hybrid modes and the browser surface are unchanged; the inventory too.

## 1.34

inventory: 55a67ea9b2a338ffd4cc48bb11d525829ca22a8477c59286f87c0b7ef869996a

A standalone core answers the rest of the reverse targets its families
call with what Bun did for them (S25 cut-over, WP2b; wire/core-channel.md,
The standalone core): the review family's (`review.socket`,
`review.host`, `review.forge`, `review.connection` with the rendered
pages' tokens and storage, `review.published`, `review.addThread`), the
mr_reviews family's (the inbox's glab and gh reads through one forge gate,
the reviews agent's turns on Claude Code), the work family's, the voice
family's, the notification feed's and `mr_cache.load`. Its `front` family
serves `/rendered/<token>/...` and a sandboxed frame's stray requests. Its
`voice.session_cookie` goes on to the Rust front, which answers it with a
new login. Hybrid modes and the browser surface are unchanged; the
inventory too.

## 1.33

inventory: 55a67ea9b2a338ffd4cc48bb11d525829ca22a8477c59286f87c0b7ef869996a

A standalone core answers the reverse targets of the connections,
conversation mode, the Claude mod hub, profiles, Ranger, settings, the
local history, the activity log and the host family's generations with
what Bun did for them (S25 cut-over, WP2a; wire/core-channel.md, The
standalone core), feeds its families what Bun's runtime fed them, runs the
Claude mod hub from its start and tells the review family its agents (this
machine's socket). Its `server.scheduleExit` goes on to the Rust front,
which answers it and exits with code 0 a second later; a connection's
endpoints a family declares reach the core's `front` family first when no
connection is in their context. Hybrid modes and the browser surface are
unchanged; the inventory too.

## 1.32

inventory: 55a67ea9b2a338ffd4cc48bb11d525829ca22a8477c59286f87c0b7ef869996a

The Rust front runs without Bun (S25 cut-over, decision D1;
wire/core-channel.md, The standalone core): without
`ROAMGATE_SIDECAR_BIN` it spawns its own executable as `roamgate core` with
the new `ROAMGATE_CORE_STANDALONE=1` (`0` on a Bun core), welcomes it with
every family Rust's and sends it every route and socket it does not serve
itself. The front's new internal calls `internal.front.start` (the server's
configuration; the connections start) and `internal.front.stop` (at its
shutdown) go to the core's new `front` family, which terminates `/ws` (the
hello, RPC routing to connections and families, replies, pushes,
`bridge.ping`, `bridge.status`, `bridge.pause_others`, Herdr pass-through
with list deltas), answers `/api/health` and the connection-scoped routes,
and refuses what Bun answered with its own code and no family serves yet
(`standalone_unported`). A standalone core answers reverse targets in its
own process (`unknown_target` for one nobody registered) and delivers its
pushes to its own `/ws` sockets. The hybrid modes and the browser surface
are unchanged; the inventory too. `roamgate.bun` next to the front's
executable is no longer looked for.

## 1.31

inventory: 55a67ea9b2a338ffd4cc48bb11d525829ca22a8477c59286f87c0b7ef869996a

The local history is a family the core serves (S25 prerequisite, item
df7df4e2; wire/core-channel.md, The history family): `history` in
owners/families.json (`/api/history`, `/api/history/commit`,
`roamgate history`, the repo's status file and pass lock). While the core
owns it, roamgate-history runs the repo with Bun's files and commits; it
asks the new reverse target `history.release` (Bun's runtime stops, its last
pass written) before it starts, and `history.configure` to change
settings.json's `history` while Bun owns that file; the front sends the
writes of the stores it still owns as `internal.history.changed` and
`internal.history.work_changed`, one at a time, and asks
`internal.history.release` before its own runtime runs again. The browser
surface and the inventory are unchanged.

## 1.30

inventory: 55a67ea9b2a338ffd4cc48bb11d525829ca22a8477c59286f87c0b7ef869996a

Behind the Rust front the Rust core serves the voice socket while it owns
the voice family (Phase 10, S22; wire/core-channel.md, The Rust core's link
to the Rust front): the Rust core links to the front
(`ROAMGATE_FRONT_CHANNEL`, `ROAMGATE_FRONT_TOKEN`, set by the front on its
Bun core and inherited by the Rust core), which sends it the `ws_open` of
`/api/voice/ws` and `/api/voice/call/signalling` first; a core that does not
own voice answers `{accepted: false, pass: true}` and the socket is the Bun
core's as before. The Bun core forwards `POST /api/voice/call/handoff` to
the core while it owns voice behind a Rust front. The browser surface and
the inventory are unchanged.

## 1.29

inventory: 55a67ea9b2a338ffd4cc48bb11d525829ca22a8477c59286f87c0b7ef869996a

`roamgate setup voice` is the voice family's (Phase 10, S22;
wire/core-channel.md, CLI pass-through): passed through to the core while
Rust owns voice, `setup`'s other words staying the Bun CLI's. The browser
surface and the inventory are unchanged.

- owners: a family's `cli` entry may name a command and its first word;
  `voice` gives `cli` `["voice", "setup voice"]`.

## 1.28

inventory: 55a67ea9b2a338ffd4cc48bb11d525829ca22a8477c59286f87c0b7ef869996a

The voice family changes hands with one helper at a time (Phase 10, S22;
wire/core-channel.md, Families in the core): Bun's voice steps aside while
the core owns the family. The browser surface is unchanged; the inventory
too.

- wire, reverse target: `voice.release` (Bun closes its voice sockets and
  stops its helper, low-GPU watch, setup job and companion before the core
  serves voice).
- wire: the front's own call `internal.voice.release` (the core stops its
  own before Bun runs voice again).
- http: `/api/voice/ws` and `/api/voice/call/signalling` answer 503 from
  Bun while the core runs voice.

## 1.27

inventory: 55a67ea9b2a338ffd4cc48bb11d525829ca22a8477c59286f87c0b7ef869996a

Ranger's archive and Workspaces arrangement tools run in the Rust core on
the archive and workspace families' code (Phase 11, S23), so the core no
longer asks Bun for them.

- wire, reverse targets: `assistant.workspace_tree` and `assistant.archive`
  are gone.

## 1.26

inventory: 55a67ea9b2a338ffd4cc48bb11d525829ca22a8477c59286f87c0b7ef869996a

The Rust front's Bun core runs the Rust core (Phase 7, S18;
wire/core-channel.md, Stage 2): with `ROAMGATE_CORE_BIN`, which the front
passes on, the Bun core spawns the Rust core and routes the families the
owners table gives it as behind the Bun front, handovers included.

- env: `ROAMGATE_CLI_EXEC` and `ROAMGATE_CLI_STANDALONE`, set by the Rust
  front for its Bun core: the front's executable, which the update family
  replaces (front).

## 1.25

inventory: 82630773da82f87c93e300a6bc0036fa849854059c54a53850415913eaebb075

The Claude mod hub runs in the Rust core while it owns both the review and
the conversation families (S21; wire/core-channel.md, The Claude mod hub),
Bun's otherwise. The browser surface, the agent socket and the mod's
requests are unchanged; the inventory too.

- wire, reverse targets: `claude_mod.mirror {mods: [{gone, live_until,
  pane}], tools}` (what Bun's synchronous readers read while the core runs
  the hub), `claude_mod.changed {connection_id, pane_id, change}`,
  `claude_mod.released`.
- wire: the front's own calls `internal.review.mod_take`, `.mod_release`,
  `.mod_flush` (at the front's shutdown) and `.mod_deliver {connection_id,
  pane_id, text, kind}` (the message id, null when the mod is gone, or the
  error `claude_mod_refused`).
- storage: claude-mod-inbox.json changes hands through the file between
  Bun's hub and the core's: the side giving the hub up writes it first.

## 1.24

inventory: 82630773da82f87c93e300a6bc0036fa849854059c54a53850415913eaebb075

Agent history cursors are the transcript's (agent_sessions, S21): either
side, or a restarted server, answers a browser's cursor the same, so a
cursor survives a flip and shadow reads compare like with like.

- rpc: `agent_history.get`'s `cursor.revision` is the transcript's size in
  bytes plus one and `cursor.epoch` a hash of the agent, path and file
  identity (with the signature once the file was seen rewritten); a delta
  is answered whenever its base can be read again from the transcript's
  prefix (append-only formats; Antigravity answers a snapshot unless
  nothing changed). The schema now lists the `cursor` parameter and the
  delta's `base_revision`, `upserts`, `removed` and `order`.

## 1.23

inventory: 82630773da82f87c93e300a6bc0036fa849854059c54a53850415913eaebb075

Conversation mode served by the Rust core (Phase 9, S21; wire/core-channel.md,
The conversation family), while the owners table gives the conversation
family to Rust. The browser surface (`agent_chat.*` and its events), the
holder protocol and the agent socket are unchanged; the inventory too.

- wire, reverse targets: `conversation.host` (what the core's services
  need of Bun by `op`: the connection, the SSH argv for its host, prompt
  cards, idle stop and keep awake, the profiles' launches, the mirror of
  the state Bun's synchronous readers read, `released` after a handover of
  the family).
- wire: the front's own calls `internal.conversation.attach`, the
  holder's requests (`.holder_hold`, `.holder_fg`, `.holder_output`,
  `.holder_handback`), Bun's callers of the service (`.prompt`, `.send`,
  `.switch_session`, `.restart_process`, `.restart_terminal`,
  `.auto_start`) and its notices (`.pane_closed`, `.sweep`,
  `.socket_closed`, `.stop`).
- storage: conversation-leases.json and conversation-suspended.json have
  one writer, the family's owner; they change hands through the files (the
  side giving the family up saves the holders' read positions on the
  leases first).

## 1.22

inventory: 82630773da82f87c93e300a6bc0036fa849854059c54a53850415913eaebb075

The review family served by the Rust core (Phase 8, S19; wire/core-channel.md,
The review family), while the owners table gives the review family to
Rust. The browser surface (`review.*`, `claude_mod.*`,
`/api/review/image`, the `review` push) and the agent socket's requests are
unchanged; the inventory too.

- wire: the front's own calls `internal.review.agents` (which hosts run the
  review client, the panes whose mod has its tools, the agent socket keys),
  `internal.review.call` (the front's own use of the service: Work board
  links, MR reviews, conversation mode's roots and prompts, Ranger's
  thread replies) and `internal.review.close` (before the front opens
  reviews.sqlite again).
- wire, reverse targets: `review.release` (Bun closes its service and lets
  go of reviews.sqlite), `review.socketsTaken` (the core listens on the
  agent sockets, renamed over Bun's paths), `review.published` (the core's
  pushes Bun acts on), `review.host`, `review.forge`, `review.connection`
  and `review.socket` (what the service and the agent socket ask of what
  Bun still owns, by `op`).
- agent socket: while the core owns the family it serves Bun's socket
  paths; the Claude mod's requests on it still reach Bun's hub until S21.

## 1.21

inventory: 82630773da82f87c93e300a6bc0036fa849854059c54a53850415913eaebb075

The workspace family served by the Rust core (Phase 6, S17;
wire/core-channel.md, The workspace family), while the owners table gives
it to Rust. The browser surface (`file.*`, `git.*`, `worktree.*`,
`bridge.workspace_tree.*`, the file routes, the `workspace.git_status`,
`workspace.last_step_completed` and `workspace_tree` pushes) is unchanged;
the inventory too.

- owners: the workspace family now also answers the settings that need git
  or worktree hooks (`settings.workspace_auto_sync.*`,
  `settings.worktree_directory.get`, `settings.worktree_hooks.get`,
  `settings.worktree_command.update`, `settings.update_repo`); `/api/history`
  and `/api/history/commit` left it (they stay with the local history
  runtime, the front's). Its writes of settings.json go through the
  settings family's writer, so the core must own settings too.
- wire: the front's own calls `internal.workspace.runtime_start`,
  `.runtime_stop`, `.events` (its runtimes and what their subscriptions
  saw), `.enrich`, `.last_step`, `.invalidate` and `.tree` (`get`, `apply`,
  `place`).
- wire, reverse targets: `workspace.ssh_run` (a command on a connection's
  SSH host, through whoever owns the host family's slots),
  `workspace.kept_steps` (the review service's steps with threads);
  `herdr.call` takes `fresh`; `connections.ready` names each connection's
  `ssh_host`; a browser call's ctx carries `client_ip` (file.reveal's
  loopback check).

## 1.20

inventory: 82630773da82f87c93e300a6bc0036fa849854059c54a53850415913eaebb075

Spawns off the server's event loop (Work item e5872732):

- exec: the shared runners (runProcessWithCode and its timeout), the
  binary runners, the runners fed on stdin and the Claude successor lookup
  spawn their commands from a worker thread (`utils/spawn-thread.ts`), one
  entry `spawn utils/spawn-thread.ts#spawnOnLoop` in place of their four
  (spawned on the loop only when threads are off). Commands, arguments,
  environment, timeouts and outputs are unchanged.
- The MR reviews' efforts store and the Reviews agent's conversation are
  written in the background, the JSONL appends share one appender, and a
  Ranger run's files are removed asynchronously; files and formats are
  unchanged.

## 1.19

inventory: 31a27c547dd692d57fa719181b21e2cd034d673e75b9c8e7341e7b44be734694

The agent sessions and the agent profiles served by the Rust core (Phase 9,
S21; wire/core-channel.md, The agent_sessions family and The agent_profiles
family), while the owners table gives those families to Rust. The browser
surface (`agent_history.*`, `agent_session.*`, `agent_seen.*`,
`agent_profile.*`, the agent session downloads, `agent_history.changed`) is
unchanged; the inventory too.

- wire, reverse targets: `agent_sessions.connection`, `.herdr_call` (Herdr
  as the readers see it, conversation mode's and the Claude mods' panes
  included), `.host_read` (a transcript read on the connection's host,
  stdout in base64), `.herdr_boot`, `.watch_remote` (the remote history
  watch helper), `.seen_written`, `notifications.clear_pane`;
  `profiles.host` (what the profile calls need of a connection, by `op`)
  and `profiles.sessions_changed` (each write of session-profiles.json).
- wire: the front's own calls `internal.agent_sessions.annotate`,
  `.quiet_turn`, `.note`, `.seen_reload`, `.flush`, `.socket_closed`,
  `.refresh`, `.remote_stat`, `.remote_exit`, and
  `internal.agent_profiles.store`.
- storage: agent-seen.json and session-profiles.json have one writer, the
  family's owner; the seen marks are flushed and read again on each change
  of hands, Bun's profile store follows the core's writes in memory.

## 1.18

inventory: 31a27c547dd692d57fa719181b21e2cd034d673e75b9c8e7341e7b44be734694

The voice family's adapter in the Rust core (Phase 10, S22;
wire/core-channel.md, Families in the core), landed Bun-owned: the voice
socket stays the front's until Rust is the front, so the family flips with
Phase 10. The browser surface (`/api/voice` and under it) is unchanged; the
inventory too.

- owners: `owners/families.json` gives `voice` the CLI command `voice`
  (`roamgate voice`), passed through while Rust owns the family.
- wire, reverse targets: `voice.errand_read`, `voice.errand_prompt` and
  `voice.errand_status` (the sessions the companion's errands go to,
  through Bun's own code for them), `voice.work_tool` and
  `voice.work_states` (the Work board the companion uses) and
  `voice.session_cookie` (a login for a call handed to another device).

## 1.17

inventory: 31a27c547dd692d57fa719181b21e2cd034d673e75b9c8e7341e7b44be734694

Stage 2 of the core channel (Phase 7, S18; wire/core-channel.md, Stage 2:
the Rust front): the Rust front holds the port and runs the Bun server as
its portless core. The routes, methods and pushes are unchanged: the
inventory reads the server's request handler, now `handleFetch` (Bun.serve's
`fetch` and the front's forwarded requests both call it).

- env: `ROAMGATE_CORE_CHANNEL` and `ROAMGATE_CORE_TOKEN`, set by the Rust
  front for its Bun core (front).

## 1.16

inventory: d1974dc1f1c8441606395df22b7df0530f55309e459f6b7aaa742d9c09dfc00b

The MR reviews served by the Rust core (Phase 8, S20; wire/core-channel.md,
Reverse targets and Families in the core), while the owners table gives the
mr_reviews family to Rust. The browser surface (`bridge.mr_reviews.*`, the
`mr_reviews` pushes) is unchanged; the inventory too.

- wire: the front's own calls `internal.mr_reviews.board_tool` (the agent
  socket's `reviews` command), `.call` (a `bridge.mr_reviews.*` method the
  front asks, for an effort's leader pane), `.tree_changed`, and, for the
  reviews agent's turns run by Bun, `.agent_tool` and `.agent_event`.
- wire, reverse targets: `mr_reviews.connections`, `mr_reviews.connection`
  (scripts, folders, Herdr, launch and conversation mode on a connection),
  `mr_reviews.fetch` (glab and gh reads through Bun's forge gate),
  `mr_reviews.settings_write` (settings.json's `mr_reviews`, written only
  when unchanged since the core read it), `mr_reviews.review`,
  `mr_reviews.tree`, `mr_reviews.create_worktree`, `mr_reviews.run_model`,
  `mr_reviews.inference_models`, `mr_reviews.agent_command`,
  `mr_reviews.agent_turn` and `mr_reviews.agent_stop`.
- owners: the mr_reviews family takes the `roamgate reviews` command
  (`cli: ["reviews"]`): the core binary runs it while Rust owns the family.

## 1.15

inventory: d1974dc1f1c8441606395df22b7df0530f55309e459f6b7aaa742d9c09dfc00b

Ranger served by the Rust core (Phase 11, S23; wire/core-channel.md, The
assistant family), while the owners table gives the assistant family to
Rust. The browser surface (`bridge.assistant.*`, the `assistant` and
`assistant_notification` pushes) is unchanged; the inventory too.

- wire: the front's own calls `internal.assistant.connections` (the
  connection table after each change), `.resume`, `.deliver_chat_comments`
  and `.release` (before the front takes Ranger back).
- wire, reverse targets: `assistant.release` (Bun disposes its own service
  before the core starts its), `assistant.connections`, `assistant.host`
  (what Ranger's context reads of the runtimes Bun owns, by `op`, with the
  dispatch gates and `gate_revoke`), `assistant.workspace_tree`,
  `assistant.archive` and `assistant.chat_thread_reply`; a message Ranger
  may show crosses as code `assistant_user` or `unsupported_platform`.
- wire, pushes: the core's `{assistant}` (key `assistant`) and
  `{assistant_notification}` go to the browsers through the front's
  per-socket deltas and the notification feed, as Bun's own service's.
- env: run from source, the front gives the core `ROAMGATE_PI_SIDECAR`
  (Bun's `server/src/assistant/pi-sidecar-main.ts`) unless it is set.

## 1.14

inventory: d1974dc1f1c8441606395df22b7df0530f55309e459f6b7aaa742d9c09dfc00b

The Work board served by the Rust core (Phase 4, S15; wire/core-channel.md,
Families in the core), while the owners table gives the work family to
Rust. The browser surface (`bridge.work.*`, the `work` push) is unchanged;
the inventory too.

- wire: the front's own calls `internal.work.tool` (the agent socket's
  `work` command and the Claude Code mod's `work_*` tools),
  `internal.work.user_tool` (the voice companion's Work tools),
  `internal.work.questions_seen` and `internal.work.owner_pane`.
- wire, reverse targets: `work.review` (the review service: `find`,
  `open`, `get`, `session_of_comment`, `add_thread`, `add_image`,
  `edit_comment`, `delete_comment`, `move_thread`, `set_anchor`), `work.notify`
  (the For you notification), `work.git`, `work.read_file`,
  `work.checkout`, `work.panes`, `work.workspaces`, `agents.addresses`,
  `connections.list`, `history.changed` and `history.work_changed` (the
  local history Bun keeps), each run by Bun's own code for the board.
- storage: `data:work` (work.json, history.jsonl) has one writer, the
  family's owner; the voice companion's state line only reads work.json.
- vectors: `vectors/tool-params.json`, how every catalog tool's parameters
  are refused, in typebox's words, for the Rust tool registry
  (`roamgate-claude`) to say the same.

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
- http: while the connections are being handed to the Rust core, an API
  request (but login and logout) waits for them to settle, 10 s at most;
  the inventory reads that `/api/` prefix check as no route of its own.

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
