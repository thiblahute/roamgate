import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The build this Roamgate runs: the deploy script writes the commit it
 * built into `server/public/.built-from` next to the server (D13), read
 * again every minute by the Work service. Without the file (a dev
 * server), the checkout's HEAD stands in when asked.
 */

/** This server's own checkout: the directory above `server/`. */
export function ownCheckout(from = import.meta.dir): string {
  // server/src/work -> server/src -> server -> the checkout.
  return resolve(from, "..", "..", "..");
}

export function builtFromPath(checkout = ownCheckout()): string {
  return join(checkout, "server", "public", ".built-from");
}

const SHA = /^[0-9a-f]{40}$/;

/** The deployed commit, or null when no build says. */
export function readDeployed(path = builtFromPath()): string | null {
  try {
    if (!existsSync(path)) return null;
    const sha = readFileSync(path, "utf8").trim().toLowerCase();
    return SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** The checkout's HEAD, read from .git without running git (a dev server). */
export function readHead(checkout = ownCheckout()): string | null {
  try {
    let gitDir = join(checkout, ".git");
    if (!existsSync(gitDir)) return null;
    // A worktree: .git is a file naming its git dir.
    const stat = readFileSync(gitDir, "utf8").trim();
    if (stat.startsWith("gitdir: ")) gitDir = resolve(checkout, stat.slice(8));
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (SHA.test(head)) return head;
    if (!head.startsWith("ref: ")) return null;
    const ref = head.slice(5);
    const common = existsSync(join(gitDir, "commondir"))
      ? resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim())
      : gitDir;
    const loose = join(common, ref);
    if (existsSync(loose)) {
      const sha = readFileSync(loose, "utf8").trim();
      return SHA.test(sha) ? sha : null;
    }
    const packed = join(common, "packed-refs");
    if (!existsSync(packed)) return null;
    for (const line of readFileSync(packed, "utf8").split("\n")) {
      const [sha, name] = line.split(" ");
      if (name === ref && sha && SHA.test(sha)) return sha;
    }
    return null;
  } catch {
    return null;
  }
}
