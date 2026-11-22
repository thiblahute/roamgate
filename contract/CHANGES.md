# Contract changes

Each change of the server's observable surface after the freeze is logged
here, newest first, in the same commit as the change: a section per contract
version with the inventory digest the check computes (`inventory: <sha256>`,
also in `contract.json`), what changed, and the family it concerns, so the
Rust owner of that family can take it over.

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
