import { userInfo } from "node:os";
import { resolve } from "node:path";

/**
 * Why this Roamgate may not connect to SSH hosts, if so: it runs with a HOME
 * of its own (a test server), so it has none of the real Roamgate's leases.
 * On a host it would bind the same Roamgate socket over the real one, and
 * the conversation holders polling there would be told things only the real
 * Roamgate knows about. ROAMGATE_ALLOW_SSH=1 connects anyway.
 */
export function sshRefusal(
  env: Record<string, string | undefined> = process.env,
  accountHome: string = safeAccountHome(),
): string | null {
  if (env.ROAMGATE_ALLOW_SSH === "1") return null;
  const home = env.HOME;
  if (!home || !accountHome || resolve(home) === resolve(accountHome))
    return null;
  return `This Roamgate runs with its own HOME (${home}), as a test server does, so it does not connect to SSH hosts: it would take the host's Roamgate socket from the real one. Set ROAMGATE_ALLOW_SSH=1 to connect anyway.`;
}

function safeAccountHome(): string {
  try {
    return userInfo().homedir;
  } catch {
    return "";
  }
}
