# Server contract

Everything the Roamgate server exposes, written down so that a second
implementation (the Rust server) can be held to the same behaviour, and
frozen so that the Bun server cannot change it unnoticed. `contract.json`
carries the contract's version, the digest of the inventory and the pinned
protocol versions and limits; `CHANGES.md` logs every change.

| Surface              | Where                                                        | What an entry holds                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser RPC on `/ws` | `rpc/<family>/<method>.json`                                 | `params`, `reply` and optional `error` JSON Schemas, scope (`bridge` or `connection`), handler, whether Herdr sees it; `rpc/herdr/passthrough.json` is every other method, forwarded to Herdr |
| Pushes on `/ws`      | `push/<name>.json`                                           | the message's JSON Schema itself (an event by its name, a keyed push by its key), with `x-inventory`, `x-sent-by` and `x-coalescing`                                                          |
| HTTP routes          | `http/openapi.yaml`                                          | OpenAPI 3.1 path items; a last `{static}` or `{path}` segment stands for the rest of the path, empty or with slashes                                                                          |
| Other WebSockets     | `ws/asyncapi.yaml`                                           | AsyncAPI 3 messages of the notification feed, the voice socket and call signalling, each with its `x-inventory` name                                                                          |
| Agent socket         | `agent-socket/openapi.yaml`                                  | `POST /v1/<command>` operations                                                                                                                                                               |
| CLI                  | `cli/commands.json`, `cli/help/`                             | commands, actions, flags, server flags; the help each prints, byte for byte                                                                                                                   |
| Environment          | `env.md`                                                     | every variable read, its meaning and readers                                                                                                                                                  |
| Storage              | `storage/index.json`, `storage/sqlite/`, `schemas/`          | files under the data root, named files, SQLite tables and the SQL each database runs                                                                                                          |
| Processes            | `exec.md`                                                    | every place a process starts and the programs named there                                                                                                                                     |
| Wire protocols       | `wire/`                                                      | protocols with no other home (the test clock, the internal channel to the Rust core)                                                                                                          |
| Owners               | `owners/families.json`                                       | the families that move to Rust one at a time: their methods, paths, files and shadowed reads                                                                                                  |
| Types                | `schemas/shared/*.schema.json`, `schemas/server.schema.json` | JSON Schema 2020-12 of `shared/*.ts` and of the server-local types listed in `schemas/server-types.ts`, generated, then reconciled through `schemas/reconcile.json`                           |

An entry whose `status` (or `x-status`) is `inventoried` is known by name
only; record mode (`bun run contract:record check`, which reads this
directory through `record-check.ts`) and the parity suite tighten it into a
`typed` one.

## The check

`scripts/contract/check.test.ts` runs with the rest of `bun test`. It reads
the server's surface from its code (`scripts/contract/inventory.ts`: the
dispatch of handleRpc and the tables it delegates to, the fetch route chain
and the connection ENDPOINTS, the agent socket's command switch, the CLI
command table, every `roamgateEnv` and environment read, every data path
helper, the SQL, the spawn sites) and fails when:

- a name of the code has no entry here, or an entry names something the code
  no longer has;
- the inventory's digest differs from `contract.json`, or `CHANGES.md` has no
  section for the current version with that digest;
- a pinned constant changed;
- the CLI help, the SQL of a database, or a schema generated from the types
  differs from the files here;
- a `$ref` leads nowhere.

The inventory fails by itself when the code takes a shape it cannot read (a
new RPC family delegated to another module, a route prefix handed to a new
handler): extend `scripts/contract/inventory.ts` in the same change.

## Changing the surface

A change that adds, removes or renames anything observable ships its contract
update in the same commit:

1. `bun scripts/contract/scaffold.ts` adds an entry for each new name (it
   never touches existing ones); fill it in, and delete the entries of names
   that are gone.
2. `bun scripts/contract/scaffold.ts --regenerate` rewrites the generated
   parts (CLI help, SQL, schemas); review the diff.
3. Bump `version` in `contract.json`, set `inventory_sha256` to the digest the
   scaffold prints, and add a section to the top of `CHANGES.md`:
   `## <version>`, a blank line, `inventory: <digest>`, then what changed and
   for which family.
