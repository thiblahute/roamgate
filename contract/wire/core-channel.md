# Core channel

While the server moves from Bun to Rust family by family (Rust migration
plan, section 8.2), two processes serve it together: the **front**, which
holds the port, TLS, auth and the browser WebSockets, and the **core**, a
portless process it spawns. In stage 1 the front is the Bun server and the
core is the Rust binary (`roamgate core`); in stage 2 (phase 7) the roles
swap and the same channel carries the Bun code as the core. This file is the
contract between them. The Bun side is `server/src/core-channel/`, the Rust
side the `roamgate-sidecar` crate; both are held to
`contract/vectors/core-channel.json`.

Nothing here runs unless the front is told where the core is: without
`ROAMGATE_CORE_BIN`, the Bun server opens no socket, spawns nothing, watches
no file and behaves exactly as before.

## Variables

| Variable                   | Read by | Meaning                                                                                                                                                                                                                              |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ROAMGATE_CORE_BIN`        | front   | Path of the Rust `roamgate` binary to run as the core (`<bin> core`). Unset or empty: no core, nothing below happens.                                                                                                                |
| `ROAMGATE_CORE_CHANNEL`    | core    | Where to connect: a Unix socket path, or a named pipe (`\\.\pipe\...`) on Windows. Set by the front for its child only.                                                                                                              |
| `ROAMGATE_CORE_TOKEN`      | core    | 64 hex digits the core proves itself with in `hello`. Set by the front for its child only.                                                                                                                                           |
| `ROAMGATE_CORE_SERVED_LOG` | core    | A debug core appends `<family> <what>` to this file for each browser call, HTTP request and CLI command of a family it served: the parity suite's proof that a family it gave to Rust was served by Rust. A release core ignores it. |
| `ROAMGATE_CLI_EXEC`        | core    | The front's executable, which `update` and `rollback` replace: set by the Bun CLI when it passes a command through (see CLI pass-through), and by the Bun server for the core it spawns. Unset: the core's own.                      |
| `ROAMGATE_CLI_VERSION`     | core    | Set with `ROAMGATE_CLI_EXEC`: that executable's version.                                                                                                                                                                             |
| `ROAMGATE_CLI_STANDALONE`  | core    | Set with `ROAMGATE_CLI_EXEC`: `1` when that executable is the standalone binary, `0` when it runs from source.                                                                                                                       |
| `ROAMGATE_CORE_TEST`       | both    | `1` turns on the `test.echo` family and reverse target used by the channel's own cross-language test. Honoured only by a server run from source and a debug build of the core; a release ignores it.                                 |

The core gets the front's environment otherwise (HOME, data root, record
mode), minus the test clock's variables, which the front has already removed
from its own environment: the core runs on the real clock.

## Process

- The front creates `<data>/runtime` (0700), listens, then spawns the core
  with `ROAMGATE_CORE_CHANNEL` and `ROAMGATE_CORE_TOKEN`. The spawner always
  listens and the child always connects, so neither waits on the other's
  readiness: the socket exists before the child starts.
- The socket is `<data>/runtime/core-<front pid>.sock`. When that path is
  longer than 100 bytes (Unix socket paths are limited to 104 to 108), it is
  `core.sock` in a fresh 0700 directory made with `mkdtemp` under the
  temporary directory. On Windows it is the named pipe
  `\\.\pipe\roamgate-core-<front pid>-<16 random hex digits>`. Stale
  `core-<pid>.sock` files of processes that no longer run are removed at
  start; the front removes its own when it stops.
- Startup does not wait for the core: the port opens and `/healthz` answers
  as before, and every family stays with the front until the core says
  `hello`.
- The core's stdout and stderr are the front's (its log lines land in the
  same journal), its stdin is closed.
- A core that does not say `hello` within 10 s, or goes 30 s without
  sending a frame, is killed. A core that exits or is killed is spawned
  again after 1 s, doubling up to 5 minutes, and the delay starts again at
  1 s once a core has stayed up 10 minutes. A `refused` core (wrong token or
  protocol) waits the same way, so a stale binary never spins.
- The core exits when the channel closes (the front stopped or died): it
  never outlives its front.
- The front stops the core with `bye`, closes the channel, and kills it if it
  still runs 3 s later.
- Fail safe: while there is no core (none configured, not started yet,
  crashed, refused, being restarted), every family is served by the front,
  whatever the owners table says. In stage 1 Bun still has every family's
  code, so a crash of the core costs nothing but the time Rust was the
  owner.

## Frames

The voice helper's codec (`contract/vectors/voice-frames.json`): a
little-endian u32 length of what follows, a kind byte, the payload. The
channel accepts frames up to 64 MiB (length field, kind byte included).

| Kind | Payload                                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | One message: a compact JSON object, UTF-8                                                                                                                            |
| 2    | A body chunk: the stream's u32 (little-endian), a flags byte, then the bytes. Flags: bit 0 `END` (last chunk), bit 1 `RESPONSE` (a response's body, not a request's) |

Other kinds are an error that closes the channel. Body chunks carry at most
256 KiB of bytes each.

## Messages

Every message has `t`, its type. Requests (`call`, `reverse_call`, `http`)
carry an `id`: each side numbers its own requests from 1, and a `reply`,
`http_resp`, `cancel` or `ack` names the id of the request it is about, in
the numbering of the side that sent that request. A message of an unknown
`t` is ignored (logged once), so either side can add messages without the
other breaking.

| `t`            | From                | Fields                                                                                                                               | Meaning                                                                                                                                                                                                                                                                                |
| -------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`        | core, first         | `protocol` (1), `token`, `side` (`rust` or `bun`), `version`, `pid`, `families` (the families it implements), `test` (bool)          | The core introduces itself.                                                                                                                                                                                                                                                            |
| `welcome`      | front               | `protocol`, `side`, `owners`, `shadow`, `clock` (optional)                                                                           | The token and protocol are right; `owners` and `shadow` as in `owner`. `clock`: the front runs on the test clock (contract/wire/test-clock.md), whose time this is; see Families in the core.                                                                                          |
| `refused`      | front               | `reason`                                                                                                                             | Wrong token or protocol; the front closes the channel.                                                                                                                                                                                                                                 |
| `owner`        | front               | `owners` (`{family: "rust" \| "bun"}`), `shadow` (`{enabled, rate}`)                                                                 | The owners table changed.                                                                                                                                                                                                                                                              |
| `call`         | front               | `id`, `method`, `params`, `ctx`, `shadow` (bool, optional)                                                                           | A browser RPC the core answers. `shadow: true`: a shadow read, whose answer is only compared.                                                                                                                                                                                          |
| `reply`        | either              | `id`, then `result` or `error` (`{message, code?, data?}`)                                                                           | The answer to a `call` or `reverse_call`, or an `http` that failed before its `http_resp`.                                                                                                                                                                                             |
| `cancel`       | the requester       | `id`                                                                                                                                 | The browser socket or HTTP client is gone: the answer is no longer wanted. The other side may stop; it still sends nothing or a `reply` it already had.                                                                                                                                |
| `push`         | core                | `message`, `key` (optional), `connection_id` and `connection_generation` (optional), `socket_id` (optional), `session_id` (optional) | A push to browsers: `message` is the browser message. With `connection_id` the front sends it in that connection's envelope; `socket_id` limits it to one browser socket, `session_id` to one login's sockets. `key` is its coalescing key, on the channel and on each browser socket. |
| `http`         | front               | `id`, `method`, `url` (path and query), `headers` (`[[name, value]]`, names lowercase), `ctx`, `body` (bool)                         | An HTTP request the core serves; with `body`, chunks of stream `id` follow, the last with `END`.                                                                                                                                                                                       |
| `http_resp`    | core                | `id`, `status`, `headers`, `body` (bool)                                                                                             | Its response head; with `body`, chunks with `RESPONSE` follow, the last with `RESPONSE` and `END`.                                                                                                                                                                                     |
| `ack`          | the body's receiver | `id`, `response` (bool), `bytes`                                                                                                     | That many more bytes of the body were consumed.                                                                                                                                                                                                                                        |
| `reverse_call` | core                | `id`, `target`, `args`, `ctx` (optional)                                                                                             | A call into what the front still owns. Answered by `reply`.                                                                                                                                                                                                                            |
| `ping`, `pong` | front, core         | `n`                                                                                                                                  | Liveness: the front pings after 10 s without sending anything; the core answers at once.                                                                                                                                                                                               |
| `bye`          | either              |                                                                                                                                      | The sender is stopping; the channel closes after it.                                                                                                                                                                                                                                   |

