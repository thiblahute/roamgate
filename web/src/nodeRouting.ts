/**
 * What a page served by a Roamgate node (the Mac) takes from the node's own
 * socket for the node's connection, and what keeps going to the home (the
 * desktop). The one place the split is decided: the routed bridge
 * (routedBridge.ts) asks these functions and nothing else.
 *
 * Only the latency-critical families of the node's connection are served by
 * the node: its terminals, its Herdr topology and actions, its files, the
 * git reads Changes and Files make, and its agent session reads. Everything
 * else on that connection (git writes, worktrees, conversations, reviews,
 * profiles, forwards, settings) and everything shared stays on the home,
 * which remains the single writer of shared state.
 */

/** A node's advertisement, in its socket's hello (`hello.node`). */
export interface NodeAdvertisement {
  /** The home's origin, `https://host`, without a path. */
  home: string;
  /** The id the node's own connection has on the home and on the node. */
  connection_id: string;
  version: string;
}

/** Method prefixes the node answers for its own connection. */
const NODE_METHOD_PREFIXES = [
  // Terminals: attach, input, resize, scroll, links, popups.
  "terminal.",
  // Herdr topology and actions.
  "workspace.",
  "tab.",
  "pane.",
  // Files.
  "file.",
  // Agent session reads, and the history subscription whose pushes follow.
  "agent_history.",
];

/** Single methods the node answers for its own connection. */
const NODE_METHODS = new Set([
  "popup.close",
  "plugin.action.invoke",
  "agent.list",
  "agent.get",
  "agent_session.get",
  "agent_task.get",
  "agent_tasks.get",
  "agent_commands.get",
  "agent_artifacts.get",
  // Git reads used by Changes and Files (not reviews).
  "git.commit_file",
  "git.commit_preview",
  "git.commits",
  "git.diff_file",
  "git.diff_files",
  "git.diff_summary",
  "git.refs",
  "worktree.list",
]);

/**
 * Methods under a node prefix that stay on the home: they run the home's
 * worktree steps and settings rather than reading or driving Herdr.
 */
const HOME_METHODS_UNDER_NODE_PREFIX = new Set<string>();

/** Whether the node answers `method` for its own connection. */
export function nodeServesMethod(method: string): boolean {
  if (HOME_METHODS_UNDER_NODE_PREFIX.has(method)) return false;
  if (NODE_METHODS.has(method)) return true;
  return NODE_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
}

/**
 * Event prefixes of the node's connection that come from the home even while
 * the node's socket is up: what the home alone does for that connection
 * (conversations, notifications and limit pauses, settings, the worktree
 * steps of `worktree.open`).
 */
const HOME_EVENT_PREFIXES = [
  "agent_chat.",
  "roamgate.",
  "settings.",
  "worktree.",
  "workspace.last_step_completed",
];

/** Whether the node's socket delivers the event `name` of its connection. */
export function nodeServesEvent(name: string): boolean {
  return !HOME_EVENT_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Global methods a node answers while the home is unreachable: enough to
 * list its own connection and keep its socket alive. The rest (Work,
 * reviews, settings, every write) is the home's and is not attempted.
 */
const NODE_GLOBAL_METHODS = new Set([
  "connections.list",
  "bridge.ping",
  "bridge.status",
]);

export function nodeServesGlobalMethod(method: string): boolean {
  return NODE_GLOBAL_METHODS.has(method);
}

/** A node's advertisement, when the hello carries a valid one. */
export function parseNodeAdvertisement(
  hello: unknown,
  pageOrigin: string,
): NodeAdvertisement | null {
  if (!hello || typeof hello !== "object") return null;
  const node = (hello as { node?: unknown }).node;
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const { home, connection_id, version } = node as Record<string, unknown>;
  if (
    typeof home !== "string" ||
    typeof connection_id !== "string" ||
    connection_id.length === 0 ||
    typeof version !== "string"
  )
    return null;
  let url: URL;
  try {
    url = new URL(home);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.origin !== home ||
    url.origin === pageOrigin
  )
    return null;
  return { home: url.origin, connection_id, version };
}

/** The home's socket URL. */
export function homeSocketUrl(home: string): string {
  const url = new URL("/ws", home);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/**
 * HTTP routes a node page fetches from its own origin: its connection's
 * scoped routes and the page's own shell. Every other `/api/` route is the
 * home's.
 */
export function nodeServesHttpPath(
  path: string,
  connectionId: string,
): boolean {
  const scoped = `/api/connections/${encodeURIComponent(connectionId)}/`;
  return (
    path.startsWith(scoped) ||
    path === "/api/logout" ||
    path === "/api/node" ||
    path.startsWith("/api/health")
  );
}
