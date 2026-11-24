# Pi sidecar

Pi (`@earendil-works/pi-ai`, `pi-coding-agent`, `pi-durable`, `chord`) has
no Rust equivalent, so the server runs Ranger's non-Claude providers in a
sidecar: a Bun program serving Pi's drivers over its stdin and stdout. It
is started on the first Pi call and never for Claude Code. The sidecar is
`server/src/assistant/pi-sidecar-main.ts`, compiled to the standalone
`roamgate-pi` (`bun run build:pi`, and `cargo xtask package` for a
release); the server's client is the `roamgate-pi` crate. Both are held to
`contract/vectors/pi-sidecar.json`.

## Variable

| Variable              | Read by | Meaning                                                                                                                                                                                                                                                                                       |
| --------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROAMGATE_PI_SIDECAR` | server  | The sidecar to run: a `.ts`, `.js`, `.mjs` or `.cjs` file runs with Bun (the server's own Bun when it runs from source, else `bun` on PATH), anything else is the executable. Unset or empty: the server runs `roamgate-pi` beside its own executable. The sidecar does not get the variable. |

The sidecar gets the server's environment otherwise: HOME, the data root
and `PI_CODING_AGENT_DIR` decide where Pi's files are, as in the server.

## Process

- One sidecar per server, shared by every Ranger directory (the chat's and
  each task run's). Started by the first call that needs Pi, after which the
  server sends `initialize` and waits for its reply before anything else.
- It exits when its stdin closes. The server closes it after five minutes
  with no request in flight either way, and kills it 3 s later if it is
  still there. The next call starts it again.
- If it exits, every request in flight fails with `The Pi sidecar exited
  (<code or signal>)`, and runs in flight fail as a crashed turn does: the
  service's recovery resumes them from their durable pointer.
- Stdout carries the wire only: the sidecar sends `console.log`, `info` and
  `debug` to stderr, which goes to the server's log. A stdout line that is
  not a message is logged (its first 200 characters) and skipped; a line
  longer than 64 MiB is dropped.

## Messages

JSON-RPC 2.0, one compact JSON object per line (`\n`). Both sides send
requests, each numbering its own; a request's `params` is an object. The
sidecar answers every request; a failure is an error with code `-32000`,
the thrown message, and `data.user: true` when the assistant shows that
message to the user and the model as it is (`AssistantUserError`, an
unsupported platform): the receiving side rethrows it as that class. An
unknown method is `-32601`. `$/cancel` (`{"id": n}`, a notification either
way) aborts the signal of the other side's request `n`.

### Server to sidecar

Every request but `initialize` names its driver with `directory` (the
Ranger directory) and `credential_directory` (where `auth.json` and
`models.json` are, the chat's directory for a task run; default
`directory`). The sidecar keeps one Pi driver per pair until `dispose`.

| Method              | Params                                                                                              | Result                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `initialize`        | `protocol`: 1                                                                                       | `{protocol: 1, pid}`; another protocol is refused                  |
| `catalog`           | `source` (`assistant` or `pi`)                                                                      | `{providers, models}`                                              |
| `configure_model`   | `input`: the model connection (`AssistantModelConnection`)                                          | null                                                               |
| `read_tool_details` | `entries`, `messages`, `source_directory`?                                                          | the messages with their tool details                               |
| `login`             | `provider`, `method` (`api_key` or `oauth`), `credential_source`                                    | null; cancelled with `$/cancel`                                    |
| `run`               | `input`: `config`, `entries`, `text`, `request_id`?, `recover`?, `steers`?; `callbacks`; `handlers` | the entries to keep; cancelled with `$/cancel` (Pi stops the turn) |
| `steer`             | `text`, `request_id`                                                                                | null, or the error when no turn takes it                           |
| `stop`              | none                                                                                                | null, once the driver's turn ended                                 |
| `dispose`           | none                                                                                                | null; the driver is forgotten                                      |

`callbacks` lists the optional callbacks the server has (`checkpoint`,
`replace`, `thinking`, `sources`, `steered`) and `handlers` its tool
handlers besides `read` (`propose`, `task`, `notify`, `show`, `arrange`,
`threads`, `archive`): the sidecar gives Pi only those, since their presence
changes the tools Pi offers and what it reports.

### Sidecar to server

Each carries `request`, the id of the server's request it belongs to.

| Message                | Kind         | Params                                  | Server does                                                                                                                                                           |
| ---------------------- | ------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.event`            | notification | `type`, `args`                          | calls the run's callback `type` (`delta`, `message`, `tool`, `error`, `replace`, `thinking`, `sources`, `steered`) with `args`; `steered`'s absent request id is null |
| `run.checkpoint`       | request      | `entries`                               | saves them, then answers null: Pi admits the turn only after                                                                                                          |
| `run.tool`             | request      | `handler`, `args`                       | calls that tool handler with `args` and the request's signal; answers its `{text, sources?}`                                                                          |
| `configure_model.save` | request      | `path`, `value`                         | writes `models.json`, then answers null: Pi reads it back only after                                                                                                  |
| `login.prompt`         | request      | `prompt`: `type`, `message`, `options`? | asks the user; answers the text                                                                                                                                       |
| `login.event`          | notification | `event`                                 | shows it (`info`, `progress`, `auth_url`, `device_code`)                                                                                                              |

Notifications and requests of one run reach the server in the order the
sidecar sent them, before that run's result.

## Files

The sidecar runs Pi on the files Pi keeps:
`auth.json` (written by Pi's logins), the durable stores
`durable/<id>/execution.sqlite` with their `<id>.lock` (one live owner,
whichever process), and `models.json` (read by Pi, written by the server
through `configure_model.save`). A chat started by Pi in one process
continues in the next sidecar the server starts.
