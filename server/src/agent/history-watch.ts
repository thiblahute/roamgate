import { type FSWatcher, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { sshReadCommandArgv } from "../bridge/ssh-command";
import { holdSshSession } from "../bridge/ssh-sessions";

export type WatchHandle = { close(): void };

/** One helper over every watched path on a host: a line per path per poll. */
export type RemoteStatSpawner = (
  paths: string[],
  onLine: (line: string) => void,
  onExit: () => void,
) => WatchHandle;

export type HistoryChanged = {
  event: "agent_history.changed";
  data: { pane_id: string; path: string };
};

export type HistoryWatcherOptions<Ws> = {
  /** The pane's session file now, null when it has none. */
  resolvePath: (params: Record<string, unknown>) => Promise<string | null>;
  send: (ws: Ws, event: HistoryChanged) => void;
  /** Local: a watch on the file (and its folder, for recreation). */
  watchLocal?: (path: string, onChange: () => void) => WatchHandle;
  /** Remote: set for a connection over SSH. */
  spawnRemote?: RemoteStatSpawner;
  debounceMs?: number;
  /** How often panes are resolved again (a /clear, a resumed session). */
  reresolveMs?: number;
  /** A remote helper restarts this long after the paths changed. */
  restartMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
};

function watchLocalFile(path: string, onChange: () => void): WatchHandle {
  const watchers: FSWatcher[] = [];
  const name = basename(path);
  const add = (target: string, filter?: (file: string | null) => boolean) => {
    try {
      const watcher = watch(target, { persistent: false }, (_event, file) => {
        if (!filter || filter(file === null ? null : String(file))) onChange();
      });
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch {
      // Gone or unreadable: the next resolve finds it again.
    }
  };
  add(path);
  add(dirname(path), (file) => file === name);
  return {
    close() {
      for (const watcher of watchers.splice(0)) watcher.close();
    },
  };
}

/** The stat loop a remote host runs, one line per path each second. */
export const REMOTE_STAT_SCRIPT = [
  "while :; do",
  '  for f in "$@"; do',
  "    s=$(stat -c '%s %Y %i' \"$f\" 2>/dev/null || stat -f '%z %m %i' \"$f\" 2>/dev/null || echo gone)",
  '    printf \'%s\\t%s\\n\' "$f" "$s"',
  "  done",
  "  sleep 1",
  "done",
].join("\n");

export function createRemoteStatSpawner(args: {
  host: string;
  shQuote: (value: string) => string;
  annotate?: (argv: string[]) => string[];
}): RemoteStatSpawner {
  return (paths, onLine, onExit) => {
    let stopped = false;
    let child: ReturnType<typeof Bun.spawn> | null = null;
    const argv = sshReadCommandArgv(
      args.host,
      `sh -c ${args.shQuote(REMOTE_STAT_SCRIPT)} sh ${paths.map(args.shQuote).join(" ")}`,
      [],
      "agent_history.watch",
    );
    args.annotate?.(argv);
    void (async () => {
      const release = await holdSshSession(argv);
      try {
        if (stopped) return;
        const proc = Bun.spawn(argv, {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        });
        child = proc;
        const decoder = new TextDecoder();
        let buffered = "";
        for await (const chunk of proc.stdout) {
          buffered += decoder.decode(chunk, { stream: true });
          let newline = buffered.indexOf("\n");
          while (newline >= 0) {
            onLine(buffered.slice(0, newline));
            buffered = buffered.slice(newline + 1);
            newline = buffered.indexOf("\n");
          }
        }
        await proc.exited;
      } catch {
        // Reported as an exit.
      } finally {
        release();
        if (!stopped) onExit();
      }
    })();
    return {
      close() {
        stopped = true;
        child?.kill();
      },
    };
  };
}

/** The session file an agent_history.get result read, if it says. */
export function historyFilePath(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const record = result as { file?: unknown; path?: unknown };
  const file = record.file as { path?: unknown } | null | undefined;
  if (file && typeof file === "object" && typeof file.path === "string")
    return file.path || null;
  return typeof record.path === "string" && record.path ? record.path : null;
}

/**
 * Pushes `agent_history.changed` to the browsers watching a pane when its
 * session file changes, for every agent kind: they fetch their delta with
 * agent_history.get and their cursor. Local files are watched; a remote
 * connection runs one stat helper for all its watched files, holding a
 * single SSH session slot.
 */
export function createHistoryWatcher<Ws>(options: HistoryWatcherOptions<Ws>) {
  const debounceMs = options.debounceMs ?? 150;
  const reresolveMs = options.reresolveMs ?? 30_000;
  const restartMs = options.restartMs ?? 500;
  const watchLocal = options.watchLocal ?? watchLocalFile;
  const log = options.log ?? (() => {});
  type Pane = {
    params: Record<string, unknown>;
    path: string | null;
    watchers: Set<Ws>;
    handle: WatchHandle | null;
    timer: ReturnType<typeof setTimeout> | null;
  };
  const panes = new Map<string, Pane>();
  let reresolveTimer: ReturnType<typeof setInterval> | null = null;
  let remote: WatchHandle | null = null;
  let remotePaths = "";
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  const signatures = new Map<string, string>();
  let disposed = false;

  function changed(paneId: string) {
    const pane = panes.get(paneId);
    if (!pane?.path || pane.timer) return;
    pane.timer = setTimeout(() => {
      pane.timer = null;
      if (!pane.path) return;
      for (const ws of pane.watchers)
        options.send(ws, {
          event: "agent_history.changed",
          data: { pane_id: paneId, path: pane.path },
        });
    }, debounceMs);
  }

  function watchedPaths(): string[] {
    return [
      ...new Set(
        [...panes.values()].flatMap((pane) => (pane.path ? [pane.path] : [])),
      ),
    ].toSorted();
  }

  function onRemoteLine(line: string) {
    const tab = line.indexOf("\t");
    if (tab < 0) return;
    const path = line.slice(0, tab);
    const signature = line.slice(tab + 1);
    const before = signatures.get(path);
    signatures.set(path, signature);
    if (before === undefined || before === signature) return;
    for (const [paneId, pane] of panes) if (pane.path === path) changed(paneId);
  }

  function restartRemote() {
    if (!options.spawnRemote || disposed) return;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      const paths = watchedPaths();
      const key = paths.join("\n");
      if (key === remotePaths && remote) return;
      remote?.close();
      remote = null;
      remotePaths = key;
      for (const path of [...signatures.keys()])
        if (!paths.includes(path)) signatures.delete(path);
      if (!paths.length) return;
      const handle = options.spawnRemote!(paths, onRemoteLine, () => {
        if (remote !== handle) return;
        remote = null;
        log("history watch helper exited; restarting");
        restartTimer = setTimeout(restartRemote, 5000);
      });
      remote = handle;
    }, restartMs);
  }

  function watchPane(paneId: string, pane: Pane) {
    pane.handle?.close();
    pane.handle = null;
    if (pane.path && !options.spawnRemote)
      pane.handle = watchLocal(pane.path, () => changed(paneId));
    if (options.spawnRemote) restartRemote();
  }

  async function resolve(paneId: string, pane: Pane) {
    let path: string | null;
    try {
      path = await options.resolvePath(pane.params);
    } catch {
      path = null;
    }
    if (panes.get(paneId) !== pane || path === pane.path) return;
    pane.path = path;
    watchPane(paneId, pane);
    // Another file now: what the browser shows may be stale.
    changed(paneId);
  }

  function ensureReresolve() {
    if (reresolveTimer || disposed) return;
    reresolveTimer = setInterval(() => {
      for (const [paneId, pane] of panes) void resolve(paneId, pane);
    }, reresolveMs);
  }

  function drop(paneId: string) {
    const pane = panes.get(paneId);
    if (!pane) return;
    pane.handle?.close();
    if (pane.timer) clearTimeout(pane.timer);
    panes.delete(paneId);
    if (options.spawnRemote) restartRemote();
    if (!panes.size && reresolveTimer) {
      clearInterval(reresolveTimer);
      reresolveTimer = null;
    }
  }

  return {
    async subscribe(ws: Ws, params: Record<string, unknown>) {
      const paneId = String(params.pane_id ?? "");
      if (!paneId) throw new Error("pane_id is required");
      let pane = panes.get(paneId);
      if (!pane) {
        pane = {
          params: { ...params },
          path: null,
          watchers: new Set(),
          handle: null,
          timer: null,
        };
        panes.set(paneId, pane);
        ensureReresolve();
        pane.watchers.add(ws);
        await resolve(paneId, pane);
      } else pane.watchers.add(ws);
      return { pane_id: paneId, path: pane.path };
    },
    unsubscribe(ws: Ws, paneId: string) {
      const pane = panes.get(paneId);
      if (!pane) return;
      pane.watchers.delete(ws);
      if (!pane.watchers.size) drop(paneId);
    },
    cleanupWs(ws: Ws) {
      for (const [paneId, pane] of [...panes]) {
        pane.watchers.delete(ws);
        if (!pane.watchers.size) drop(paneId);
      }
    },
    /**
     * The file a history read just resolved for the pane: when it is not
     * the watched one (the pane moved to another session), watch it now.
     */
    notePath(paneId: string, path: string | null) {
      const pane = panes.get(paneId);
      if (!pane || !path || path === pane.path) return;
      pane.path = path;
      watchPane(paneId, pane);
      changed(paneId);
    },
    /** Resolve a pane again now (its session moved: a handover, /clear). */
    refresh(paneId: string) {
      const pane = panes.get(paneId);
      if (pane) void resolve(paneId, pane);
    },
    dispose() {
      disposed = true;
      for (const paneId of [...panes.keys()]) drop(paneId);
      if (restartTimer) clearTimeout(restartTimer);
      remote?.close();
      remote = null;
    },
  };
}

export type HistoryWatcher<Ws = unknown> = ReturnType<
  typeof createHistoryWatcher<Ws>
>;
