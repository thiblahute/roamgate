import { expect, test } from "bun:test";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { dataRoot } from "../server/src/config/data-paths";

const userHome = userInfo().homedir;
const inside = (path: string, dir: string) => {
  const rest = relative(dir, path);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
};

test("a test run has a home of its own, for itself and the processes it starts", () => {
  expect(homedir()).not.toBe(userHome);
  expect(process.env.HOME).toBe(homedir());
  expect(inside(dataRoot(), userHome)).toBe(false);
});

test("a store whose variable a test restored falls back into that home, not the user's", () => {
  const previous = process.env.ROAMGATE_SETTINGS_PATH;
  // What a file's afterAll leaves to the work its timed-out test left
  // running (a mr-reviews test wrote over settings.json so on 2026-11-23).
  delete process.env.ROAMGATE_SETTINGS_PATH;
  delete process.env.HERDR_GUI_SETTINGS_PATH;
  try {
    const path = join(dataRoot(), "settings.json");
    expect(path).toBe(join(homedir(), ".config", "roamgate", "settings.json"));
    expect(inside(path, userHome)).toBe(false);
  } finally {
    if (previous !== undefined) process.env.ROAMGATE_SETTINGS_PATH = previous;
  }
});

const CHILD = "ROAMGATE_TEST_HOME_CHILD";

test("the Roamgate and Herdr paths of the shell that runs the tests are dropped", async () => {
  if (process.env[CHILD] === "1") return;
  const child = Bun.spawn(
    [process.execPath, "test", import.meta.path, "-t", "inherited"],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        [CHILD]: "1",
        ROAMGATE_SETTINGS_PATH: join(
          userHome,
          ".config/roamgate/settings.json",
        ),
        ROAMGATE_HERDR_SOCKET_PATH: join(userHome, ".config/herdr/herdr.sock"),
        HERDR_PANE_ID: "w1:p1",
        ROAMGATE_LIVE_VOICE: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(`${out}${err}`).toContain(" 1 pass");
  expect(code).toBe(0);
});

test("inherited", () => {
  if (process.env[CHILD] !== "1") return;
  expect(process.env.ROAMGATE_SETTINGS_PATH).toBeUndefined();
  expect(process.env.ROAMGATE_HERDR_SOCKET_PATH).toBeUndefined();
  expect(process.env.HERDR_PANE_ID).toBeUndefined();
  // A switch, not a place: kept.
  expect(process.env.ROAMGATE_LIVE_VOICE).toBe("1");
});
