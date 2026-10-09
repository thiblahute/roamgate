/**
 * Bounds concurrent SSH sessions per destination. OpenSSH's sshd defaults to
 * MaxSessions 10 per connection and MaxStartups 10 unauthenticated logins, so
 * a burst of host commands (the focus prefetch alone spawns about a dozen)
 * would otherwise have sessions refused or logins dropped.
 */
export const SSH_SESSION_LIMIT = 8;

export type SshMasterRegistration = {
  destination: string;
  controlPath: string;
  /** Cheap per-command test: the process runs and its socket exists. */
  isListening: () => boolean;
  /** Confirms the master still serves sessions (process alive, `-O check`). */
  isAlive: () => Promise<boolean>;
};

type SshCommandRoute = {
  destination: string;
  /** Set when the argv multiplexes over this master's control socket. */
  controlPath?: string;
  /** The same command without multiplexing, for the one cold retry. */
  cold: string[];
  /** Only read-only commands may run twice when their master dies. */
  retrySafe: boolean;
};

// Keyed by the owning runtime, not the destination: two profiles that reach
// the same host each own and dispose their own master.
const masters = new Map<object, SshMasterRegistration>();
// Command argv built by sshCommandArgv, recognised by identity so callers that
// pass the array through unchanged need no knowledge of multiplexing.
const routes = new WeakMap<readonly string[], SshCommandRoute>();
const sessionSlots = new Map<
  string,
  { active: number; waiters: Array<() => void> }
>();

export function registerSshMaster(
  owner: object,
  registration: SshMasterRegistration,
): void {
  masters.set(owner, registration);
}

export function unregisterSshMaster(owner: object): void {
  masters.delete(owner);
}

/** A ready roamgate-owned master for the destination, if any. */
export function sshMasterControlPath(destination: string): string | undefined {
  for (const master of masters.values()) {
    if (master.destination === destination && master.isListening()) {
      return master.controlPath;
    }
  }
  return undefined;
}

export function routeSshCommand(
  argv: readonly string[],
  route: SshCommandRoute,
): void {
  routes.set(argv, route);
}

export async function acquireSshSession(
  destination: string,
): Promise<() => void> {
  let slot = sessionSlots.get(destination);
  if (!slot) {
    slot = { active: 0, waiters: [] };
    sessionSlots.set(destination, slot);
  }
  const current = slot;
  if (current.active >= SSH_SESSION_LIMIT) {
    await new Promise<void>((resolve) => current.waiters.push(resolve));
  } else {
    current.active += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Hand the slot straight to the next waiter so a newcomer cannot jump it.
    const next = current.waiters.shift();
    if (next) {
      next();
      return;
    }
    current.active -= 1;
    if (current.active === 0) sessionSlots.delete(destination);
  };
}

/** Holds a session slot for argv built by sshCommandArgv; others pass through. */
export function holdSshSession(argv: readonly string[]): Promise<() => void> {
  const route = routes.get(argv);
  return route ? acquireSshSession(route.destination) : Promise.resolve(noop);
}

function noop() {}

// OpenSSH prints these when it could not use the master and already fell back
// to its own connection; a 255 then belongs to that cold attempt.
const MUX_FALLBACK_STDERR =
  /Control socket connect|mux_client_request_session: session request failed/;

async function masterDied(controlPath: string): Promise<boolean> {
  for (const master of masters.values()) {
    if (master.controlPath !== controlPath) continue;
    return !(await master.isAlive().catch(() => false));
  }
  return true;
}

/**
 * Runs argv from sshCommandArgv inside the destination's session limit. A
 * read-only command (sshReadCommandArgv) is rerun once without multiplexing
 * when the master died under it. A mux client whose master goes away exits 255
 * with nothing on stderr, while the remote side may still be running; a 255
 * while the master is still alive is the remote command's own status. Other
 * commands report that 255 rather than risk running twice.
 */
export async function runSshCommand<T extends { code: number; stderr: string }>(
  argv: string[],
  run: (argv: string[]) => Promise<T>,
): Promise<T> {
  const route = routes.get(argv);
  if (!route) return run(argv);
  const release = await acquireSshSession(route.destination);
  try {
    const result = await run(argv);
    if (
      route.retrySafe &&
      route.controlPath &&
      result.code === 255 &&
      !MUX_FALLBACK_STDERR.test(result.stderr) &&
      (await masterDied(route.controlPath))
    ) {
      return await run(route.cold);
    }
    return result;
  } finally {
    release();
  }
}
