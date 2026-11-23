import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertSafeDataPath, replaceDataFile } from "./data-paths";

/**
 * Login cookies ended by a logout before they expire: the SHA-256 of each
 * (never the cookie itself) with its expiry in seconds, kept next to the
 * session signing secret so a restart does not bring them back. An entry
 * goes once its cookie has expired anyway.
 */
export type RevokedSessions = {
  has(token: string): boolean;
  /** Ends `token`, valid until `expiresAt` (seconds). */
  add(token: string, expiresAt: number): void;
};

type RevokedState = { version: 1; revoked: Record<string, number> };

/** At most this many cookies are kept; past it the soonest to expire go. */
export const MAX_REVOKED_SESSIONS = 10_000;

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readRevoked(path: string): Map<string, number> {
  const revoked = new Map<string, number>();
  let text: string;
  try {
    assertSafeDataPath(path);
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.error(
        `[auth] could not read the ended logins: ${(error as Error).message}`,
      );
    return revoked;
  }
  try {
    const state = JSON.parse(text) as Partial<RevokedState>;
    if (state?.version !== 1 || !state.revoked)
      throw new Error("not version 1");
    for (const [hash, expiresAt] of Object.entries(state.revoked))
      if (/^[a-f0-9]{64}$/.test(hash) && Number.isInteger(expiresAt))
        revoked.set(hash, expiresAt);
  } catch (error) {
    console.error(
      `[auth] ignoring the unreadable ended logins in ${path}: ${(error as Error).message}`,
    );
  }
  return revoked;
}

/**
 * The cookies ended at `path` (revokedSessionsPath), null for memory only.
 * `now` gives seconds.
 */
export function openRevokedSessions(
  path: string | null,
  now: () => number = () => Math.floor(Date.now() / 1000),
): RevokedSessions {
  const revoked = path ? readRevoked(path) : new Map<string, number>();
  const prune = () => {
    const at = now();
    for (const [hash, expiresAt] of revoked)
      if (expiresAt <= at) revoked.delete(hash);
    if (revoked.size > MAX_REVOKED_SESSIONS) {
      const soonest = [...revoked].sort((a, b) => a[1] - b[1]);
      for (const [hash] of soonest.slice(
        0,
        revoked.size - MAX_REVOKED_SESSIONS,
      ))
        revoked.delete(hash);
    }
  };
  return {
    has: (token) => {
      const expiresAt = revoked.get(digest(token));
      return expiresAt !== undefined && expiresAt > now();
    },
    add: (token, expiresAt) => {
      revoked.set(digest(token), expiresAt);
      prune();
      if (!path) return;
      try {
        replaceDataFile(
          path,
          `${JSON.stringify({
            version: 1,
            revoked: Object.fromEntries(revoked),
          } satisfies RevokedState)}\n`,
        );
      } catch (error) {
        // The logout still holds until a restart.
        console.error(
          `[auth] could not keep an ended login: ${(error as Error).message}`,
        );
      }
    },
  };
}
