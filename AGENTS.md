# Repository Guidelines

## Project Structure & Module Organization

This repo contains a Rust server (a Cargo workspace) and a React/Vite
frontend for Herdr.
Frontend code lives in `web/src`, with reusable UI under `web/src/components`,
assets under `web/src/assets`, and styling split between `web/src/styles`
(theme tokens, base primitives, vendor overrides, app-shell layout) and
co-located `web/src/components/*.css` files (see the style organization
guidelines in `CONTRIBUTING.md`).
The server lives in `crates/` (the `roamgate` binary is `crates/roamgate`;
`docs/ARCHITECTURE.md` maps the crates), its parity suite in `parity/` and
the build and release tooling in `xtask/`. What stays TypeScript under
`server/`: the Claude Code mod (`server/claude-mod`) and the Pi sidecar
(`server/src/assistant/pi-sidecar-main.ts` and what it imports, compiled
to `roamgate-pi`). Code shared by the web app is in `shared/`; release and
repository helpers live in `scripts/`. Generated build output belongs in
`web/dist`, `server/public`, `server/roamgate*`, `target/` and `dist/`;
these paths are ignored and should not be committed.

## Build, Test, and Development Commands

Install all Bun workspace dependencies from the repository root with
`bun install --frozen-lockfile` (Bun 1.4.4 or newer), and a stable Rust
toolchain with `rustfmt` and `clippy`. The root `bun.lock` is the only
lockfile of the TypeScript workspaces and `Cargo.lock` the Cargo
workspace's; shared TypeScript, Bun types, and lint/format tooling belong in
the root manifest. Keep runtime dependencies in their owning workspace.
- `bun run dev:web`: start the Vite frontend on port 5173.
- `bun run dev:server`: run the server (`cargo run -p roamgate`) on port 8788,
  the one Vite proxies to.
- `bun run build`: build the web app, then the release server
  (`cargo build --release -p roamgate`), which embeds it.
- `bun run build:pi`: compile the Pi sidecar `server/roamgate-pi`.
- `cargo xtask package <platform>`: build, package and verify a release
  target of `targets.toml` (`roamgate`, `roamgate-pi` and `VERSION` in
  versioned and latest `tar.xz` archives with checksums and the update
  manifest, in `target/dist/`); `cargo xtask targets` lists the platforms.
  Build the web app first.
- `bun run build:assets`: rebuild `contract/assets/js/rendered-helper.js`,
  the Claude mod's tool table and `contract/assets/index.json` after changing
  an embedded asset, a tool or the rendered helper (see `contract/assets`).
- `bun run format [paths...]`: format the given paths with the pinned root
  Biome config, or all supported files when no paths are given.
- `bun run format:check [paths...]`: check formatting with the same path scope.
- `bun run lint`: lint JavaScript, TypeScript, and React code with Oxlint.
- `bun run test`: run the TypeScript tests (web, shared, the Pi sidecar, the
  scripts and the contract checks) serially.
- `bun run test:quick`: run the same suite with four workers.
- `bun run typecheck`: run all TypeScript checks.
- `bun run typecheck:bun`: run Bun's native `bun check` against all three
  TypeScript projects (CI).