`ctx` is what the front knows of the request: `connection_id`,
`connection_generation`, `socket_id` (the front's number for the browser
socket), `lane`, `session_id` (the first 16 hex digits of the SHA-256 of
the login's session token, never the token itself), and for HTTP
`client_ip`. Fields that do not apply are left out.

A body's sender keeps at most 4 MiB of it unacknowledged; the receiver
acknowledges bytes as its consumer takes them, so a slow browser slows the
core rather than filling the front's memory.

The front never forwards a WebSocket upgrade: in stage 1 it terminates every
browser WebSocket itself and the core reaches browsers through `push`.

### Reverse targets

The front answers these in stage 1; a family that needs more adds one here.
The limit_resume family (Phase 2) added `connections.ready` through
`agent.transcript_tail` and `herdr.call`'s `timeout_ms`: what it needs of
the connections, conversation mode, the Claude mods, agent sessions and
settings.json, which Bun owns until their own phases. The work family
(Phase 4) added `work.review` through `history.work_changed`: the review
service, notifications, git and files on a connection, Herdr's panes and
workspaces, the agent sessions and the local history, each through Bun's
own code for the board.

| Target                      | `args`                                                                                                                                                                                                                                                                                                                                                                                                                             | Result                                                                                                                                                                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `herdr.call`                | `connection_id` (optional: the default connection), `method`, `params`, `timeout_ms` (optional: the runtime's default)                                                                                                                                                                                                                                                                                                             | Herdr's result                                                                                                                                                                                                                                                                                        |
| `host.run`                  | `connection_id` (optional), `argv`, `cwd` (optional), `timeout_ms` (optional, 60000)                                                                                                                                                                                                                                                                                                                                               | `{code, stdout, stderr}`, run on the connection's host (over its SSH for an SSH connection)                                                                                                                                                                                                           |
| `review.addThread`          | the params of the `review.thread.add` RPC                                                                                                                                                                                                                                                                                                                                                                                          | the thread                                                                                                                                                                                                                                                                                            |
| `activity.dayInput`         | `date` (`YYYY-MM-DD`)                                                                                                                                                                                                                                                                                                                                                                                                              | the activity log's day as the time-report provider gets it (DayInput), or an error with code `not_configured` while recording is off or there is no log; time_report's, until the activity family moves (Phase 3)                                                                                     |
| `test.echo`                 | anything                                                                                                                                                                                                                                                                                                                                                                                                                           | `{args, ctx}` (only with the test family on)                                                                                                                                                                                                                                                          |
| `connections.ready`         | none                                                                                                                                                                                                                                                                                                                                                                                                                               | `[{id, generation, remote_platform}]`: the connections whose runtime is ready (`remote_platform` null for a local or POSIX host)                                                                                                                                                                      |
| `settings.limit_resume.get` | none                                                                                                                                                                                                                                                                                                                                                                                                                               | the `limit_resume` settings in effect (`{enabled, message, margin_seconds}`, defaults included)                                                                                                                                                                                                       |
| `conversation.owned_panes`  | `connection_id`                                                                                                                                                                                                                                                                                                                                                                                                                    | `[{pane_id, session_id, phase, agent_status, agent}]`: the panes conversation mode holds                                                                                                                                                                                                              |
| `conversation.prompt`       | `connection_id`, `pane_id`, `text`                                                                                                                                                                                                                                                                                                                                                                                                 | `true` when conversation mode holds the pane and queued the text, else `false`                                                                                                                                                                                                                        |
| `claude_mod.panes`          | `connection_id`                                                                                                                                                                                                                                                                                                                                                                                                                    | the panes whose Claude runs a live Roamgate mod, as the mod hub says them (`pane_id`, `session_id`, `status`, ...)                                                                                                                                                                                    |
| `claude_mod.deliver`        | `connection_id`, `pane_id`, `text`, `kind`                                                                                                                                                                                                                                                                                                                                                                                         | `true` when the pane's live mod took the text, else `false`                                                                                                                                                                                                                                           |
| `agent.transcript_tail`     | `connection_id`, `pane_id`                                                                                                                                                                                                                                                                                                                                                                                                         | the last 64 KiB of the pane session's transcript, or `null`                                                                                                                                                                                                                                           |
| `herdr.setupGuard`          | none                                                                                                                                                                                                                                                                                                                                                                                                                               | the default connection's setup guard (`sshHost`, `session`, `hasExplicitSocketPath`, `hasExplicitClientSocketPath`), or the error setup would answer                                                                                                                                                  |
| `herdr.ping`                | none                                                                                                                                                                                                                                                                                                                                                                                                                               | the default connection's Herdr `ping` result (its ready runtime's, else the configured socket's)                                                                                                                                                                                                      |
| `server.scheduleExit`       | none                                                                                                                                                                                                                                                                                                                                                                                                                               | `{scheduled: true}`; the front exits a second later for its supervisor to start the updated executable                                                                                                                                                                                                |
| `settings.changed`          | `revision`, `settings`, `origin` (`core`), `cause` (`{method, connection_id}` of the core's handler)                                                                                                                                                                                                                                                                                                                               | `{applied}`; sent by the core after each write its own settings handlers make, before their answer: the front keeps the settings when newer than its copy and follows the change as its own handlers would (the claude start hook, the limit resumer, a connection's auto rename and terminal codecs) |
| `mr_cache.load`             | `token`, `op` (`load` or `paused`), `value` (`paused`: the answer known)                                                                                                                                                                                                                                                                                                                                                           | `load`: the reader's forge read, `{value, ttl_ms, failed, paused_until}`, or `{error, paused_until}` when it threw; `paused`: `{paused_until}` for `value` (epoch ms, 0: no pause). An unknown token is an error                                                                                      |
| `mr_cache.release`          | none                                                                                                                                                                                                                                                                                                                                                                                                                               | `{}` once Bun wrote its own MR cache to `mr-cache/state.json` and dropped it (the core is taking the family)                                                                                                                                                                                          |
| `notifications.feed`        | `last`, `events` (the feed's events as notifications.json keeps them), `deliver` (ids of those to send to the sockets now, in order)                                                                                                                                                                                                                                                                                               | `{ok: true}`; the front's copy of the feed is replaced and the `deliver` events go to the notification sockets that want them                                                                                                                                                                         |
| `notifications.clients`     | none                                                                                                                                                                                                                                                                                                                                                                                                                               | `{android_connected, clients}`: the notification sockets open, as `bridge.notifications.status` lists them                                                                                                                                                                                            |
| `notifications.current`     | `token` (from `internal.notifications.publish`'s `current`)                                                                                                                                                                                                                                                                                                                                                                        | `true` while what that notification is about is still current (its connection's runtime), else `false`                                                                                                                                                                                                |
| `activity.dayInput`         | `date` (`YYYY-MM-DD`)                                                                                                                                                                                                                                                                                                                                                                                                              | the activity log's day as the time-report provider gets it (DayInput), or an error with code `not_configured` while recording is off or there is no log; time_report's while Bun owns the activity family (the core builds the day itself while it owns it)                                           |
| `activity.hostScript`       | `connection_id`, `script`                                                                                                                                                                                                                                                                                                                                                                                                          | `{code, stdout}`: the activity log's read-only git script run on the connection's host (over its SSH read path, in the background lane, 20 s), `{code: 0, stdout: ""}` on a host with no POSIX shell; the activity family's                                                                           |
| `work.review`               | `op` and its arguments: `find {item}`, `open {item, connection_id, root, title}`, `get {review}`, `session_of_comment {id}`, `add_thread {session_id, author, text, anchor}`, `move_thread {session_id, thread_id, anchor}`, `set_anchor {session_id, thread_id, anchor}`, `add_image {session_id, type, data (base64)}`, `edit_comment {session_id, comment_id, author, text}`, `delete_comment {session_id, comment_id, author}` | what the review service answers the Work board (a review snapshot or null, a session or null, a thread, an image's path, `{deleted, thread}`); work's, until the review family moves (Phase 8)                                                                                                        |
| `work.notify`               | `op` (`publish` or `clear`), `item`                                                                                                                                                                                                                                                                                                                                                                                                | `{ok: true}`: the For you notification of a work item published or cleared, as Bun's board does it                                                                                                                                                                                                    |
| `work.git`                  | `root`, `args`, `connection_id` (optional: local)                                                                                                                                                                                                                                                                                                                                                                                  | `{code, stdout}` of `git -C root args` on the connection (code null when it did not run: not ready, a Windows host, an error); work's, until the host layer moves (Phase 5)                                                                                                                           |
| `work.read_file`            | `root`, `path` (relative), `connection_id` (optional)                                                                                                                                                                                                                                                                                                                                                                              | the file's text in the checkout's working tree, or null                                                                                                                                                                                                                                               |
| `work.checkout`             | none                                                                                                                                                                                                                                                                                                                                                                                                                               | this Roamgate's own checkout (the deployed rule's, and where `server/public/.built-from` is)                                                                                                                                                                                                          |
| `work.panes`                | `connection_id`                                                                                                                                                                                                                                                                                                                                                                                                                    | Herdr's `pane.list` panes of a ready connection, `[]` otherwise                                                                                                                                                                                                                                       |
| `work.workspaces`           | `connection_id`                                                                                                                                                                                                                                                                                                                                                                                                                    | Herdr's `workspace.list` workspaces of a ready connection, `[]` otherwise                                                                                                                                                                                                                             |
| `agents.addresses`          | none                                                                                                                                                                                                                                                                                                                                                                                                                               | the addresses (`CONNECTION/PANE`) of the agent sessions Roamgate manages, as `agent_sessions` lists them                                                                                                                                                                                              |
| `connections.list`          | none                                                                                                                                                                                                                                                                                                                                                                                                                               | `[{id, generation, is_default}]`: every connection                                                                                                                                                                                                                                                    |
| `history.changed`           | `area`, `id` (optional)                                                                                                                                                                                                                                                                                                                                                                                                            | `{ok: true}`: the local history told a store of the area changed                                                                                                                                                                                                                                      |
| `history.work_changed`      | `item` (null when removed), `id`, `change`, `actor` (`{by, address?, caller?}`), `at`                                                                                                                                                                                                                                                                                                                                              | `{ok: true}`: the local history told of a Work change, committed by its author                                                                                                                                                                                                                        |

An unknown target is an error reply with code `unknown_target`.

### The test family

With `ROAMGATE_CORE_TEST=1` the core says `test.echo` in its `hello`
families and answers, for the channel's cross-language test
(`server/src/core-channel/hybrid.test.ts`):

| Request                             | Answer                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| call `test.echo.read`               | `{params, ctx}`: what it was given                                                                                          |
| call `test.echo.push`               | params `{key, message, count}`: pushes `count` messages, each `message` (fields may be added), all with `key`, then answers |
| call `test.echo.reverse`            | reverse calls `test.echo` with its params, answers that reply (`{args, ctx}`)                                               |
| `POST /api/test-echo/stream`        | 200, the request body echoed back as it comes                                                                               |
| `GET /api/test-echo/stream?bytes=N` | 200, `N` bytes of `x`, streamed                                                                                             |

### Pushes and coalescing

Each side writes its messages through one outbound queue. A push with a
`key` replaces a push with the same key that is still queued (not yet
written): the older one is dropped and the newer one goes to the end of the
queue, so it never overtakes messages queued before it. A push already
written is never replaced. The front also passes the key to each browser
socket's send, which coalesces the same way there.

## Families in the core

The core serves the families its binary implements (`hello.families`); a
browser call goes to the family whose `rpc` entries name its method, an
HTTP request to the one whose `http` entries name its path. A family's
code runs its background work (timers, watchers) and writes its files only
while the core owns it: the core tells each family when it starts owning
it (from `welcome` and each `owner`) and when it stops (an `owner` giving
it back, or the channel closing).

The front's own calls to a family are `call`s of `internal.<family>.<op>`
(no family declares the `internal.` prefix, so a browser never reaches
one): what the front still owns tells a Rust-owned family something
happened (a Herdr event, a setting changed). Each family documents its
internal calls and its reverse targets with its code.

The front's internal calls by family:

| Call                                        | Params                                                                                                                                       | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `internal.limit_resume.poke`                | `connection_id`, `pane_id` (optional)                                                                                                        | Something changed in a pane (a Herdr agent event, a Claude mod's or a conversation's turn ended), or the settings changed (no `pane_id`, once per connection): the resumer looks at the connection shortly. Answers `{ok: true}`.                                                                                                                                                                                                                                                                                |
| `internal.settings.get`                     | none                                                                                                                                         | The settings family: `{revision, settings}`, settings.json as the core holds it and the number of its last write.                                                                                                                                                                                                                                                                                                                                                                                                |
| `internal.settings.update`                  | `base_revision`, `settings`                                                                                                                  | The settings family: writes the front's settings (normalised) unless the file moved on since `base_revision`, an error with code `stale` then; answers `{revision, settings}` as written.                                                                                                                                                                                                                                                                                                                        |
| `internal.mr_cache.get`                     | `key`, `token`, `fresh`, `head` (optional: the checkout's `ref\ncommit` HEAD, null when unknown)                                             | An answer of the MR cache, `{value, fetchedAt, stale}`, as mr-cache/cache.ts's `get`: when it needs a forge read it asks the reader registered under `token` (`mr_cache.load`). A failed read is an error with code `load_failed`; `not_owner` or `not_ready` while the core does not hold the cache.                                                                                                                                                                                                            |
| `internal.mr_cache.flush`                   | none                                                                                                                                         | Writes `mr-cache/state.json` now if the core holds the cache; the front asks it before reading the file again when it takes the family back. Answers `{}`.                                                                                                                                                                                                                                                                                                                                                       |
| `internal.notifications.state`              | none                                                                                                                                         | The feed's events (`{version: 1, last, events}`, as notifications.json keeps them): the front's copy, taken when the core starts owning the family.                                                                                                                                                                                                                                                                                                                                                              |
| `internal.notifications.publish`            | `task` (a task or Ranger notification), `kind`, `actions`, `prompt`, `path` (each optional), `android_connected`, `current` (optional token) | A notification to keep, send to the sockets (through `notifications.feed`) and push to the devices that want it; Web Push skips the quiet devices when `android_connected`, and with a `current` token asks `notifications.current` before each send. Answers `{id}`.                                                                                                                                                                                                                                            |
| `internal.notifications.clear_tag`          | `tag`                                                                                                                                        | Withdraws the notifications with the tag, if one is still out. Answers `{ok: true}`.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `internal.notifications.clear_pane`         | `connection_id`, `pane_id`                                                                                                                   | The user looked at the pane. Answers `{ok: true}`.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `internal.notifications.clear_blocked_pane` | `connection_id`, `pane_id`                                                                                                                   | The pane's agent stopped waiting on the user (a permission prompt's notification stays). Answers `{ok: true}`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `internal.notifications.clear_prompt`       | `prompt_id`                                                                                                                                  | The prompt was answered or went back to the terminal. Answers `{ok: true}`.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `internal.activity.start`                   | none                                                                                                                                         | Bun's recorder stopped (or never ran): the core's recorder may start writing activity.sqlite. The core starts it only while it owns the family; without this call it starts 15 s after it took the family. Answers `{ok: true, recording}`.                                                                                                                                                                                                                                                                      |
| `internal.activity.signals`                 | `signals`: `[{op, ts, ...}]`                                                                                                                 | What only the front sees, in the order it saw it, each with `ts`, when it arrived (epoch ms): `connection_status` (`connection_id`, `state`), `herdr_event` (`connection_id`, `event`, only the pane, workspace and worktree events the recorder reads), `pane_list` (`connection_id`, `result`, `started_at`), `owned_agent` (`connection_id`, `pane_id`), `socket_closed` (`socket_id`). Never terminal content. The front sends one batch at a time. Answers `{ok}`, false when the core records nothing now. |
| `internal.activity.flush`                   | none                                                                                                                                         | Answers `{ok: true}` once the core's recorder applied every signal it received (its Herdr listings included). With a test clock, the front asks it before each `advance` moves the time, so a held signal is recorded at the time it was sent.                                                                                                                                                                                                                                                                   |
| `internal.activity.stop`                    | none                                                                                                                                         | Before the front takes the family back (and at its shutdown): the core's recorder ends its spans and session; answers `{ok: true}` once it did.                                                                                                                                                                                                                                                                                                                                                                  |
| `internal.work.tool`                        | `tool`, `params`, `caller`, `address` (optional), `by` (optional, `user`)                                                                    | An agent's Work board tool (the agent socket's `work` command, the mod's `work_*` tools): answers `{text}`, the tool's answer; an error keeps the board's code (`invalid`, `not_found`, `conflict`, `forbidden`, `unavailable`).                                                                                                                                                                                                                                                                                 |
| `internal.work.user_tool`                   | `tool`, `params`, `source` (optional)                                                                                                        | One of the user's own tools (the voice companion's): answers `{text}`.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `internal.work.questions_seen`              | `item`, `threads`                                                                                                                            | An item's review changed: its open questions are counted on its card. Answers `{ok: true}`.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `internal.work.owner_pane`                  | `item`, `connection_id`                                                                                                                      | Where the item's comments go on that connection: `{pane}` (null: they wait).                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Bun's own copy of a family stops its background work and writes while the
core owns the family and starts again (reading its files afresh) when it
comes back; what Bun still needs of a Rust-owned family comes from its
pushes (limit_resume: the last `roamgate.limit_pauses` per connection, for
Ranger's context), from its reverse calls (notifications: the feed's
events after each change, for the notification sockets Bun terminates until
Phase 7), or its files read, never written (work: the voice companion's
state line counts the items of `<data>/work/work.json`).

### The settings family

While the core owns the settings family it is settings.json's one writer
and the front a client of it. The front reads `internal.settings.get` once
(then keeps it), and makes each of its own changes on the settings of the
revision it holds, sent with `internal.settings.update` against that
revision; refused as `stale`, it reads again and makes the change again (5
attempts). Revisions start at the core's start time in milliseconds and
grow by one per write, so a restarted core never reuses one. The front
keeps what its write is answered; a write of the core's own handlers is
told to it with `settings.changed` before their answer goes out, and kept
when newer than its copy. When the core does not answer a read, the front reads
the file (the writer always replaces it whole). The core makes its store
afresh each time it starts owning the family and while Bun owns it reads
the file and writes nothing. The settings methods that also need Herdr,
git, worktree hooks, secret files or a provider are not the family's (its
`rpc` list names the others): their handlers stay in Bun and write through
the same writer.

The activity family hands its log over without two writers: the old
owner's recorder stops (its spans end, its session stops) before the new
owner's starts, and the new one hears the connections' states as they are
(`connection_status` signals stamped with the handover's time). While the
owners table gives the family to Rust and the core has not connected yet,
the front holds what it would record, with the time each came, until the
core takes the family (they go to it) or 15 s pass (Bun's recorder records
them). A browser's `activity.presence` reaches the core with the page's
`socket_id`; `bridge.activity.timeline` while Bun owns the family is a
shadow read of the log opened read-only.

The core runs on the real clock, but its families follow the front's test
clock: when the front runs on one, `welcome.clock` is its time, and after
each `advance` the front calls `internal.clock.advance {to}` (the test
clock's new time) and waits for its reply, which comes once the families'
timers due by then ran. A release core ignores `welcome.clock` and answers
`internal.clock.advance` with the error code `no_test_clock`.

## CLI pass-through

A family's `cli` entries in families.json are commands of `roamgate`. When
the Bun CLI runs one of them and the owners table gives that family to
`rust`, it runs the core binary instead, with the same arguments
(`<core> <command> <args...>`): `ROAMGATE_CORE_BIN` when set, else the
table's `core` (the path of the binary that last wrote it with `roamgate
owners`). The child gets the CLI's environment plus `ROAMGATE_CLI_EXEC`,
`ROAMGATE_CLI_VERSION` and `ROAMGATE_CLI_STANDALONE`, its standard input,
and its output lines go to the CLI's own output; the CLI exits with the
child's exit code. Without a core binary to run, the Bun CLI runs the
command itself and says so on stderr. The table is read once per command:
a CLI run needs no server.

## Owners table

`<data>/runtime/owners.json`, read by the front at start and whenever it
changes; the server never writes it. `roamgate owners` (a hidden command of
the Rust binary, temporary like the channel) shows it and is its one
writer: `roamgate owners set <family>... rust|bun` flips families,
`roamgate owners shadow on|off|<rate>` sets the shadow reads; it refuses
unknown families and a file it cannot parse, writes the file whole (0600,
by rename), and records its own path as `core` for the CLI pass-through.

```json
{
  "version": 1,
  "owners": { "limit_resume": "rust" },
  "shadow": { "enabled": true, "rate": 0.1 },
  "core": "/home/me/.local/share/roamgate/core/roamgate"
}
```

A family missing from `owners` is Bun's. A missing or invalid file means
every family is Bun's and shadow reads are on at rate 0.1 (an invalid file
is logged once per change). The families, the methods and paths of each, and
the files each writes are declared in `contract/owners/families.json`; a
method or path belongs to the family with its exact name, else to the one
with the longest matching prefix.

The update and herdr_setup families are routed at their own routes rather
than before them: the front keeps its method match and idle budget for
those paths, then hands the request to the core when the core serves the
family; their handlers check the confirmation headers themselves.

The front routes a browser RPC or an HTTP request to the core only when its
family is given to `rust`, the core is connected, and its `hello` named that
family; otherwise the front serves it. The `test` family routes only with
`ROAMGATE_CORE_TEST=1` on both sides.

## One writer per file

Each file of `contract/storage/index.json` is written by at most one family
(`files` in families.json; no file is in two families), and only the side
that owns that family writes it. The side that does not own a family neither
answers its methods (routing) nor runs its background writers: each side's
family code asks the owners table (`bunOwns(family)` in Bun,
`Owners::check_write` in Rust) before writing, and Rust's check refuses a
write of a family it does not own. SQLite databases may be opened read-only
by the non-owner for shadow reads (WAL). The session secret's rotation stays
with the auth owner, and both sides take the same mkdir lock.

## Shadow reads

For a method in its family's `shadow` list, the side that answered (the
owner) also sends the call to the other side, when that side has the family,
after the browser got its answer, and compares the two results. Writes are
never doubled.

- Sampled: each eligible call is shadowed with probability `shadow.rate`, at
  most once per method every 5 s, at most 2 at a time, only when the
  request's params and the owner's result are under 256 KiB of JSON each.
  A shadow call that takes more than 10 s is abandoned.
- Paused while GameMode reports a game (`gamemoded -s`, asked at most every
  30 s; through `host-spawn` in a toolbox), and when `shadow.enabled` is
  false.
- The comparison (`shadowDiff` in the vectors) walks both results: an object
  by the owner's keys in order, then the other's extra keys; an array
  element by element after comparing lengths; it reports `missing`,
  `extra`, `type` (with both JSON types), `length` (with both lengths) and
  `value` (never the values themselves) at a path like `$.items[3].name`
  (`$["a-b"]` for a key that is not an identifier), and keeps the first 20.
- A difference is logged as one `[shadow]` warning line and appended to
  `<data>/runtime/shadow.jsonl` (`{at, method, family, owner, diffs,
  truncated}`), which is rotated to `shadow.jsonl.1` past 5 MiB. A shadow
  call that fails is logged the same way with `error`.
