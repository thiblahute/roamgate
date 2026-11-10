import { describe, expect, test } from "bun:test";
import { claudeMemoryDriver } from "./claude-memory";

describe("claudeMemoryDriver", () => {
  test("the reader leaves safe mode and has no tools", () => {
    const launch = claudeMemoryDriver.reader("/x/memories")!;
    expect(launch.tools).toBe("");
    expect(launch.args).not.toContain("--safe-mode");
    expect(launch.args).toContain("--settings");
    const settings = JSON.parse(
      launch.args[launch.args.indexOf("--settings") + 1]!,
    );
    expect(settings.autoMemoryDirectory).toBe("/x/memories");
    expect(settings.disableAllHooks).toBe(true);
  });

  test("the writer's file tools are limited to the directory", () => {
    const launch = claudeMemoryDriver.writer("/x/memories");
    expect(launch.cwd).toBe("/x/memories");
    expect(launch.tools).toBe("Read,Write,Edit,Glob");
    expect(launch.args).toContain("dontAsk");
    const settings = JSON.parse(
      launch.args[launch.args.indexOf("--settings") + 1]!,
    );
    expect(settings.permissions.allow).toEqual([
      "Read(/x/memories/**)",
      "Write(/x/memories/**)",
      "Edit(/x/memories/**)",
      "Glob",
    ]);
  });
});
