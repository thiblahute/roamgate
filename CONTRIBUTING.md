# Contributing

## Development Setup

Use Bun 1.4.4+, Node ^20.19.0 or >=22.12.0 (for Vite 8), a stable Rust
toolchain with `rustfmt` and `clippy`, and a running local Herdr server:

```bash
bun install --frozen-lockfile
bun run install-hooks
bun run build:web
# Run in separate terminals:
bun run dev:server
bun run dev:web
```

Open <http://localhost:5173>. Vite proxies `/api`, `/ws`, and `/login` to the dev
bridge on `127.0.0.1:8788` (services use 8787). `dev:server` runs the server
(`cargo run -p roamgate`) in development mode, so loopback needs no login. To
test authentication, run `cargo run -p roamgate -- --port 8788` without
`NODE_ENV=development`. Never forward a development listener; see
[Security](./SECURITY.md#trust-model).

`bun.lock` is the only lockfile of the TypeScript workspaces and `Cargo.lock`
the Cargo workspace's. Shared tooling belongs in the root manifest and runtime
dependencies in the `web` or `server` workspace (the Pi sidecar's). Commit
manifest and lockfile changes together.

## Validation

On a fresh checkout, run `bun run build:web` once: the server embeds the web
app, and the parity suite serves it. Then iterate with focused checks:

| Check          | Command                                                                              |
| -------------- | ------------------------------------------------------------------------------------ |
| Format         | `bun run format <paths...>` or `bun run format:check`                                |
| Types          | `bun run typecheck:quick` (no asset rebuild)                                         |
| Lint           | `bun run lint` (Oxlint; rules in `.oxlintrc.json`)                                   |
| Tests          | `bun test <path>`, `bun run test` (serial), or `bun run test:quick` (four workers)   |
| Frontend build | `bun run build:web` (required for frontend changes)                                  |
| Rust           | `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` |

The pre-commit hook runs lint and `bun run typecheck:bun` (Bun's native
`bun check` across the root, web, and server projects). Let it run instead of
repeating it manually; without the hook, run both yourself. Never bypass it. Run
formatting and related tests separately.

Every `bun test` run starts in a temporary home (`scripts/test-home.ts`,
preloaded by `bunfig.toml`): `os.homedir()` and `HOME` point there, so a
store a test did not point elsewhere, or work a timed-out test left running
after its file restored the environment, never reaches your own Roamgate
data. Run tests from the repository root, where `bunfig.toml` is.

PR CI runs format, lint, types, the site build, and the full `test:quick` suite,
and the Rust workflow the Rust checks, the parity suite and every release
target's package. Releases run `bun run precommit` and must package and
inspect every platform archive and checksum; see [builds](docs/DEPLOYMENT.md#build-a-standalone-executable)
and the [release policy](AGENTS.md#release-notes).

### Test clock

Scenarios about deadlines (idle stop, cooldowns, cache lifetimes, retries)
start a debug server with `ROAMGATE_TEST_CLOCK=<socket>`: its time and timers
become virtual and move only when the test sends `advance <ms>` on that
socket. A release binary refuses the variable (unless built with the
`roamgate-base/test-clock` feature). The protocol and its
semantics are in [contract/wire/test-clock.md](contract/wire/test-clock.md).

A test server stays in its own world with two more variables:
`ROAMGATE_HOST_SPAWN` names the host-spawn it runs from a toolbox (empty for
none), so it never asks the real host's GameMode, and
`ROAMGATE_SSH_RUNTIME_DIR` replaces `/tmp` for its SSH masters and forwards,
so its orphan sweep never touches another server's. Its voice setup
assistant reads two more, honoured from source only, like the test clock:
`ROAMGATE_TEST_VOICE_HARDWARE` names a JSON file with the hardware
`GET /api/voice/setup` reports instead of the host's, and
`ROAMGATE_TEST_VOICE_MODELS_URL` a base URL the model downloads go to
instead of Hugging Face and GitHub (`https://host/path` becomes
`<base>/host/path`).

### Parity suite

`parity/` drives the server from outside only: `cargo test -p roamgate-parity
--test scenarios` runs every scenario of `parity/scenarios/` against
`ROAMGATE_SERVER_CMD` (by default this checkout's debug `roamgate`, built
once per run), each in a run of its own (HOME, data root, fake Herdr, fakes
of ssh, glab, gh, claude and the rest on its PATH, test clock), and checks
the recorded traffic against `contract/`; `ROAMGATE_CLI_CMD` names the CLI
the `cli` steps run (the server command by default). The scenario format is
in `parity/src/scenario.rs`. A scenario that runs the release binary
(`server.command: standalone`) builds it (`PARITY_STANDALONE` names a
prebuilt one). Ranger's providers but Claude Code run Pi in the
`roamgate-pi` sidecar: the harness compiles it from this checkout once per
run into `<target>/parity-pi/` and names it in `ROAMGATE_PI_SIDECAR`, and as
`${PI_SIDECAR}` in scenarios. A failure lists what the core lacked
(`reverse-missing <target>`, `unported <what>`, from its served log).
`cargo run -p roamgate-parity --bin parity-ledger` refreshes
`parity/ledger.tsv`, which maps every TypeScript test to what covers it on
the Rust side; `PARITY_GATE_STRICT=1 cargo test -p roamgate-parity --test
gate` makes the ledger and the contract coverage gates fail on gaps, and
checks `contract/env.md` against what the crates read. `PARITY_KEEP=1` keeps
a run's directory, `PARITY_JOBS` bounds the servers run at once. A run names
its server and CLI commands on stderr, in each failure and in `run.json` of
each run's directory.

### Rust workspace

The repository root is a Cargo workspace: `crates/roamgate` (the server
binary: `roamgate [server flags]` runs the front with its core and serves the web build it carries, read from `server/public` in a debug
build and embedded in a release one; the management commands), `parity/`,
and `xtask/`. The voice helper (`voice/helper`) is a workspace of its own,
with its own `Cargo.lock` and the `[patch]` sections that point at its git
dependencies; build and check it from its directory. Check the root one with
`cargo fmt --all --check`, `cargo clippy --locked --all-targets -- -D warnings`
and `cargo nextest run --locked` (the Rust workflow runs them).

With a `CARGO_TARGET_DIR` outside the checkout (one shared by several
worktrees, say), the build script of `system-deps-meta` (pulled by the
voice helper's GStreamer crates) cannot find the workspace from its own
directory: set `SYSTEM_DEPS_BUILD_MANIFEST` to `voice/helper/Cargo.toml`.
The parity suite finds its checkout at run time, so its binaries may be
shared, but run them from the checkout they should read and write.

`targets.toml` lists the seven release targets; `scripts/targets.test.ts` keeps
the release workflow and the installers in line with it. `cargo xtask` reads it:

- `cargo xtask package <platform...|all> [--version X.Y.Z]` builds `roamgate`
  for each target with the web app in `server/public` embedded
  (`bun run build:web` first) and compiles the Pi sidecar `roamgate-pi` for
  it with Bun, packages both in the release layout (versioned
  and latest `tar.xz`, `.sha256`, `.update.json`) in `target/dist`, and
  verifies the package, running the binary when this machine can. Linux and
  macOS targets build with cargo-zigbuild off their OS, Windows targets with
  cargo-xwin.
- `cargo xtask update-proof <platform> --from <earlier roamgate>` installs
  an earlier build (the last release's binary) in a sandbox (its own HOME, XDG directories and TMPDIR), lets its
  `roamgate update` install the package from a loopback mirror, and checks
  the new binary, `roamgate.previous`, the package's `roamgate-pi` beside it
  (added by a second `roamgate update` when the earlier updater left it
  out), the served web app, and that `roamgate rollback` swaps both back.
  Package with `--version "$(cargo xtask version --next)"` so there is
  something to update to. `--exec-prefix` runs the sandbox through an emulated container, such as
  linux-arm64 with `xtask/proof/Containerfile`.

### Manual browser checks

Automated tests do not launch browsers. For affected UI, check against a real
backend and record the device/browser and results in the PR:
- Dialog focus and keyboard navigation, scaled layouts, and HTML preview
  isolation (CSP, direct navigation).
- iOS Safari and Android Chrome: keyboard open/close, IME, selecting while output
  streams, and landscape/scaled menus.
- Connection recovery, notifications with the page closed, and server-side
  settings changes.
- Two tabs on the same origin: preferences sync without reload, while workspace,
  files, drafts, and focus stay independent.

A test server gets its own `$HOME`, so it never replaces the real client and
socket in `~/.cache/roamgate`. Such a server does not connect SSH profiles:
on the host it would take the Roamgate socket from the running bridge, whose
conversation-mode holders poll there. Use local connections, or set
`ROAMGATE_ALLOW_SSH=1` against a host no other Roamgate serves.

## Security Checks and Dependency Updates

- **CodeQL** scans JavaScript/TypeScript and GitHub Actions on PRs, pushes to
  `main`, and weekly. Use `pull_request`, never `pull_request_target`, for
  untrusted code.
- **Dependency Audit** (`bun run audit`) checks `bun.lock` on dependency PRs and
  weekly. High/critical findings fail. Fix findings in a PR; do not suppress them.
- **Dependabot** opens weekly grouped minor/patch PRs; majors are separate.
  Nothing auto-merges.

When reviewing updates:
- Review `@xterm/xterm` and `@xterm/addon-fit` together and check terminal
  rendering, sizing, input, and touch scrolling.
- CodeMirror/Lezer, diff2html/highlight.js, and Radix/cmdk are coupled: check the
  lockfile for duplicate copies and run the highlighting and overlay tests. Use a
  targeted `bun update '<pkg>' --filter roamgate-web` if transitive versions need
  refreshing.
- The root `highlight.js` override keeps diff2html aligned with the directly
  imported grammar; update it together with `web/package.json`.
- Treat major build-tool upgrades as migrations: keep the browser target,
  lazy-loading boundaries, and asset size budgets. A failing check means fix the
  update, not disable the check.

## Style Organization

| Path under `web/src/`   | Responsibility                                              |
| ----------------------- | ----------------------------------------------------------- |
| `styles/tokens.css`     | Theme variables (`:root`, `data-theme`, `data-accent`)      |
| `styles/base.css`       | Resets and shared primitives: modals, forms, badges, panels |
| `styles/vendor.css`     | Shared syntax/diff overrides                                |
| `styles/layout/*.css`   | App-shell regions, imported once by `App.tsx`               |
| `components/<Name>.css` | Component styles, imported and deleted with the component   |

Prefix classes with the component name and keep media queries beside their
rules. Lazily loaded features must import the shared styles they need rather
than rely on another feature having loaded them.

## Pages Website and Tutorial

Edit `site/` for the landing page and **only `docs/TUTORIAL.md`** for tutorial
text. `scripts/build-pages.ts` renders the tutorial and checks links in
`.pages-dist/`:

```bash
bun test scripts/pages-content.test.ts scripts/pages-workflow.test.ts
bun run build:site
```

Serve `.pages-dist/` to check `/tutorial/`, narrow layouts, and keyboard
navigation. Never commit generated output. **Deploy Pages** runs on pushes to
`main` and requires a published Latest release. For product images, follow the
[screenshot workflow](docs/SCREENSHOTS.md).

## Pull Requests

Use focused, imperative commits. PR descriptions cover behavior, verification,
and compatibility impact. Screenshots are not required for UI changes unless
requested; never commit them just for review. Keep generated assets and binaries
out of Git.

Unlabeled PRs are labeled automatically (`documentation`, `dependencies`, `bug`,
or `enhancement`); correct the label before merging if needed. Contributions are
MIT-licensed.
