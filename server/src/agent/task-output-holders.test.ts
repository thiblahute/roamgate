import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heldOpenFiles } from "./task-output-holders";

const linux = process.platform === "linux";

test.skipIf(!linux)(
  "a process writing a background command's output holds it until it exits",
  async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "task-holders-")));
    const output = join(dir, "b1.output");
    // The shape a background command has: a child whose stdout is the file.
    const fd = openSync(output, "w");
    const child = spawn("sleep", ["30"], { stdio: ["ignore", fd, "ignore"] });
    // The parent lets go of its copy: only the child holds the file now.
    closeSync(fd);
    try {
      const held = await heldOpenFiles([output, join(dir, "other.output")]);
      expect(held?.has(output)).toBe(true);
      expect(held?.has(join(dir, "other.output"))).toBe(false);
    } finally {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
    const after = await heldOpenFiles([output]);
    expect(after?.has(output)).toBe(false);
  },
);

test("no paths asked about means nothing to look for", async () => {
  expect(await heldOpenFiles([])).toBeNull();
});
