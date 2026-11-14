import { readdir, readlink } from "node:fs/promises";

/**
 * Which of these files a process on this machine holds open: a background
 * command writes its output through a file its shell holds, so one held is
 * one still running. Null where /proc does not say (other platforms, or a
 * process table that cannot be read): the caller then goes by the file alone.
 */
export async function heldOpenFiles(
  paths: readonly string[],
): Promise<Set<string> | null> {
  if (process.platform !== "linux" || !paths.length) return null;
  let pids: string[];
  try {
    pids = await readdir("/proc");
  } catch {
    return null;
  }
  const wanted = new Set(paths);
  const held = new Set<string>();
  await Promise.all(
    pids
      .filter((pid) => /^\d+$/.test(pid))
      .map(async (pid) => {
        let fds: string[];
        try {
          fds = await readdir(`/proc/${pid}/fd`);
        } catch {
          return;
        }
        await Promise.all(
          fds.map(async (fd) => {
            try {
              const target = await readlink(`/proc/${pid}/fd/${fd}`);
              if (wanted.has(target)) held.add(target);
            } catch {
              // Closed meanwhile, or not ours to read.
            }
          }),
        );
      }),
  );
  return held;
}
