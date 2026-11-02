import { createUiSettingsRpcHandler } from "./bridge/settings-rpc";
import { runInSshLane, type SshLane } from "./bridge/ssh-sessions";
import { loadOrCreateSessionSecret } from "./config/session-secret";
import { removeLeftoverDataTemporaries } from "./config/data-paths";
import {
  createAgentSeenStore,
  createHerdrBootCache,
  markAgentSeen,
} from "./agent/agent-seen";
import { historyFilePath } from "./agent/history-watch";
import {
  overlaySuspendedPanes,
  withOwnedSessions,
} from "./agent/agent-sessions";
import {
  authTokenPrintCommand,
  isShortAuthPassword,
  RECOMMENDED_PASSWORD_LENGTH,
} from "./config/auth-token";
import type { ServerWebSocket } from "bun";
import { createAssistantContext } from "./assistant/context";
import {
  RANGER_THREAD_AUTHOR,
  RANGER_THREAD_TOOL,
  rangerChatKey,
  rangerChatSession,
} from "../../shared/rangerChat";
import { isHtmlPath } from "../../shared/filePreview";
import { DOWNLOAD_TIMEOUT_MS } from "./workspace/file-constants";
import { canRevealFiles } from "./workspace/file-manager";
import { createWebPushService } from "./notifications/web-push";
import { rmSync } from "node:fs";
import packageJson from "../../package.json";
import { diffState } from "../../shared/stateDelta";
import { createListDeltas, LIST_DELTA_SHAPES } from "./bridge/list-delta";
import type { SshTunnelConfig } from "./bridge/ssh-tunnel";
import {
  flushCoalescedMessages,
  receiveWebSocketAck,
  sendWebSocketMessage,
  WebSocketCleanupTracker,
  WS_BACKPRESSURE_HARD_LIMIT_BYTES,
  WS_PER_MESSAGE_DEFLATE,
  webSocketFlowStats,
} from "./bridge/websocket-send";
import {
  browserUrlFor,
  getLanIPs,
  isAnyHost,
  loadServerConfig,
  openBrowser,
  withLoginToken,
} from "./config/server-config";
import { cliCommands, runCli, topLevelHelp } from "./cli";
import { CONTINUE_TO_SERVER, defaultCliContext } from "./cli/command";
import { enrichIntegrationVersions } from "./herdr/integration-versions";
import {
  createHerdrSetupHandlers,
  herdrSetupGuardForProfile,
} from "./http/herdr-setup";
import { HerdrClient } from "./bridge/herdr-client";
import {
  connectionRoutingErrorResponse,
  type ParsedConnectionHttpRoute,
  parseConnectionHttpRoute,
  publishConnectionHttpResponse,
  rawRequestPathname,
  resolveConnectionHttpRoute,
} from "./connections/http-routing";
import {
  ConnectionManager,
  type ConnectionRuntimeContext,
  sanitizeConnectionError,
} from "./connections/manager";
import { watchNetworkChanges } from "./connections/network-watch";
import {
  ConnectionProbeError,
  ConnectionProfileService,
  connectionIdentityForProfile,
  loadConnectionProfileBootstrap,
  type SyntheticLocalProfile,
  testConnectionSockets,
} from "./connections/profile-service";
import { sshRefusal } from "./connections/ssh-guard";
import {
  type ConnectionProfile,
  ConnectionProfileStore,
  connectionRecoveryFingerprint,
} from "./connections/profiles";
import { createSshProfileRuntimeConfig } from "./connections/ssh-profile-runtime";
import { sweepOrphanedSshMasters } from "./bridge/ssh-master";
import {
  CONNECTION_CHANGED_DURING_REQUEST,
  ConnectionRoutingError,
  createConnectionReplyPublisher,
  createLegacyRoutingLogger,
  isBridgeGlobalMethod,
  serializeConnectionEnvelope,
  resolveReadyConnection,
  serializeHerdrEventEnvelope,
  validateConnectionGeneration,
  validateConnectionId,
} from "./connections/protocol";
import {
  type ConnectionRpcRequest,
  isConnectionRpcEnvelope,
  resolveRpcRoute,
} from "./connections/rpc-routing";
import {
  createLegacyConnectionRuntime,
  type LegacyConnectionRuntime,
} from "./connections/runtime";
import { createShutdownController } from "./connections/shutdown";
import { readConnectionAgentSessions } from "./connections/agent-sessions";
import { readConnectionAgentTasks } from "./connections/agent-tasks";
import {
  createWorkspaceTreeToolHandler,
  readWorkspaceTreeConnections,
} from "./assistant/workspace-tree-tools";
import {
  agentGroupPaths,
  agentGroupPlacementOps,
  applyWorkspaceTreeOps,
  createWorkspaceTreePruner,
  listWorkspaceIdentities,
  onWorkspaceTreeChanged,
  placeCreatedWorkspace,
  readWorkspaceTree,
} from "./config/workspace-tree";
import {
  parseWorkspaceTreeOp,
  WorkspaceTreeError,
  type WorkspaceTreeOp,
  workspaceRefFor,
} from "../../shared/workspaceTree";
import { bindListenerBeforeConnectionStart } from "./connections/startup";
import { LEGACY_DEFAULT_CONNECTION_ID } from "./connections/types";
import { unixOnlyMessage } from "./connections/unix-only";
import {
  createSshForwards,
  forwardToWire,
  roamgateOwnPorts,
} from "./bridge/ssh-forward";
import { createAuthHandlers, unauthenticatedLoginRedirect } from "./http/auth";
import { serveStatic } from "./http/static-files";
import { handleInstanceSettings } from "./http/instance-settings";
import {
  readGuiSettings,
  worktreeRemoveCommandFor,
} from "./config/gui-settings";
import {
  TERMINAL_UPLOAD_TIMEOUT_MS,
  terminalUploadRequestBodyLimit,
} from "./http/terminal-upload";
import { createVoiceRoutes } from "./http/voice";
import { createVoiceSocket } from "./http/voice-socket";
import { configuredCleaner } from "./voice/voice-cleaner";
import { configuredRouter } from "./voice/voice-router";
import { type ErrandEntry, VoiceErrands } from "./voice/voice-errands";
import { readVoiceConfig, VoiceHelper } from "./voice/voice-helper";
import { VoiceLibrary } from "./voice/voice-library";
import {
  createUpdateHandlers,
  UPDATE_HTTP_IDLE_TIMEOUT_SECONDS,
} from "./http/update";
import {
  configureServerLogger,
  createRecoveryReporter,
  type RecoveryReporter,
  serverLogger,
} from "./utils/logger";
import { runProcessWithCodeTimeout, shQuote } from "./utils/process-utils";
import { rpcLogLevel } from "./utils/rpc-logging";
import { handleReviewRpc, isReviewMethod } from "./review/rpc";
import {
  AGENT_CHAT_METHODS,
  handleAgentChatRpc,
  isAgentChatMethod,
} from "./conversation/rpc";
import { defaultLeaseFile } from "./conversation/lease";
import { promptPaneAgent } from "./conversation/prompt-pane";
import {
  createReviewService,
  ReviewError,
  type ReviewService,
} from "./review/service";
import { pruneReviewImages, reviewImageFile } from "./review/images";
import { openReviewStorage, reviewDirectory } from "./review/storage";
import { ReviewGoneError } from "./workspace/review-patch";
import { SessionImageGoneError } from "./agent/session-images";
import {
  type GlabContext,
  findBranchMergeRequest,
  readCheckout,
  readCommitDiff,
  readMergeRequest,
  readMergeRequestCommits,
  readMergeRequestDiff,
  readRawFile,
} from "./review/gitlab";
import {
  createReviewAgentServer,
  type ReviewAgentServer,
} from "./review/agent-server";
import { setupRemoteReviewAgent as setupRemoteReviewClient } from "./review/agent-remote";
import { sshMasterControlPath } from "./bridge/ssh-sessions";
import { createWorkspaceWorktree } from "./worktree/create";
import { inspectWorkspacePath } from "./workspace/path";
import {
  removeWorktreeWithRecovery,
  runWorktreeRemoveCommand,
  WORKTREE_REMOVE_TIMEOUT_MS,
} from "./worktree/remove";

const APP_VERSION = packageJson.version;
const cliCommandList = cliCommands();
const cliResult = await runCli(
  process.argv.slice(2),
  defaultCliContext(APP_VERSION),
  cliCommandList,
);
if (cliResult === CONTINUE_TO_SERVER) {
  // `service run <env>` loaded the service environment; start the listener.
  process.argv.splice(2);
} else if (cliResult !== null) {
  process.exit(cliResult);
}
const config = loadServerConfig(APP_VERSION, {
  helpText: () => topLevelHelp(cliCommandList),
});
// Only a listener startup may rotate sessions. Management commands also read
// ServerConfig, sometimes with a different environment from the running service.
let sessionSecret = "";
if (config.authRequired) {
  try {
    sessionSecret = loadOrCreateSessionSecret([
      config.password,
      ...(config.pin ? [config.pin] : []),
    ]);
  } catch (cause) {
    console.error(
      `[bridge] FATAL: could not load the session signing secret: ${(cause as Error).message}`,
    );
    process.exit(1);
  }
}
configureServerLogger(config.logLevel);
const logger = serverLogger;
// Command masters of a Roamgate that crashed outlive it; end them.
void sweepOrphanedSshMasters({ logger: logger.child("ssh") }).catch(
  () => undefined,
);
if (
  config.authRequired &&
  !config.generatedAuthToken &&
  isShortAuthPassword(config.password)
) {
  logger.warn(
    `The login password is shorter than ${RECOMMENDED_PASSWORD_LENGTH} characters. Use a longer one if this server is reachable beyond a trusted private network.`,
  );
}
if (config.authRequired && config.pin) {
  logger.warn(
    "PIN login is enabled. Use only behind a trusted private network or VPN; keep your password/token available for recovery.",
  );
}
const cpuProfile = config.profile
  ? (await import("./utils/cpu-profile")).startCpuProfile(
      config.profile,
      APP_VERSION,
      logger,
    )
  : undefined;
// Which agents' finished turns the user saw in Roamgate (agent-seen.ts).
const agentSeen = createAgentSeenStore();
// Seen marks hold for one Herdr server process: its boot id, per connection.
const herdrBoots = createHerdrBootCache();
const webPush = createWebPushService({
  warn: (message) => logger.warn(message),
});
// Voice chat's helper starts on the first voice request.
const voiceHelper = new VoiceHelper(() => readVoiceConfig());
// Work said by voice on sessions (errands): their processes stay up
// while it runs (idle stop).
const voiceErrands = new VoiceErrands({
  read: async (connectionId, paneId) => {
    const runtime = connectionManager.readyRuntime(connectionId);
    if (!runtime) throw new Error(`${connectionId} is not connected`);
    const history = (await runtime.agentSessions.readHistory({
      history_version: 2,
      cursor: null,
      pane_id: paneId,
    })) as { entries?: ErrandEntry[] };
    return history.entries ?? [];
  },
  prompt: async (connectionId, paneId, text) => {
    const runtime = connectionManager.readyRuntime(connectionId);
    if (!runtime) throw new Error(`${connectionId} is not connected`);
    if (!(await runtime.conversation.prompt(paneId, text)))
      await runtime.herdr.call("agent.prompt", { target: paneId, text }, 5000);
  },
});
// Voice sockets open, and when one was last used: a call keeps the
// sessions' processes up (idle stop), its pauses included.
let voiceSocketsOpen = 0;
let lastVoiceAt = 0;
const VOICE_KEEPS_AWAKE_MS = 10 * 60_000;
/** Why a conversation's process must stay up now; null: nothing. */
function conversationKeepAwake(
  connectionId: string,
  paneId: string,
): string | null {
  if (voiceSocketsOpen > 0 || Date.now() - lastVoiceAt < VOICE_KEEPS_AWAKE_MS)
    return "a voice call is open";
  if (voiceErrands.working(`${connectionId}/${paneId}`))
    return "a companion job runs on it";
  return null;
}
const handleVoice = createVoiceRoutes(
  voiceHelper,
  configuredRouter(() => readVoiceConfig()),
  voiceErrands,
  () => {
    const config = readVoiceConfig();
    return "error" in config ? undefined : config.errand_folder;
  },
  new VoiceLibrary({
    clone: (request) => voiceHelper.cloneVoice(request),
    applied: () => voiceHelper.applyTtsModels(),
  }),
);
const voiceSocket = createVoiceSocket(
  voiceHelper,
  configuredCleaner(() => readVoiceConfig()),
);
const VOICE_HTTP_IDLE_TIMEOUT_SECONDS = 120;
const downstreamConnectionConfig = {
  socketPath: config.socketPath,
  clientSocketPath: config.clientSocketPath,
  sshHost: config.sshHost,
  session: config.session,
  hasExplicitSocketPath: config.hasExplicitSocketPath,
  hasExplicitClientSocketPath: config.hasExplicitClientSocketPath,
};
const {
  isAuthed,
  sessionToken,
  handleTokenLogin,
  handleLogin,
  handlePinLogin,
  handleLogout,
  loginPage,
} = createAuthHandlers({
  authRequired: config.authRequired,
  password: config.password,
  pin: config.pin,
  sessionSecret,
  urlLoginToken: config.generatedAuthToken,
  tokenCommand:
    config.generatedAuthTokenPath &&
    authTokenPrintCommand(config.generatedAuthTokenPath),
  secureCookies: Boolean(config.tls),
});

