import { join } from "node:path";
import type { CoreProcess, SpawnCore } from "../supervisor";

export const FAKE_CORE = join(import.meta.dir, "fake-core.ts");

/** Spawns the fake core instead of `<bin> core`, with `extra` variables. */
export function spawnFake(
  extra: Record<string, string> = {},
  spawned: string[][] = [],
): SpawnCore {
  return (argv, env): CoreProcess => {
    spawned.push(argv);
    const child = Bun.spawn([process.execPath, FAKE_CORE, ...argv.slice(1)], {
      env: { ...env, ...extra },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    return {
      pid: child.pid,
      exited: child.exited.then((code) => code ?? null),
      kill: (signal) => child.kill(signal),
    };
  };
}