- `bun run typecheck:quick`: the same checks with `tsc` and no dependency
  rebuild. See [local validation](CONTRIBUTING.md#validation).
- `bun run precommit`: run formatting, lint, full type checks, and `test:quick`.
- `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings` and
  `cargo test` (or `cargo nextest run`): the Rust checks; `cargo test -p
  roamgate-parity --test scenarios` runs the parity suite against this
  checkout's debug `roamgate` (`ROAMGATE_SERVER_CMD` names another server).

## Coding Style & Naming Conventions

Use TypeScript, React function components, and the existing CSS class naming
style. Format supported files with the root `biome.json`; do not rely on a
global or editor fallback formatter. Prefer small, focused components in
`web/src/components`. Keep manual edits ASCII unless the file already uses
non-ASCII text. Use existing store and bridge helpers before adding new
abstractions.

## Documentation Guidelines

Keep `README.md` concise and English-only. Use it as the project entry point and
link to focused documents instead of embedding detailed operation or
implementation material. Put the feature tour and shortcuts in `FEATURES.md`,
deployment and configuration instructions in `docs/DEPLOYMENT.md`, and system
contracts in `docs/ARCHITECTURE.md`. Permanent docs describe current supported
behavior and contracts, not task status, plans, phases, dated verification logs,
or agent transcripts; keep those details in PRs, external artifacts, or Git
history. Add a focused document only when an enduring topic cannot fit an
existing home. Keep one canonical home per topic and link to it. When finishing
work, consolidate or delete stale status documents and repair their links.

## Testing Guidelines

TypeScript tests live beside their modules as `*.test.ts` and use `bun:test`;
Rust tests are each crate's (unit tests in its modules, integration tests in
its `tests/`). The cases of `shared/` logic and of the server's parsers and
builders are JSON vectors in `contract/vectors` (format in its README),
replayed by the crates and by `bun test` for `shared/`: change or add a
vector there, not a test body. The server's observable behaviour is held by
the parity suite's scenarios (`parity/scenarios`, run against the server
from outside); a behaviour change ships its scenario and its contract entry
(`contract/README.md`). During local iteration, run a related file with
`bun test <path>`, a crate's tests with `cargo test -p <crate>`, or one
scenario with `cargo test -p roamgate-parity --test scenarios -- <name>`.
The server and the parity suite need the web build: run `bun run build:web`
once on a fresh checkout. Automated tests do not launch browsers; validate affected UI and browser security
behavior manually against a real backend using the checklist in `CONTRIBUTING.md`.
Use Bun's fake timers for timer deadlines and events for socket readiness rather
than waiting out production timeouts; restore real timers in `finally`.
The local pre-commit hook runs lint and native Bun type checks. Without the hook,
run `bun run lint` and `bun run typecheck:bun` before committing. Run formatting
and related tests separately; CI runs the complete validation suite. Do not also
run the hook's checks manually immediately before committing an unchanged
revision. See the iteration workflow
in [local validation](CONTRIBUTING.md#validation).
For frontend-facing work, also run `bun run build:web`. Release work must package
(`cargo xtask package`) and inspect every supported platform archive and
checksum.

## Commit & Pull Request Guidelines

Git history uses concise imperative messages, for example `Use built-in CLI
argument parser` or `Add command palette and release 0.0.3`. Keep commits
focused and mention user-visible behavior in the message when relevant. PR
descriptions should include a short summary and verification commands.
Screenshots are not required for UI changes; capture or upload them only when
explicitly requested. Do not commit screenshot files solely for PR review.

## Release Notes

GitHub Releases is the canonical release history. Notes are generated by GitHub
from merged pull requests using `--generate-notes` and the categories in
`.github/release.yml`; keep PR titles and labels accurate instead of maintaining
a shared release-log file. Preserve migration, security, breaking-change,
data-loss, and platform-compatibility guidance in permanent documentation linked
from the release notes. Leave detailed records in PRs, external artifacts, or
Git history.

Stable releases use separate prepare and publish phases:
1. Run the **Prepare Release** workflow with `X.Y.Z` or
   `patch`/`minor`/`major`. It updates the three `package.json` versions plus
   `herdr-plugin.toml` and opens a normal release PR.
   Review that PR and select **Approve workflows to run** to start CI for the
   bot-created PR. Wait for its checks to pass before merging; the workflow
   never merges or tags on its own.
2. Run the **Publish Release** workflow with the merged `X.Y.Z` version. It
   finds and verifies the matching release commit on `main`, creates the
   annotated `vX.Y.Z` tag there, and starts `.github/workflows/release.yml` on
   that tag, which publishes the GitHub release with generated notes.

For local preparation, `bun run release:prepare <X.Y.Z | patch | minor | major>`
updates the release files without committing, tagging, or pushing. Submit those
changes through a normal PR because direct pushes to `main` are not allowed.
