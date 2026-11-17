import { test } from "bun:test";

/** Run DOM tests in their own process so global browser shims cannot leak between files. */
export function inIsolatedChild(
  path: string,
  name: string,
  flag: string,
  timeoutMs: number,
): boolean {
  if (process.env[flag] === "1") return true;
  test(
    name,
    async () => {
      const child = Bun.spawn([process.execPath, "test", path], {
        env: { ...process.env, [flag]: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    },
    timeoutMs,
  );
  return false;
}
