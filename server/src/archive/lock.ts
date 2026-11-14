import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** A lock older than this is taken over even if its process looks alive. */
const STALE_MS = 12 * 60 * 60 * 1000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One lock per host in the archive directory, so a pull and a push from the
 * same host never run together. Returns a release function, or null when
 * another sync holds it.
 */
export function acquireHostLock(
  archiveDir: string,
  host: string,
): (() => void) | null {
  const dir = join(archiveDir, "locks");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${host.replace(/[^\w.-]/g, "_")}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder: number;
      let age: number;
      try {
        holder = Number(readFileSync(path, "utf8"));
        age = Date.now() - statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (holder && alive(holder) && age < STALE_MS) return null;
      rmSync(path, { force: true });
    }
  }
  return null;
}
