import { conversationDriver } from "./drivers";
import type { ApiKeyAnswer } from "./env";
import type { SpawnHeadless } from "./headless";
import type { ConversationHerdr } from "./herdr";
import type { HolderRegistry } from "./holder";
import type { LeaseStore } from "./lease";
import type { HolderChannel } from "./pane-child";

/** No holder answered for a pane conversation mode owns. */
export class HolderMissing extends Error {}

/** What a guarded start needs of its runtime. */
export type GuardedStartDeps = {
  leases: LeaseStore;
  holders: HolderRegistry;
  herdr: ConversationHerdr;
  /** Waits for the pane's holder (Handover.waitForHolder). */
  waitForHolder: (paneId: string) => Promise<boolean>;
  /** The pane holder's channel, if it said it runs one. */
  channel: (paneId: string) => HolderChannel | undefined;
  /** Starts (or reads) the headless process: the holder's, or a test's. */
  spawnHeadless: SpawnHeadless;
  askApiKey: (
    paneId: string,
    signal?: AbortSignal,
  ) => Promise<ApiKeyAnswer | null>;
  setLost: (paneId: string, reason: string) => void;
  clearLost: (paneId: string) => void;
  recoverLater: (paneId: string) => Promise<boolean>;
  emitLease: (paneId: string) => void;
  closed: () => boolean;
  log: (message: string, fields?: Record<string, unknown>) => void;
};

/**
 * Starts the headless process only while conversation mode owns the
 * session, its holder keeps the pane (and holds this session), no claude
 * runs in the pane or anywhere else on the session, and no headless one
 * is still at work on it (left by a Roamgate that died, or by an SSH
 * client that went away while the host's claude went on).
 */
export function guardedSpawn(
  deps: GuardedStartDeps,
  paneId: string,
): SpawnHeadless {
  const { leases, holders, log } = deps;
  return async (spawn) => {
    const lease = leases.get(paneId);
    if (!lease || lease.phase !== "conversation")
      throw new Error("Conversation mode does not own this session");
    // A pane with no holder is a bare shell (the holder died, or the
    // pane id now names another pane): claude could be typed there.
    const held = await deps.waitForHolder(paneId).catch(() => false);
    if (!held) {
      // Gone for good (the host restarted, say), the terminal gets the
      // session back. Checked once the caller is done with this start.
      void deps.recoverLater(paneId);
      throw new HolderMissing(
        "The pane holder is not running; show the terminal to take the session back",
      );
    }
    // What the holder runs already (or ran while nobody read) comes
    // first: it is the session's one writer.
    let attached: Awaited<ReturnType<SpawnHeadless>>;
    try {
      attached = await deps.spawnHeadless({ ...spawn, attachOnly: true });
    } catch (error) {
      // Its holder is there, yet what it runs cannot be read: nothing
      // is delivered until it is recovered.
      if (holders.connected(paneId) && !spawn.signal?.aborted)
        deps.setLost(
          paneId,
          error instanceof Error ? error.message : String(error),
        );
      throw error;
    }
    deps.clearLost(paneId);
    if (attached || spawn.attachOnly) return attached;
    // The pane has an API key Claude Code has no answer for: claude -p
    // would use it without asking, so nothing starts until the user
    // says (what is sent meanwhile waits in the queue).
    const apiKeyAnswer =
      deps.channel(paneId)?.status()?.apiKey === "new"
        ? await deps.askApiKey(paneId, spawn.signal)
        : null;
    const ids = [
      ...new Set([
        lease.session_id,
        spawn.sessionId,
        ...(lease.headless_session_ids ?? []),
      ]),
    ];
    const info = await deps.herdr.processInfo(paneId);
    const running = await deps.herdr.headlessRunning(ids);
    if (
      info.foreground_processes.some(
        conversationDriver(lease.agent).terminal.isAgentProcess,
      )
    ) {
      // The holder resumed claude by itself (Roamgate was away): the
      // terminal has the session now.
      if (!running && leases.get(paneId) === lease) {
        log("claude runs in a held pane; the terminal has the session", {
          pane: paneId,
        });
        leases.delete(paneId);
        queueMicrotask(() => deps.emitLease(paneId));
      }
      throw new Error(
        "Claude runs in the pane's terminal; conversation mode will not start a second one",
      );
    }
    if (running)
      throw new Error(
        "An earlier conversation process still works on this session; try again once it has finished",
      );
    const elsewhere = await deps.herdr.writerElsewhere(paneId, ids);
    if (elsewhere)
      throw new Error(
        `${elsewhere.text}; conversation mode will not start a second writer`,
      );
    const holderSession = holders.session(paneId);
    if (holderSession && !ids.includes(holderSession))
      throw new Error("The pane holder holds another session");
    const current = leases.get(paneId);
    if (!current || current.phase !== "conversation" || deps.closed())
      throw new Error("Conversation mode does not own this session");
    return deps.spawnHeadless(
      apiKeyAnswer ? { ...spawn, apiKeyAnswer } : spawn,
    );
  };
}
