# Contributing

## Development Setup

Use Bun 1.4.4+, Node ^20.19.0 or >=22.12.0 (for Vite 8), and a running local
Herdr server:

```bash
bun install --frozen-lockfile
bun run install-hooks
# Run in separate terminals:
bun run dev:server
bun run dev:web
```

Open <http://localhost:5173>. Vite proxies `/api`, `/ws`, and `/login` to the dev
bridge on `127.0.0.1:8788` (services and `start:server` use 8787). `dev:server`
runs in development mode, so loopback needs no login. To test authentication,
run `NODE_ENV=production bun run start:server`. Never forward a development
listener; see [Security](./SECURITY.md#trust-model).

`bun.lock` is the only lockfile. Shared tooling belongs in the root manifest and
runtime dependencies in the `web` or `server` workspace. Commit manifest and
lockfile changes together.

## Validation

On a fresh checkout, run `bun run typecheck` once to generate the web assets that
process-level tests need. Then iterate with focused checks:

| Check          | Command                                                                            |
| -------------- | ---------------------------------------------------------------------------------- |
| Format         | `bun run format <paths...>` or `bun run format:check`                              |
| Types          | `bun run typecheck:quick` (no asset rebuild)                                       |
| Lint           | `bun run lint` (Oxlint; rules in `.oxlintrc.json`)                                 |
| Tests          | `bun test <path>`, `bun run test` (serial), or `bun run test:quick` (four workers) |
| Frontend build | `bun run build:web` (required for frontend changes)                                |

The pre-commit hook runs lint and `bun run typecheck:bun` (Bun's native
`bun check` across the root, web, and server projects). Let it run instead of
repeating it manually; without the hook, run both yourself. Never bypass it. Run
formatting and related tests separately.

Every `bun test` run starts in a temporary home (`scripts/test-home.ts`,
preloaded by `bunfig.toml`): `os.homedir()` and `HOME` point there, so a
store a test did not point elsewhere, or work a timed-out test left running
after its file restored the environment, never reaches your own Roamgate
data. Run tests from the repository root, where `bunfig.toml` is.

PR CI runs format, lint, types, the site build, and the full `test:quick` suite.
Releases run `bun run precommit` and must package and inspect every platform
archive and checksum; see [builds](docs/DEPLOYMENT.md#build-a-standalone-executable)
and the [release policy](AGENTS.md#release-notes).

### Test clock

Scenarios about deadlines (idle stop, cooldowns, cache lifetimes, retries)
start the server from source with `ROAMGATE_TEST_CLOCK=<socket>`: its time and
timers become virtual and move only when the test sends `advance <ms>` on that
socket. The standalone binary refuses the variable. The protocol and its
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

`parity/` drives a server from outside only, so the same cases hold the Bun
server and the Rust one: `cargo test -p roamgate-parity` runs every scenario
of `parity/scenarios/` against `ROAMGATE_SERVER_CMD` (the Bun server from this
checkout by default), each in a run of its own (HOME, data root, fake Herdr,
fakes of ssh, glab, gh, claude and the rest on its PATH, test clock), and
checks the recorded traffic against `contract/`. The scenario format is in
`parity/src/scenario.rs`. `cargo run -p roamgate-parity --bin parity-ledger`
refreshes `parity/ledger.tsv`, which maps every TS test to what replaces it;
`PARITY_GATE_STRICT=1` makes the ledger and the contract coverage gates fail
on gaps. `PARITY_KEEP=1` keeps a run's directory, `PARITY_JOBS` bounds the
servers run at once.

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

The tests that start a server process (`server/src/connections/*process.test.ts`)
rehearse families on the Rust core with `ROAMGATE_CORE_BIN` naming the core and
`ROAMGATE_TEST_RUST_FAMILIES` the families (comma separated) their test
server's owners table gives it, such as `host`.

### Windows SSH end-to-end test

This opt-in test needs a disposable bridge (allowing unauthenticated loopback
WebSockets, such as a dev server) and two Windows profiles connected to dedicated
Herdr 0.9.1+ sessions named `roamgate-ssh-*`, each with a PowerShell pane. Close
browser viewers first. It sends commands, resizes, and reconnects, so **never
point it at real sessions**:

```bash
ROAMGATE_LIVE_WINDOWS_SSH_URL=http://127.0.0.1:8788 \
ROAMGATE_LIVE_WINDOWS_SSH_SESSION=roamgate-ssh-e2e \
ROAMGATE_LIVE_WINDOWS_SSH_OTHER_SESSION=roamgate-ssh-other \
bun test server/src/connections/windows-ssh-live.test.ts
```

### Live voice test

`bun run test:voice-live` checks that what is said into a voice chat comes
out as said, through the real path: an isolated bridge (its own `$HOME`,
port 0) runs the voice helper and models of your `voice.json`, headless
Chrome's fake microphone plays English and French speech (made with
macOS's `say`, Chrome's echo cancellation, noise suppression and auto gain
on it), and the page's voice link listens on the voice socket and in a
WebRTC call: as is; with sung music under the call that the microphone
hears too; with someone else speaking first; and with one voice going
from English to French (Parakeet drifts to English on some French, and
Whisper reads it again). The runs with music, someone else or two
languages take the speaker's voice from recordings of it
(`speaker_reference`), and the same runs without are printed beside them.
Without recordings, music asked for at the call's start must stay silent
on the replies leg until the speaker has spoken, then play, while the
microphone hears everything the call plays; the voice taken must be the
speaker's first sentence, and no sung word may be heard.
Each run's word error rate is printed and must stay under its bound. The
page also reads replies in the call, which must be heard on its replies
leg (their decoded level is printed); and the test bridge's own helper is
killed in the middle of a call, which must be made again with its
signalling opened once more, both legs back within ten seconds, what is
said next heard as said and a reply heard. `ROAMGATE_LIVE_VOICE_SOAK=1`
adds a call of three minutes, which must keep its one signalling socket
and both legs, each carrying RTP every ten seconds. It needs macOS and
Chrome (or `CHROME_BIN`), takes about twelve minutes (three more with the
soak), and is skipped by `bun run test`. Run it on the Mac before deploying a voice or
helper change. `ROAMGATE_LIVE_VOICE_HELPER` tests another helper binary,
`ROAMGATE_LIVE_VOICE_CONFIG` another `voice.json`,
`ROAMGATE_LIVE_VOICE_MUSIC` plays a WAV of your music under the call and
the speech, `ROAMGATE_LIVE_VOICE_CLIPS` adds a directory of your own
recordings (`<name>.wav` with its words in `<name>.txt`), with
`ROAMGATE_LIVE_VOICE_REFERENCE` (comma-separated files) as their speaker's
voice, and `ROAMGATE_LIVE_VOICE_KEEP=1` keeps each run's `server.log`.

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
