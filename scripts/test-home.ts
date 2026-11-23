// Preloaded by every `bun test` run (bunfig.toml): the run gets a home of its
// own, so nothing a test does reaches the user's Roamgate data.
//
// A test points a store elsewhere with an environment variable
// (ROAMGATE_SETTINGS_PATH...) and restores it when its file ends. Work a
// test left running past its timeout carries on after that, and without
// the variable every data path falls back to the home: on 2026-11-23 a
// timed-out mr-reviews test wrote its fixture settings over the user's
// settings.json that way. Here, the fallback is a temporary home.
//
// Bun reads the home once, when the process starts, so changing HOME here
// does not move os.homedir(): node:os is replaced with one answering the
// temporary home, and HOME (USERPROFILE, APPDATA, LOCALAPPDATA on Windows)
// is set for the processes the tests start with process.env (Bun.spawn
// without an env gives a child the environment the run started with). The
// Roamgate and Herdr paths, sockets and pane the run inherits are dropped
// from process.env.
import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

// What the shell that runs the tests points at (an agent's pane names its
// Herdr socket and pane): a test that wants one sets it itself.
for (const name of Object.keys(process.env)) {
  if (
    /^(ROAMGATE|HERDR_GUI|HERDR)_/.test(name) &&
    /(_PATH|_DIR|SOCKET|_PANE_ID|_TAB_ID|_WORKSPACE_ID)$/.test(name)
  )
    delete process.env[name];
}

const home = mkdtempSync(join(os.tmpdir(), "roamgate-test-home-"));
process.env.HOME = home;
if (process.platform === "win32") {
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  mkdirSync(process.env.APPDATA, { recursive: true });
  mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
}
// Git run without a home of its own still commits.
writeFileSync(
  join(home, ".gitconfig"),
  "[user]\n\tname = Roamgate Test\n\temail = test@example.org\n",
);

const real = { ...os };
const isolated = { ...real, homedir: () => home };
mock.module("node:os", () => ({ ...isolated, default: isolated }));

process.on("exit", () => {
  rmSync(home, { recursive: true, force: true });
});
