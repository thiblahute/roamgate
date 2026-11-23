# Tool catalog

`catalog.json` is every tool Roamgate gives a model, by table: its name,
its input's JSON Schema and its description verbatim, and what the table
adds (whether it writes, whether a rerun after a crash is safe, whether it
runs alone).

- The server's tables (the Reviews board, the Reviews agent, the Work
  board, Ranger, the voice companion's Work board and YouTube player) are
  serialised from the server's code by `scripts/contract/tools-catalog.ts`.
- The Claude mod's table, `claude-mod`, is the catalog's own: the mod reads
  it from `server/claude-mod/hooks/catalog.gen.ts`, generated from here.
- `constants` holds the names both sides share (`MOD_VIA`, the mod's name
  in its requests).

`bun run build:assets` rewrites the catalog and the mod's module;
`scripts/contract/tools-catalog.test.ts` fails when either is stale.