type RpcRequest = ConnectionRpcRequest;

const { handleUpdateCheck, handleUpdateInstall } = createUpdateHandlers({
  appVersion: APP_VERSION,
  runProcessWithCodeTimeout,
  shQuote,
  scheduleProcessExit: scheduleManagedShutdown,
});
const clients = new Set<ServerWebSocket<unknown>>();
const clientIds = new WeakMap<ServerWebSocket<unknown>, number>();
const clientSessions = new WeakMap<ServerWebSocket<unknown>, string | null>();
interface WebSocketCleanupSnapshot {
  client: string;
  viewedTerminals: string[];
}
let nextClientId = 1;
// The Workspaces arrangement is server-wide: every open browser follows it,
// whichever connection it shows.
onWorkspaceTreeChanged((tree) => {
  const line = JSON.stringify({ workspace_tree: tree });
  for (const ws of clients) safeSend(ws, line, "workspace-tree");
});

const rpcOutcomes = new Map<string, { status: "error"; detail?: string }>();

const IMPORTANT_RPC_METHODS = new Set([
  "bridge.pause_others",
  "agent_history.get",
  "agent_history.entry",
  "agent_session.get",
  ...AGENT_CHAT_METHODS.filter(
    (method) =>
      method !== "agent_chat.state" && method !== "agent_chat.subscribe",
  ),
  "file.read",
  "git.diff_file",
  "git.commit_file",
  "git.commit_preview",
  "git.file_action",
  "git.pull",
  "git.repo_action",
  "settings.update_repo",
  "settings.workspace_auto_sync.get",
  "settings.workspace_auto_sync.list",
  "settings.workspace_auto_sync.update",
  "settings.workspace_auto_sync.update_key",
  "settings.worktree_hooks.get",
  "settings.worktree_directory.get",
  // The popup is toggled by a single keystroke and closed by several paths,
  // so every open and close is worth a line: a fast close is exactly the one
  // that makes the key look dead.
  "popup.close",
  "plugin.action.invoke",
  "terminal.watch_popup",
  "worktree.create",
  "worktree.open",
  "worktree.remove",
]);
const SLOW_RPC_LOG_MS = 750;
const legacyRoutingLogger = createLegacyRoutingLogger({
  log: (message) =>
    logger.warn("deprecated request routing", { detail: message }),
});

function clientLabel(ws: ServerWebSocket<unknown>): string {
  const id = clientIds.get(ws);
  return id ? `c${id}` : "unknown";
}

function assignClientId(ws: ServerWebSocket<unknown>): string {
  clientIds.set(ws, nextClientId++);
  return clientLabel(ws);
}

