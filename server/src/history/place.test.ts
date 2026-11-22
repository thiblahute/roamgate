import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { expandLocation, historyHost, historyPlace } from "./place";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("history is on at <data>/history unless the settings or the environment say", () => {
  expect(historyPlace(null, "/d", {}, "/home/u")).toEqual({
    enabled: true,
    location: "/d/history",
    defaultLocation: "/d/history",
  });
  expect(historyPlace(null, "/d", { ROAMGATE_HISTORY: "off" }).enabled).toBe(
    false,
  );
  expect(
    historyPlace({ history: { enabled: true } }, "/d", {
      ROAMGATE_HISTORY: "off",
    }).enabled,
  ).toBe(true);
  expect(
    historyPlace(
      { history: { location: "~/keep" } },
      "/d",
      { ROAMGATE_HISTORY_DIR: "/x" },
      "/home/u",
    ),
  ).toEqual({ enabled: true, location: "/home/u/keep", defaultLocation: "/x" });
  expect(() => expandLocation("relative/dir")).toThrow(/absolute/);
});

test("in a toolbox the host's name is the machine's", () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-host-"));
  dirs.push(dir);
  writeFileSync(join(dir, "hostname"), "amd-desktop\n");
  expect(historyHost(true, join(dir, "hostname"))).toBe("amd-desktop");
  expect(historyHost(true, join(dir, "missing"))).toBe(hostname());
  expect(historyHost(false)).toBe(hostname());
});
