# Embedded assets

The files the server embeds and sends or installs as they are: the
`roamgate-review` and `roamgate-hold` clients installed on SSH hosts (this
machine runs the `roamgate` binary under those names,
`crates/roamgate-agent-client`, which does what they do), the SKILL.md
installed on every host, the scripts it runs on hosts over SSH (POSIX shell,
Python, PowerShell), the login page, the script of rendered review pages and
the voice model catalog. SSH hosts run no Roamgate binary, so these bytes are
a contract: both servers embed these same files (the Bun server imports them
as text through `server/src/assets`), and the clients' checksums stay the
same.

`index.json` lists each file with its kind, the tags it fills and the
server modules that use it; `server/src/assets/assets.test.ts` checks it.

## Templates

A file with tags is a template, filled by `fillTemplate`
(`server/src/assets/template.ts`). Nothing but the tags is special:

| Tag | Becomes |
| --- | --- |
| `{{name}}` | the value as given: the caller quotes it for the shell or PowerShell |
| `{{#name}}...{{/name}}` | its content when `name` is true, nothing when false |
| `{{^name}}...{{/name}}` | its content when `name` is false |

Every tag needs a value and every value a tag, or filling throws. The
installed clients and SKILL.md have no tags: they are written to hosts byte
for byte.

## Changing an asset

Edit the file, then run `bun run build:assets`: it rebuilds
`js/rendered-helper.js` from `web/src/renderedHelper.ts` with the web
toolchain (`web/vite.helper.config.ts`), regenerates the tool catalog and
rewrites `index.json`. Biome and Oxlint leave this directory alone.