function logDetail(value: string): string {
  return sanitizeConnectionError(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")
    .trim()
    .slice(0, 300);
}

function parseRpcMeta(raw: string): {
  id: string | null;
  method: string | null;
  connectionId: unknown;
  connectionGeneration: unknown;
  lane: SshLane;
} {
  try {
    const msg = JSON.parse(raw);
    return {
      id: typeof msg?.id === "string" ? msg.id : null,
      method: typeof msg?.method === "string" ? msg.method : null,
      // What the browser marks background (badges, polls) yields on the host.
      lane: msg?.lane === "background" ? "background" : "interactive",
      connectionId: Object.hasOwn(msg ?? {}, "connection_id")
        ? msg.connection_id
        : undefined,
      connectionGeneration: Object.hasOwn(msg ?? {}, "connection_generation")
        ? msg.connection_generation
        : undefined,
    };
  } catch {
    return {
      id: null,
      method: null,
      connectionId: undefined,
      connectionGeneration: undefined,
      lane: "interactive",
    };
  }
}

function rpcOutcomeKey(ws: ServerWebSocket<unknown>, id: string) {
  return `${clientLabel(ws)}\0${id}`;
}

function markRpcError(
  ws: ServerWebSocket<unknown>,
  id: string | null | undefined,
  detail?: string,
) {
  if (!id) return;
  rpcOutcomes.set(rpcOutcomeKey(ws, id), { status: "error", detail });
}

/** The agent sessions summaries each socket was given, newest first. */
const agentSessionVersions = new WeakMap<
  object,
  { version: string; result: Record<string, unknown> }[]
>();

/** The Ranger state each socket was last given, for its deltas. */
const assistantBases = new WeakMap<
  object,
  { stamp: string; snapshot: unknown }
>();

/** Topology lists answered as changes to what each socket holds. */
const listReply = createListDeltas();

/** Characters of each RPC's reply, for the log: what a slow link carried. */
const rpcReplyChars = new Map<string, number>();
const LARGE_RPC_REPLY_CHARS = 256 * 1024;

function takeRpcReplyChars(
  ws: ServerWebSocket<unknown>,
  id: string | null,
): number | undefined {
  if (!id) return undefined;
  const key = rpcOutcomeKey(ws, id);
  const chars = rpcReplyChars.get(key);
  rpcReplyChars.delete(key);
  return chars;
}

function takeRpcOutcome(ws: ServerWebSocket<unknown>, id: string | null) {
  if (!id) return null;
  const key = rpcOutcomeKey(ws, id);
  const outcome = rpcOutcomes.get(key) ?? null;
  rpcOutcomes.delete(key);
  return outcome;
}

function shouldLogRpc(
  method: string | null,
  elapsedMs: number,
  failed: boolean,
) {
  if (!method) return failed;
  if (failed) return true;
  if (method === "bridge.ping" || method === "bridge.status") return false;
  if (method === "terminal.input" || method === "terminal.scroll") return false;
  if (method === "terminal.resize" && elapsedMs < SLOW_RPC_LOG_MS) return false;
  return (
    IMPORTANT_RPC_METHODS.has(method) ||
    // What the review pane waits on, but its polls.
    (method.startsWith("review.") && !REVIEW_POLL_METHODS.has(method)) ||
    elapsedMs >= SLOW_RPC_LOG_MS
  );
}

/** Review methods asked every few seconds: logged only when slow. */
const REVIEW_POLL_METHODS = new Set([
  "review.state",
  "review.prompts",
  "review.list",
  "review.activity",
]);

function logRpc(
  ws: ServerWebSocket<unknown>,
  method: string | null,
  startedAt: number,
  status: "ok" | "error",
  connectionId: string | null,
  detail?: string,
  replyChars?: number,
) {
  const elapsedMs = Date.now() - startedAt;
  const failed = status === "error";
  const large = (replyChars ?? 0) >= LARGE_RPC_REPLY_CHARS;
  if (!large && !shouldLogRpc(method, elapsedMs, failed)) return;
  const level = rpcLogLevel({ method, status, detail });
  logger[level]("rpc completed", {
    status,
    client: clientLabel(ws),
    method: method ? logDetail(method) : "unknown",
    connection: connectionId ? logDetail(connectionId) : undefined,
    duration_ms: elapsedMs,
    reply_chars: large ? replyChars : undefined,
    detail: detail ? logDetail(detail) : undefined,
  });
}

function summarizeHerdrEvent(event: any): string {
  const type = logDetail(String(event?.event ?? event?.type ?? "unknown"));
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  const ids = ["workspace_id", "tab_id", "pane_id", "agent_id", "terminal_id"]
    .map((key) => {
      const value = data[key] ?? event?.[key];
      return typeof value === "string" && value
        ? `${key}=${logDetail(value)}`
        : "";
    })
    .filter(Boolean);
  return [`type=${type}`, ...ids].join(" ");
}

/**
 * One registry for the whole server: local ports are a single machine-wide
 * space, so two connections cannot each decide they own 5173.
 */
// Updated once the listener is bound (a configured port 0 resolves then).
let forwardReservedListeningPort = config.port;
// Read at runtime, as server-config does, so Bun does not inline it.
const { NODE_ENV: forwardNodeEnvironment } = process.env;
const sshForwards = createSshForwards({
  logger: logger.child("forward"),
  reservedPorts: () =>
    roamgateOwnPorts(
      forwardReservedListeningPort,
      forwardNodeEnvironment === "development",
    ),
});
// Forwards belong to the machine, not to a browser tab: every open tab shows
// the same list, so a port one of them opened can be found and closed from
// another. Carries no connection envelope for the same reason.
sshForwards.onChange((forwards) => {
  const line = JSON.stringify({ forwards: forwards.map(forwardToWire) });
  for (const ws of clients) safeSend(ws, line, "forwards");
});
const connectionProfileStore = new ConnectionProfileStore();
const syntheticLegacyProfile: SyntheticLocalProfile = {
  id: LEGACY_DEFAULT_CONNECTION_ID,
  label: "Default",
  type: "local",
  control_socket_path: config.socketPath,
  client_socket_path: config.clientSocketPath,
  auto_connect: true,
};
const explicitLegacyOverride = Boolean(
  config.hasExplicitSocketPath ||
    config.hasExplicitClientSocketPath ||
    config.sshHost ||
    config.session,
);
let connectionBootstrap;
try {
  connectionBootstrap = loadConnectionProfileBootstrap({
    store: connectionProfileStore,
    legacyProfile: syntheticLegacyProfile,
    explicitLegacyOverride,
  });
} catch (error) {
  const registryLoadError = sanitizeConnectionError(error);
  logger.error("invalid connection registry preserved", {
    error: registryLoadError,
    profile_mutations: "disabled",
  });
  connectionBootstrap = {
    defaultConnectionId: LEGACY_DEFAULT_CONNECTION_ID,
    explicitLegacyOverride,
    persistedRegistry: null,
    registryLoadError,
    registrations: [
      { profile: syntheticLegacyProfile, readOnly: true as const },
    ],
  };
}

// A workspace closed or removed leaves the Workspaces arrangement, and a
// ready connection's vanished workspaces too; a down one keeps its own.
const workspaceTreePruner = createWorkspaceTreePruner({
  list: (connectionId) =>
    listWorkspaceIdentities(connectionManager, connectionId),
  read: () => readWorkspaceTree(),
  onError: (error, connectionId) =>
    logger.warn("could not tidy the workspace arrangement", {
      connection: connectionId,
      error: sanitizeConnectionError(error),
    }),
});

const connectionFailureReporters = new Map<string, RecoveryReporter>();
const readyConnectionGenerations = new Map<string, number>();

function connectionFailureReporter(connectionId: string): RecoveryReporter {
  let reporter = connectionFailureReporters.get(connectionId);
  if (!reporter) {
    reporter = createRecoveryReporter({
      logger: logger.child("connections"),
      failureMessage: "connection degraded",
      recoveryMessage: "connection recovered",
    });
    connectionFailureReporters.set(connectionId, reporter);
  }
  return reporter;
}

// Ranger's scheduled tasks wait on these for a connection to come back.
const connectionStatusListeners = new Set<() => void>();
const connectionManager = new ConnectionManager<LegacyConnectionRuntime>(
  connectionBootstrap.defaultConnectionId,
  (status) => {
    for (const listener of connectionStatusListeners)
      try {
        listener();
      } catch (error) {
        logger.warn("connection status listener failed", {
          error: sanitizeConnectionError(error),
        });
      }
    const fields = {
      connection: status.id,
      state: status.state,
      generation: status.generation,
    };
    logger.debug("connection status", {
      ...fields,
      error: status.error?.message,
    });
    const reporter = connectionFailureReporter(status.id);
    if (
      (status.state === "error" || status.state === "reconnecting") &&
      status.error
    ) {
      reporter.failure(status.error.message, fields);
      return;
    }
    if (status.state !== "ready") return;
    resumeAssistantIfLoaded();
    workspaceTreePruner.ready(status.id);
    if (reporter.recovered(fields)) {
      readyConnectionGenerations.set(status.id, status.generation);
    } else if (
      readyConnectionGenerations.get(status.id) !== status.generation
    ) {
      readyConnectionGenerations.set(status.id, status.generation);
      logger.info("connection ready", fields);
    }
  },
  logger.child("connections"),
);

const assistantContext = createAssistantContext({
  catalog: () => connectionProfiles.list(),
  // A turn Ranger starts is not one the user has to look at.
  onAgentPrompted: ({ connectionId, paneId, terminalId, seq, status }) =>
    agentSeen.quietTurn(connectionId, paneId, terminalId, seq, status),
  lease: (id) => connectionManager.readyRuntimeLease(id),
  recoveryFingerprint: (id) => {
    const profile = connectionProfiles
      .list()
      .find((profile) => profile.id === id);
    if (!profile) throw new Error("Ranger connection is no longer configured");
    return connectionRecoveryFingerprint(profile);
  },
  connectionStatus: (id) => {
    if (!connectionManager.has(id)) return undefined;
    const status = connectionManager.status(id);
    return {
      label: status.label,
      state: status.state,
      ...(status.error ? { error: status.error.message } : {}),
    };
  },
  watchConnections: (listener) => {
    connectionStatusListeners.add(listener);
    return () => connectionStatusListeners.delete(listener);
  },
  createWorktree: async (runtime, params, isCurrent, beforeDispatch) => {
    const result = await createWorkspaceWorktree(
      runtime,
      params,
      isCurrent,
      undefined,
      undefined,
      beforeDispatch,
    );
    await placeCreatedWorkspaceUnder(
      runtime.identity?.id ?? "",
      (method, callParams) => runtime.herdr.call(method, callParams),
      result,
      typeof params.workspace_id === "string" ? params.workspace_id : undefined,
    );
    return result;
  },
  onWorkspaceCreated: ({ connectionId, workspaceId, sourceWorkspaceId }) => {
    const runtime = connectionManager.readyRuntime(connectionId);
    if (!runtime) return Promise.resolve();
    return placeCreatedWorkspaceUnder(
      connectionId,
      (method, callParams) => runtime.herdr.call(method, callParams),
      { workspace_id: workspaceId },
      sourceWorkspaceId,
    );
  },
});
// Ranger arranges the Workspaces list through the same store and push as
// the sidebar's bridge.workspace_tree.apply.
const assistantWorkspaceTree = createWorkspaceTreeToolHandler({
  connections: () => readWorkspaceTreeConnections(connectionManager),
  read: () => readWorkspaceTree(),
  apply: (ops) => applyWorkspaceTreeOps(ops),
});
let assistantServiceTask: Promise<
  Awaited<
    ReturnType<typeof import("./assistant/service").createAssistantService>
  >
> | null = null;
function getAssistantService() {
  assistantServiceTask ??= import("./assistant/service")
    .then(({ createAssistantService }) =>
      createAssistantService({
        context: assistantContext,
        workspaceTree: assistantWorkspaceTree,
        // Ranger answers the comments on its chat's messages in their
        // threads, as an agent does with roamgate-review reply.
        chatThreads: async (sessionId, params) => {
          const thread = getReviewService().replyInChat({
            chat: rangerChatKey(sessionId),
            commentId: params.comment_id,
            text: params.text,
            author: RANGER_THREAD_AUTHOR,
          });
          return {
            text: `Answered in thread [${thread.id.slice(0, 8)}].`,
          };
        },
        publish: (snapshot) => {
          let payload: string | null = null;
          // A page that read the state with a stamp gets each change as a
          // delta from what this socket was last given, in order.
          let stamp: string | null = null;
          const deltas = new Map<string, string | null>();
          for (const ws of clients) {
            const base = assistantBases.get(ws);
            if (!base) {
              payload ??= JSON.stringify({ assistant: snapshot });
              safeSend(ws, payload, "assistant", "assistant");
              continue;
            }
            stamp ??= Bun.hash(JSON.stringify(snapshot)).toString(36);
            if (base.stamp === stamp) continue;
            if (!deltas.has(base.stamp)) {
              const delta = diffState(
                base.snapshot as Record<string, unknown>,
                snapshot as unknown as Record<string, unknown>,
              );
              deltas.set(
                base.stamp,
                delta
                  ? JSON.stringify({
                      assistant: {
                        state_delta: delta,
                        base: base.stamp,
                        stamp,
                      },
                    })
                  : null,
              );
            }
            assistantBases.set(ws, { stamp, snapshot });
            const line = deltas.get(base.stamp);
            if (line) safeSend(ws, line, "assistant");
          }
        },
        notify: (notification) => {
          const payload = JSON.stringify({
            assistant_notification: notification,
          });
          for (const ws of clients)
            safeSend(ws, payload, "assistant_notification");
          webPush.notify(notification, () => true);
        },
      }),
    )
    .catch((error) => {
      assistantServiceTask = null;
      throw error;
    });
  return assistantServiceTask;
}

/** GitLab project ids by host and path, for finding branches' merge requests. */
const reviewProjectIds = new Map<string, number>();

function reviewGlabContext(
  runtime: LegacyConnectionRuntime,
  root: string,
): GlabContext {
  return {
    root,
    host: runtime.sshHost(),
    shQuote,
    runProcessWithCodeTimeout,
  };
}

/** An image pasted into a review comment, to the signed-in browser. */
async function serveReviewImage(url: URL): Promise<Response> {
  const image = reviewImageFile(
    reviewDirectory(),
    url.searchParams.get("session") ?? "",
    url.searchParams.get("name") ?? "",
  );
  const file = image ? Bun.file(image.path) : null;
  if (!image || !file || !(await file.exists()))
    return new Response("not found", { status: 404 });
  return new Response(file, {
    headers: {
      "content-type": image.type,
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    },
  });
}

let reviewService: ReviewService | null = null;
function getReviewService(): ReviewService {
  if (reviewService) return reviewService;
  reviewService = createReviewService({
    storage: openReviewStorage(reviewDirectory()),
    publish: (push) => {
      // Machine-wide like forwards: each browser keeps the reviews of the
      // connections it shows and can raise a review opened on another one.
      const payload = JSON.stringify({ review: push });
      // A session's snapshot replaces the one before: a browser behind on a
      // slow link gets only the newest instead of every one in turn.
      const coalesceKey =
        push.type === "session"
          ? `review:${push.snapshot.session.id}`
          : push.type === "prompts"
            ? `review-prompts:${push.connectionId}`
            : undefined;
      if (payload.length > 1024 * 1024)
        logger.debug("large review push", {
          type: push.type,
          ...(push.type === "session"
            ? {
                session: push.snapshot.session.id,
                threads: push.snapshot.threads.length,
              }
            : push.type === "prompts"
              ? { prompts: push.prompts.length }
              : {}),
          chars: payload.length,
        });
      for (const ws of clients) safeSend(ws, payload, "review", coalesceKey);
    },
    loadCommits: async (session) => {
      const { runtime } = resolveReadyConnection(
        connectionManager,
        session.connectionId,
      );
      // Comparing two versions of a branch: its commits were rewritten, so
      // they would show the whole branch again, not what changed.
      if (session.target.kind === "range" && session.target.compare) return [];
      if (session.target.kind === "range")
        return runtime.files.readReviewCommits(
          session.root,
          session.target.base,
          session.target.head,
        );
      if (session.target.kind !== "mr") return [];
      const context = reviewGlabContext(runtime, session.root);
      const mr = await readMergeRequest(context, session.target.url);
      try {
        return await runtime.files.readReviewCommits(
          session.root,
          mr.baseSha,
          mr.headSha,
        );
      } catch {
        return readMergeRequestCommits(context, mr);
      }
    },
    loadPatchIds: async (session, shas) => {
      const { runtime } = resolveReadyConnection(
        connectionManager,
        session.connectionId,
      );
      return runtime.files.readReviewPatchIds(session.root, shas);
    },
    loadDiff: async (session, commit) => {
      const { runtime } = resolveReadyConnection(
        connectionManager,
        session.connectionId,
      );
      if (commit) {
        try {
          return await runtime.files.readReviewCommitPatch(
            session.root,
            commit,
          );
        } catch (error) {
          if (session.target.kind !== "mr") throw error;
          const context = reviewGlabContext(runtime, session.root);
          const mr = await readMergeRequest(context, session.target.url);
          const listed = (await readMergeRequestCommits(context, mr)).find(
            (entry) => entry.sha.startsWith(commit),
          );
          return readCommitDiff(context, mr, commit, listed?.parent ?? null);
        }
      }
      if (session.target.kind !== "mr")
        return runtime.files.readReviewPatch(session.root, session.target);
      // A merge request: diff its commits locally when the checkout has
      // them (one host command), else ask GitLab for the diff.
      const context = reviewGlabContext(runtime, session.root);
      const mr = await readMergeRequest(context, session.target.url);
      try {
        const diff = await runtime.files.readReviewPatch(session.root, {
          kind: "range",
          base: mr.baseSha,
          head: mr.headSha,
        });
        return { ...diff, baseSha: mr.baseSha, headSha: mr.headSha };
      } catch {
        return readMergeRequestDiff(context, mr);
      }
    },
    chatReplyHow: (session) =>
      session.target.kind === "chat" &&
      rangerChatSession(session.target.chat) !== null
        ? `your \`${RANGER_THREAD_TOOL}\` tool (comment_id: the bracketed ID, text: your answer)`
        : undefined,
    onDeliveryError: (session, reason) =>
      logger.warn("review comments not delivered", {
        connection: session.connectionId,
        pane: session.agent.paneId ?? "",
        error: reason,
      }),
    promptAgent: async (connectionId, paneId, text) => {
      // A Ranger chat's threads go to Ranger, as a message in that chat.
      const rangerChat = rangerChatSession(paneId);
      if (rangerChat) {
        await (await getAssistantService()).deliverChatComments(
          rangerChat,
          text,
        );
        return;
      }
      const { runtime } = resolveReadyConnection(
        connectionManager,
        connectionId,
      );
      await promptPaneAgent(runtime, paneId, text);
    },
    // The comments follow the agent's session to the pane it runs in now.
    sessionPane: async (connectionId, sessionId) => {
      // A Ranger chat is in no pane: its threads go to the chat itself.
      if (rangerChatSession(sessionId)) return sessionId;
      const { runtime } = resolveReadyConnection(
        connectionManager,
        connectionId,
      );
      return runtime.agentSessions.sessionPane(sessionId);
    },
    paneSession: async (connectionId, paneId) => {
      if (rangerChatSession(paneId)) return null;
      const { runtime } = resolveReadyConnection(
        connectionManager,
        connectionId,
      );
      return runtime.agentSessions.paneSession(paneId);
    },
    // Agents run the review client: on this machine once it is installed,
    // on an SSH host once its client and socket forward are set up there.
    agentChannel: (connectionId) => {
      const runtime = connectionManager.readyRuntime(connectionId);
      if (!runtime || runtime.remotePlatform === "windows") return false;
      return runtime.sshHost()
        ? reviewAgentHosts.has(connectionId)
        : reviewAgentInstalled;
    },
    gitlab: {
      context: (session) => {
        const { runtime } = resolveReadyConnection(
          connectionManager,
          session.connectionId,
        );
        return reviewGlabContext(runtime, session.root);
      },
      checkout: (session) => {
        const { runtime } = resolveReadyConnection(
          connectionManager,
          session.connectionId,
        );
        return readCheckout(reviewGlabContext(runtime, session.root));
      },
      find: (session, checkout) => {
        const { runtime } = resolveReadyConnection(
          connectionManager,
          session.connectionId,
        );
        return findBranchMergeRequest(
          reviewGlabContext(runtime, session.root),
          checkout,
          reviewProjectIds,
        );
      },
    },
    loadState: (session) => {
      const { runtime } = resolveReadyConnection(
        connectionManager,
        session.connectionId,
      );
      return runtime.files.readReviewState(session.root, session.target);
    },
    loadHeads: (connectionId, entries) => {
      const { runtime } = resolveReadyConnection(
        connectionManager,
        connectionId,
      );
      return runtime.files.readReviewHeads(entries);
    },
    loadFile: async (session, rev, path) => {
      const { runtime } = resolveReadyConnection(
        connectionManager,
        session.connectionId,
      );
      try {
        return await runtime.files.readReviewFile(session.root, rev, path);
      } catch (error) {
        // An MR's commits may not be in the checkout; GitLab has the file.
        if (!rev || !session.gitlab) throw error;
        const context = reviewGlabContext(runtime, session.root);
        const url =
          session.target.kind === "mr" ? session.target.url : undefined;
        if (!url) throw error;
        return readRawFile(
          context,
          await readMergeRequest(context, url),
          path,
          rev,
        );
      }
    },
  });
  // Images of reviews discarded before the last restart.
  try {
    pruneReviewImages(
      reviewDirectory(),
      new Set(reviewService.list().map(({ session }) => session.id)),
    );
  } catch (error) {
    logger.warn("review images not pruned", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return reviewService;
}

let reviewAgent: ReviewAgentServer | null = null;
/** The review client and its socket are set up on this machine. */
let reviewAgentInstalled = false;
/** SSH connections whose host has the review client and its socket. */
const reviewAgentHosts = new Set<string>();
function getReviewAgent(): ReviewAgentServer {
  reviewAgent ??= createReviewAgentServer({
    service: getReviewService(),
    hasViewers: () => clients.size > 0,
    notify: notifyFromAgent,
    workspaces: workspaceFromAgent,
    // Conversation mode's pane holders (roamgate-hold).
    holder: {
      hold: ({ connectionId, paneId, sessionId, signal, status, shell }) => {
        const runtime = connectionManager.readyRuntime(connectionId);
        if (!runtime)
          throw new ReviewError("this connection is not ready", 503);
        return runtime.conversation.holder.hold({
          paneId,
          sessionId,
          signal,
          status,
          shell,
        });
      },
      fg: ({ connectionId, paneId, spec, status, shell }) => {
        const runtime = connectionManager.readyRuntime(connectionId);
        if (!runtime)
          throw new ReviewError("this connection is not ready", 503);
        return runtime.conversation.holder.fg({ paneId, spec, status, shell });
      },
      output: ({ connectionId, ...input }) => {
        const runtime = connectionManager.readyRuntime(connectionId);
        if (!runtime)
          throw new ReviewError("this connection is not ready", 503);
        return runtime.conversation.holder.output(input);
      },
      handback: ({ connectionId, paneId }) => {
        const runtime = connectionManager.readyRuntime(connectionId);
        if (!runtime)
          throw new ReviewError("this connection is not ready", 503);
        return runtime.conversation.holder.handback({ paneId });
      },
    },
    directory: reviewDirectory(),
    logger: logger.child("review"),
    connections: () =>
      connectionManager.list().flatMap((status) => {
        const runtime = connectionManager.readyRuntime(status.id);
        if (!runtime || runtime.remotePlatform === "windows") return [];
        return [
          {
            id: runtime.identity.id,
            herdrSocketPath: runtime.socketPath,
            sshHost: runtime.sshHost(),
            readRoot: (path: string) => runtime.files.readReviewRoot(path),
            readDefaultBase: (root: string) =>
              runtime.files.readDefaultBase(root),
          },
        ];
      }),
  });
  return reviewAgent;
}

/**
 * An agent making a worktree or workspace, or naming one it started work
 * in (`roamgate-review worktree|workspace|place`): the workspace goes under
 * the agent's own in the Workspaces list, or into the group `--group`
 * names (made first with `--create-group`). `groups` lists those paths.
 */
async function workspaceFromAgent(input: {
  connectionId: string;
  paneId: string;
  workspaceId: string;
  command: "place" | "worktree" | "workspace" | "groups";
  params: Record<string, string>;
}): Promise<Record<string, unknown>> {
  const { connectionId, paneId, command, params } = input;
  const runtime = connectionManager.readyRuntime(connectionId);
  if (!runtime) throw new ReviewError("this connection is not ready", 503);
  const call = (method: string, callParams: Record<string, unknown> = {}) =>
    runtime.herdr.call(method, callParams);
  let requester = input.workspaceId;
  if (!requester && paneId) {
    const pane = (await call("pane.get", { pane_id: paneId }))?.pane;
    requester = typeof pane?.workspace_id === "string" ? pane.workspace_id : "";
  }
  if (!requester && command !== "groups")
    throw new ReviewError("cannot tell which workspace you are in");
  const listed = await runtime.worktreeParents.enrichWorkspaceList(
    await call("workspace.list"),
  );
  const workspaces: any[] = Array.isArray(listed?.workspaces)
    ? listed.workspaces
    : [];
  const parent = workspaces.find((each) => each?.workspace_id === requester);
  if (!parent && command !== "groups")
    throw new ReviewError("your workspace is not listed by Herdr");
  const usualParent = workspaces.find(
    (each) =>
      parent?.worktree?.is_linked_worktree === true &&
      typeof parent.worktree.parent_workspace_id === "string" &&
      each?.workspace_id === parent.worktree.parent_workspace_id,
  );
  const asker = {
    ...(parent ? { asker: workspaceRefFor(connectionId, parent) } : {}),
    ...(usualParent
      ? { askerUsualParent: workspaceRefFor(connectionId, usualParent) }
      : {}),
  };
  if (command === "groups")
    return agentGroupPaths(await readWorkspaceTree(), {
      ref: asker.asker,
      usualParent: asker.askerUsualParent,
    });
  const group = params.group?.trim();
  const create = params.create_group === "1";
  /** Into the group: refused (nothing made) when the path leads nowhere. */
  const intoGroup = async (subject?: Record<string, unknown>) => {
    try {
      const placement = agentGroupPlacementOps(await readWorkspaceTree(), {
        ...(subject
          ? { subject: workspaceRefFor(connectionId, subject as any) }
          : {}),
        ...asker,
        group: group!,
        create,
      });
      if (subject) await applyWorkspaceTreeOps(placement.ops);
      return placement;
    } catch (error) {
      if (error instanceof WorkspaceTreeError)
        throw new ReviewError(error.message, 404);
      throw error;
    }
  };
  if (group) await intoGroup();
  if (command === "place") {
    const target = workspaces.find((each) =>
      params.workspace_id
        ? each?.workspace_id === params.workspace_id
        : each?.worktree?.checkout_path === params.path ||
          each?.cwd === params.path,
    );
    if (!target) throw new ReviewError("no workspace matches", 404);
    if (group) {
      const placement = await intoGroup(target);
      return {
        placed: target.workspace_id,
        group: placement.path.join("/"),
        ...(placement.created.length ? { created: placement.created } : {}),
      };
    }
    if (target.workspace_id === requester)
      throw new ReviewError("that is your own workspace");
    // Asked for explicitly: placed even where the usual list would nest it.
    await applyWorkspaceTreeOps([
      {
        op: "move",
        subject: { workspace: workspaceRefFor(connectionId, target) },
        parent: { workspace: workspaceRefFor(connectionId, parent) },
      },
    ]);
    return { placed: target.workspace_id, under: requester };
  }
  const dir = params.repo || params.dir || params.cwd;
  if (!dir?.startsWith("/"))
    throw new ReviewError("the client did not send its directory");
  const result =
    command === "worktree"
      ? await call("worktree.create", {
          cwd: dir,
          branch: params.branch,
          ...(params.base ? { base: params.base } : {}),
          ...(params.path ? { path: params.path } : {}),
          ...(params.label ? { label: params.label } : {}),
          focus: false,
        })
      : await call("workspace.create", {
          cwd: dir,
          ...(params.label ? { label: params.label } : {}),
          source_workspace_id: requester,
          focus: false,
        });
  const created = result?.workspace;
  if (group && created?.workspace_id) {
    // Named by its checkout as the list will see it.
    const fresh = await runtime.worktreeParents.enrichWorkspaceList(
      await call("workspace.list"),
    );
    const seen = (
      Array.isArray(fresh?.workspaces) ? fresh.workspaces : []
    ).find((each: any) => each?.workspace_id === created.workspace_id);
    const placement = await intoGroup(seen ?? created);
    return {
      workspace_id: created.workspace_id,
      label: created.label ?? null,
      ...(result?.worktree?.path ? { path: result.worktree.path } : {}),
      group: placement.path.join("/"),
      ...(placement.created.length ? { created: placement.created } : {}),
    };
  }
  await placeCreatedWorkspaceUnder(connectionId, call, result, requester);
  return {
    workspace_id: created?.workspace_id ?? null,
    label: created?.label ?? null,
    ...(result?.worktree?.path ? { path: result.worktree.path } : {}),
    under: requester,
  };
}

/**
 * An agent saying the user needs to act (`roamgate-review notify`): kept with
 * the agent until the user looks at it, pushed to their devices, and the open
 * pages told to read their agents again.
 */
async function notifyFromAgent(input: {
  connectionId: string;
  paneId: string;
  agent: string;
  title?: string;
  text: string;
}) {
  const { connectionId, paneId, agent, title, text } = input;
  agentSeen.note(connectionId, paneId, { text, ...(title ? { title } : {}) });
  const status = connectionManager
    .list()
    .find((each) => each.id === connectionId);
  const runtime = connectionManager.readyRuntime(connectionId);
  let pane: { workspace_id?: string; tab_id?: string } | undefined;
  let workspaceLabel: string | undefined;
  try {
    const [panes, workspaces] = (await Promise.all([
      runtime?.herdr.call("pane.list", {}),
      runtime?.herdr.call("workspace.list", {}),
    ])) as [
      { panes?: { pane_id: string; workspace_id?: string; tab_id?: string }[] },
      { workspaces?: { workspace_id: string; label?: string }[] },
    ];
    pane = panes?.panes?.find((each) => each.pane_id === paneId);
    workspaceLabel = workspaces?.workspaces?.find(
      (each) => each.workspace_id === pane?.workspace_id,
    )?.label;
  } catch {
    // The push still goes, without its workspace.
  }
  if (status)
    webPush.notify(
      {
        kind: "blocked",
        connectionId,
        runtimeGeneration: status.generation,
        paneId,
        ...(pane?.workspace_id ? { workspaceId: pane.workspace_id } : {}),
        ...(pane?.tab_id ? { tabId: pane.tab_id } : {}),
        ...(workspaceLabel ? { workspaceLabel } : {}),
        agent,
        title: `${workspaceLabel ?? agent}: ${title ?? "needs you"}`,
        body: text,
      },
      () => true,
    );
  try {
    const line = serializeHerdrEventEnvelope(
      connectionId,
      { event: "roamgate.agent_note", data: { pane_id: paneId } },
      status?.generation,
    );
    for (const ws of clients) safeSend(ws, line, "event");
  } catch {
    // The pages see it with their next read.
  }
}

/** Lets agents on an SSH host reach the review pane over the master. */
function setupRemoteReviewAgent(connectionId: string, host: string) {
  // Until it is set up again, comments are not typed for a missing client.
  reviewAgentHosts.delete(connectionId);
  const controlPath = sshMasterControlPath(host);
  if (!controlPath) return;
  let localSocket: string;
  try {
    localSocket = getReviewAgent().listen(connectionId);
  } catch (error) {
    logger.warn("review agent socket unavailable", {
      connection: connectionId,
      error: sanitizeConnectionError(error),
    });
    return;
  }
  void setupRemoteReviewClient({
    host,
    controlPath,
    localSocket,
    connectionId,
    run: runProcessWithCodeTimeout,
  }).then(
    () => {
      reviewAgentHosts.add(connectionId);
      logger.debug("review client ready", { connection: connectionId });
    },
    (error) =>
      logger.warn("review client unavailable on this host", {
        connection: connectionId,
        error: sanitizeConnectionError(error),
      }),
  );
}

function resumeAssistantIfLoaded() {
  void assistantServiceTask
    ?.then((service) => service.resume())
    .catch(() => {
      logger.warn("Ranger recovery could not be started");
    });
}

const { handleHerdrStatus, handleHerdrSetup } = createHerdrSetupHandlers({
  ping: () => {
    const runtime = connectionManager.defaultReadyRuntime();
    return runtime
      ? runtime.herdr.ping()
      : new HerdrClient(config.socketPath).ping();
  },
  guard: () =>
    herdrSetupGuardForProfile(
      config,
      connectionProfiles
        .list()
        .find((profile) => profile.id === connectionManager.defaultId()),
    ),
});

function runtimeFactoryForProfile(
  profile: ConnectionProfile | SyntheticLocalProfile,
) {
  const identity = connectionIdentityForProfile(profile);
  return (context: ConnectionRuntimeContext) => {
    const profileConfig: SshTunnelConfig =
      profile.id === LEGACY_DEFAULT_CONNECTION_ID
        ? downstreamConnectionConfig
        : profile.type === "ssh"
          ? createSshProfileRuntimeConfig(profile)
          : {
              socketPath: profile.control_socket_path,
              clientSocketPath: profile.client_socket_path,
              sshHost: undefined,
              session: undefined,
              hasExplicitSocketPath: true,
              hasExplicitClientSocketPath: true,
              ownedRuntimeDirectory: undefined,
            };
    // A test server (a HOME of its own) stays off the real hosts.
    const refusal = profileConfig.sshHost ? sshRefusal() : null;
    if (refusal) throw new ConnectionProbeError(refusal, false);
    let runtime: LegacyConnectionRuntime;
    try {
      runtime = createLegacyConnectionRuntime({
        identity,
        connectionGeneration: context.generation,
        config: profileConfig,
        logger: logger.child("connection"),
        safeSend,
        broadcast: (payload, context) => {
          for (const ws of clients) safeSend(ws, payload, context);
        },
        clientLabel,
        markRpcError,
        taskNotificationSource: config.taskNotificationSource,
        conversationLeaseFile: defaultLeaseFile(),
        conversationKeepAwake,
        // No terminal to fall back on: the prompt waits for a browser, and
        // its timeout denies.
        askAgentPrompt: ({ connectionId, paneId, signal, ...prompt }) =>
          getReviewService().prompts.request({
            ...prompt,
            connectionId,
            paneId,
            agent: "Claude",
            // A headless claude: there is no terminal to ask instead.
            noTerminal: true,
            signal,
          }),
        onTaskEvent: (event) => {
          const connections = connectionProfiles.list();
          webPush.notify(
            {
              ...event,
              connectionId: identity.id,
              connectionLabel:
                connections.length > 1
                  ? (connections.find(
                      (connection) => connection.id === identity.id,
                    )?.label ?? identity.label)
                  : undefined,
              runtimeGeneration: context.generation,
            },
            context.isCurrent,
          );
        },
        onEvent: (event, eventIdentity) => {
          if (!context.isCurrent()) return;
          logger.debug("Herdr event", {
            connection: eventIdentity.id,
            detail: summarizeHerdrEvent(event),
          });
          try {
            const line = serializeHerdrEventEnvelope(
              eventIdentity.id,
              event,
              context.generation,
            );
            for (const ws of clients) safeSend(ws, line, "event");
          } catch (error) {
            logger.warn("dropped invalid Herdr event", {
              connection: eventIdentity.id,
              error: sanitizeConnectionError(error),
            });
          }
          void workspaceTreePruner.event(eventIdentity.id, event);
        },
        forwards: sshForwards,
        onSshMasterReady: profileConfig.sshHost
          ? () => {
              if (context.isCurrent() && profileConfig.sshHost)
                setupRemoteReviewAgent(identity.id, profileConfig.sshHost);
            }
          : undefined,
        onTransportExit: profileConfig.sshHost
          ? (error) => {
              if (!context.isCurrent()) return;
              const reconnecting = connectionProfiles.willRetry(
                profile.id,
                error,
              );
              context.reportError(error, { reconnecting });
              connectionProfiles.runtimeFailed(profile.id, error);
            }
          : undefined,
      });
    } catch (error) {
      if (profileConfig.ownedRuntimeDirectory) {
        rmSync(profileConfig.ownedRuntimeDirectory, {
          recursive: true,
          force: true,
        });
      }
      throw error;
    }
    return {
      ...runtime,
      async startTransport() {
        await runtime.startTransport();
        await testConnectionSockets(
          profileConfig.socketPath,
          profileConfig.clientSocketPath,
        );
      },
    };
  };
}

const connectionProfiles = new ConnectionProfileService({
  manager: connectionManager,
  store: connectionProfileStore,
  bootstrap: connectionBootstrap,
  createRuntime: runtimeFactoryForProfile,
});
// A pending SSH retry may wait up to its capped backoff. When the host's
// network changes, a peer that was unreachable may be back: try now.
const stopNetworkWatch = watchNetworkChanges(() => {
  logger.debug("network changed; retrying waiting connections");
  connectionProfiles.retryNow();
});

/**
 * Automatic placement in the Workspaces arrangement: the workspace a
 * worktree or session was made for goes under the workspace that asked.
 * Never fails the creation: the user can always place it by hand.
 */
async function placeCreatedWorkspaceUnder(
  connectionId: string,
  herdrCall: (method: string, params?: Record<string, unknown>) => Promise<any>,
  created: unknown,
  requesterWorkspaceId: string | undefined,
) {
  if (!connectionId || !requesterWorkspaceId) return;
  try {
    const record =
      created && typeof created === "object"
        ? (created as Record<string, any>)
        : {};
    const workspaceId =
      record.workspace?.workspace_id ?? record.workspace_id ?? undefined;
    if (typeof workspaceId !== "string" || workspaceId === requesterWorkspaceId)
      return;
    const list = (await herdrCall("workspace.list", {})) as {
      workspaces?: any[];
    };
    const enriched = connectionManager.readyRuntime(connectionId)
      ?.worktreeParents
      ? await connectionManager
          .readyRuntime(connectionId)!
          .worktreeParents.enrichWorkspaceList(list)
      : list;
    const find = (id: string) =>
      enriched?.workspaces?.find((each: any) => each?.workspace_id === id);
    await placeCreatedWorkspace({
      connectionId,
      workspace: find(workspaceId) ?? record.workspace,
      parent: find(requesterWorkspaceId),
    });
  } catch (error) {
    logger.warn("unable to place a created workspace", {
      connection: connectionId,
      error: sanitizeConnectionError(error),
    });
  }
}

function notifyBrowserClientCount() {
  connectionManager.forEachCurrentRuntime((runtime) => {
    runtime.terminalBridge.browserClientCountChanged(clients.size);
  });
}

const webSocketCleanup = new WebSocketCleanupTracker<
  ServerWebSocket<unknown>,
  WebSocketCleanupSnapshot
>((ws) => {
  const viewedTerminals: string[] = [];
  connectionManager.forEachCurrentRuntime((runtime) => {
    viewedTerminals.push(...runtime.terminalBridge.viewedTerminals(ws));
    runtime.terminalBridge.cleanupWs(ws);
    runtime.conversation.cleanupWs(ws);
    runtime.historyWatcher.cleanupWs(ws);
  });
  const snapshot = {
    client: clientLabel(ws),
    viewedTerminals,
  };
  clients.delete(ws);
  notifyBrowserClientCount();
  return snapshot;
});

function safeSend(
  ws: ServerWebSocket<unknown>,
  payload: string,
  context = "message",
  coalesceKey?: string,
): boolean {
  return sendWebSocketMessage(ws, payload, {
    cleanup: () => {
      webSocketCleanup.cleanup(ws);
    },
    coalesceKey,
    context,
    warn: (message) =>
      logger.warn("websocket send failed", {
        detail: message.replace(/^\[bridge\] /, ""),
      }),
  });
}

const PANE_INPUT_METHODS = new Set([
  "pane.send_input",
  "pane.send_text",
  "pane.send_keys",
]);

const handleUiSettingsRpc = createUiSettingsRpcHandler();

async function handleRpc(ws: ServerWebSocket<unknown>, raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeSend(
      ws,
      JSON.stringify({ error: { message: "bad json" } }),
      "bad-json",
    );
    return;
  }
  if (!isConnectionRpcEnvelope(parsed)) {
    safeSend(
      ws,
      JSON.stringify({ error: { message: "invalid request envelope" } }),
      "invalid-request-envelope",
    );
    return;
  }
  const req = parsed as RpcRequest;
  const { id, method } = req;
  let { params } = req;
  let validationConnectionId: string | undefined;
  let connectionIdValidationFailed = false;
  if (Object.hasOwn(req, "connection_id")) {
    try {
      validationConnectionId = validateConnectionId(req.connection_id);
    } catch {
      connectionIdValidationFailed = true;
    }
  }
  let validationConnectionGeneration: number | undefined;
  let connectionGenerationValidationFailed = false;
  if (Object.hasOwn(req, "connection_generation")) {
    try {
      validationConnectionGeneration = validateConnectionGeneration(
        req.connection_generation,
      );
    } catch {
      connectionGenerationValidationFailed = true;
    }
  }
  if (typeof id !== "string" || !id || typeof method !== "string" || !method) {
    const message = connectionIdValidationFailed
      ? "invalid connection_id"
      : connectionGenerationValidationFailed
        ? "invalid connection_generation"
        : "missing id/method";
    markRpcError(ws, typeof id === "string" ? id : undefined, message);
    const responseId = typeof id === "string" ? id : undefined;
    const payload = validationConnectionId
      ? serializeConnectionEnvelope(
          validationConnectionId,
          {
            ...(responseId ? { id: responseId } : {}),
            error: { message },
          },
          validationConnectionGeneration,
        )
      : JSON.stringify({
          ...(responseId ? { id: responseId } : {}),
          error: { message },
        });
    safeSend(ws, payload, "invalid-request");
    return;
  }
  let route: ReturnType<typeof resolveRpcRoute<LegacyConnectionRuntime>>;
  try {
    route = resolveRpcRoute({
      request: req,
      registry: connectionManager,
      legacyClient: ws,
      legacyLogger: legacyRoutingLogger,
    });
  } catch (error) {
    const message = (error as Error).message;
    markRpcError(ws, id, message);
    const connectionId =
      error instanceof ConnectionRoutingError ? error.connectionId : undefined;
    const connectionGeneration =
      error instanceof ConnectionRoutingError
        ? error.connectionGeneration
        : undefined;
    const payload = connectionId
      ? serializeConnectionEnvelope(
          connectionId,
          {
            id,
            error: { message },
          },
          connectionGeneration,
        )
      : JSON.stringify({ id, error: { message } });
    safeSend(ws, payload, "connection-routing-error");
    return connectionId ?? null;
  }
  const connectionId = route.scope === "connection" ? route.connectionId : null;
  const requestIsCurrent = () => route.scope === "bridge" || route.isCurrent();
  const encode = (message: Record<string, unknown>) =>
    route.scope === "connection"
      ? serializeConnectionEnvelope(
          route.connectionId,
          message,
          route.generation,
        )
      : JSON.stringify(message);
  const replyPublisher =
    route.scope === "connection"
      ? createConnectionReplyPublisher({
          connectionId: route.connectionId,
          generation: route.generation,
          requestId: id,
          isCurrent: route.isCurrent,
          send: (payload, context) => {
            if (id) rpcReplyChars.set(rpcOutcomeKey(ws, id), payload.length);
            return safeSend(ws, payload, context);
          },
          markError: (message) => markRpcError(ws, id, message),
        })
      : null;
  const sendReply = (
    message: Record<string, unknown>,
    context: string,
  ): boolean => {
    if (replyPublisher) return replyPublisher.send(message, context);
    const payload = encode(message);
    if (id) rpcReplyChars.set(rpcOutcomeKey(ws, id), payload.length);
    return safeSend(ws, payload, context);
  };
  const sendError = (context: string, error: unknown) => {
    const message = (error as Error).message;
    markRpcError(ws, id, message);
    // A review whose checkout or commits are gone says so to the overlay; a
    // sent image that is not there says so to the chat.
    const code =
      error instanceof ReviewGoneError || error instanceof SessionImageGoneError
        ? error.code
        : undefined;
    sendReply({ id, error: code ? { message, code } : { message } }, context);
  };
  if (
    method === "bridge.ui_settings.get" ||
    method === "bridge.ui_settings.update"
  ) {
    try {
      const result = await handleUiSettingsRpc(method, params ?? {});
      if (method === "bridge.ui_settings.update") {
        const line = JSON.stringify({ ui_settings: result });
        for (const client of clients)
          if (client !== ws) safeSend(client, line, "ui-settings");
      }
      sendReply({ id, result }, "ui-settings");
    } catch (error) {
      sendError("ui-settings-error", error);
    }
    return;
  }
  if (method === "bridge.ping") {
    sendReply({ id, result: { ok: true } }, "bridge-ping");
    return;
  }
  if (method === "bridge.status") {
    sendReply(
      {
        id,
        result: {
          clients: clients.size,
          terminals:
            connectionManager
              .defaultReadyRuntime()
              ?.terminalBridge.statusTerminals() ?? [],
          default_connection_id: connectionManager.defaultId(),
          connections: connectionProfiles.list(),
        },
      },
      "bridge-status",
    );
    return;
  }
  if (method.startsWith("bridge.assistant.")) {
    try {
      const result =
        method === "bridge.assistant.context"
          ? await (await getAssistantService()).workspaceCatalog()
          : method === "bridge.assistant.mentions"
            ? await (await getAssistantService()).mentionCatalog(params ?? {})
            : method === "bridge.assistant.task.get"
              ? await (await getAssistantService()).taskDetail(params ?? {})
              : await (await getAssistantService()).handle(
                  method,
                  params ?? {},
                );
      // A page that holds the state sends the stamp of its last read
      // (`since`): an unchanged state is the stamp alone, not a megabyte.
      if (method === "bridge.assistant.get" && params && "since" in params) {
        const stamp = Bun.hash(JSON.stringify(result)).toString(36);
        // Pushes to this socket go as deltas from this state from now on,
        // in the same order as this reply.
        assistantBases.set(ws, { stamp, snapshot: result });
        sendReply(
          {
            id,
            result:
              params.since === stamp
                ? { unchanged: true, stamp }
                : { snapshot: result, stamp },
          },
          "assistant",
        );
        return;
      }
      sendReply({ id, result }, "assistant-rpc");
    } catch (error) {
      sendError("assistant-rpc-error", error);
    }
    return;
  }
  if (method.startsWith("bridge.workspace_tree.")) {
    // The Workspaces arrangement belongs to this Roamgate server and spans
    // every connection, so it answers whichever connection is active.
    try {
      let result: unknown;
      if (method === "bridge.workspace_tree.get") {
        result = { tree: await readWorkspaceTree() };
      } else if (method === "bridge.workspace_tree.apply") {
        const raw = Array.isArray(params?.ops) ? params.ops : [];
        const ops = raw.slice(0, 64).map(parseWorkspaceTreeOp);
        if (!ops.length || ops.some((op: unknown) => !op))
          throw new Error("bridge.workspace_tree.apply needs valid ops");
        result = {
          tree: await applyWorkspaceTreeOps(ops as WorkspaceTreeOp[]),
        };
      } else {
        throw new Error(`unknown bridge-global method: ${method}`);
      }
      sendReply({ id, result }, "workspace-tree");
    } catch (error) {
      sendError("workspace-tree-error", error);
    }
    return;
  }
  if (method === "connections.agent_tasks") {
    try {
      sendReply(
        {
          id,
          result: await readConnectionAgentTasks(
            connectionManager,
            params ?? {},
          ),
        },
        "connections-agent-tasks",
      );
    } catch (error) {
      sendError("connections-agent-tasks-error", error);
    }
    return;
  }
  if (method === "connections.list") {
    sendReply(
      {
        id,
        result: {
          default_connection_id: connectionManager.defaultId(),
          connections: connectionProfiles.list(),
        },
      },
      "connections-list",
    );
    return;
  }
  if (method === "connections.agent_sessions") {
    try {
      const sessions = await readConnectionAgentSessions(connectionManager);
      // Their agents as agent.list gives them: seen in Roamgate and when,
      // and what they said, so another connection's workspaces go by the
      // user's last look and show Done the same way on every device.
      const result = {
        connections: await Promise.all(
          sessions.connections.map(async (snapshot) => {
            if (!snapshot.agents) return snapshot;
            const runtime = connectionManager.readyRuntime(
              snapshot.connection_id,
            );
            const boot = runtime
              ? await herdrBoots.get(snapshot.connection_id, () =>
                  runtime.recoveryIdentity(AbortSignal.timeout(3_000)),
                )
              : null;
            return {
              ...snapshot,
              agents: agentSeen.annotate(
                snapshot.connection_id,
                snapshot.agents,
                boot,
              ),
            };
          }),
        ),
      };
      // Read again on every burst of agent events: an answer that did not
      // change since the one the page holds is only its stamp.
      // One that did change goes as the changes since the version this
      // socket was given, when the page holds it.
      const version = Bun.hash(JSON.stringify(result)).toString(36);
      const kept = agentSessionVersions.get(ws) ?? [];
      const base = kept.find((each) => each.version === params?.since);
      agentSessionVersions.set(
        ws,
        [
          { version, result },
          ...kept.filter((each) => each.version !== version),
        ].slice(0, 2),
      );
      const delta =
        base && base.version !== version
          ? diffState(base.result, result as Record<string, unknown>)
          : null;
      sendReply(
        {
          id,
          result:
            params?.since === version
              ? { unchanged: true, version }
              : delta && base
                ? { sessions_delta: delta, base: base.version, version }
                : { ...result, version },
        },
        "connections-agent-sessions",
      );
    } catch (error) {
      sendError("connections-agent-sessions-error", error);
    }
    return;
  }
  if (method.startsWith("connections.")) {
    try {
      let result: unknown;
      if (method === "connections.create") {
        result = await connectionProfiles.create(params?.profile ?? params);
      } else if (method === "connections.update") {
        result = await connectionProfiles.update(
          params?.id,
          params?.profile ?? params,
        );
      } else if (method === "connections.remove") {
        result = await connectionProfiles.remove(params?.id);
      } else if (method === "connections.set_default") {
        result = await connectionProfiles.setDefault(params?.id);
      } else if (method === "connections.connect") {
        result = await connectionProfiles.connect(params?.id);
      } else if (method === "connections.disconnect") {
        result = await connectionProfiles.disconnect(params?.id);
      } else if (method === "connections.test") {
        result = await connectionProfiles.test(params?.profile ?? params);
      } else {
        throw new Error(`unknown bridge-global method: ${method}`);
      }
      sendReply({ id, result }, "connections-mutation");
    } catch (error) {
      const message = sanitizeConnectionError(error);
      markRpcError(ws, id, message);
      sendReply({ id, error: { message } }, "connections-mutation-error");
    }
    return;
  }
  if (method === "bridge.pause_others") {
    const targets = Array.from(clients).filter((client) => client !== ws);
    let pausedClients = 0;
    for (const client of targets) {
      const ok = safeSend(
        client,
        JSON.stringify({
          control: {
            type: "pause_connection",
            reason:
              "Another Roamgate client paused this connection. Resume when you want this browser to sync again.",
          },
        }),
        "pause-other-client",
      );
      if (ok) pausedClients += 1;
    }
    sendReply(
      {
        id,
        result: {
          ok: true,
          paused_clients: pausedClients,
          clients: clients.size,
        },
      },
      "bridge-pause-others",
    );
    return;
  }

  if (route.scope === "bridge") {
    sendError(
      "unknown-bridge-method",
      new Error(`unknown bridge-global method: ${method}`),
    );
    return null;
  }
  const connection = route.runtime;
  if (
    connection.remotePlatform === "windows" &&
    /^(?:file\.|git\.|worktree\.|agent_chat\.|agent_history\.|agent_session\.|agent_commands\.|agent_artifacts\.|agent_tasks?\.|settings\.(?:workspace_auto_sync|worktree_hooks)\.)/.test(
      method,
    )
  ) {
    sendError(
      "unsupported-windows-operation",
      new Error(unixOnlyMessage("This operation")),
    );
    return;
  }
  const {
    sshHost,
    herdr,
    worktreeParents,
    handleSettingsRpc,
    handleForwardRpc,
    worktreeRemovalCoordinator,
    worktreeRemovalRuntime,
    terminalBridge,
  } = connection;
  const {
    listWorkspaceFiles,
    resolveWorkspaceFiles,
    readWorkspaceFile,
    searchWorkspaceFiles,
    revealWorkspaceFile,
    createWorkspaceDirectory,
    moveWorkspaceFile,
    readGitDiffSummary,
    readWorkspacePullRequest,
    readGitDiffFile,
    readGitCommits,
    readGitCommit,
    readGitCommitFile,
    readGitCommitPreview,
    runGitPull,
    runWorkspaceGitFileAction,
    runWorkspaceGitRepoAction,
  } = connection.files;
  const { enrichWorkspacesWithGitStatus, invalidateGitStatus } =
    connection.status;
  const {
    runWorktreeHook,
    worktreeRemoveHookContext,
    runWorktreeRemovedHook,
    runWorktreeOpenedHook,
    sourceWorkspaceForWorktreeCreate,
  } = connection.worktreeHooks;
  const {
    readHistory: readAgentMessageHistory,
    readSummary: readAgentSessionSummary,
    readEntry: readAgentHistoryEntry,
    readImage: readAgentHistoryImage,
    readCommands: readAgentCommands,
    readArtifacts: readAgentArtifacts,
    readTasks: readAgentTasks,
    readTask: readAgentTask,
  } = connection.agentSessions;

  if (
    method === "workspace.path" ||
    (method === "workspace.create" && params?.cwd != null && params.cwd !== "")
  ) {
    try {
      const info = await inspectWorkspacePath(
        method === "workspace.path" ? params?.path : params?.cwd,
        { host: sshHost(), remotePlatform: connection.remotePlatform },
        method === "workspace.path",
      );
      if (method === "workspace.path") {
        sendReply({ id, result: info }, method);
        return;
      }
      if (info.error) throw new Error(`${info.error} ${info.path}`);
      if (!requestIsCurrent())
        throw new Error("Creation connection changed. Reconnect and retry.");
      params = { ...params, cwd: info.path };
    } catch (error) {
      sendError(`${method}-error`, error);
      return;
    }
  }

  if (
    (method === "tab.create" || method === "workspace.create") &&
    params &&
    Object.hasOwn(params, "browser_source")
  ) {
    try {
      const result = await terminalBridge.createFromTerminal(
        ws,
        method,
        params,
        requestIsCurrent,
        async () => {
          if (
            method === "workspace.create" &&
            params?.cwd != null &&
            params.cwd !== ""
          ) {
            const info = await inspectWorkspacePath(
              params.cwd,
              { host: sshHost(), remotePlatform: connection.remotePlatform },
              false,
            );
            if (info.error) throw new Error(`${info.error} ${info.path}`);
          }
        },
      );
      sendReply({ id, result }, method);
    } catch (error) {
      sendError(`${method}-error`, error);
    }
    return;
  }

  const herdrBoot = () =>
    herdrBoots.get(connection.identity.id, () =>
      connection.recoveryIdentity(AbortSignal.timeout(3_000)),
    );
  if (method === "agent.list") {
    const agentSince =
      params && "since" in params ? { since: params.since } : null;
    if (agentSince && params) delete params.since;
    try {
      const [list, boot] = await Promise.all([
        connection.remotePlatform === "windows"
          ? herdr.call("agent.list", params ?? {})
          : connection.agentSessions.listWithActivity(params ?? {}),
        herdrBoot(),
      ]);
      const result = agentSeen.annotate(connection.identity.id, list, boot);
      sendReply(
        {
          id,
          result: agentSince
            ? listReply(
                ws,
                connection.identity.id,
                method,
                result,
                agentSince.since,
              )
            : result,
        },
        "agent-list",
      );
    } catch (e) {
      sendError("agent-list-error", e);
    }
    return;
  }
  if (method === "agent_seen.mark") {
    try {
      const result = await markAgentSeen(
        agentSeen,
        herdrBoots,
        connection.identity.id,
        params,
        () => connection.recoveryIdentity(AbortSignal.timeout(3_000)),
      );
      sendReply({ id, result }, method);
    } catch (e) {
      sendError("agent-seen-error", e);
    }
    return;
  }

  if (method === "agent_history.get") {
    try {
      const result = await readAgentMessageHistory(params ?? {});
      // The pane may have moved to another file (/clear, a new session):
      // its watcher follows now instead of at its next re-resolve.
      if (typeof params?.pane_id === "string")
        connection.historyWatcher.notePath(
          params.pane_id,
          historyFilePath(result),
        );
      sendReply({ id, result }, "agent-history-get");
    } catch (e) {
      sendError("agent-history-get-error", e);
    }
    return;
  }
  if (method === "agent_artifacts.get") {
    try {
      sendReply({ id, result: await readAgentArtifacts(params ?? {}) }, method);
    } catch (e) {
      sendError(`${method}-error`, e);
    }
    return;
  }
  if (method === "agent_commands.get") {
    try {
      sendReply({ id, result: await readAgentCommands(params ?? {}) }, method);
    } catch (e) {
      sendError(`${method}-error`, e);
    }
    return;
  }
  if (method === "agent_tasks.get" || method === "agent_task.get") {
    try {
      const result =
        method === "agent_tasks.get"
          ? await readAgentTasks(params ?? {})
          : await readAgentTask(params ?? {});
      sendReply({ id, result }, method);
    } catch (e) {
      sendError(`${method}-error`, e);
    }
    return;
  }
  if (method === "agent_history.entry") {
    try {
      const result = await readAgentHistoryEntry(params ?? {});
      sendReply({ id, result }, "agent-history-entry");
    } catch (e) {
      sendError("agent-history-entry-error", e);
    }
    return;
  }
  if (method === "agent_history.image") {
    try {
      const result = await readAgentHistoryImage(params ?? {});
      sendReply({ id, result }, "agent-history-image");
    } catch (e) {
      sendError("agent-history-image-error", e);
    }
    return;
  }
  if (method === "agent_session.get") {
    try {
      const result = await readAgentSessionSummary(params ?? {});
      sendReply({ id, result }, "agent-session-get");
    } catch (e) {
      sendError("agent-session-get-error", e);
    }
    return;
  }
  if (method === "file.list") {
    try {
      const result = await listWorkspaceFiles(params ?? {});
      sendReply({ id, result }, "file-list");
    } catch (e) {
      sendError("file-list-error", e);
    }
    return;
  }
  if (method === "file.resolve") {
    try {
      const result = await resolveWorkspaceFiles(params ?? {});
      sendReply({ id, result }, "file-resolve");
    } catch (e) {
      sendError("file-resolve-error", e);
    }
    return;
  }
  if (method === "file.mkdir" || method === "file.move") {
    try {
      const result = await (method === "file.mkdir"
        ? createWorkspaceDirectory
        : moveWorkspaceFile)(params ?? {});
      sendReply({ id, result }, method);
    } catch (e) {
      sendError(`${method}-error`, e);
    }
    return;
  }
  if (method === "file.read") {
    try {
      const result = await readWorkspaceFile(params ?? {});
      sendReply({ id, result }, "file-read");
    } catch (e) {
      sendError("file-read-error", e);
    }
    return;
  }
  if (method === "file.search") {
    try {
      const result = await searchWorkspaceFiles(params ?? {});
      sendReply({ id, result }, "file-search");
    } catch (e) {
      sendError("file-search-error", e);
    }
    return;
  }
  if (isAgentChatMethod(method)) {
    try {
      const result = await handleAgentChatRpc(
        connection.conversation,
        connection.historyWatcher,
        ws,
        method,
        params ?? {},
      );
      sendReply({ id, result }, "agent-chat");
    } catch (e) {
      sendError("agent-chat-error", e);
    }
    return;
  }
  if (isReviewMethod(method)) {
    try {
      const result = await handleReviewRpc(
        getReviewService(),
        {
          id: connection.identity.id,
          resolveRoot: async (workspaceId) =>
            (
              await connection.files.resolveWorkspaceGitRoot({
                workspace_id: workspaceId,
              })
            ).root,
          readDefaultBase: (root) => connection.files.readDefaultBase(root),
          readRoot: (path) => connection.files.readReviewRoot(path),
          scanRepos: (paths, agentPaths) =>
            connection.files.scanReviewRepos(paths, agentPaths),
        },
        method,
        params ?? {},
      );
      if (method === "review.open")
        logger.info("review opened", {
          connection: connection.identity.id,
          workspace: String(params?.workspace_id ?? ""),
        });
      sendReply({ id, result }, "review");
    } catch (e) {
      // A removed checkout fails each poll the same way: not a warning each.
      logger[e instanceof ReviewGoneError ? "debug" : "warn"](
        "review request failed",
        {
          method,
          error: e instanceof Error ? e.message : String(e),
        },
      );
      sendError("review-error", e);
    }
    return;
  }
  if (method === "file.reveal") {
    try {
      const result = await revealWorkspaceFile(params ?? {}, ws.remoteAddress);
      sendReply({ id, result }, "file-reveal");
    } catch (e) {
      sendError("file-reveal-error", e);
    }
    return;
  }
  if (method === "git.diff_summary") {
    try {
      const result = await readGitDiffSummary(params ?? {});
      sendReply({ id, result }, "git-diff-summary");
    } catch (e) {
      sendError("git-diff-summary-error", e);
    }
    return;
  }
  if (method === "git.pull_request") {
    try {
      const result = await readWorkspacePullRequest(params ?? {});
      sendReply({ id, result }, "git-pull-request");
    } catch {
      // Root resolution errors may include remote URLs or CLI diagnostics.
      sendError(
        "git-pull-request-error",
        new Error("Cannot resolve this workspace's Git checkout."),
      );
    }
    return;
  }
  if (method === "git.diff_file") {
    try {
      const result = await readGitDiffFile(params ?? {});
      sendReply({ id, result }, "git-diff-file");
    } catch (e) {
      sendError("git-diff-file-error", e);
    }
    return;
  }
  if (
    method === "git.commits" ||
    method === "git.commit" ||
    method === "git.commit_file" ||
    method === "git.commit_preview"
  ) {
    try {
      const result =
        method === "git.commits"
          ? await readGitCommits(params ?? {})
          : method === "git.commit"
            ? await readGitCommit(params ?? {})
            : method === "git.commit_file"
              ? await readGitCommitFile(params ?? {})
              : await readGitCommitPreview(params ?? {});
      sendReply({ id, result }, method);
    } catch (e) {
      sendError(`${method}-error`, e);
    }
    return;
  }
  if (method === "git.pull") {
    try {
      const result = await runGitPull(params ?? {});
      invalidateGitStatus(result.root);
      sendReply({ id, result }, "git-pull");
    } catch (e) {
      sendError("git-pull-error", e);
    }
    return;
  }
  if (method === "git.file_action") {
    try {
      const result = await runWorkspaceGitFileAction(params ?? {});
      invalidateGitStatus(result.root);
      sendReply({ id, result }, "git-file-action");
    } catch (e) {
      sendError("git-file-action-error", e);
    }
    return;
  }
  if (method === "git.repo_action") {
    try {
      const result = await runWorkspaceGitRepoAction(params ?? {});
      invalidateGitStatus(result.root);
      sendReply({ id, result }, "git-repo-action");
    } catch (e) {
      sendError("git-repo-action-error", e);
    }
    return;
  }
  if (method.startsWith("terminal.")) {
    return terminalBridge.handleTerminalRpc(
      ws,
      id,
      method,
      params ?? {},
      requestIsCurrent,
    );
  }
  if (method.startsWith("settings.")) {
    return handleSettingsRpc(ws, id, method, params ?? {}, requestIsCurrent);
  }
  if (method.startsWith("forward.")) {
    if (!handleForwardRpc) {
      markRpcError(ws, id, "port forwarding is unavailable");
      return;
    }
    return handleForwardRpc(ws, id, method, params ?? {}, requestIsCurrent);
  }
  if (method === "worktree.create") {
    try {
      const result = await createWorkspaceWorktree(
        connection,
        params ?? {},
        requestIsCurrent,
        (error) => {
          if (!requestIsCurrent()) return;
          logger.warn("unable to persist worktree parent", {
            connection: connectionId,
            error: sanitizeConnectionError(error),
          });
        },
      );
      await placeCreatedWorkspaceUnder(
        connectionId ?? "",
        (method, callParams) => herdr.call(method, callParams),
        result,
        typeof params?.workspace_id === "string"
          ? params.workspace_id
          : undefined,
      );
      sendReply(
        {
          id,
          result,
        },
        "worktree-create",
      );
    } catch (e) {
      sendError("worktree-create-error", e);
    }
    return;
  }
  if (method === "worktree.open") {
    try {
      const workspaceId = String(params?.workspace_id ?? "");
      const sourceWorkspace = await sourceWorkspaceForWorktreeCreate(
        params ?? {},
      );
      const result = await herdr.call(method, params ?? {});
      await worktreeParents
        .rememberWorktreeParent(result, workspaceId, requestIsCurrent)
        .catch((error) => {
          if (!requestIsCurrent()) return;
          logger.warn("unable to persist opened worktree parent", {
            connection: connectionId,
            error: sanitizeConnectionError(error),
          });
        });
      const openedHook = await runWorktreeOpenedHook(result, sourceWorkspace);
      sendReply(
        {
          id,
          result: { ...result, opened_hook: openedHook },
        },
        "worktree-open",
      );
    } catch (e) {
      sendError("worktree-open-error", e);
    }
    return;
  }
  if (method === "worktree.remove") {
    try {
      const workspaceId = String(params?.workspace_id ?? "");
      const result = await worktreeRemovalCoordinator.run(
        workspaceId,
        async () => {
          const removeHookContext = await worktreeRemoveHookContext(
            params ?? {},
          );
          const checkoutState = removeHookContext
            ? await worktreeRemovalRuntime
                .inspectCheckout(removeHookContext.checkoutPath)
                .catch(() => "unknown" as const)
            : "unknown";
          const beforeRemoveHook =
            removeHookContext && checkoutState !== "missing"
              ? await runWorktreeHook({
                  hook: "teardown",
                  checkoutPath: removeHookContext.checkoutPath,
                  sourceCheckoutPath: removeHookContext.sourceCheckoutPath,
                  repoSettingsKey: removeHookContext.repoSettingsKey,
                })
              : ({
                  event: "worktree.before_remove",
                  status: "skipped",
                } as const);
          if (beforeRemoveHook.status === "failed") {
            markRpcError(
              ws,
              id,
              beforeRemoveHook.error || "before-remove hook failed",
            );
            return {
              ok: false,
              skipped_remove: true,
              before_remove_hook: beforeRemoveHook,
            };
          }

          const removeCommand = removeHookContext
            ? worktreeRemoveCommandFor(
                await readGuiSettings(),
                removeHookContext.repoSettingsKey,
              )
            : undefined;
          const removal = await removeWorktreeWithRecovery({
            call: (name, callParams) =>
              herdr.call(name, callParams, WORKTREE_REMOVE_TIMEOUT_MS),
            params: params ?? {},
            checkoutPath: removeHookContext?.checkoutPath,
            runtime: worktreeRemovalRuntime,
            // The command removes the checkout (git recworktree also its
            // nested ones); Herdr then only closes the workspace, as its own
            // removal would. Not installed on this host: Herdr removes it.
            removeWithCommand:
              removeCommand && removeHookContext
                ? async () => {
                    const force = params?.force === true;
                    const fallback = await runWorktreeRemoveCommand({
                      template: removeCommand,
                      checkoutPath: removeHookContext.checkoutPath,
                      sourceCheckoutPath: removeHookContext.sourceCheckoutPath,
                      force,
                      host: sshHost(),
                      runProcess: runProcessWithCodeTimeout,
                    });
                    if (fallback)
                      return {
                        fallback: `${fallback} Herdr removed the worktree.`,
                      };
                    await herdr.call("workspace.close", {
                      workspace_id: workspaceId,
                    });
                    return {
                      result: {
                        forced: force,
                        path: removeHookContext.checkoutPath,
                        type: "worktree_removed",
                        workspace_id: workspaceId,
                      },
                    };
                  }
                : undefined,
          });
          if (removal.cleanup?.preserved_path) {
            logger.warn("preserved stale worktree files", {
              connection: connectionId,
              path: removal.cleanup.preserved_path,
            });
          }
          if (removeHookContext?.checkoutPath) {
            await worktreeParents
              .forgetWorktree(removeHookContext.checkoutPath, requestIsCurrent)
              .catch((error) => {
                if (!requestIsCurrent()) return;
                logger.warn("unable to remove worktree parent", {
                  connection: connectionId,
                  error: sanitizeConnectionError(error),
                });
              });
          }
          const removedHook = await runWorktreeRemovedHook(removeHookContext);
          return {
            ...removal.result,
            ...(removal.cleanup ? { cleanup: removal.cleanup } : {}),
            ...(removal.commandFallback
              ? { command_fallback: removal.commandFallback }
              : {}),
            before_remove_hook: beforeRemoveHook,
            removed_hook: removedHook,
          };
        },
      );
      sendReply({ id, result }, "worktree-remove");
    } catch (e) {
      sendError("worktree-remove-error", e);
    }
    return;
  }
  const isPaneInput = PANE_INPUT_METHODS.has(method);
  let inputTerminalId: string | undefined;
  if (isPaneInput && typeof params?.pane_id === "string") {
    // While Claude exits for conversation mode (or the holder resumes it),
    // text would land in the dying TUI or the bare shell.
    const refusal = connection.conversation.inputRefusal(params.pane_id);
    if (refusal) {
      sendError("pane-input-refused", new Error(refusal));
      return;
    }
    // Resolve the recipient before input can produce a clipboard write.
    try {
      const pane = await herdr.call(
        "pane.get",
        { pane_id: params.pane_id },
        2000,
      );
      if (typeof pane?.pane?.terminal_id === "string")
        inputTerminalId = pane.pane.terminal_id;
    } catch {
      // A failed lookup must not prevent input.
    }
  }
  // A page holding a topology list sends its stamp; Herdr never sees it.
  const listSince =
    params && LIST_DELTA_SHAPES[method] && "since" in params
      ? { since: params.since }
      : null;
  if (listSince && params) delete params.since;
  try {
    if (method === "tab.rename" && typeof params?.tab_id === "string") {
      connection.tabAutoRenamer?.markManualRename(
        params.tab_id,
        typeof params.label === "string" ? params.label : undefined,
      );
    }
    // Panes conversation mode holds are Claude panes still; Herdr sees
    // only their holder, and answers agent.get on one with not found.
    let result = (await withOwnedSessions(
      (...args) => herdr.call(...args),
      () => connection.conversation.ownedPanes(),
    )(method, params ?? {}, undefined, () => {
      if (isPaneInput && !requestIsCurrent())
        throw new Error(CONNECTION_CHANGED_DURING_REQUEST);
      if (inputTerminalId)
        terminalBridge.noteTerminalInput(ws, inputTerminalId);
    })) as Awaited<ReturnType<typeof herdr.call>>;
    // The conversations stopped as shell jobs (Ctrl+Z), on their panes.
    result = overlaySuspendedPanes(
      method,
      result,
      connection.conversation.suspendedPanes(),
    ) as Awaited<ReturnType<typeof herdr.call>>;
    if (
      method === "integration.list" &&
      connection.remotePlatform !== "windows"
    ) {
      result = await enrichIntegrationVersions(result, {
        sshHost: sshHost(),
        ping: () => herdr.ping(),
      });
    }
    if (method === "workspace.list") {
      if (connection.remotePlatform !== "windows") {
        result = await worktreeParents.enrichWorkspaceList(result);
        result = await enrichWorkspacesWithGitStatus(result);
      }
      result = {
        ...result,
        navigation_mode: await terminalBridge.navigationMode(),
        tab_move_supported: await terminalBridge.tabMoveSupported(),
        endpoint_availability: terminalBridge.endpointAvailability(),
      };
    }
    if (listSince) {
      sendReply(
        {
          id,
          result: listReply(
            ws,
            connection.identity.id,
            method,
            result,
            listSince.since,
          ),
        },
        method,
      );
      return;
    }
    sendReply({ id, result }, method);
  } catch (e) {
    sendError(`${method}-error`, e);
  }
}

async function handleConnectionHttpRequest(
  route: ParsedConnectionHttpRoute,
  url: URL,
  req: Request,
): Promise<Response> {
  if (route.kind === "error") {
    return connectionRoutingErrorResponse(route.error);
  }

  let resolved: ReturnType<
    typeof resolveConnectionHttpRoute<LegacyConnectionRuntime>
  >;
  const generationText = url.searchParams.get("connection_generation");
  const requestedGeneration =
    generationText === null
      ? undefined
      : /^(0|[1-9]\d*)$/.test(generationText)
        ? Number(generationText)
        : generationText;
  try {
    resolved = resolveConnectionHttpRoute({
      route,
      requestedGeneration,
      registry: connectionManager,
      legacyLogger: legacyRoutingLogger,
    });
  } catch (error) {
    if (error instanceof ConnectionRoutingError) {
      return connectionRoutingErrorResponse(error);
    }
    return Response.json(
      { error: "connection routing failed" },
      { status: 500 },
    );
  }

  const { runtime: connection, endpoint } = resolved;
  if (connection.remotePlatform === "windows" && endpoint !== "herdr-info") {
    return publishConnectionHttpResponse(
      resolved,
      Response.json(
        {
          error:
            "Remote file transfers and agent history require a Unix SSH host.",
        },
        { status: 501 },
      ),
    );
  }
  try {
    let response: Response;
    if (endpoint === "herdr-info") {
      response = await connection.handleHerdrInfo();
    } else if (endpoint === "upload-image") {
      response = await connection.handleImageUpload(req);
    } else if (endpoint === "terminal-upload") {
      response = await connection.handleTerminalUpload(
        req,
        url.searchParams.get("filename"),
      );
    } else if (endpoint === "agent-session-download") {
      response = await connection.agentSessions.downloadFile({
        pane_id: url.searchParams.get("pane_id"),
        agent: url.searchParams.get("agent"),
      });
    } else if (endpoint === "agent-session-atif") {
      response = await connection.agentSessions.downloadAtif({
        pane_id: url.searchParams.get("pane_id"),
        agent: url.searchParams.get("agent"),
      });
    } else if (endpoint === "file-download") {
      try {
        response = await connection.files.downloadWorkspaceFile({
          workspace_id: url.searchParams.get("workspace_id"),
          path: url.searchParams.get("path"),
          scope: url.searchParams.get("scope"),
          inline: url.searchParams.get("inline") === "1",
          range: req.headers.get("range") ?? undefined,
          if_range: req.headers.get("if-range") ?? undefined,
        });
      } catch (error) {
        response = new Response((error as Error).message, { status: 400 });
      }
    } else if (endpoint === "file-upload") {
      try {
        const result = await connection.files.uploadWorkspaceFile(
          {
            workspace_id: url.searchParams.get("workspace_id"),
            directory: url.searchParams.get("directory"),
            filename: url.searchParams.get("filename"),
          },
          req,
        );
        response = Response.json(result);
      } catch (error) {
        response = Response.json(
          { error: (error as Error).message },
          { status: 400 },
        );
      }
    } else {
      try {
        const result = await connection.files.deleteWorkspaceFile({
          workspace_id: url.searchParams.get("workspace_id"),
          path: url.searchParams.get("path"),
        });
        response = Response.json(result);
      } catch (error) {
        response = Response.json(
          { error: (error as Error).message },
          { status: 400 },
        );
      }
    }
    return publishConnectionHttpResponse(resolved, response);
  } catch (error) {
    return publishConnectionHttpResponse(
      resolved,
      Response.json({ error: (error as Error).message }, { status: 500 }),
    );
  }
}

function main() {
  const server = bindListenerBeforeConnectionStart({
    bindListener: () =>
      Bun.serve<{ sessionToken: string | null; voice?: true }>({
        port: config.port,
        hostname: config.host,
        tls: config.tls,
        maxRequestBodySize: terminalUploadRequestBodyLimit(),
        async fetch(req, server) {
          const requestPathname = rawRequestPathname(req.url);
          let url: URL;
          try {
            url = new URL(req.url);
          } catch {
            return new Response("invalid request URL", { status: 400 });
          }

          // Forwarded headers are untrusted; use the actual TCP peer address.
          const clientIp = server.requestIP(req)?.address ?? "unknown";
          const tokenLoginResponse = handleTokenLogin(req, clientIp);
          if (tokenLoginResponse) return tokenLoginResponse;

          if (url.pathname === "/health" || url.pathname === "/healthz") {
            return new Response("Ok", {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }

          // Auth endpoints are always reachable.
          if (url.pathname === "/api/login/pin" && req.method === "POST") {
            return handlePinLogin(req, clientIp);
          }
          if (url.pathname === "/api/login" && req.method === "POST") {
            return handleLogin(req, clientIp);
          }
          if (url.pathname === "/login") {
            return loginPage(req);
          }
          // The login page's logo and favicon must also work before login.
          if (url.pathname === "/roamgate-icon-192.png") {
            return serveStatic(req, config.publicDir);
          }
          if (url.pathname === "/api/logout") {
            const response = handleLogout(req);
            const token = sessionToken(req);
            if (response.ok && config.authRequired && token) {
              for (const client of clients) {
                if (clientSessions.get(client) !== token) continue;
                webSocketCleanup.cleanup(client);
                client.close(4001, "Logged out");
              }
            }
            return response;
          }

          // Authentication is bypassed only for development loopback listeners.
          if (!isAuthed(req)) {
            const accept = req.headers.get("accept") ?? "";
            if (req.method === "GET" && accept.includes("text/html")) {
              return unauthenticatedLoginRedirect();
            }
            return new Response("unauthorized", { status: 401 });
          }

          if (url.pathname === "/ws") {
            if (
              server.upgrade(req, { data: { sessionToken: sessionToken(req) } })
            )
              return undefined;
            return new Response("websocket upgrade failed", { status: 400 });
          }
          if (url.pathname === "/api/notifications/push") {
            return webPush.handle(req);
          }
          if (url.pathname === "/api/instance-settings") {
            return handleInstanceSettings(req);
          }
          if (url.pathname === "/api/health") {
            return Response.json({
              ok: true,
              version: APP_VERSION,
              socket: config.socketPath,
              auth_required: config.authRequired,
            });
          }
          if (url.pathname === "/api/update/check" && req.method === "GET") {
            server.timeout(req, UPDATE_HTTP_IDLE_TIMEOUT_SECONDS);
            return handleUpdateCheck(req);
          }
          if (url.pathname === "/api/update/install" && req.method === "POST") {
            // Binary download and verification can exceed Bun's default ten-second
            // request timeout. Keep the larger budget scoped to update requests.
            server.timeout(req, UPDATE_HTTP_IDLE_TIMEOUT_SECONDS);
            return handleUpdateInstall(req);
          }
          if (url.pathname === "/api/review/image" && req.method === "GET") {
            return serveReviewImage(url);
          }
          if (url.pathname === "/api/herdr/status" && req.method === "GET") {
            return handleHerdrStatus();
          }
          if (url.pathname === "/api/herdr/setup" && req.method === "POST") {
            // Herdr download plus service start shares the update budget.
            server.timeout(req, UPDATE_HTTP_IDLE_TIMEOUT_SECONDS);
            return handleHerdrSetup(req);
          }
          if (url.pathname === "/api/voice/ws") {
            if (
              server.upgrade(req, {
                data: { sessionToken: sessionToken(req), voice: true },
              })
            )
              return undefined;
            return new Response("websocket upgrade failed", { status: 400 });
          }
          if (url.pathname.startsWith("/api/voice")) {
            // Transcribing a long recording can outlast the default timeout.
            server.timeout(req, VOICE_HTTP_IDLE_TIMEOUT_SECONDS);
            const response = await handleVoice(req, url.pathname);
            if (response) return response;
          }
          const connectionRoute = parseConnectionHttpRoute(
            requestPathname,
            req.method,
          );
          if (connectionRoute) {
            if (
              connectionRoute.kind === "connection" &&
              connectionRoute.endpoint === "terminal-upload"
            ) {
              server.timeout(req, TERMINAL_UPLOAD_TIMEOUT_MS / 1000);
            }
            if (
              connectionRoute.kind === "connection" &&
              connectionRoute.endpoint === "file-download" &&
              url.searchParams.get("inline") === "1" &&
              isHtmlPath(url.searchParams.get("path") ?? "")
            ) {
              // HTML preparation can require several bounded SSH resource reads.
              server.timeout(req, DOWNLOAD_TIMEOUT_MS / 1000);
            }
            return handleConnectionHttpRequest(connectionRoute, url, req);
          }
          // Everything else: serve the built frontend (embedded or on-disk).
          return serveStatic(
            req,
            config.publicDir,
            (await readGuiSettings()).title_suffix,
          );
        },
        websocket: {
          perMessageDeflate: WS_PER_MESSAGE_DEFLATE,
          // Bun drops sends past its own limit; the slow-socket policy in
          // websocket-send decides when a socket is too far behind.
          backpressureLimit: WS_BACKPRESSURE_HARD_LIMIT_BYTES,
          open(ws) {
            // A voice socket is no Herdr client: see voiceSocket.
            if (ws.data.voice) {
              voiceSocketsOpen += 1;
              lastVoiceAt = Date.now();
              return;
            }
            clients.add(ws);
            clientSessions.set(ws, ws.data.sessionToken);
            const label = assignClientId(ws);
            logger.debug("client connected", {
              client: label,
              clients: clients.size,
            });
            notifyBrowserClientCount();
            safeSend(
              ws,
              JSON.stringify({
                hello: true,
                socket: config.socketPath,
                bridge_protocol_version: 2,
                default_connection_id: connectionManager.defaultId(),
                capabilities: {
                  connection_id: true,
                  connection_scoped_http: true,
                  file_reveal: canRevealFiles(ws.remoteAddress),
                  connection_runtime_generation: true,
                  embedded_assistant: true,
                  flow_control: true,
                  list_delta: true,
                  herdr_task_notifications:
                    config.taskNotificationSource === "herdr",
                },
              }),
              "hello",
            );
            // The registry is global and must arrive before any Herdr catalog
            // or runtime lease is available, including with an offline default.
            safeSend(
              ws,
              JSON.stringify({
                forwards: sshForwards.list().map(forwardToWire),
              }),
              "forwards",
            );
          },
          drain(ws) {
            if (ws.data.voice) return;
            // The viewer caught up: send the newest repaint we held back.
            flushCoalescedMessages(ws, {
              cleanup: () => {
                webSocketCleanup.cleanup(ws);
              },
              warn: (detail) =>
                logger.warn("websocket send failed", {
                  detail: detail.replace(/^\[bridge\] /, ""),
                }),
            });
          },
          message(ws, message) {
            if (ws.data.voice) {
              lastVoiceAt = Date.now();
              return voiceSocket.message(ws, message);
            }
            if (!clients.has(ws)) return;
            const text =
              typeof message === "string" ? message : message.toString();
            if (
              receiveWebSocketAck(ws, text, {
                cleanup: () => {
                  webSocketCleanup.cleanup(ws);
                },
                warn: (detail) =>
                  logger.warn("websocket send failed", {
                    detail: detail.replace(/^\[bridge\] /, ""),
                  }),
              })
            )
              return;
            const { id, method, connectionId, connectionGeneration, lane } =
              parseRpcMeta(text);
            const startedAt = Date.now();
            let responseConnectionId: string | null = null;
            let logConnectionId: string | null = null;
            if (method && !isBridgeGlobalMethod(method)) {
              if (connectionId === undefined) {
                responseConnectionId = connectionManager.defaultId();
                logConnectionId = responseConnectionId;
              } else {
                try {
                  responseConnectionId = validateConnectionId(connectionId);
                  logConnectionId = responseConnectionId;
                } catch {
                  logConnectionId = "invalid";
                }
              }
            }
            runInSshLane(lane, () => handleRpc(ws, text))
              .then(() => {
                const outcome = takeRpcOutcome(ws, id);
                logRpc(
                  ws,
                  method,
                  startedAt,
                  outcome?.status ?? "ok",
                  logConnectionId,
                  outcome?.detail,
                  takeRpcReplyChars(ws, id),
                );
              })
              .catch((e) => {
                logRpc(
                  ws,
                  method,
                  startedAt,
                  "error",
                  logConnectionId,
                  (e as Error).message,
                  takeRpcReplyChars(ws, id),
                );
                const errorMessage: Record<string, unknown> = {
                  error: { message: (e as Error).message },
                };
                if (id) errorMessage.id = id;
                safeSend(
                  ws,
                  responseConnectionId
                    ? serializeConnectionEnvelope(
                        responseConnectionId,
                        errorMessage,
                        typeof connectionGeneration === "number"
                          ? connectionGeneration
                          : undefined,
                      )
                    : JSON.stringify(errorMessage),
                  "message-error",
                );
              });
          },
          close(ws) {
            if (ws.data.voice) {
              voiceSocketsOpen = Math.max(0, voiceSocketsOpen - 1);
              lastVoiceAt = Date.now();
              return voiceSocket.close(ws);
            }
            const { client, viewedTerminals } = webSocketCleanup.complete(ws);
            const flow = webSocketFlowStats(ws);
            logger.debug("client disconnected", {
              client,
              clients: clients.size,
              sent: flow.sent,
              unacked: flow.enabled ? flow.sent - flow.acked : "n/a",
              queued: flow.queued,
              rate: flow.rate,
              heaviest: flow.heaviest,
              last_ack_ms: flow.lastAckAgeMs ?? undefined,
              terminals: viewedTerminals.length
                ? viewedTerminals.join(",")
                : "none",
            });
          },
        },
      }),
    startConnection: async () => {
      await connectionProfiles.startConfigured();
      // Resume saved work even when no browser has opened Ranger yet.
      await getAssistantService();
      resumeAssistantIfLoaded();
      notifyBrowserClientCount();
      const runtime = connectionManager.defaultReadyRuntime();
      void runtime?.herdr
        .ping()
        .then((ping) =>
          logger.info("Herdr reachable", {
            connection: runtime.identity.id,
            version: ping.version,
            protocol: ping.protocol,
          }),
        )
        .catch((error) =>
          logger.warn("Herdr not reachable yet", {
            connection: runtime.identity.id,
            error: sanitizeConnectionError(error),
            action: "run `roamgate herdr setup`; RPCs retry per request",
          }),
        );
    },
    onConnectionError: (error) => {
      logger.warn("default connection startup failed", {
        error: sanitizeConnectionError(error),
      });
    },
  });
  const listeningPort = server.port ?? config.port;
  forwardReservedListeningPort = listeningPort;
  const publicBrowserUrl = browserUrlFor(
    config.host,
    listeningPort,
    Boolean(config.tls),
  );
  logger.info("listening", {
    url: publicBrowserUrl,
    websocket: "/ws",
    log_level: config.logLevel,
  });
  if (config.authRequired) {
    if (config.generatedAuthTokenPath) {
      logger.info("authentication required", {
        mode: "generated token",
        path: config.generatedAuthTokenPath,
      });
    } else {
      logger.info("authentication required", { mode: "password" });
    }
  }
  logger.debug("Herdr sockets configured", {
    control_socket: config.socketPath,
    client_socket: config.clientSocketPath,
    public_dir: config.publicDir,
  });
  logger.info("browser URL", { url: publicBrowserUrl });
  void removeLeftoverDataTemporaries()
    .then((removed) => {
      if (removed > 0)
        logger.info("removed leftover temporary data files", {
          count: removed,
        });
    })
    .catch((error) =>
      logger.warn("leftover temporary data files not removed", {
        error: sanitizeConnectionError(error),
      }),
    );

  const browserUrl = withLoginToken(
    publicBrowserUrl,
    config.generatedAuthToken,
  );
  if (isAnyHost(config.host)) {
    const lanUrls = getLanIPs().map((ip) =>
      browserUrlFor(ip, listeningPort, Boolean(config.tls)),
    );
    if (lanUrls.length > 0) {
      for (const url of lanUrls) logger.info("LAN URL", { url });
    } else {
      logger.warn("no LAN IPv4 address detected");
    }
  }
  if (process.platform !== "win32") {
    try {
      getReviewAgent().installLocal();
      reviewAgentInstalled = true;
    } catch (error) {
      logger.warn("review agent unavailable", {
        error: sanitizeConnectionError(error),
      });
    }
  }
  openBrowser(config, browserUrl);
}

let managerStopTask: Promise<void> | null = null;
function stopManagerOnce(): Promise<void> {
  // Seen marks are written in batches: keep the last ones.
  agentSeen.flush();
  webPush.stop();
  stopNetworkWatch();
  connectionProfiles.stopSupervision();
  managerStopTask ??= (async () => {
    // Pause the harness before taking away the runtimes its reads depend on.
    await assistantServiceTask
      ?.then((assistant) => assistant.dispose())
      .catch(() => undefined);
    await Promise.all([connectionManager.stopAll(), cpuProfile?.stop()]);
    reviewAgent?.stop();
    reviewService?.close();
  })();
  return managerStopTask;
}

const shutdownController = createShutdownController({
  stop: stopManagerOnce,
  exit: (code) => process.exit(code),
  onStopError: (error) => {
    logger.error("connection shutdown failed", {
      error: sanitizeConnectionError(error),
    });
  },
});

function scheduleManagedShutdown(): void {
  const timer = setTimeout(() => {
    void shutdownController.request(0);
  }, 1_000);
  timer.unref();
}

process.on("exit", () => {
  voiceHelper.stop();
  void stopManagerOnce();
});
process.on("SIGINT", () => {
  void shutdownController.request(130);
});
process.on("SIGTERM", () => {
  void shutdownController.request(143);
});

try {
  main();
} catch (e) {
  logger.error("fatal startup error", { error: e });
  void shutdownController.request(1);
}
