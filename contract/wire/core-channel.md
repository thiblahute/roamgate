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

| Variable                | Read by | Meaning                                                                                                                                                                                              |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROAMGATE_CORE_BIN`     | front   | Path of the Rust `roamgate` binary to run as the core (`<bin> core`). Unset or empty: no core, nothing below happens.                                                                                |
| `ROAMGATE_CORE_CHANNEL` | core    | Where to connect: a Unix socket path, or a named pipe (`\\.\pipe\...`) on Windows. Set by the front for its child only.                                                                              |
| `ROAMGATE_CORE_TOKEN`   | core    | 64 hex digits the core proves itself with in `hello`. Set by the front for its child only.                                                                                                           |
| `ROAMGATE_CORE_TEST`    | both    | `1` turns on the `test.echo` family and reverse target used by the channel's own cross-language test. Honoured only by a server run from source and a debug build of the core; a release ignores it. |

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
| `welcome`      | front               | `protocol`, `side`, `owners`, `shadow`                                                                                               | The token and protocol are right; `owners` and `shadow` as in `owner`.                                                                                                                                                                                                                 |
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

| Target             | `args`                                                                               | Result                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `herdr.call`       | `connection_id` (optional: the default connection), `method`, `params`               | Herdr's result                                                                              |
| `host.run`         | `connection_id` (optional), `argv`, `cwd` (optional), `timeout_ms` (optional, 60000) | `{code, stdout, stderr}`, run on the connection's host (over its SSH for an SSH connection) |
| `review.addThread` | the params of the `review.thread.add` RPC                                            | the thread                                                                                  |
| `test.echo`        | anything                                                                             | `{args, ctx}` (only with the test family on)                                                |

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

## Owners table

`<data>/runtime/owners.json`, read by the front at start and whenever it
changes; the server never writes it (it is edited by hand on dogfood until a
family's flip brings a command for it):

```json
{
  "version": 1,
  "owners": { "limit_resume": "rust" },
  "shadow": { "enabled": true, "rate": 0.1 }
}
```

A family missing from `owners` is Bun's. A missing or invalid file means
every family is Bun's and shadow reads are on at rate 0.1 (an invalid file
is logged once per change). The families, the methods and paths of each, and
the files each writes are declared in `contract/owners/families.json`; a
method or path belongs to the family with its exact name, else to the one
with the longest matching prefix.

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
