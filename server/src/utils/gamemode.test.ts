import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gameModeActive, gameModeCommand, parseGameMode } from "./gamemode";
import { hostSpawnPath } from "./host-spawn";

describe("GameMode", () => {
  test("gamemoded -s's answer", () => {
    expect(parseGameMode("gamemode is active\n")).toBe(true);
    expect(parseGameMode("gamemode is inactive\n")).toBe(false);
    expect(parseGameMode("")).toBeNull();
    expect(parseGameMode("sh: gamemoded: command not found")).toBeNull();
  });

  test("asked on the host from a toolbox", () => {
    expect(gameModeCommand(true, "/usr/bin/host-spawn")).toEqual([
      "/usr/bin/host-spawn",
      "--no-pty",
      "gamemoded",
      "-s",
    ]);
    expect(gameModeCommand(true, null)).toBeNull();
    expect(gameModeCommand(false)).toEqual(["gamemoded", "-s"]);
  });

  test.if(process.platform === "linux")(
    "through the host-spawn that runs, past a broken one on PATH",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "gamemode-"));
      try {
        const broken = join(root, "broken");
        const real = join(root, "real");
        mkdirSync(broken);
        mkdirSync(real);
        writeFileSync(join(broken, "host-spawn"), "");
        chmodSync(join(broken, "host-spawn"), 0o644);
        writeFileSync(
          join(real, "host-spawn"),
          '#!/bin/sh\n[ "$*" = "--no-pty gamemoded -s" ] && echo "gamemode is active"\n',
        );
        chmodSync(join(real, "host-spawn"), 0o755);
        const hostSpawn = hostSpawnPath(`${broken}:${real}`, []);
        expect(hostSpawn).toBe(join(real, "host-spawn"));
        expect(await gameModeActive(gameModeCommand(true, hostSpawn))).toBe(
          true,
        );
        // The broken one alone: no answer, not a thrown EACCES.
        expect(hostSpawnPath(broken, [])).toBeNull();
        expect(await gameModeActive(gameModeCommand(true, null))).toBeNull();
        expect(
          await gameModeActive([join(broken, "host-spawn"), "gamemoded"]),
        ).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
