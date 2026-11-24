# Server contract

Everything the Roamgate server exposes, written down: the server (the Rust
crates under `crates/`) is held to it by its own tests and by the parity
suite (`parity/`), which drives it from outside and checks every recorded
exchange against these files. `contract.json` carries the contract's
version, the digest of its names and the pinned protocol versions and
limits; `CHANGES.md` logs every change.

| Surface              | Where                                                        | What an entry holds                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser RPC on `/ws` | `rpc/<family>/<method>.json`                                 | `params`, `reply` and optional `error` JSON Schemas, scope (`bridge` or `connection`), handler, whether Herdr sees it; `rpc/herdr/passthrough.json` is every other method, forwarded to Herdr                               |
| Pushes on `/ws`      | `push/<name>.json`                                           | the message's JSON Schema itself (an event by its name, a keyed push by its key), with `x-inventory`, `x-sent-by` and `x-coalescing`                                                                                        |
| HTTP routes          | `http/openapi.yaml`                                          | OpenAPI 3.1 path items; a last `{static}` or `{path}` segment stands for the rest of the path, empty or with slashes                                                                                                        |
| Other WebSockets     | `ws/asyncapi.yaml`                                           | AsyncAPI 3 messages of the notification feed, the voice socket and call signalling, each with its `x-inventory` name                                                                                                        |
| Agent socket         | `agent-socket/openapi.yaml`                                  | `POST /v1/<command>` operations                                                                                                                                                                                             |
| CLI                  | `cli/commands.json`, `cli/help/`                             | commands, actions, flags, server flags; the help each prints, byte for byte                                                                                                                                                 |
| Environment          | `env.md`                                                     | every variable read, its meaning and readers                                                                                                                                                                                |
| Storage              | `storage/index.json`, `storage/sqlite/`, `schemas/`          | files under the data root, named files, SQLite tables and the SQL each database runs                                                                                                                                        |
| Processes            | `exec.md`                                                    | every place a process starts and the programs named there                                                                                                                                                                   |
| Wire protocols       | `wire/`                                                      | protocols with no other home: the test clock, the Pi sidecar, the internal channel between the front and the core, and the families it routes to (`wire/families.json`: their methods, paths and the files each writes)     |
| Performance          | `perf/baseline.json`                                         | the Bun server's measurements of the migration plan's section 5.9, per machine, and the gate each metric sets for the Rust server                                                                                           |
| Types                | `schemas/shared/*.schema.json`, `schemas/server.schema.json` | JSON Schema 2020-12 of `shared/*.ts`, generated, then reconciled through `schemas/reconcile.json`; and of the server's own types, written by hand and held to the Rust types by roamgate-protocol's `contract_schemas` test |

An entry whose `status` (or `x-status`) is `inventoried` is known by name
only; record mode (`bun run contract:record check`, which reads this
directory through `record-check.ts`) and the parity suite tighten it into a
`typed` one.

## The checks

`scripts/contract/check.test.ts` runs with the rest of `bun test` and fails
when:

- an entry is malformed (a file that names something else than its path
  says, a missing golden or schema it refers to);
- the digest of the contract's names (every RPC method, push, HTTP
  operation, socket message, agent socket command, CLI command, variable,
  storage entry and process) differs from `contract.json`, or `CHANGES.md`
  has no section for the current version with that digest;
- a schema generated from `shared/`'s types differs from the file here;
- a `$ref` leads nowhere, or an OpenAPI document has keys OpenAPI does not.

The Rust side holds the server to the rest: the CLI help goldens
(roamgate-cli's tests), the SQL each database runs (the crates open them
from `storage/sqlite`), the wire and storage types (roamgate-protocol's
`contract_schemas`), the vectors (each crate replays its files), and the
parity suite's gate (`parity/tests/gate.rs`): every entry covered by a
scenario, `env.md` against the variables the crates read, every recorded
exchange of a scenario run checked against the entries.

## Changing the surface

A change that adds, removes or renames anything observable ships its contract
update in the same commit:

1. Add, change or delete the entries of the names concerned (and a
   scenario that covers a new one).
2. `bun scripts/contract/schemas.ts --write` rewrites the generated
   schemas when a type of `shared/` changed; review the diff.
3. Bump `version` in `contract.json`, set `inventory_sha256` to the digest
   `bun test scripts/contract` prints as expected, and add a section to the
   top of `CHANGES.md`: `## <version>`, a blank line, `inventory: <digest>`,
   then what changed and for which family.

## Performance baselines

`scripts/bench/run.ts` measures a server in a world of its own (scratch
HOME, two Herdr servers, fixture repositories at the `v0.8.15` tag, copies
of the user's review and work stores, fake ssh, glab, gh and headless
Claude that count what they are asked): start time, RSS idle and with 3
connections and 20 warm terminals, RPC latency per family, terminal
throughput, echo latency and bytes on the wire, git status over ssh, inbox
forge calls (on the test clock), archive ingest and search, conversation
streaming, and voice latency: the final transcript to the first audio of
the reply, and the helper ping round trip, both against the parity suite's
fake voice helper (`parity-fake`, built by the run unless
`BENCH_PARITY_FAKE` names it), which logs when it reads and writes each
frame. It waits while GameMode reports a game and deletes the world after.

```sh
# This checkout's release server, then its gates against the baseline:
cargo build --release -p roamgate
bun scripts/bench/run.ts --out run.json
bun scripts/bench/run.ts compare contract/perf/baseline.json run.json --machine desktop
# Another server in the same world:
BENCH_SERVER_CMD="path/to/roamgate" bun scripts/bench/run.ts --out other.json
# Some metrics again (--only), replacing only those of the machine's baseline:
bun scripts/bench/run.ts --only voice --baseline contract/perf/baseline.json --machine desktop
```

The stored baseline is the Bun server's, measured before the cut-over; a
run records its server command, and `compare` prints it for both sides.

Compare only runs of the same machine, under the same conditions (each
metric records the load average around it and whether a game ran).
