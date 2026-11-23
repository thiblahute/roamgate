import {
  ClaudeModError,
  type ClaudeModHub,
  type ClaudeModPane,
} from "./claude-mod";

/**
 * The Claude mod hub as the server's code reads it, whichever side runs it.
 * Bun runs its own (claude-mod.ts) unless the Rust core owns both the review
 * and the conversation families; then the core runs it, and this answers
 * the synchronous readers (live, pane, panes, hasTools, a delivery's
 * refusal) from the mirror the core sends after each change
 * (`claude_mod.mirror`), and hands deliveries to the core.
 * contract/wire/core-channel.md, The Claude mod hub.
 */
export type ClaudeModMirror = {
  mods: {
    gone: boolean;
    /** Live until then (epoch ms); null while a poll is in flight. */
    live_until: number | null;
    pane: ClaudeModPane;
  }[];
  tools: ReturnType<ClaudeModHub["toolsState"]>;
};

export type ClaudeModFront = ClaudeModHub & {
  /** Whether the core runs the hub now. */
  onCore(): boolean;
  /**
   * The core takes the hub: Bun's writes its inbox and stops (the caller
   * then asks the core to read it).
   */
  toCore(): void;
  /** The core gave the hub back (its inbox written): Bun's reads it again. */
  toBun(): void;
  /** What the core's hub says now. */
  mirror(mirror: ClaudeModMirror): void;
};

const MAX_PER_PANE = 50;

export function createClaudeModFront(args: {
  /** A new hub of Bun's, reading the inbox's file. */
  make: () => ClaudeModHub;
  /** A delivery for the core's hub (its answer comes later). */
  deliverOnCore: (
    connectionId: string,
    paneId: string,
    text: string,
    kind: string,
  ) => void;
  now?: () => number;
}): ClaudeModFront {
  const now = args.now ?? Date.now;
  let bun: ClaudeModHub | null = args.make();
  let mirrored: ClaudeModMirror = { mods: [], tools: [] };
  /** Ids the front gives deliveries it handed to the core. */
  let handed = 0;

  const key = (connectionId: string, paneId: string) =>
    `${connectionId}\n${paneId}`;
  function mod(connectionId: string, paneId: string) {
    const at = key(connectionId, paneId);
    return mirrored.mods.find(
      (each) => key(each.pane.connection_id, each.pane.pane_id) === at,
    );
  }
  function live(each: ClaudeModMirror["mods"][number] | undefined): boolean {
    return (
      !!each &&
      !each.gone &&
      (each.live_until === null || now() < each.live_until)
    );
  }
  function tools(connectionId: string, paneId: string) {
    return mirrored.tools.find(
      (each) =>
        each.connection_id === connectionId &&
        each.pane_id === paneId &&
        now() < each.fresh_until,
    );
  }
  function notHere(): never {
    throw new ClaudeModError("the Claude mod hub runs in the Rust core", 503);
  }

  return {
    onCore: () => !bun,
    toCore() {
      if (!bun) return;
      bun.dispose();
      bun.flush();
      bun = null;
      mirrored = { mods: [], tools: [] };
    },
    toBun() {
      if (bun) return;
      bun = args.make();
      mirrored = { mods: [], tools: [] };
    },
    mirror(next) {
      mirrored = next;
    },
    poll: async (input) => (bun ? bun.poll(input) : notHere()),
    ack: (input) => (bun ? bun.ack(input) : notHere()),
    event: (input) => (bun ? bun.event(input) : notHere()),
    tools: (input) => (bun ? bun.tools(input) : notHere()),
    hasWorkTools: (connectionId, paneId) =>
      bun
        ? bun.hasWorkTools(connectionId, paneId)
        : !!tools(connectionId, paneId)?.work,
    hasRules: (connectionId, paneId) =>
      bun
        ? bun.hasRules(connectionId, paneId)
        : !!tools(connectionId, paneId)?.rules,
    toolsState: () =>
      bun
        ? bun.toolsState()
        : mirrored.tools.filter((each) => now() < each.fresh_until),
    hasTools: (connectionId, paneId) =>
      bun ? bun.hasTools(connectionId, paneId) : !!tools(connectionId, paneId),
    deliver(connectionId, paneId, text, kind = "") {
      if (bun) return bun.deliver(connectionId, paneId, text, kind);
      const each = mod(connectionId, paneId);
      if (!live(each)) return null;
      if (!text.trim()) return null;
      if (each!.pane.waiting >= MAX_PER_PANE)
        throw new ClaudeModError(
          `${MAX_PER_PANE} messages already wait for that session`,
          429,
        );
      // Counted until the core's next mirror says it.
      each!.pane = { ...each!.pane, waiting: each!.pane.waiting + 1 };
      args.deliverOnCore(connectionId, paneId, text, kind);
      handed -= 1;
      return { id: handed };
    },
    live: (connectionId, paneId) =>
      bun ? bun.live(connectionId, paneId) : live(mod(connectionId, paneId)),
    pane(connectionId, paneId) {
      if (bun) return bun.pane(connectionId, paneId);
      const each = mod(connectionId, paneId);
      return live(each) ? each!.pane : null;
    },
    panes(connectionId) {
      if (bun) return bun.panes(connectionId);
      return mirrored.mods
        .filter(
          (each) => each.pane.connection_id === connectionId && live(each),
        )
        .map((each) => each.pane);
    },
    waiting: (connectionId, paneId) =>
      bun
        ? bun.waiting(connectionId, paneId)
        : (mod(connectionId, paneId)?.pane.waiting ?? 0),
    sweep: async () => {
      await bun?.sweep();
    },
    flush() {
      bun?.flush();
    },
    dispose() {
      bun?.dispose();
    },
    clearFile() {
      bun?.clearFile();
    },
  };
}
