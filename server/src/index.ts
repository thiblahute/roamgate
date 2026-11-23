// First: with ROAMGATE_TEST_CLOCK set, every module must see the test clock.
import "./utils/test-clock-env";
import { rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import packageJson from "../../package.json";
import { agentAddress } from "../../shared/agentMessage";
import type { AssistantTaskNotification } from "../../shared/assistant";
import { isHtmlPath } from "../../shared/filePreview";
import {
  LIMIT_PAUSES_EVENT,
  type LimitPause,
  parseLimitPauses,
} from "../../shared/limitResume";
import type { MrItem } from "../../shared/mrReviews";
import {
  RANGER_THREAD_AUTHOR,
  RANGER_THREAD_TOOL,
  rangerChatKey,
  rangerChatSession,
} from "../../shared/rangerChat";
import { parseStorageWrite, RENDERED_PREFIX } from "../../shared/renderedPage";
import {
  type AgentPermissionPrompt,
  type AgentPromptAnswer,
  EFFORT_SESSION_PREFIX,
  type ReviewAnchor,
  type ReviewPush,
  type ReviewSession,
  type ReviewSnapshot,
  type ReviewTarget,
  type ReviewThread,
  WORK_SESSION_PREFIX,
} from "../../shared/review";
import { diffState } from "../../shared/stateDelta";
import type { WorkItem } from "../../shared/work";
import {
  parseWorkspaceTreeOp,
  WorkspaceTreeError,
  type WorkspaceTreeOp,
  workspaceRefFor,
} from "../../shared/workspaceTree";
import { createActivityFront } from "./activity/front";
import { openActivityReader } from "./activity/reader";
import { createActivityRecorder } from "./activity/recorder";
import { subjectsFromSettings } from "./activity/subject-settings";
import { isDate } from "./activity/timeline";
import { readActivityTimeline } from "./activity/timeline-rpc";
import {
  type AgentMessenger,
  createAgentMessenger,
} from "./agent/agent-messenger";
import {
  createAgentSeenStore,
  createHerdrBootCache,
  markAgentSeen,
} from "./agent/agent-seen";
import {
  overlaySuspendedPanes,
  withOwnedSessions,
} from "./agent/agent-sessions";
import {
  type ClaudeModChange,
  type ClaudeModTypeResult,
  createClaudeModHub,
} from "./agent/claude-mod";
import {
  type ClaudeModMirror,
  createClaudeModFront,
} from "./agent/claude-mod-front";
import {
  type ClaudeModInstallState,
  claudeModHostScript,
  claudeModStateOf,
  parseClaudeModHostOutput,
} from "./agent/claude-mod-plugin";
import {
  createRemoteStatSpawner,
  historyFilePath,
  type WatchHandle,
} from "./agent/history-watch";
import { useArchivedSessionFiles } from "./agent/session-file-access";
import { SessionImageGoneError } from "./agent/session-images";
import { defaultSessionIndexDir } from "./agent/session-index-store";
import { resolveArchiveDir } from "./archive/dir";
import { createArchivedSessionReader } from "./archive/file-access";
import { createArchiveRpc } from "./archive/rpc";
import { NoTextRepo, searchArchive } from "./archive/search";
import { normalizeArchiveSettings } from "./archive/settings";
import { createArchiveToolHandler } from "./assistant/archive-tools";
import { createAssistantContext } from "./assistant/context";
import { AssistantUserError } from "./assistant/errors";
import {
  createWorkspaceTreeToolHandler,
  readWorkspaceTreeConnections,
} from "./assistant/workspace-tree-tools";
import { HerdrClient } from "./bridge/herdr-client";
import { createListDeltas, LIST_DELTA_SHAPES } from "./bridge/list-delta";
import { createUiSettingsRpcHandler } from "./bridge/settings-rpc";
import { sshCommandArgv, sshReadCommandArgv } from "./bridge/ssh-command";
import {
  createSshForwards,
  forwardToWire,
  roamgateOwnPorts,
} from "./bridge/ssh-forward";
import { sweepOrphanedSshMasters } from "./bridge/ssh-master";
import { annotateSshArgv } from "./bridge/ssh-metrics";
import {
  currentSshLane,
  runInSshLane,
  type SshLane,
  setSshCommandFacade,
  sshMasterControlPath,
} from "./bridge/ssh-sessions";
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
import { cliCommands, runCli, topLevelHelp } from "./cli";
import { CONTINUE_TO_SERVER, defaultCliContext } from "./cli/command";
import {
  authTokenPrintCommand,
  isShortAuthPassword,
  RECOMMENDED_PASSWORD_LENGTH,
} from "./config/auth-token";
import { dataRoot, removeLeftoverDataTemporaries } from "./config/data-paths";
import {
  activitySettings,
  applyRemoteGuiSettings,
  claudeStartMode,
  conversationIdleStopMinutes,
  type GuiSettings,
  type GuiSettingsRemote,
  limitResumeSettings,
  onGuiSettingsChanged,
  readGuiSettings,
  setGuiSettingsRemote,
  updateGuiSettings,
  worktreeRemoveCommandFor,
} from "./config/gui-settings";
import { openRevokedSessions } from "./config/revoked-sessions";
import {
  browserUrlFor,
  getLanIPs,
  isAnyHost,
  loadServerConfig,
  openBrowser,
  withLoginToken,
} from "./config/server-config";
import {
  loadOrCreateSessionSecret,
  revokedSessionsPath,
} from "./config/session-secret";
import { isStandaloneBinary } from "./config/standalone";
import {
  agentGroupPaths,
  agentGroupPlacementOps,
  applyWorkspaceTreeOps,
  createWorkspaceTreePruner,
  listWorkspaceIdentities,
  notifyWorkspaceTreeChanged,
  onWorkspaceTreeChanged,
  placeCreatedWorkspace,
  readWorkspaceTree,
  setWorkspaceTreeCore,
} from "./config/workspace-tree";
import { readConnectionAgentSessions } from "./connections/agent-sessions";
import { readConnectionAgentTasks } from "./connections/agent-tasks";
import {
  type HostEvent,
  type HostStatusPush,
  RemoteConnections,
  RemoteHerdrClient,
  SwitchingConnectionManager,
  sshCommandFacade,
} from "./connections/host-facade";
import {
  connectionRoutingErrorResponse,
  type ParsedConnectionHttpRoute,
  parseConnectionHttpRoute,
  publishConnectionHttpResponse,
  publishLocalFileResponse,
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
  type ConnectionProfileBootstrap,
  ConnectionProfileService,
  connectionIdentityForProfile,
  loadConnectionProfileBootstrap,
  type SyntheticLocalProfile,
  testConnectionSockets,
} from "./connections/profile-service";
import {
  type ConnectionProfile,
  ConnectionProfileStore,
  connectionRecoveryFingerprint,
} from "./connections/profiles";
import {
  CONNECTION_CHANGED_DURING_REQUEST,
  ConnectionRoutingError,
  createConnectionReplyPublisher,
  createLegacyRoutingLogger,
  isBridgeGlobalMethod,
  resolveReadyConnection,
  serializeConnectionEnvelope,
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
import { sshRefusal } from "./connections/ssh-guard";
import { createSshProfileRuntimeConfig } from "./connections/ssh-profile-runtime";
import { bindListenerBeforeConnectionStart } from "./connections/startup";
import type { ConnectionIdentity, ConnectionStatus } from "./connections/types";
import { LEGACY_DEFAULT_CONNECTION_ID } from "./connections/types";
import {
  UnsupportedPlatformError,
  unixOnlyMessage,
} from "./connections/unix-only";
import {
  recordCli,
  recordFetch,
  recordServe,
  recordSpawns,
  recordWebSocket,
} from "./contract-record/hooks";
import { contractRecorder } from "./contract-record/recorder";
import {
  claudeStartHookInstallArgv,
  claudeStartHookInstallCommand,
} from "./conversation/claude-start-hook";
import {
  type ConversationMirror,
  emptyConversationMirror,
} from "./conversation/core-front";
import {
  defaultLeaseFile,
  flushLeaseFiles,
  forgetLeaseFiles,
} from "./conversation/lease";
import { parseHolderStatus } from "./conversation/pane-child";
import { promptPaneAgent } from "./conversation/prompt-pane";
import {
  AGENT_CHAT_METHODS,
  handleAgentChatRpc,
  isAgentChatMethod,
} from "./conversation/rpc";
import { parseHolderShell, parseSuspendedSpec } from "./conversation/suspended";
import {
  bunOwns,
  type CallContext,
  type CoreFront,
  coreConfigured,
  onOwnershipChanged,
  type PushMessage,
  sessionIdOf,
  socketIdOf,
  startCoreFront,
} from "./core-channel";
import { ChannelError } from "./core-channel/channel";
import { readOwners } from "./core-channel/owners";
import { FAMILIES, httpFamilyOf } from "./core-channel/protocol";
import { coreChannelOf, startSidecar } from "./core-channel/sidecar";
import { enrichIntegrationVersions } from "./herdr/integration-versions";
import { historyPaths, type ReviewSource } from "./history/area";
import { stableJson } from "./history/format";
import {
  historyChanged,
  historyWorkChanged,
  type WorkChange,
} from "./history/hooks";
import { expandLocation, historyAreas, historyPlace } from "./history/place";
import { withHistoryHooks } from "./history/reviews";
import { HistoryRuntime } from "./history/runtime";
import { createAuthHandlers, unauthenticatedLoginRedirect } from "./http/auth";
import {
  CALL_HANDOFF_PATH,
  createCallHandoffRedeem,
} from "./http/call-handoff";
import {
  createHerdrSetupHandlers,
  herdrSetupGuardForProfile,
} from "./http/herdr-setup";
import { createHistoryRoute } from "./http/history";
import { handleInstanceSettings } from "./http/instance-settings";
import { publicOrigin } from "./http/public-origin";
import {
  connectionFileReader,
  connectionRootFinder,
  createRenderedPages,
  RENDERED_BODY_MAX_BYTES,
  renderedAddress,
  renderedStray,
  renderedSvgPage,
} from "./http/rendered-pages";
import {
  createSiteStorage,
  renderedStoragePath,
} from "./http/rendered-storage";
import { serveStatic } from "./http/static-files";
import {
  TERMINAL_UPLOAD_TIMEOUT_MS,
  terminalUploadRequestBodyLimit,
} from "./http/terminal-upload";
import {
  createUpdateHandlers,
  UPDATE_HTTP_IDLE_TIMEOUT_SECONDS,
} from "./http/update";
import { createVoiceRoutes, withSearches } from "./http/voice";
import { createVoiceLowGpuRoute } from "./http/voice-low-gpu";
import { createVoiceSetupRoute } from "./http/voice-setup";
import { createVoiceSocket } from "./http/voice-socket";
import {
  createLimitResumer,
  type LimitResumer,
} from "./limit-resume/scheduler";
import { createLimitResumeStore, limitResumeStore } from "./limit-resume/store";
import { mrCachePush } from "./mr-cache/push";
import {
  mrCacheLoad,
  mrCacheRelease,
  onMrCacheChange,
  setMrCacheCore,
  sharedMrCache,
} from "./mr-cache/shared";
import { type MrConnection, orderConnections } from "./mr-reviews/clones";
import {
  type CoreAgentTurn,
  createCoreAgentTurns,
} from "./mr-reviews/core-agent";
import { runClaudeModel } from "./mr-reviews/curation";
import {
  createInboxFetchers,
  type FetchCall,
  ForgeToolMissingError,
  NotSignedInError,
} from "./mr-reviews/fetchers";
import { defaultProfileInferenceModels } from "./mr-reviews/inference";
import { createMrReviews, type MrReviews } from "./mr-reviews/module";
import { isMrReviewsMethod } from "./mr-reviews/rpc";
import { createNotificationFeed } from "./notifications/notification-feed";
import { createWebPushService } from "./notifications/web-push";
import { profileModels } from "./profiles/models";
import {
  commandForSession,
  type LaunchSpec,
  launchRegistry,
  profileForSession,
  profilesOf,
  sessionProfiles,
} from "./profiles/profiles";
import { PROFILE_RPC_METHODS, returnAfterReset } from "./profiles/rpc";
import { setupRemoteReviewAgent as setupRemoteReviewClient } from "./review/agent-remote";
import {
  createReviewAgentServer,
  LOCAL_SOCKET_KEY,
  REVIEW_HOME_DIR,
  type ReviewAgentServer,
} from "./review/agent-server";
import { createForgeCache, parseForgeRefParam } from "./review/forge";
import {
  createDraftNote,
  createDraftReply,
  deleteDraftNote,
  draftReply,
  draftThread,
  findBranchMergeRequest,
  type GlabContext,
  type MergeRequestInfo,
  readCheckout,
  readCommitDiff,
  readMergeRequest,
  readMergeRequestCommits,
  readMergeRequestDiff,
  readMergeRequestThreads,
  readRawFile,
  updateDraftNote,
} from "./review/gitlab";
import {
  localImageFile,
  pruneReviewImages,
  reviewImageFile,
  saveReviewImage,
} from "./review/images";
import {
  handleReviewRpc,
  isReviewMethod,
  type ReviewRpcConnection,
} from "./review/rpc";
import {
  createReviewService,
  ReviewError,
  type ReviewService,
} from "./review/service";
import { openReviewStorage, reviewDirectory } from "./review/storage";
import { createTimeReport, dayInput, TimeReportError } from "./time-report/rpc";
import { herdrEventName } from "./utils/herdr-events";
import {
  configureServerLogger,
  createRecoveryReporter,
  type RecoveryReporter,
  serverLogger,
} from "./utils/logger";
import { watchLoopStalls } from "./utils/loop-stall";
import { runProcessWithCodeTimeout, shQuote } from "./utils/process-utils";
import { rpcLogLevel } from "./utils/rpc-logging";
import { activeTestClock, realTimers } from "./utils/test-clock";
import { turnCauses } from "./voice/turn-causes";
import { configuredCleaner } from "./voice/voice-cleaner";
import { configuredDictation } from "./voice/voice-dictation";
import { type ErrandEntry, VoiceErrands } from "./voice/voice-errands";
import { configuredFront } from "./voice/voice-front";
import { detectHardware, systemProbe } from "./voice/voice-hardware";
import {
  callBackground,
  frontMode,
  readVoiceConfig,
  VoiceHelper,
  voiceConfigPath,
  writeFrontMode,
} from "./voice/voice-helper";
import { VoiceLibrary } from "./voice/voice-library";
import { gameModeActive, lowGpuPath, VoiceLowGpu } from "./voice/voice-low-gpu";
import {
  CompanionMemory,
  companionMemoryPath,
  frontCompaction,
} from "./voice/voice-memory";
import { CompanionMemoryFiles } from "./voice/voice-memory-files";
import { defaultHelperPath, defaultModelsDir } from "./voice/voice-models";
import { VoiceProfiles, voiceProfilesDir } from "./voice/voice-profiles";
import { configuredResearch } from "./voice/voice-research";
import { configuredRouter } from "./voice/voice-router";
import { VoiceSetupRunner } from "./voice/voice-setup";
import { tastePath, VoiceTaste } from "./voice/voice-taste";
import { voiceTestOverrides } from "./voice/voice-test-env";
import {
  configuredTools,
  type VoiceWorkBoard,
  voiceWorkBoard,
} from "./voice/voice-tools";
import { WaitingAnswers } from "./voice/voice-waiting";
import { ownCheckout, readDeployed, readHead } from "./work/deployed";
import { handleWorkRpc, isWorkMethod } from "./work/rpc";
import {
  createWorkService,
  type WorkService,
  type WorkServiceDeps,
} from "./work/service";
import {
  openWorkStore,
  WorkError,
  type WorkStore,
  workDirectory,
} from "./work/store";
import { type WorkUserToolName, workTool } from "./work/tools";
import { DOWNLOAD_TIMEOUT_MS } from "./workspace/file-constants";
import { canRevealFiles } from "./workspace/file-manager";
import { createWorkspaceFront } from "./workspace/front";
import { keepLastSteps } from "./workspace/git-diff";
import { gitShellCommandArgv } from "./workspace/git-shell";
import { downloadLocalFile } from "./workspace/local-files";
import { inspectWorkspacePath } from "./workspace/path";
import {
  runBinaryProcessWithTimeout,
  runProcessWithInputTimeout,
} from "./workspace/process";
import { downloadRemoteFile } from "./workspace/remote-files";
import { isHostPath, ReviewGoneError } from "./workspace/review-patch";
import {
  createWorkspaceWorktree,
  resolveRepoSettingsKey,
} from "./worktree/create";
import {
  removeWorktreeWithRecovery,
  runWorktreeRemoveCommand,
  WORKTREE_REMOVE_TIMEOUT_MS,
} from "./worktree/remove";

const APP_VERSION = packageJson.version;
// Contract record mode (contract-record/recorder.ts): null, and nothing
// wrapped, unless ROAMGATE_CONTRACT_RECORD is set.
const recorder = contractRecorder();
recordSpawns(recorder);
const cliCommandList = cliCommands();
const recordedCli = recordCli(
  recorder,
  process.argv.slice(2),
  defaultCliContext(APP_VERSION),
);
const cliResult = await runCli(
  process.argv.slice(2),
  recordedCli.context,
  cliCommandList,
);
if (cliResult !== null && cliResult !== CONTINUE_TO_SERVER)
  recordedCli.finish(cliResult);
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
if (recorder) {
  for (const secret of [config.password, config.pin, sessionSecret])
    recorder.redactor.addSecret(secret);
  logger.info("contract record mode on", { directory: recorder.directory });
}
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
// A busy event loop delays every call: say when, and for how long.
watchLoopStalls({
  report: (fields) => logger.debug("event loop stalled", fields),
});
// Which agents' finished turns the user saw in Roamgate (agent-seen.ts).
// While the Rust core owns agent_sessions it keeps them (agent-seen.json is
// its file then): the marks, notes and annotations go to it, and this store
// is made again, reading the file afresh, when the family comes back.
let agentSeen = createAgentSeenStore();
// Seen marks hold for one Herdr server process: its boot id, per connection.
const herdrBoots = createHerdrBootCache();

/** Whether the Rust core serves the agent sessions now. */
function agentSessionsOnCore(): boolean {
  return !!coreFront && !bunOwns("agent_sessions");
}

/** A notice for the core's agent sessions; dropped when it is gone. */
function tellAgentSessions(op: string, params: Record<string, unknown>) {
  void coreFront
    ?.callInternal("agent_sessions", op, params)
    .catch((error: unknown) =>
      logger.debug("agent sessions notice not delivered", {
        op,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
}

/** Herdr's agent list with each finished agent's Done, from either side. */
async function annotateAgentSeen(
  connectionId: string,
  result: unknown,
  boot: string | null,
): Promise<unknown> {
  if (!agentSessionsOnCore())
    return agentSeen.annotate(connectionId, result, boot);
  return coreFront!.callInternal("agent_sessions", "annotate", {
    connection_id: connectionId,
    result,
    boot,
  });
}

// The core takes the seen marks: Bun's last ones are written first, then
// the core reads the file again. Back to Bun: the file as the core left it.
let agentSeenOnCore = false;
onOwnershipChanged(() => {
  const onCore = agentSessionsOnCore();
  if (onCore === agentSeenOnCore) return;
  agentSeenOnCore = onCore;
  if (onCore) {
    void agentSeen.flush().then(() => tellAgentSessions("seen_reload", {}));
  } else agentSeen = createAgentSeenStore();
});
/**
 * Git on a connection's host for the activity log's branches and remotes:
 * read-only, behind interactive SSH work (Bun's recorder, and the core's
 * through the `activity.hostScript` reverse call).
 */
async function activityHostScript(
  connectionId: string,
  script: string,
): Promise<{ code: number; stdout: string }> {
  const runtime = connectionManager.readyRuntime(connectionId);
  if (!runtime) throw new Error(`connection not ready: ${connectionId}`);
  const host = runtime.sshHost();
  // No POSIX shell to read with: the log keeps what Herdr says.
  if (
    runtime.remotePlatform === "windows" ||
    (!host && process.platform === "win32")
  )
    return { code: 0, stdout: "" };
  const argv = host
    ? sshReadCommandArgv(host, script, [], "activity.repo")
    : ["/bin/sh", "-c", script];
  return runInSshLane("background", () =>
    runProcessWithCodeTimeout(argv, 20_000),
  );
}
// The activity log (activity/recorder.ts): opt-in, `activity` in settings.json.
// With a Rust core, the activity family's owner records (activity/front.ts).
const createBunActivityRecorder = () =>
  createActivityRecorder({
    settings: async () => activitySettings(await readGuiSettings()),
    directory: () => dataRoot(),
    herdrCall: async (connectionId, method, params) => {
      const lease = connectionManager.readyRuntimeLease(connectionId);
      if (!lease) throw new Error(`connection not ready: ${connectionId}`);
      return lease.runtime.herdr.call(method, params, 5000);
    },
    // Conversation mode's claude: Herdr's state for its pane is not its own.
    ownedAgents: (connectionId) =>
      connectionManager.readyRuntime(connectionId)?.conversation.ownedPanes() ??
      [],
    // Branches and remotes: read-only git, behind interactive SSH work.
    runHostScript: activityHostScript,
    logger: logger.child("activity"),
  });
const activity = createActivityFront({
  createRecorder: createBunActivityRecorder,
  // Without ROAMGATE_CORE_BIN: Bun's recorder, exactly as before.
  core: coreConfigured(process.env)
    ? () =>
        coreFront && {
          owned: () => !bunOwns("activity"),
          expected: () => coreFront?.tableOwner("activity") === "rust",
          call: (op, params) => coreFront!.callInternal("activity", op, params),
          presence: (params, ctx) =>
            coreFront!.callRpc("activity.presence", params, ctx),
        }
    : null,
  heldAtStart:
    coreConfigured(process.env) &&
    readOwners(join(dataRoot(), "runtime")).owners.activity === "rust",
  socketId: socketIdOf,
  // Its own waits are real time: a test clock waits for them (settle).
  setTimeout: (run, ms) => {
    const timer = realTimers.setTimeout(run, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clearTimeout: (timer) =>
    realTimers.clearTimeout(timer as ReturnType<typeof setTimeout>),
  logger: logger.child("activity"),
});
onOwnershipChanged(() => activity.ownershipChanged());
// The workspace family: each runtime's auto-sync, Last step turns and git
// status, and the Workspaces arrangement, are the core's while it owns the
// family (workspace/front.ts, contract/wire/core-channel.md).
const workspaceFront = createWorkspaceFront({
  core: () =>
    coreFront && {
      owned: () => !bunOwns("workspace"),
      call: (op, params) => coreFront!.callInternal("workspace", op, params),
    },
  setTimeout: (run, ms) => {
    const timer = realTimers.setTimeout(run, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clearTimeout: (timer) =>
    realTimers.clearTimeout(timer as ReturnType<typeof setTimeout>),
  logger: logger.child("workspace"),
});
setWorkspaceTreeCore({
  owned: () => !!coreFront && workspaceFront.owned(),
  call: (params) => workspaceFront.call("tree", params),
});
onOwnershipChanged(() => workspaceFront.ownershipChanged());
// A test clock moves only once the core recorded what it was sent.
if (coreConfigured(process.env))
  activeTestClock()?.settleBefore(() => activity.settle());
const timeReportDeps = {
  settings: async () => {
    const settings = await readGuiSettings();
    return {
      activity: activitySettings(settings),
      timeReport: settings.time_report ?? null,
    };
  },
  openReader: async () =>
    openActivityReader(dataRoot(), Date.now, {
      subjectOf: subjectsFromSettings(await readGuiSettings()),
    }),
};
const timeReport = createTimeReport(timeReportDeps);
const createBunWebPush = () =>
  createWebPushService({
    warn: (message) => logger.warn(message),
  });
// Bun's Web Push runs while Bun owns the notifications family (always,
// without a Rust core); a fresh one (with the registry read again) starts
// when the family comes back from the core.
let webPush = createBunWebPush();
/**
 * Every notification goes through the feed: it builds the message once for
 * Web Push and for the notification socket (the Android app).
 */
const notifications = createNotificationFeed({
  webPush: { notify: (...args) => webPush.notify(...args) },
  answerPrompt: ({ connectionId, promptId }, answer) => {
    // The core's prompts are answered there, without waiting.
    if (coreFront && reviewsOnCore()) {
      void coreFront
        .callInternal("review", "call", {
          method: "prompts.answer",
          params: { connectionId, id: promptId, answer },
        })
        .catch(() => {});
      return true;
    }
    return getReviewService().prompts.answer({
      connectionId,
      id: promptId,
      answer,
    });
  },
  warn: (message) => logger.warn(message),
  logger: logger.child("notifications"),
});
/** The permission prompts open per connection, to notify each once. */
const notifiedPrompts = new Map<string, Set<string>>();
// Voice chat's helper starts on the first voice request, with the low-GPU
// profile's models over voice.json's while it is on.
const voiceHelper = new VoiceHelper(() => voiceLowGpu.config());
// The low-GPU profile (`roamgate voice profile low-gpu`, the Voice
// settings, GameMode at a call's start): its state file followed.
const voiceLowGpu = new VoiceLowGpu({
  path: lowGpuPath(),
  readConfig: () => readVoiceConfig(),
  modelsDir: defaultModelsDir(),
  helper: voiceHelper,
  gameMode: () => gameModeActive(),
});
voiceHelper.beforeCall = () => voiceLowGpu.beforeCall();
voiceLowGpu.watch();
const handleVoiceLowGpu = createVoiceLowGpuRoute(voiceLowGpu);
// The Voice settings' setup assistant: models downloaded, voice.json
// pointed at them, the helper restarted with them once it is free.
// A test server's hardware and model mirror (voice-test-env.ts).
const voiceTest = voiceTestOverrides();
const voiceSetup = new VoiceSetupRunner(
  {
    hardware: voiceTest.hardware ?? (() => detectHardware(systemProbe())),
    ...(voiceTest.packages ? { packages: voiceTest.packages } : {}),
    modelsDir: defaultModelsDir(),
    configPath: voiceConfigPath(),
    helperPath: defaultHelperPath(),
  },
  () => {
    const reload = voiceHelper.reloadModels();
    if (reload === "after-call") {
      const retry = setInterval(() => {
        if (voiceHelper.reloadModels() !== "after-call") clearInterval(retry);
      }, 15_000);
      retry.unref?.();
    }
    return reload;
  },
);
const handleVoiceSetup = createVoiceSetupRoute(voiceSetup);
// The people whose voices calls know again (voice-profiles.ts).
voiceHelper.speakers.useLibrary(new VoiceProfiles(voiceProfilesDir()));
// A job's answer nobody heard (the page reloaded, the call ended): kept
// for the next voice chat to mention (voice-waiting.ts).
const waitingAnswers = new WaitingAnswers();
/**
 * How the companion's errands reach a session: its history, a prompt, and
 * what it does now. Bun's own errands use them, and the Rust core's voice
 * family through the `voice.errand_*` reverse targets.
 */
const voiceErrandDeps = {
  read: async (connectionId: string, paneId: string) => {
    const runtime = connectionManager.readyRuntime(connectionId);
    if (!runtime) throw new Error(`${connectionId} is not connected`);
    const history = (await runtime.agentSessions.readHistory({
      history_version: 2,
      cursor: null,
      pane_id: paneId,
    })) as { entries?: ErrandEntry[] };
    return history.entries ?? [];
  },
  prompt: async (connectionId: string, paneId: string, text: string) => {
    const runtime = connectionManager.readyRuntime(connectionId);
    if (!runtime) throw new Error(`${connectionId} is not connected`);
    // Windows hosts: the messenger does not reach them.
    if (runtime.remotePlatform === "windows") {
      if (await runtime.conversation.prompt(paneId, text)) return;
      if (runtime.claudeMod.deliver(paneId, text, "companion")) return;
      await runtime.herdr.call("agent.prompt", { target: paneId, text }, 5000);
      return;
    }
    // Any mode, as `roamgate-review message` reaches a session: conversation
    // queue, else its Claude mod, else typed once the terminal is idle.
    await getAgentMessenger().deliver(agentAddress(connectionId, paneId), text);
  },
  // What it does now: what it asks the user (a permission or question
  // card), its status, and the messages queued for it.
  status: async (connectionId: string, paneId: string) => {
    const runtime = connectionManager.readyRuntime(connectionId);
    if (!runtime) return null;
    const asked = (
      (await reviewServiceCall("prompts.list", {
        connectionId,
      })) as AgentPermissionPrompt[]
    ).find((prompt) => prompt.paneId === paneId);
    const chat = runtime.conversation.lease(paneId)
      ? runtime.conversation.state(paneId)
      : null;
    let status: string | null = chat?.status ?? null;
    if (!status) {
      const info = await runtime.herdr
        .call("agent.get", { target: paneId }, 5000)
        .catch(() => null);
      const agent = (info as { agent?: { agent_status?: unknown } } | null)
        ?.agent;
      status =
        typeof agent?.agent_status === "string" ? agent.agent_status : null;
    }
    return {
      status,
      waiting: asked
        ? asked.questions?.[0]?.question || asked.summary || asked.tool
        : null,
      queued:
        (chat?.queue.length ?? 0) +
        getAgentMessenger().waitingFor(agentAddress(connectionId, paneId)),
    };
  },
};
// Work said by voice on sessions (errands): their processes stay up
// while it runs (idle stop).
const voiceErrands = new VoiceErrands({
  keep: (answer) => waitingAnswers.keep(answer),
  ...voiceErrandDeps,
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
const voiceResearch = configuredResearch(() => readVoiceConfig());
const companionMemoryFiles = new CompanionMemoryFiles();
const voiceTools = configuredTools(
  () => readVoiceConfig(),
  undefined,
  undefined,
  voiceHelper,
  new VoiceTaste(tastePath(), companionMemoryFiles.dir),
  // Read when a job starts: the board is made on first use (Bun's), or the
  // Rust core's while it owns the work family.
  () => voiceWork(),
);
const companionMemory = new CompanionMemory({
  path: companionMemoryPath(),
  compact: frontCompaction(() => readVoiceConfig(), companionMemoryFiles),
  files: companionMemoryFiles,
  jobs: () => withSearches("", voiceResearch(), voiceTools()),
  onCompacted: (reason) => {
    // The companion went quiet: a good time to refresh the music taste.
    if (reason === "idle" || reason === "end") voiceTools()?.refreshTaste();
    // Quietly, between calls only: the next call starts from the summary.
    if (reason === "size" || voiceSocket.currentCall()) return;
    const front = voiceFront();
    if (front && !front.busy) front.restart();
  },
});
const voiceFront = configuredFront(
  () => readVoiceConfig(),
  undefined,
  () => companionMemory.block(),
  companionMemoryFiles,
);
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
  voiceFront,
  () => {
    const config = readVoiceConfig();
    return "error" in config ? null : frontMode(config);
  },
  (mode) => writeFrontMode(mode),
  voiceResearch,
  () => voiceSocket.currentCall(),
  voiceTools,
  companionMemory,
  companionMemoryFiles,
  waitingAnswers,
  () => voiceLowGpu.reason(),
);
const voiceSocket = createVoiceSocket(
  voiceHelper,
  configuredCleaner(() => readVoiceConfig()),
  () => {
    const config = readVoiceConfig();
    return "error" in config ? undefined : config.max_pause_ms;
  },
  () => {
    // Read as a call starts: the music taste is refreshed then, when due.
    voiceTools()?.refreshTaste();
    const config = readVoiceConfig();
    return "error" in config ? null : callBackground(config);
  },
  () => {
    const config = readVoiceConfig();
    return "error" in config ? null : (config.call_ice_address ?? null);
  },
  undefined,
  () => companionMemory.callEnded(),
  configuredDictation(() => readVoiceConfig(), companionMemoryFiles),
  () => voiceFront() !== null,
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
  newSessionCookie,
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
  ...(config.authRequired
    ? {
        revoked: openRevokedSessions(revokedSessionsPath()),
      }
    : {}),
});

const redeemCallHandoff = createCallHandoffRedeem({
  redeem: (token) => voiceSocket.redeemHandoff(token),
  sessionCookie: newSessionCookie,
});

type RpcRequest = ConnectionRpcRequest;

const { handleUpdateCheck, handleUpdateInstall } = createUpdateHandlers({
  appVersion: APP_VERSION,
  runProcessWithCodeTimeout,
  shQuote,
  scheduleProcessExit: scheduleManagedShutdown,
});
const clients = new Set<ServerWebSocket<unknown>>();
/** Resumes the sessions a usage limit stopped (set once connections exist). */
let limitResumer: LimitResumer | null = null;
/**
 * Roamgate's Claude mods (agent/claude-mod.ts): the inbox of each pane whose
 * Claude runs one, and what each says of its session.
 */
const claudeModHub = createClaudeModFront({
  make: () =>
    createClaudeModHub({
      file: join(dataRoot(), "claude-mod-inbox.json"),
      log: (message, fields) =>
        logger.child("claude-mod").info(message, fields),
      debug: (message, fields) =>
        logger.child("claude-mod").debug(message, fields),
      type: typeForClaudeMod,
      onChange: claudeModChanged,
    }),
  // The core's hub takes it; the channel keeps the order of deliveries.
  deliverOnCore: (connectionId, paneId, text, kind) => {
    void coreFront
      ?.callInternal("review", "mod_deliver", {
        connection_id: connectionId,
        pane_id: paneId,
        text,
        kind,
      })
      .catch((error: unknown) =>
        logger.child("claude-mod").warn("message not delivered to the core", {
          connection: connectionId,
          pane: paneId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  },
});

/** A pane's Claude mod came, went, or said something new (either hub). */
function claudeModChanged(
  connectionId: string,
  paneId: string,
  change: ClaudeModChange,
): void {
  // The browsers read the panes again, with the mod's state laid over.
  let generation: number | undefined;
  try {
    generation = connectionManager.readyRuntimeLease(connectionId)?.generation;
  } catch {
    generation = undefined;
  }
  try {
    const line = serializeHerdrEventEnvelope(
      connectionId,
      { event: "roamgate.claude_mod", data: { pane_id: paneId, change } },
      generation,
    );
    for (const ws of clients) safeSend(ws, line, "claude-mod");
  } catch {}
  // A turn ended (on a usage limit, maybe).
  if (change !== "usage") pokeLimit(connectionId, paneId);
}

/**
 * The core runs the Claude mod hub while it owns both review (its agent
 * socket takes the mods' requests) and conversation; the inbox changes
 * hands through its file (contract/wire/core-channel.md).
 */
function modHubOnCore(): boolean {
  return !!coreFront && !bunOwns("review") && !bunOwns("conversation");
}
let modHubSwitch: Promise<void> = Promise.resolve();
function switchModHub(): void {
  modHubSwitch = modHubSwitch.then(async () => {
    const toCore = modHubOnCore();
    if (toCore === claudeModHub.onCore()) return;
    const log = logger.child("claude-mod");
    if (!toCore) {
      // The core writes its inbox before Bun's hub reads it.
      await coreFront
        ?.callInternal("review", "mod_release", {})
        .catch(() => undefined);
      claudeModHub.toBun();
      log.info("the Claude mod hub runs in Bun");
      return;
    }
    claudeModHub.toCore();
    // The core may hear of its families a moment after this front.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await coreFront!.callInternal("review", "mod_take", {});
        log.info("the Claude mod hub runs in the Rust core");
        return;
      } catch (error) {
        if (!modHubOnCore()) break;
        if (attempt === 19)
          log.warn("the core did not take the Claude mod hub", {
            error: error instanceof Error ? error.message : String(error),
          });
        await Bun.sleep(250);
      }
    }
    claudeModHub.toBun();
  });
}
onOwnershipChanged(switchModHub);

/**
 * A message a pane's Claude mod left when it went away: typed as for a
 * session without one, through Herdr once its agent is idle.
 */
async function typeForClaudeMod(
  connectionId: string,
  paneId: string,
  text: string,
): Promise<ClaudeModTypeResult> {
  const runtime = connectionManager.readyRuntime(connectionId);
  if (!runtime) return "wait";
  if (await runtime.conversation.prompt(paneId, text)) return "typed";
  let info: unknown;
  try {
    info = await runtime.herdr.call("agent.get", { target: paneId }, 5000);
  } catch (error) {
    if (/not[_ ]found/i.test(String(error))) return "gone";
    throw error;
  }
  const agent = (info as { agent?: { agent_status?: unknown } } | null)?.agent;
  if (!agent) return "gone";
  if (agent.agent_status !== "idle" && agent.agent_status !== "done")
    return "wait";
  await runtime.herdr.call("agent.prompt", { target: paneId, text }, 5000);
  return "typed";
}

/**
 * Configuration > Integrations: Roamgate's Claude mod on a connection's
 * host. Claude Code's own plugin commands install and remove it.
 */
async function claudeModIntegration(
  connectionId: string,
  action: "status" | "install" | "uninstall",
): Promise<ClaudeModInstallState> {
  const runtime = connectionManager.readyRuntime(connectionId);
  if (!runtime) throw new Error("this connection is not ready");
  const sessions = claudeModHub.panes(connectionId).length;
  const host = runtime.sshHost();
  // The review socket and its client are Unix-only.
  if (
    runtime.remotePlatform === "windows" ||
    (!host && process.platform === "win32")
  )
    return {
      available: false,
      reason: "The Claude mod needs a Unix host",
      min_claude: "",
      installed: false,
      enabled: false,
      from_roamgate: false,
      sessions,
    };
  const run = async (which: typeof action) => {
    const script = claudeModHostScript(which);
    const argv = host
      ? sshReadCommandArgv(host, script, [], "claude.mod")
      : ["/bin/sh", "-lc", script];
    const result = await runProcessWithCodeTimeout(argv, 120_000);
    return `${result.stdout}\n${result.code !== 0 ? `ROAMGATE_SCRIPT_FAILED ${result.stderr}` : ""}`;
  };
  if (action === "status")
    return claudeModStateOf(await run("status"), sessions);
  const before = claudeModStateOf(await run("status"), sessions);
  if (action === "install" && !before.available) return before;
  const output = await run(action);
  const state = claudeModStateOf(output, sessions);
  const parsed = parseClaudeModHostOutput(output);
  logger.info("claude mod " + action, {
    connection: connectionId,
    exit: parsed.exit,
    installed: state.installed,
    enabled: state.enabled,
  });
  if (parsed.exit !== 0) {
    let reason = parsed.actionOutput;
    try {
      const line = parsed.actionOutput.trim().split("\n").at(-1) ?? "";
      const json = JSON.parse(line) as { error?: unknown; message?: unknown };
      reason = String(json.error ?? json.message ?? reason);
    } catch {}
    return {
      ...state,
      reason: `claude plugin ${action} failed${reason ? `: ${reason.slice(0, 300)}` : ""}`,
    };
  }
  return state;
}
const clientIds = new WeakMap<ServerWebSocket<unknown>, number>();
const clientSessions = new WeakMap<ServerWebSocket<unknown>, string | null>();

// The Rust core (core-channel/): null unless ROAMGATE_CORE_BIN names one.
let coreFront: CoreFront | null = null;

/** A push of the core's, to the browsers it names. */
function deliverCorePush(push: PushMessage): void {
  const message = push.message as {
    event?: unknown;
    data?: unknown;
    assistant?: unknown;
    assistant_notification?: unknown;
  };
  // Ranger's state and notifications, as Bun's own service publishes them
  // (each socket's deltas, the notification feed).
  if (!push.connection_id && message && "assistant" in message) {
    publishAssistantSnapshot(message.assistant);
    return;
  }
  if (!push.connection_id && message && "assistant_notification" in message) {
    notifyAssistant(
      message.assistant_notification as AssistantTaskNotification,
    );
    return;
  }
  // The workspace family's arrangement: Bun's listeners (the browsers,
  // MR reviews) hear it as they hear Bun's own store.
  if (!push.connection_id && message && "workspace_tree" in message) {
    notifyWorkspaceTreeChanged(
      (
        message as {
          workspace_tree: Parameters<typeof notifyWorkspaceTreeChanged>[0];
        }
      ).workspace_tree,
    );
    return;
  }
  // A runtime's workspace events went to the activity log as Bun's did.
  if (
    push.connection_id &&
    typeof message?.event === "string" &&
    message.event.startsWith("workspace.")
  )
    activity.herdrEvent(push.connection_id, message);
  if (message?.event === LIMIT_PAUSES_EVENT && push.connection_id)
    rustLimitPauses.set(push.connection_id, parseLimitPauses(message.data));
  const line = push.connection_id
    ? serializeConnectionEnvelope(
        push.connection_id,
        push.message,
        push.connection_generation,
      )
    : JSON.stringify(push.message);
  for (const client of clients) {
    if (push.socket_id !== undefined && socketIdOf(client) !== push.socket_id)
      continue;
    if (
      push.session_id !== undefined &&
      sessionIdOf(clientSessions.get(client)) !== push.session_id
    )
      continue;
    safeSend(client, line, "core-push", push.key);
  }
}

/** The connection a reverse call names, or the default one. */
/** Whether the Rust core runs conversation mode now. */
function conversationOnCore(): boolean {
  return !!coreFront && !bunOwns("conversation");
}

/** What the core's conversation mode shows each connection's front. */
const conversationMirrors = new Map<string, ConversationMirror>();

/** The front's side of a connection's conversation mode in the core. */
function conversationCoreFor(connectionId: string) {
  return {
    onCore: conversationOnCore,
    call: (
      op: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      if (!coreFront) return Promise.reject(new Error("no core"));
      return conversationSwitch.then(() =>
        coreFront!.callInternal(
          "conversation",
          op,
          { connection_id: connectionId, ...params },
          signal,
        ),
      );
    },
    mirror: () =>
      conversationMirrors.get(connectionId) ?? emptyConversationMirror(),
  };
}

// The family changing hands: the side that had it saves what it read on
// the leases (conversation-leases.json) before the other reads them.
let conversationOnCoreNow = false;
let conversationSwitch: Promise<void> = Promise.resolve();
let conversationReleased: (() => void) | null = null;
onOwnershipChanged(() => {
  const onCore = conversationOnCore();
  if (onCore === conversationOnCoreNow) return;
  conversationOnCoreNow = onCore;
  const runtimes: LegacyConnectionRuntime[] = [];
  connectionManager.forEachCurrentRuntime((runtime) => runtimes.push(runtime));
  conversationSwitch = conversationSwitch.then(async () => {
    if (onCore) {
      for (const runtime of runtimes) runtime.conversationOwnerChanged(true);
      await flushLeaseFiles();
      forgetLeaseFiles();
      for (const runtime of runtimes)
        await coreFront
          ?.callInternal("conversation", "attach", {
            connection_id: runtime.identity.id,
          })
          .catch(() => undefined);
      return;
    }
    // Back to Bun: once the core saved its own (or a while, a core gone).
    if (coreFront)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000);
        conversationReleased = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    conversationReleased = null;
    conversationMirrors.clear();
    forgetLeaseFiles();
    for (const runtime of runtimes) runtime.conversationOwnerChanged(false);
  });
});

/** `conversation.host`: what the core's conversation mode asks. */
async function conversationHost(
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const op = args.op;
  if (op === "released") {
    conversationReleased?.();
    return { ok: true };
  }
  const runtime = coreRuntime(args);
  const connectionId = runtime.identity.id;
  const paneId = typeof args.pane_id === "string" ? args.pane_id : "";
  switch (op) {
    case "connection": {
      const lease = connectionManager.readyRuntimeLease(connectionId);
      const sshHost = runtime.sshHost();
      return {
        connection_id: connectionId,
        generation: lease?.generation ?? null,
        ssh: !!sshHost,
        // Locally, this Roamgate's own holder and socket.
        local_holder: sshHost
          ? null
          : {
              bin: join(homedir(), REVIEW_HOME_DIR, "bin", "roamgate-hold"),
              socket: join(homedir(), REVIEW_HOME_DIR, "review.sock"),
            },
      };
    }
    case "ssh_argv": {
      const host = runtime.sshHost();
      if (!host) throw new Error("this connection has no SSH host");
      return sshReadCommandArgv(
        host,
        String(args.command ?? ""),
        [],
        typeof args.tag === "string" ? args.tag : "agent_chat",
      );
    }
    case "ask":
      return getReviewService().prompts.request({
        tool: String(args.tool ?? ""),
        input: args.input,
        canAlways: args.can_always === true,
        ...(Array.isArray(args.questions)
          ? { questions: args.questions as never }
          : {}),
        timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : 0,
        connectionId,
        paneId,
        agent: "Claude",
        noTerminal: true,
        signal,
      });
    case "idle_stop_minutes":
      return conversationIdleStopMinutes(await readGuiSettings());
    case "keep_awake":
      return conversationKeepAwake(connectionId, paneId);
    case "models_offered":
      return profileModels(
        profileForSession(
          await readGuiSettings(),
          String(args.session_id ?? ""),
        ),
      );
    case "choose_model":
      sessionProfiles().chooseModel(
        String(args.session_id ?? ""),
        String(args.model ?? ""),
        typeof args.resolved === "string" ? args.resolved : null,
      );
      return { ok: true };
    case "register_launch":
      launchRegistry().register(
        connectionId,
        paneId,
        args.spec as LaunchSpec,
        String(args.token ?? ""),
      );
      return { ok: true };
    case "mirror":
      conversationMirrors.set(connectionId, args.mirror as ConversationMirror);
      return { ok: true };
    case "tell":
      if (args.what === "lease_changed")
        runtime.conversationLeaseChanged(paneId);
      else if (args.what === "owned_status")
        runtime.conversationOwnedStatus(paneId);
      return { ok: true };
    default:
      throw new Error(`conversation.host: unknown op ${String(op)}`);
  }
}

function coreRuntime(args: { connection_id?: unknown }) {
  const id =
    typeof args.connection_id === "string"
      ? args.connection_id
      : connectionManager.defaultId();
  const lease = connectionManager.readyRuntimeLease(id);
  if (!lease) throw new Error(`connection not ready: ${id}`);
  return lease.runtime;
}

/** A reverse call's pane and text. */
function corePaneText(args: unknown): { pane_id: string; text: string } {
  const { pane_id, text } = (args ?? {}) as {
    pane_id?: unknown;
    text?: unknown;
  };
  if (typeof pane_id !== "string" || typeof text !== "string")
    throw new Error("needs a pane_id and a text");
  return { pane_id, text };
}

/** The session a `voice.errand_*` reverse call names. */
function voicePaneOf(args: unknown): {
  connection_id: string;
  pane_id: string;
} {
  const { connection_id, pane_id } = (args ?? {}) as {
    connection_id?: unknown;
    pane_id?: unknown;
  };
  if (typeof connection_id !== "string" || typeof pane_id !== "string")
    throw new Error("a voice errand needs a connection_id and a pane_id");
  return { connection_id, pane_id };
}

/** What the core may call in Bun (contract/wire/core-channel.md). */
/** The remote history watch helpers the core's watchers asked for. */
const coreRemoteWatches = new Map<
  string,
  { id: number; handle: WatchHandle }
>();

const coreReverseTargets = {
  // The assistant family's (Ranger, while the core runs it): Bun stops its
  // own service first, and answers the tools of what it still owns.
  "assistant.release": async () => {
    await releaseBunAssistant();
    return {};
  },
  "assistant.connections": async () => assistantConnections(),
  "assistant.host": assistantReverse(async (args: unknown) =>
    assistantHost((args ?? {}) as Record<string, unknown>),
  ),
  "assistant.workspace_tree": assistantReverse(
    async (args: unknown, _ctx: unknown, signal: AbortSignal) => {
      const { kind, params } = (args ?? {}) as {
        kind?: unknown;
        params?: unknown;
      };
      if (typeof kind !== "string")
        throw new Error("assistant.workspace_tree needs a kind");
      return assistantWorkspaceTree(
        kind as Parameters<typeof assistantWorkspaceTree>[0],
        (params ?? {}) as Record<string, unknown>,
        signal,
      );
    },
  ),
  "assistant.archive": assistantReverse(
    async (args: unknown, _ctx: unknown, signal: AbortSignal) => {
      const { kind, params } = (args ?? {}) as {
        kind?: unknown;
        params?: unknown;
      };
      if (typeof kind !== "string")
        throw new Error("assistant.archive needs a kind");
      return assistantArchive(
        kind as Parameters<typeof assistantArchive>[0],
        (params ?? {}) as Record<string, unknown>,
        signal,
      );
    },
  ),
  "assistant.chat_thread_reply": assistantReverse(async (args: unknown) => {
    const { session_id, params } = (args ?? {}) as {
      session_id?: unknown;
      params?: { comment_id?: unknown; text?: unknown };
    };
    if (
      typeof session_id !== "string" ||
      typeof params?.comment_id !== "string" ||
      typeof params.text !== "string"
    )
      throw new Error(
        "assistant.chat_thread_reply needs a session and a reply",
      );
    return assistantChatThreadReply(session_id, {
      comment_id: params.comment_id,
      text: params.text,
    });
  }),
  ...reviewReverseTargets(),
  "herdr.call": async (args: unknown) => {
    const { method, params, timeout_ms, fresh } = (args ?? {}) as {
      method?: unknown;
      params?: unknown;
      timeout_ms?: unknown;
      fresh?: unknown;
    };
    if (typeof method !== "string")
      throw new Error("herdr.call needs a method");
    const herdr = coreRuntime(args as { connection_id?: unknown }).herdr;
    const callParams = (params ?? {}) as Record<string, unknown>;
    if (fresh === true)
      return herdr.call(
        method,
        callParams,
        typeof timeout_ms === "number" ? timeout_ms : undefined,
        undefined,
        { fresh: true },
      );
    return herdr.call(
      method,
      callParams,
      ...(typeof timeout_ms === "number" ? [timeout_ms] : []),
    );
  },
  // The workspace family's commands on a connection's SSH host, run as the
  // workspace's own (workspace/process.ts): through the session slots.
  // The workspace family's Last steps: those whose review has threads
  // keep their snapshot refs.
  "workspace.kept_steps": async (args: unknown) => {
    const { root } = (args ?? {}) as { root?: unknown };
    if (typeof root !== "string")
      throw new Error("workspace.kept_steps needs a root");
    return getReviewService().keptSteps(root);
  },
  "workspace.ssh_run": async (args: unknown) => {
    const { command, read, tag, timeout_ms, stdin_b64 } = (args ?? {}) as {
      command?: unknown;
      read?: unknown;
      tag?: unknown;
      timeout_ms?: unknown;
      stdin_b64?: unknown;
    };
    if (typeof command !== "string")
      throw new Error("workspace.ssh_run needs a command");
    const runtime = coreRuntime(args as { connection_id?: unknown });
    const host = runtime.sshHost();
    if (!host) throw new Error("workspace.ssh_run needs an SSH connection");
    const name = typeof tag === "string" && tag ? tag : undefined;
    const argv = annotateSshArgv(
      read === true
        ? sshReadCommandArgv(host, command, [], name)
        : sshCommandArgv(host, command, [], name),
      { connection: runtime.identity.id },
    );
    const timeoutMs = typeof timeout_ms === "number" ? timeout_ms : 60_000;
    if (typeof stdin_b64 === "string") {
      const ran = await runProcessWithInputTimeout(
        argv,
        Buffer.from(stdin_b64, "base64"),
        timeoutMs,
      );
      return {
        code: ran.code,
        stdout_b64: Buffer.from(ran.stdout).toString("base64"),
        stderr: ran.stderr,
      };
    }
    const ran = await runBinaryProcessWithTimeout(argv, timeoutMs);
    return {
      code: ran.code,
      stdout_b64: Buffer.from(ran.stdout).toString("base64"),
      stderr: ran.stderr,
    };
  },
  // What the limit_resume family asks of what Bun still owns.
  "connections.ready": async () =>
    connectionManager.list().flatMap((status) => {
      const lease = connectionManager.readyRuntimeLease(status.id);
      if (!lease) return [];
      return [
        {
          id: status.id,
          generation: lease.generation,
          remote_platform: lease.runtime.remotePlatform ?? null,
          ssh_host: lease.runtime.sshHost() ?? null,
        },
      ];
    }),
  // The notifications family's: the feed's events after a change in the
  // core (those to send to the sockets now by id), the sockets open, and
  // whether a notification the core queued for Web Push is still current.
  "notifications.feed": async (args: unknown) => {
    const { last, events, deliver } = (args ?? {}) as {
      last?: unknown;
      events?: unknown;
      deliver?: unknown;
    };
    if (typeof last !== "number" || !Array.isArray(events))
      throw new Error("notifications.feed needs last and events");
    notifications.applyCore(
      { last, events },
      Array.isArray(deliver)
        ? deliver.filter((id): id is number => typeof id === "number")
        : [],
    );
    return { ok: true };
  },
  "notifications.clients": async () => notifications.clients(),
  "notifications.current": async (args: unknown) => {
    const { token } = (args ?? {}) as { token?: unknown };
    return typeof token === "number" && notifications.currentCheck(token);
  },
  "settings.limit_resume.get": async () =>
    limitResumeSettings(await readGuiSettings()),
  "conversation.owned_panes": async (args: unknown) =>
    coreRuntime(args as { connection_id?: unknown }).conversation.ownedPanes(),
  "conversation.prompt": async (args: unknown) => {
    const { pane_id, text } = corePaneText(args);
    return coreRuntime(args as { connection_id?: unknown }).conversation.prompt(
      pane_id,
      text,
    );
  },
  "claude_mod.panes": async (args: unknown) =>
    coreRuntime(args as { connection_id?: unknown }).claudeMod.panes(),
  "claude_mod.deliver": async (args: unknown) => {
    const { pane_id, text } = corePaneText(args);
    const kind = (args as { kind?: unknown }).kind;
    return (
      coreRuntime(args as { connection_id?: unknown }).claudeMod.deliver(
        pane_id,
        text,
        typeof kind === "string" ? kind : "",
      ) !== null
    );
  },
  "agent.transcript_tail": async (args: unknown) => {
    const { pane_id } = (args ?? {}) as { pane_id?: unknown };
    if (typeof pane_id !== "string")
      throw new Error("agent.transcript_tail needs a pane_id");
    return coreRuntime(
      args as { connection_id?: unknown },
    ).limitConnection.transcriptTail(pane_id);
  },
  // The agent_sessions family in the core: Herdr as its readers see it,
  // transcripts on a connection's host, the Herdr boot ids of its seen
  // marks, and the remote history watch (contract/wire/core-channel.md).
  "agent_sessions.connection": async (args: unknown) => {
    const id =
      typeof (args as { connection_id?: unknown })?.connection_id === "string"
        ? (args as { connection_id: string }).connection_id
        : connectionManager.defaultId();
    const lease = connectionManager.readyRuntimeLease(id);
    if (!lease) throw new Error(`connection not ready: ${id}`);
    return {
      connection_id: id,
      generation: lease.generation,
      ssh: !!lease.runtime.sshHost(),
      remote_platform: lease.runtime.remotePlatform ?? null,
    };
  },
  "agent_sessions.herdr_call": async (args: unknown) => {
    const { method, params, timeout_ms } = (args ?? {}) as {
      method?: unknown;
      params?: unknown;
      timeout_ms?: unknown;
    };
    if (typeof method !== "string")
      throw new Error("agent_sessions.herdr_call needs a method");
    return coreRuntime(args as { connection_id?: unknown }).agentHerdrCall(
      method,
      (params ?? {}) as Record<string, unknown>,
      typeof timeout_ms === "number" ? timeout_ms : undefined,
    );
  },
  "agent_sessions.host_read": async (args: unknown) => {
    const { argv, timeout_ms } = (args ?? {}) as {
      argv?: unknown;
      timeout_ms?: unknown;
    };
    if (
      !Array.isArray(argv) ||
      !argv.length ||
      !argv.every((part) => typeof part === "string")
    )
      throw new Error("agent_sessions.host_read needs argv, a list of strings");
    const host = coreRuntime(args as { connection_id?: unknown }).sshHost();
    if (!host) throw new Error("agent_sessions.host_read needs an SSH host");
    const result = await runBinaryProcessWithTimeout(
      sshReadCommandArgv(
        host,
        (argv as string[]).map(shQuote).join(" "),
        [],
        "agent.session.read",
      ),
      typeof timeout_ms === "number" ? timeout_ms : 60_000,
    );
    return {
      code: result.code,
      stdout: Buffer.from(result.stdout).toString("base64"),
      stderr: result.stderr,
    };
  },
  "agent_sessions.herdr_boot": async (args: unknown) => {
    const { connection_id, fresh } = (args ?? {}) as {
      connection_id?: unknown;
      fresh?: unknown;
    };
    const runtime = coreRuntime(args as { connection_id?: unknown });
    const id =
      typeof connection_id === "string"
        ? connection_id
        : connectionManager.defaultId();
    if (fresh === true) herdrBoots.invalidate(id);
    return herdrBoots.get(id, () =>
      runtime.recoveryIdentity(AbortSignal.timeout(3_000)),
    );
  },
  "agent_sessions.watch_remote": async (args: unknown) => {
    const { connection_id, watch_id, paths } = (args ?? {}) as {
      connection_id?: unknown;
      watch_id?: unknown;
      paths?: unknown;
    };
    if (typeof connection_id !== "string" || typeof watch_id !== "number")
      throw new Error(
        "agent_sessions.watch_remote needs a connection_id and a watch_id",
      );
    const list = Array.isArray(paths)
      ? paths.filter((path): path is string => typeof path === "string")
      : [];
    const running = coreRemoteWatches.get(connection_id);
    if (running && (list.length || running.id === watch_id)) {
      coreRemoteWatches.delete(connection_id);
      running.handle.close();
    }
    if (!list.length) return { ok: true };
    const host = coreRuntime({ connection_id }).sshHost();
    if (!host) throw new Error("agent_sessions.watch_remote needs an SSH host");
    const handle = createRemoteStatSpawner({ host, shQuote })(
      list,
      (line) =>
        tellAgentSessions("remote_stat", { connection_id, watch_id, line }),
      () => {
        if (coreRemoteWatches.get(connection_id)?.id === watch_id)
          coreRemoteWatches.delete(connection_id);
        tellAgentSessions("remote_exit", { connection_id, watch_id });
      },
    );
    coreRemoteWatches.set(connection_id, { id: watch_id, handle });
    return { ok: true };
  },
  // The conversation family in the core: what it asks of this front
  // (contract/wire/core-channel.md, The conversation family).
  "conversation.host": async (
    args: unknown,
    _ctx: unknown,
    signal: AbortSignal,
  ) => conversationHost((args ?? {}) as Record<string, unknown>, signal),
  // The Claude mod hub in the core (contract/wire/core-channel.md).
  "claude_mod.mirror": async (args: unknown) => {
    claudeModHub.mirror(args as ClaudeModMirror);
    return { ok: true };
  },
  "claude_mod.changed": async (args: unknown) => {
    const { connection_id, pane_id, change } = (args ?? {}) as {
      connection_id?: unknown;
      pane_id?: unknown;
      change?: unknown;
    };
    if (
      typeof connection_id === "string" &&
      typeof pane_id === "string" &&
      typeof change === "string"
    )
      claudeModChanged(connection_id, pane_id, change as ClaudeModChange);
    return { ok: true };
  },
  "claude_mod.released": async () => {
    // The core gave up review or conversation: its inbox is on disk.
    switchModHub();
    return { ok: true };
  },
  "agent_sessions.seen_written": async () => {
    // The core wrote its last marks: Bun reads them, owning them again.
    if (!agentSessionsOnCore()) agentSeen = createAgentSeenStore();
    return { ok: true };
  },
  "notifications.clear_pane": async (args: unknown) => {
    const { pane_id } = corePaneText({ ...(args as object), text: "" });
    const { connection_id } = (args ?? {}) as { connection_id?: unknown };
    if (typeof connection_id !== "string")
      throw new Error("notifications.clear_pane needs a connection_id");
    notifications.clearPane(connection_id, pane_id);
    return { ok: true };
  },
  "host.run": async (args: unknown) => {
    const { argv, cwd, timeout_ms } = (args ?? {}) as {
      argv?: unknown;
      cwd?: unknown;
      timeout_ms?: unknown;
    };
    if (
      !Array.isArray(argv) ||
      !argv.length ||
      !argv.every((part) => typeof part === "string")
    )
      throw new Error("host.run needs argv, a list of strings");
    if (cwd !== undefined && typeof cwd !== "string")
      throw new Error("host.run's cwd is not a string");
    const timeoutMs = typeof timeout_ms === "number" ? timeout_ms : 60_000;
    const host = coreRuntime(args as { connection_id?: unknown }).sshHost();
    if (!host)
      return runProcessWithCodeTimeout(
        argv as string[],
        timeoutMs,
        cwd ? { cwd } : {},
      );
    const command = `${cwd ? `cd ${shQuote(cwd)} && ` : ""}${(argv as string[]).map(shQuote).join(" ")}`;
    return runProcessWithCodeTimeout(
      sshCommandArgv(host, command, [], "core-host-run"),
      timeoutMs,
    );
  },
  "review.addThread": async (args: unknown) =>
    reviewServiceCall("addThread", (args ?? {}) as Record<string, unknown>),
  // time_report in Rust: the activity log Bun owns until it moves too.
  "activity.dayInput": async (args: unknown) => {
    const { date } = (args ?? {}) as { date?: unknown };
    if (typeof date !== "string" || !isDate(date))
      throw new Error("activity.dayInput needs a date, YYYY-MM-DD");
    const { activity } = await timeReportDeps.settings();
    return dayInput(timeReportDeps, activity, date);
  },
  // The activity family in Rust: git on a connection's host.
  "activity.hostScript": async (args: unknown) => {
    const { connection_id, script } = (args ?? {}) as {
      connection_id?: unknown;
      script?: unknown;
    };
    if (typeof connection_id !== "string" || typeof script !== "string")
      throw new Error("activity.hostScript needs a connection_id and a script");
    return activityHostScript(connection_id, script);
  },
  // The herdr_setup family: the default connection is still Bun's.
  "herdr.setupGuard": async () => herdrSetupGuard(),
  "herdr.ping": async () => herdrSetupPing(),
  // The update family: after an install, the supervisor starts the new one.
  "server.scheduleExit": async () => {
    scheduleManagedShutdown();
    return { scheduled: true };
  },
  // The settings family: the core wrote settings.json (contract/wire/
  // core-channel.md, The settings family).
  "settings.changed": async (args: unknown) => {
    const { revision, settings, origin } = (args ?? {}) as {
      revision?: unknown;
      settings?: unknown;
      origin?: unknown;
    };
    if (
      typeof revision !== "number" ||
      !settings ||
      typeof settings !== "object"
    )
      throw new Error("settings.changed needs a revision and the settings");
    return {
      applied: applyRemoteGuiSettings(
        revision,
        settings,
        origin === "core" ? "core" : "front",
      ),
    };
  },
  // The mr_cache family: the forge reads stay here, asked by the core's
  // cache; Bun's own cache is written and dropped when the core takes it.
  "mr_cache.load": mrCacheLoad,
  "mr_cache.release": async () => mrCacheRelease(),
  // The work family: what the board asks of what Bun still owns, through
  // Bun's own deps of the board (workServiceDeps).
  "work.review": async (args: unknown) => workReviewOp(args),
  "work.notify": async (args: unknown) => {
    const { op, item } = (args ?? {}) as { op?: unknown; item?: unknown };
    if (!item || typeof item !== "object")
      throw new Error("work.notify needs an item");
    const notifications = workServiceDeps().notifications!;
    if (op === "publish") notifications.publish(item as WorkItem);
    else notifications.clear(item as WorkItem);
    return { ok: true };
  },
  "work.git": async (args: unknown) => {
    const {
      root,
      args: argv,
      connection_id,
    } = (args ?? {}) as {
      root?: unknown;
      args?: unknown;
      connection_id?: unknown;
    };
    if (
      typeof root !== "string" ||
      !Array.isArray(argv) ||
      !argv.every((part) => typeof part === "string")
    )
      throw new Error("work.git needs a root and args");
    return workServiceDeps().git!(
      root,
      argv as string[],
      typeof connection_id === "string" ? connection_id : undefined,
    );
  },
  "work.read_file": async (args: unknown) => {
    const { root, path, connection_id } = (args ?? {}) as {
      root?: unknown;
      path?: unknown;
      connection_id?: unknown;
    };
    if (typeof root !== "string" || typeof path !== "string")
      throw new Error("work.read_file needs a root and a path");
    return workServiceDeps().readFile!(
      root,
      path,
      typeof connection_id === "string" ? connection_id : undefined,
    );
  },
  "work.checkout": async () => ownCheckout(),
  // The voice family (while the core serves /api/voice): the companion's
  // errands reach the sessions through Bun's own code for them, its Work
  // tools the board Bun's companion uses, and a call handed to another
  // device gets a login from Bun's auth.
  "voice.errand_read": async (args: unknown) => {
    const { connection_id, pane_id } = voicePaneOf(args);
    return voiceErrandDeps.read(connection_id, pane_id);
  },
  "voice.errand_prompt": async (args: unknown) => {
    const { connection_id, pane_id } = voicePaneOf(args);
    const { text } = (args ?? {}) as { text?: unknown };
    if (typeof text !== "string")
      throw new Error("voice.errand_prompt needs a text");
    await voiceErrandDeps.prompt(connection_id, pane_id, text);
    return { ok: true };
  },
  "voice.errand_status": async (args: unknown) => {
    const { connection_id, pane_id } = voicePaneOf(args);
    return voiceErrandDeps.status(connection_id, pane_id);
  },
  "voice.work_tool": async (args: unknown) => {
    const { tool, params } = (args ?? {}) as {
      tool?: unknown;
      params?: unknown;
    };
    if (typeof tool !== "string")
      throw new Error("voice.work_tool needs a tool");
    return { text: await voiceWork().tool(tool as WorkUserToolName, params) };
  },
  "voice.work_states": async () =>
    voiceWork()
      .items()
      .map((item) => item.state),
  "voice.session_cookie": async () => ({ cookie: newSessionCookie() }),
  "work.panes": async (args: unknown) =>
    workServiceDeps().panes!(workConnectionOf(args)),
  "work.workspaces": async (args: unknown) =>
    workServiceDeps().workspaces!(workConnectionOf(args)),
  "agents.addresses": async () => workServiceDeps().sessions!(),
  // The agent_profiles family's (while the core owns it): what its
  // agent_profile.* calls need of a connection, by Bun's own code for it.
  "profiles.host": async (args: unknown) => {
    const { op, pane_id, session_id, spec, text, message, fields } = (args ??
      {}) as {
      op?: unknown;
      pane_id?: unknown;
      session_id?: unknown;
      spec?: unknown;
      text?: unknown;
      message?: unknown;
      fields?: unknown;
    };
    if (op === "settings")
      return { profiles: profilesOf(await readGuiSettings()) };
    const runtime = coreRuntime(args as { connection_id?: unknown });
    const host = runtime.profileHost();
    if (op === "panes") return runtime.profilePanes();
    if (op === "log") {
      host.log?.(String(message), (fields ?? {}) as Record<string, unknown>);
      return { ok: true };
    }
    if (typeof pane_id !== "string" || !pane_id)
      throw new Error("profiles.host needs a pane_id");
    switch (op) {
      case "agent_get":
        return await host.agentGet(pane_id).catch(() => null);
      case "conversation_session":
        return host.conversationSession(pane_id);
      case "conversation_model":
        return host.conversationModel?.(pane_id) ?? null;
      case "restart_process":
        return host.restartProcess(pane_id);
      case "restart_terminal":
        return host.restartTerminal(
          pane_id,
          typeof session_id === "string" ? session_id : undefined,
        );
      case "transcript_tail":
        return await host.transcriptTail(pane_id).catch(() => null);
      case "typed_launch":
        return host.typedLaunch(pane_id, spec as LaunchSpec);
      case "send_conversation":
        await host.sendConversation(pane_id, String(text));
        return { ok: true };
      case "prompt_terminal":
        await host.promptTerminal(pane_id, String(text));
        return { ok: true };
      case "mod_usage":
        return host.modUsage?.(pane_id) ?? null;
    }
    throw new Error(`profiles.host: unknown op ${String(op)}`);
  },
  // Every session choice, as the core wrote them: Bun's store keeps them
  // for its synchronous readers.
  "profiles.sessions_changed": async (args: unknown) => {
    const { sessions } = (args ?? {}) as { sessions?: unknown };
    if (!sessions || typeof sessions !== "object")
      throw new Error("profiles.sessions_changed needs sessions");
    sessionProfiles().replaceAll(
      sessions as Parameters<
        ReturnType<typeof sessionProfiles>["replaceAll"]
      >[0],
    );
    return { ok: true };
  },
  "connections.list": async () =>
    connectionManager.list().map((status) => ({
      id: status.id,
      generation: status.generation,
      is_default: !!status.is_default,
    })),
  // The local history Bun keeps (history/hooks.ts): the core's writes.
  "history.changed": async (args: unknown) => {
    const { area, id } = (args ?? {}) as { area?: unknown; id?: unknown };
    if (typeof area !== "string")
      throw new Error("history.changed needs an area");
    historyChanged(area, typeof id === "string" ? id : undefined);
    return { ok: true };
  },
  "history.work_changed": async (args: unknown) => {
    historyWorkChanged(args as WorkChange);
    return { ok: true };
  },
  // The mr_reviews family: what the reviews module asks of this server,
  // through the same code Bun's own module uses (mrReviewsHost).
  "mr_reviews.connections": async () => {
    const status = connectionManager.list().find((each) => each.is_default);
    return {
      connections: mrReviewConnections().map((each) => ({
        id: each.id,
        label: each.label,
        can_launch: !!each.launch,
      })),
      default: status
        ? {
            id: status.id,
            label: status.label,
            ready: !!connectionManager.readyRuntime(status.id),
          }
        : null,
    };
  },
  "mr_reviews.connection": async (args: unknown) =>
    mrReviewsConnectionOp((args ?? {}) as Record<string, unknown>),
  "mr_reviews.fetch": async (args: unknown) =>
    mrReviewsFetch((args ?? {}) as Record<string, unknown>),
  "mr_reviews.settings_write": async (args: unknown) => {
    const { expect, mr_reviews } = (args ?? {}) as {
      expect?: unknown;
      mr_reviews?: unknown;
    };
    if (!mr_reviews || typeof mr_reviews !== "object")
      throw new Error("mr_reviews.settings_write needs mr_reviews");
    // Written only over what the core read: else it reads again.
    let written = false;
    const next = await updateGuiSettings((current) => {
      if (stableJson(current.mr_reviews ?? null) !== stableJson(expect ?? null))
        return current;
      written = true;
      return {
        ...current,
        mr_reviews: mr_reviews as GuiSettings["mr_reviews"],
      };
    });
    return { written, mr_reviews: next.mr_reviews ?? {} };
  },
  "mr_reviews.review": async (args: unknown) => {
    const { op, params } = (args ?? {}) as {
      op?: unknown;
      params?: Record<string, any>;
    };
    const given = params ?? {};
    switch (op) {
      case "open":
        return mrReviewsHost.openReview(given as any);
      case "open_range":
        return mrReviewsHost.openRange(given as any);
      case "request":
        await mrReviewsHost.requestReview(given as any);
        return { ok: true };
      case "remove":
        await mrReviewsHost.removeReview(String(given.sessionId ?? ""));
        return { ok: true };
      case "effort":
        return (await mrReviewsHost.effortReview(given as any)) ?? null;
      default:
        throw new Error(
          `mr_reviews.review: unknown op ${String(op).slice(0, 40)}`,
        );
    }
  },
  "mr_reviews.tree": async (args: unknown) => {
    const { op, ops } = (args ?? {}) as { op?: unknown; ops?: unknown };
    if (op === "read") return mrReviewsHost.tree.read();
    if (op === "apply" && Array.isArray(ops)) {
      await mrReviewsHost.tree.apply(ops as WorkspaceTreeOp[]);
      return { ok: true };
    }
    throw new Error("mr_reviews.tree needs op read, or apply with ops");
  },
  "mr_reviews.create_worktree": async (args: unknown) => {
    const { params } = (args ?? {}) as { params?: Record<string, any> };
    return mrReviewsHost.createWorktree((params ?? {}) as any);
  },
  "mr_reviews.run_model": async (args: unknown) => {
    const { model, system, prompt } = (args ?? {}) as Record<string, unknown>;
    if (
      typeof model !== "string" ||
      typeof system !== "string" ||
      typeof prompt !== "string"
    )
      throw new Error("mr_reviews.run_model needs a model, system and prompt");
    return runClaudeModel(model, system, prompt);
  },
  "mr_reviews.inference_models": async () => {
    const models = defaultProfileInferenceModels();
    return {
      automatic: models.automatic(),
      models: await models.list().catch(() => []),
    };
  },
  // The reviews agent's turns: Bun's Claude Code driver, the core's tools.
  "mr_reviews.agent_turn": async (args: unknown) =>
    coreAgentTurns().run(args as CoreAgentTurn),
  "mr_reviews.agent_stop": async () => coreAgentTurns().stop(),
  "mr_reviews.agent_command": async (args: unknown) => {
    const { session_id } = (args ?? {}) as { session_id?: unknown };
    if (typeof session_id !== "string")
      throw new Error("mr_reviews.agent_command needs a session_id");
    return commandForSession(session_id);
  },
};

let coreAgent: ReturnType<typeof createCoreAgentTurns> | null = null;
/** The reviews agent's turns run for the core, made on first use. */
function coreAgentTurns() {
  coreAgent ??= createCoreAgentTurns({
    call: (op, params) => coreFront!.callInternal("mr_reviews", op, params),
  });
  return coreAgent;
}

/** `mr_reviews.connection {connection_id, op, ...}`: a reviews connection's member. */
async function mrReviewsConnectionOp(
  args: Record<string, unknown>,
): Promise<unknown> {
  const conn = mrReviewConnections().find(
    (each) => each.id === args.connection_id,
  );
  if (!conn)
    throw new Error(
      `connection not ready: ${String(args.connection_id).slice(0, 80)}`,
    );
  const text = (key: string) => {
    const value = args[key];
    if (typeof value !== "string")
      throw new Error(`mr_reviews.connection needs ${key}`);
    return value;
  };
  switch (args.op) {
    case "run":
      return conn.run(
        text("script"),
        typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
      );
    case "dirs":
      return conn.dirs();
    case "herdr":
      return conn.herdr(
        text("method"),
        (args.params ?? {}) as Record<string, unknown>,
      );
    case "launch":
      if (!conn.launch) throw new Error("no profile launch here");
      return conn.launch(text("pane_id"), args.spec as LaunchSpec);
    case "conversation_owned":
      return conn.conversation?.owned(text("pane_id")) ?? null;
    case "conversation_switch":
      if (!conn.conversation)
        return { ok: false, busy: false, reason: "no conversation mode here" };
      return conn.conversation.switch(text("pane_id"), text("session_id"));
    case "conversation_prompt":
      return (
        (await conn.conversation?.prompt?.(text("pane_id"), text("text"))) ??
        false
      );
    default:
      throw new Error(
        `mr_reviews.connection: unknown op ${String(args.op).slice(0, 40)}`,
      );
  }
}

/**
 * `mr_reviews.fetch {op, ...}`: the inbox's forge reads, `{value}` or
 * `{error: {kind?, message}}` (kind `not_signed_in` or `tool_missing`).
 */
async function mrReviewsFetch(args: Record<string, unknown>): Promise<unknown> {
  const call = (args.call ?? undefined) as FetchCall | undefined;
  try {
    switch (args.op) {
      case "gitlab":
        return {
          value: await mrInboxFetchers.gitlab(
            String(args.host),
            String(args.query),
            call,
          ),
        };
      case "github":
        return {
          value: await mrInboxFetchers.github(
            String(args.host),
            String(args.query),
            call,
          ),
        };
      case "gitlab_drafts":
        return {
          value: await mrInboxFetchers.gitlabDrafts(args.item as MrItem),
        };
      case "gitlab_label_events":
        return {
          value: await mrInboxFetchers.gitlabLabelEvents!(args.item as MrItem),
        };
      default:
        throw new Error(
          `mr_reviews.fetch: unknown op ${String(args.op).slice(0, 40)}`,
        );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      error: {
        ...(error instanceof NotSignedInError
          ? { kind: "not_signed_in" }
          : error instanceof ForgeToolMissingError
            ? { kind: "tool_missing" }
            : {}),
        message,
      },
    };
  }
}

/** A reverse call's connection, for the work family. */
function workConnectionOf(args: unknown): string {
  const { connection_id } = (args ?? {}) as { connection_id?: unknown };
  if (typeof connection_id !== "string")
    throw new Error("needs a connection_id");
  return connection_id;
}

/** `work.review {op, ...}`: the review service as the board asks it. */
async function workReviewOp(args: unknown): Promise<unknown> {
  const reviews = workServiceDeps().reviews!;
  const given = (args ?? {}) as Record<string, unknown>;
  const text = (key: string) => {
    const value = given[key];
    if (typeof value !== "string") throw new Error(`work.review needs ${key}`);
    return value;
  };
  const anchor = () => (given.anchor ?? {}) as Record<string, unknown>;
  switch (given.op) {
    case "find":
      return reviews.find(text("item"));
    case "open":
      return reviews.open({
        item: text("item"),
        connectionId: text("connection_id"),
        root: text("root"),
        title: text("title"),
      });
    case "get":
      return reviews.get(text("review"));
    case "session_of_comment":
      return reviews.sessionOfComment(text("id"));
    case "add_thread":
      return reviews.addThread({
        sessionId: text("session_id"),
        author: text("author"),
        text: text("text"),
        anchor: anchor(),
      });
    case "move_thread":
      return reviews.moveThread({
        sessionId: text("session_id"),
        threadId: text("thread_id"),
        anchor: anchor(),
      });
    case "set_anchor":
      return reviews.setAnchor!({
        sessionId: text("session_id"),
        threadId: text("thread_id"),
        anchor: anchor(),
      });
    case "add_image":
      return reviews.addImage!(
        text("session_id"),
        text("type"),
        new Uint8Array(Buffer.from(text("data"), "base64")),
      );
    case "edit_comment":
      return reviews.editComment!({
        sessionId: text("session_id"),
        commentId: text("comment_id"),
        author: text("author"),
        text: text("text"),
      });
    case "delete_comment":
      return reviews.deleteComment!({
        sessionId: text("session_id"),
        commentId: text("comment_id"),
        author: text("author"),
      });
    default:
      throw new Error(
        `work.review: unknown op ${String(given.op).slice(0, 40)}`,
      );
  }
}

/**
 * settings.json's writer: this process, or the Rust core while it owns
 * the settings family (Bun then reads and writes through the channel).
 */
function coreSettingsRemote(): GuiSettingsRemote {
  const asked = (value: unknown) =>
    value as { revision: number; settings: unknown };
  return {
    get: async () =>
      asked(await coreFront!.callInternal("settings", "get", {})),
    update: async (baseRevision, settings) =>
      asked(
        await coreFront!.callInternal("settings", "update", {
          base_revision: baseRevision,
          settings,
        }),
      ),
  };
}
let settingsRemote: GuiSettingsRemote | null = null;
onOwnershipChanged(() => {
  const rust = !!coreFront && !bunOwns("settings");
  if (rust === !!settingsRemote) return;
  settingsRemote = rust ? coreSettingsRemote() : null;
  setGuiSettingsRemote(settingsRemote);
  logger
    .child("settings")
    .info(
      rust
        ? "settings.json handed to the Rust core"
        : "settings.json written by Bun again",
    );
  // Read at once, so the first change the core makes is told against
  // what was there.
  void readGuiSettings().catch(() => undefined);
});
// What the core's own settings handlers changed, which the front's
// handlers would have followed up (each connection follows its own in
// connections/runtime.ts).
onGuiSettingsChanged((previous, next) => {
  if (previous === null) return;
  if (claudeStartMode(previous) !== claudeStartMode(next))
    for (const status of connectionManager.list())
      void ensureClaudeStartHook(status.id);
  if (
    JSON.stringify(limitResumeSettings(previous)) !==
    JSON.stringify(limitResumeSettings(next))
  )
    for (const status of connectionManager.list()) pokeLimit(status.id);
});

/**
 * Families whose paths keep Bun's own route checks (the method, the idle
 * budget): Bun hands them to the core at their route, not before it.
 */
// agent_sessions and workspace: their downloads and file routes are a
// connection's endpoints, routed (and their connection resolved) by Bun's
// own connection route first.
const CORE_ROUTED_IN_PLACE = new Set([
  "update",
  "herdr_setup",
  "agent_sessions",
  "workspace",
]);

function coreRoutedInPlace(path: string): boolean {
  const family = httpFamilyOf(path, FAMILIES);
  return family !== null && CORE_ROUTED_IN_PLACE.has(family);
}
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
  "agent_history.older",
  "agent_session.get",
  ...AGENT_CHAT_METHODS.filter(
    (method) =>
      method !== "agent_chat.state" && method !== "agent_chat.subscribe",
  ),
  "file.read",
  "git.diff_file",
  "git.diff_files",
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
    // The review's calls, but its polls.
    (method.startsWith("review.") && !REVIEW_POLL_METHODS.has(method)) ||
    elapsedMs >= SLOW_RPC_LOG_MS
  );
}

/** Review methods asked every few seconds: logged only when slow. */
const REVIEW_POLL_METHODS = new Set([
  "review.state",
  "review.prompts",
  "review.list",
  "review.snapshots",
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
/** connections.json as Bun serves it (read again when Bun takes it back). */
function loadConnectionBootstrap(): ConnectionProfileBootstrap {
  try {
    return loadConnectionProfileBootstrap({
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
    return {
      defaultConnectionId: LEGACY_DEFAULT_CONNECTION_ID,
      explicitLegacyOverride,
      persistedRegistry: null,
      registryLoadError,
      registrations: [
        { profile: syntheticLegacyProfile, readOnly: true as const },
      ],
    };
  }
}
const connectionBootstrap = loadConnectionBootstrap();

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
/**
 * Hosts (`local`, or `ssh:<host>`) whose Claude settings were given the
 * claude start hook in this run (see ensureClaudeStartHook).
 */
const claudeStartHooked = new Set<string>();

/** A connection's status changed (Bun's manager's, or the core's). */
function onConnectionStatus(status: ConnectionStatus) {
  if (assistantOnCore()) sendAssistantConnections();
  // Whether its agents can use the review client may have changed with it.
  if (reviewsOnCore()) sendReviewAgents();
  for (const listener of connectionStatusListeners)
    try {
      listener();
    } catch (error) {
      logger.warn("connection status listener failed", {
        error: sanitizeConnectionError(error),
      });
    }
  activity.connectionStatus(status.id, status.state);
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
  void ensureClaudeStartHook(status.id);
  resumeAssistantIfLoaded();
  workspaceTreePruner.ready(status.id);
  if (reporter.recovered(fields)) {
    readyConnectionGenerations.set(status.id, status.generation);
  } else if (readyConnectionGenerations.get(status.id) !== status.generation) {
    readyConnectionGenerations.set(status.id, status.generation);
    logger.info("connection ready", fields);
  }
}

/** Bun's connection manager (a new one each time Bun takes the host family back). */
const createBunConnectionManager = (defaultConnectionId: string) =>
  new ConnectionManager<LegacyConnectionRuntime>(
    defaultConnectionId,
    onConnectionStatus,
    logger.child("connections"),
  );
// The one the server uses: Bun's own, or while the Rust core owns the host
// family the connections it says (connections/host-facade.ts).
const connectionManager = new SwitchingConnectionManager(
  createBunConnectionManager(connectionBootstrap.defaultConnectionId),
  logger.child("connections"),
);

const assistantContextArgs: Parameters<typeof createAssistantContext>[0] = {
  limitPauses: (connectionId) =>
    limitResumer?.list(connectionId) ?? rustLimitPauses.get(connectionId) ?? [],
  catalog: () => connectionProfiles.list(),
  // A turn Ranger starts is not one the user has to look at.
  onAgentPrompted: ({ connectionId, paneId, terminalId, seq, status }) => {
    if (agentSessionsOnCore())
      tellAgentSessions("quiet_turn", {
        connection_id: connectionId,
        pane_id: paneId,
        terminal_id: terminalId,
        seq,
        status,
      });
    else agentSeen.quietTurn(connectionId, paneId, terminalId, seq, status);
  },
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
};
const assistantContext = createAssistantContext(assistantContextArgs);
// Ranger arranges the Workspaces list through the same store and push as
// the sidebar's bridge.workspace_tree.apply.
const assistantWorkspaceTree = createWorkspaceTreeToolHandler({
  connections: () => readWorkspaceTreeConnections(connectionManager),
  read: () => readWorkspaceTree(),
  apply: (ops) => applyWorkspaceTreeOps(ops),
});
// Ranger searches and reads the session archive (`roamgate archive`), read-only.
// A transcript the agent deleted is read from the archive instead.
useArchivedSessionFiles(
  createArchivedSessionReader({
    settings: async () =>
      (await readGuiSettings()).archive ?? normalizeArchiveSettings(undefined),
    archiveDir: (settings) =>
      resolveArchiveDir(
        process.env.ROAMGATE_ARCHIVE_DIR?.trim() || settings.dir,
        dataRoot(),
        console.log,
      ),
    runtime: () => ({
      homeDir: homedir(),
      platform: process.platform,
      env: process.env,
      dataDir: dataRoot(),
    }),
  }),
);
const archiveDeps = {
  settings: async () =>
    (await readGuiSettings()).archive ?? normalizeArchiveSettings(undefined),
  archiveDir: (settings: { dir?: string }) =>
    resolveArchiveDir(
      process.env.ROAMGATE_ARCHIVE_DIR?.trim() || settings.dir,
      dataRoot(),
      console.log,
    ),
  runtime: () => ({
    homeDir: homedir(),
    platform: process.platform,
    env: process.env,
    dataDir: dataRoot(),
  }),
};
// Ranger's archive search: the Rust core's while it owns the archive
// family (a search writes the archive's scratch overlay, text-live/: one
// writer); its session lookups and reads stay here, as readers.
const archiveSearch: typeof searchArchive = async (
  archiveDir,
  query,
  settings,
  options = {},
) => {
  if (!coreFront || bunOwns("archive"))
    return searchArchive(archiveDir, query, settings, options);
  try {
    return (await coreFront.callInternal(
      "archive",
      "search",
      query,
      options.signal,
    )) as Awaited<ReturnType<typeof searchArchive>>;
  } catch (error) {
    if (error instanceof ChannelError && error.code === "no_text_repo")
      throw new NoTextRepo();
    throw error;
  }
};
const assistantArchive = createArchiveToolHandler({
  ...archiveDeps,
  search: archiveSearch,
});
// The archive search view: read-only, like Ranger's tools.
const archiveRpc = createArchiveRpc(archiveDeps);
/**
 * Ranger's state to the browsers: a socket that read it with a stamp gets
 * each change as a delta from what it was last given. Bun's service and
 * the Rust core's (its `assistant` pushes) both publish through here.
 */
function publishAssistantSnapshot(snapshot: unknown) {
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
}

/** A task notification to the browsers and the notification feed. */
function notifyAssistant(notification: AssistantTaskNotification) {
  const payload = JSON.stringify({
    assistant_notification: notification,
  });
  for (const ws of clients) safeSend(ws, payload, "assistant_notification");
  notifications.publish(notification);
}

/**
 * `bridge.assistant.get` with `since` (the stamp of the page's last read):
 * an unchanged state is the stamp alone, not a megabyte. Pushes to this
 * socket go as deltas from this state from now on, in the same order as
 * this reply.
 */
function assistantStateReply(
  ws: object,
  params: Record<string, unknown>,
  result: unknown,
) {
  const stamp = Bun.hash(JSON.stringify(result)).toString(36);
  assistantBases.set(ws, { stamp, snapshot: result });
  return params.since === stamp
    ? { unchanged: true, stamp }
    : { snapshot: result, stamp };
}

/**
 * A reverse target of the assistant family: a message Ranger may show
 * (AssistantUserError, a Unix-only refusal) keeps its kind across the
 * channel, as a code; any other failure stays one the core masks.
 */
function assistantReverse<A extends unknown[]>(
  run: (...args: A) => Promise<unknown>,
): (...args: A) => Promise<unknown> {
  return async (...args) => {
    try {
      return await run(...args);
    } catch (error) {
      if (error instanceof AssistantUserError)
        throw new ChannelError(error.message, "assistant_user");
      if (error instanceof UnsupportedPlatformError)
        throw new ChannelError(error.message, "unsupported_platform");
      throw error;
    }
  };
}

/** Ranger answers a comment on its chat's messages in its thread. */
async function assistantChatThreadReply(
  sessionId: string,
  params: { comment_id: string; text: string },
) {
  const thread = (await reviewServiceCall("replyInChat", {
    chat: rangerChatKey(sessionId),
    commentId: params.comment_id,
    text: params.text,
    author: RANGER_THREAD_AUTHOR,
  })) as { id: string };
  return { text: `Answered in thread [${thread.id.slice(0, 8)}].` };
}

/**
 * The connections as the core's Ranger reads them: each one's ready
 * runtime generation (null while not ready) and state.
 */
function assistantConnections() {
  return connectionManager.list().map((status) => {
    let generation: number | null;
    try {
      generation =
        connectionManager.readyRuntimeLease(status.id)?.generation ?? null;
    } catch {
      generation = null;
    }
    return {
      id: status.id,
      generation,
      status: {
        label: status.label,
        state: status.state,
        ...(status.error ? { error: status.error.message } : {}),
      },
    };
  });
}

/** Tells the core's Ranger the connections changed. */
function sendAssistantConnections() {
  void coreFront
    ?.callInternal("assistant", "connections", {
      connections: assistantConnections(),
    })
    .catch(() => undefined);
}

/**
 * The dispatch gates of the core's Ranger in flight (by token): Bun's copy
 * refuses once the core said the gate no longer holds.
 */
const assistantGates = new Map<
  number,
  { message: string; user: boolean } | null
>();

function assistantGate(token: unknown): (() => void) | undefined {
  if (typeof token !== "number") return undefined;
  if (!assistantGates.has(token)) assistantGates.set(token, null);
  return () => {
    const revoked = assistantGates.get(token);
    if (revoked)
      throw revoked.user
        ? new AssistantUserError(revoked.message)
        : new Error(revoked.message);
  };
}

/** The runtime a lease of the core's Ranger names, while it is current. */
function assistantLeased(args: Record<string, unknown>) {
  const lease = (args.lease ?? {}) as {
    connection_id?: unknown;
    generation?: unknown;
  };
  if (typeof lease.connection_id !== "string")
    throw new Error("assistant.host needs a lease");
  const held = connectionManager.readyRuntimeLease(lease.connection_id);
  if (!held || held.generation !== lease.generation)
    throw new Error("Connection changed during Ranger read; start a new turn");
  return held;
}

/**
 * What the core's Ranger reads of the runtimes Bun owns (the live
 * context's host, contract/wire/core-channel.md), by `op`.
 */
async function assistantHost(args: Record<string, unknown>) {
  const text = (key: string) =>
    typeof args[key] === "string" ? (args[key] as string) : "";
  const query = (args.query ?? {}) as Record<string, unknown>;
  switch (args.op) {
    case "catalog":
      return assistantContextArgs
        .catalog()
        .map(({ id, label }) => ({ id, label }));
    case "lease": {
      const held = connectionManager.readyRuntimeLease(text("connection_id"));
      return held
        ? {
            connection_id: text("connection_id"),
            generation: held.generation,
            remote_platform: held.runtime.remotePlatform ?? null,
            ssh_host: held.runtime.sshHost() ?? null,
          }
        : null;
    }
    case "recovery_fingerprint":
      return (
        assistantContextArgs.recoveryFingerprint?.(text("connection_id")) ??
        null
      );
    case "limit_pauses":
      return assistantContextArgs.limitPauses?.(text("connection_id")) ?? [];
    case "create_worktree": {
      const held = assistantLeased(args);
      const gate = assistantGate(args.gate);
      try {
        return await assistantContextArgs.createWorktree!(
          held.runtime,
          (args.params ?? {}) as Record<string, unknown>,
          () => held.isCurrent(),
          () => gate?.(),
        );
      } finally {
        if (typeof args.gate === "number") assistantGates.delete(args.gate);
      }
    }
    case "agent_prompted":
      assistantContextArgs.onAgentPrompted?.(
        args.input as Parameters<
          NonNullable<typeof assistantContextArgs.onAgentPrompted>
        >[0],
      );
      return null;
    case "workspace_created":
      await assistantContextArgs.onWorkspaceCreated?.(
        args.input as Parameters<
          NonNullable<typeof assistantContextArgs.onWorkspaceCreated>
        >[0],
      );
      return null;
    case "herdr_call": {
      const held = assistantLeased(args);
      const gate = assistantGate(args.gate);
      try {
        return await held.runtime.herdr.call(
          text("method"),
          (args.params ?? {}) as Record<string, unknown>,
          typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
          gate,
        );
      } finally {
        if (typeof args.gate === "number") assistantGates.delete(args.gate);
      }
    }
    case "read_git_diff_file":
      return assistantLeased(args).runtime.files.readGitDiffFile(
        query as Parameters<
          LegacyConnectionRuntime["files"]["readGitDiffFile"]
        >[0],
      );
    case "read_git_diff_summary":
      return assistantLeased(args).runtime.files.readGitDiffSummary(
        query as Parameters<
          LegacyConnectionRuntime["files"]["readGitDiffSummary"]
        >[0],
      );
    case "resolve_workspace_git_root":
      return assistantLeased(args).runtime.files.resolveWorkspaceGitRoot(
        query as Parameters<
          LegacyConnectionRuntime["files"]["resolveWorkspaceGitRoot"]
        >[0],
      );
    case "read_history":
      return assistantLeased(args).runtime.agentSessions.readHistory(
        query as Parameters<
          LegacyConnectionRuntime["agentSessions"]["readHistory"]
        >[0],
      );
    case "read_summary": {
      const read = assistantLeased(args).runtime.agentSessions?.readSummary;
      return read ? read(query as Parameters<typeof read>[0]) : null;
    }
    case "owned_session":
      return (
        assistantLeased(args).runtime.conversation?.ownedSession(
          text("pane_id"),
        ) ?? null
      );
    case "conversation_prompt": {
      const held = assistantLeased(args);
      const gate = assistantGate(args.gate);
      try {
        return await held.runtime.conversation.prompt(
          text("pane_id"),
          text("prompt"),
          gate,
        );
      } finally {
        if (typeof args.gate === "number") assistantGates.delete(args.gate);
      }
    }
    case "read_worktree_hooks":
      return assistantLeased(args).runtime.worktreeHooks.readWorktreeHooks(
        text("cwd"),
      );
    case "recovery_identity": {
      const { runtime } = assistantLeased(args);
      return runtime.recoveryIdentity ? await runtime.recoveryIdentity() : null;
    }
    case "read_gui_settings":
      return readGuiSettings();
    case "resolve_repo_settings_key": {
      const held = assistantLeased(args);
      const input = (args.input ?? {}) as Record<string, unknown>;
      return resolveRepoSettingsKey({
        ...(input as Omit<
          Parameters<typeof resolveRepoSettingsKey>[0],
          "host" | "connectionId"
        >),
        host: held.runtime.sshHost(),
        connectionId: (args.lease as { connection_id: string }).connection_id,
      });
    }
    case "inspect_workspace_path": {
      const { runtime } = assistantLeased(args);
      return inspectWorkspacePath(
        text("cwd"),
        { host: runtime.sshHost(), remotePlatform: runtime.remotePlatform },
        false,
      );
    }
    case "note_turn_cause":
      turnCauses.note(
        text("connection_id"),
        text("pane_id"),
        args.cause as Parameters<typeof turnCauses.note>[2],
      );
      return null;
    case "gate_revoke":
      if (typeof args.token === "number" && assistantGates.has(args.token))
        assistantGates.set(args.token, {
          message: text("message"),
          user: args.user === true,
        });
      return null;
    default:
      throw new Error(`unknown assistant.host op ${String(args.op)}`);
  }
}

/** Whether Bun gave Ranger to the core (its service disposed). */
let assistantReleasedToCore = false;

/** Disposes Bun's Ranger, for the core to run it. */
async function releaseBunAssistant(): Promise<void> {
  assistantReleasedToCore = true;
  const task = assistantServiceTask;
  assistantServiceTask = null;
  if (!task) return;
  await task.then((service) => service.dispose()).catch(() => undefined);
  logger.child("assistant").info("handed to the Rust core");
}

/** The Rust core runs Ranger (it owns the assistant family). */
function assistantOnCore(): boolean {
  return !!coreFront && !bunOwns("assistant");
}

let assistantServiceTask: Promise<
  Awaited<
    ReturnType<typeof import("./assistant/service").createAssistantService>
  >
> | null = null;
function getAssistantService() {
  // The Rust core runs Ranger now: Bun's service must not run beside it
  // (both would write state.json and tasks.sqlite).
  if (assistantOnCore())
    return Promise.reject(new Error("Ranger runs in the Rust core"));
  assistantServiceTask ??= import("./assistant/service")
    .then(({ createAssistantService }) =>
      createAssistantService({
        context: assistantContext,
        workspaceTree: assistantWorkspaceTree,
        archive: assistantArchive,
        // Ranger answers the comments on its chat's messages in their
        // threads, as an agent does with roamgate-review reply.
        chatThreads: async (sessionId, params) =>
          assistantChatThreadReply(sessionId, params),
        publish: publishAssistantSnapshot,
        notify: notifyAssistant,
      }),
    )
    .catch((error) => {
      assistantServiceTask = null;
      throw error;
    });
  return assistantServiceTask;
}

/** Merge and pull requests the chats show, shared by every browser. */
const forgeCache = createForgeCache(Date.now, sharedMrCache());
// Every client learns when an answer of the MR cache changes, whichever
// surface or device asked for the read.
onMrCacheChange((change) => {
  const push = mrCachePush(change);
  if (!push) return;
  const line = JSON.stringify({ forge_cache: push });
  for (const ws of clients) safeSend(ws, line, "forge-cache");
});

/**
 * The ready connections for the reviews module: the default connection
 * first (a project's clone is looked for there first, and its review
 * worktree made there), then this machine, then the others.
 */
function mrReviewConnections(): MrConnection[] {
  return orderConnections(
    connectionManager.list().flatMap((status) => {
      const runtime = connectionManager.readyRuntime(status.id);
      if (!runtime || runtime.remotePlatform === "windows") return [];
      const host = runtime.sshHost();
      const call = (method: string, params: Record<string, unknown> = {}) =>
        runtime.herdr.call(method, params);
      return [
        {
          isDefault: status.is_default,
          remote: !!host,
          connection: {
            id: status.id,
            label: status.label,
            run: (script: string, timeoutMs = 60_000) =>
              runProcessWithCodeTimeout(
                gitShellCommandArgv(script, host || undefined),
                timeoutMs,
              ),
            herdr: call,
            launch: runtime.typedLaunch,
            conversation: {
              owned: (paneId: string) =>
                runtime.conversation.ownedSession(paneId)?.session_id ?? null,
              switch: (paneId: string, sessionId: string) =>
                runtime.conversation.switchSession(paneId, sessionId),
              prompt: (paneId: string, text: string) =>
                runtime.conversation.prompt(paneId, text),
            },
            dirs: async () => {
              const [workspaces, panes] = (await Promise.all([
                call("workspace.list"),
                call("pane.list"),
              ])) as [
                {
                  workspaces?: {
                    cwd?: string;
                    worktree?: { checkout_path?: string };
                  }[];
                },
                { panes?: { cwd?: string; foreground_cwd?: string }[] },
              ];
              return [
                ...(workspaces?.workspaces ?? []).flatMap((w) => [
                  w.cwd ?? "",
                  w.worktree?.checkout_path ?? "",
                ]),
                ...(panes?.panes ?? []).flatMap((p) => [
                  p.cwd ?? "",
                  p.foreground_cwd ?? "",
                ]),
              ].filter((dir) => dir.startsWith("/"));
            },
          } satisfies MrConnection,
        },
      ];
    }),
  );
}

/** The review store the history reads, once the review service opened it. */
let reviewStorageForHistory: ReviewSource | null = null;

/** Local history (server/src/history): a git repo of what was authored. */
const historyRuntime = new HistoryRuntime({
  areas: historyAreas(historyPaths(), () => {
    // While the core owns the reviews, the file read as it writes it.
    if (!reviewStorageForHistory)
      if (reviewsOnCore())
        reviewStorageForHistory = openReviewStorage(reviewDirectory());
      else getReviewService();
    return reviewStorageForHistory;
  }),
  place: async () => historyPlace(await readGuiSettings(), dataRoot()),
  reviews: () => reviewStorageForHistory,
  gameMode: () => gameModeActive(),
  log: logger.child("history"),
});
const handleHistory = createHistoryRoute({
  status: () => historyRuntime.status(),
  commit: () => historyRuntime.commitNow(),
  configure: async ({ location, enabled }) => {
    const expanded =
      typeof location === "string" ? expandLocation(location) : location;
    await updateGuiSettings((current) => {
      const history = { ...current.history };
      if (expanded === null) delete history.location;
      else if (expanded !== undefined) history.location = expanded;
      if (enabled !== undefined) history.enabled = enabled;
      const next = { ...current };
      if (Object.keys(history).length) next.history = history;
      else delete next.history;
      return next;
    });
  },
});

let workService: WorkService | null = null;
let workStore: WorkStore | null = null;
let workDeps: Omit<WorkServiceDeps, "store"> | null = null;

/**
 * What the Work board asks of the server: Bun's service's deps, and what
 * the Rust core reaches through the work family's reverse targets while
 * it owns the board (contract/wire/core-channel.md).
 */
function workServiceDeps(): Omit<WorkServiceDeps, "store"> {
  if (workDeps) return workDeps;
  const review = liveReviewService;
  const checkout = ownCheckout();
  workDeps = {
    publish: (push) => {
      const line = JSON.stringify({ work: push });
      for (const ws of clients) safeSend(ws, line, "work");
    },
    // While the core owns the reviews, each is asked of it.
    reviews: {
      find: (itemId) => {
        const matches = (session: ReviewSession) =>
          session.target.kind === "work" && session.target.item === itemId;
        return reviewsOnCore()
          ? coreNewestReview(matches)
          : review.newest(matches);
      },
      open: ({ item, connectionId, root, title }) => {
        const params = {
          connectionId,
          root,
          target: { kind: "work", item },
          title,
          agent: "Claude",
          raise: false,
        };
        return reviewsOnCore()
          ? coreReviews<ReviewSnapshot>("open", params)
          : review.open(params);
      },
      get: (reviewId) => {
        const matches = (session: ReviewSession) =>
          session.id.startsWith(reviewId);
        return reviewsOnCore()
          ? coreNewestReview(matches)
          : review.newest(matches);
      },
      // The review a thread (or a comment) of any connection is in.
      sessionOfComment: async (ref: string) =>
        (reviewsOnCore()
          ? await coreReviews<ReviewSnapshot[]>("list", { chats: true })
          : review.list({ chats: true })
        ).find(({ threads }) =>
          threads.some(
            (thread) =>
              thread.id === ref ||
              thread.id.startsWith(ref) ||
              thread.comments.some(
                (comment) => comment.id === ref || comment.id.startsWith(ref),
              ),
          ),
        )?.session ?? null,
      addThread: (input) => {
        const params = {
          sessionId: input.sessionId,
          author: input.author,
          text: input.text,
          anchor: input.anchor,
          kind: "discussion",
        };
        return reviewsOnCore()
          ? coreReviews<ReviewThread>("addThread", params)
          : review.addThread(params);
      },
      moveThread: (input) => {
        const params = {
          sessionId: input.sessionId,
          threadId: input.threadId,
          anchor: input.anchor,
        };
        return reviewsOnCore()
          ? coreReviews<ReviewThread>("moveThread", params)
          : review.moveThread(params);
      },
      setAnchor: (input) => {
        const params = {
          sessionId: input.sessionId,
          threadId: input.threadId,
          anchor: input.anchor,
        };
        return reviewsOnCore()
          ? coreReviews<ReviewThread>("setThreadAnchor", params)
          : review.setThreadAnchor(params);
      },
      // An image an item is added with: stored as a pasted one is.
      addImage: (sessionId, type, data) =>
        saveReviewImage(reviewDirectory(), sessionId, type, data),
      // An agent's own comment, rewritten or deleted (the review service
      // checks the author).
      editComment: (input) =>
        reviewsOnCore()
          ? coreReviews<ReviewThread>("edit", input)
          : review.edit(input),
      deleteComment: (input) =>
        reviewsOnCore()
          ? coreReviews<{ deleted: string; thread: ReviewThread | null }>(
              "deleteComment",
              input,
            )
          : review.deleteComment(input),
    },
    // An owner must be a session Roamgate manages (agent_sessions).
    sessions: async () =>
      (await getAgentMessenger().list()).map((each) => each.address),
    notifications: {
      publish: (item) => {
        const status =
          connectionManager.list().find((each) => each.is_default) ??
          connectionManager.list()[0];
        if (!status) return;
        // The item stands as the pane: its tag stays the same whatever the
        // title becomes, so the clear finds it.
        notifications.publish(
          {
            kind: "blocked",
            connectionId: status.id,
            runtimeGeneration: status.generation,
            paneId: `work:${item.id}`,
            agent: "Work",
            workspaceLabel: "Work",
            title: `For you: ${item.title.slice(0, 120)}`,
            // What the user has to do, when the item says it.
            body: item.ask
              ? item.ask.slice(0, 240)
              : item.tags.length
                ? item.tags.join(", ")
                : "On the Work board",
          },
          { kind: "work", path: `/#roamgate-work=${item.id}` },
        );
      },
      clear: (item) => {
        const status =
          connectionManager.list().find((each) => each.is_default) ??
          connectionManager.list()[0];
        if (!status) return;
        notifications.clearTag(
          JSON.stringify([
            "roamgate-task",
            status.id,
            status.generation,
            `work:${item.id}`,
          ]),
        );
      },
    },
    // The done rules: git in the rule's checkout, on its connection.
    git: async (root, args, connectionId) => {
      const runtime = connectionId
        ? connectionManager.readyRuntime(connectionId)
        : null;
      if (connectionId && (!runtime || runtime.remotePlatform === "windows"))
        return { code: null, stdout: "" };
      const script = `git -C ${shQuote(root)} ${args.map(shQuote).join(" ")}`;
      try {
        const read = await runProcessWithCodeTimeout(
          gitShellCommandArgv(script, runtime?.sshHost() || undefined),
          30_000,
        );
        return { code: read.code, stdout: read.stdout };
      } catch {
        return { code: null, stdout: "" };
      }
    },
    // The decisions' rule reads uncommitted ticks in the working tree.
    readFile: async (root, path, connectionId) => {
      const runtime = connectionId
        ? connectionManager.readyRuntime(connectionId)
        : null;
      if (connectionId && (!runtime || runtime.remotePlatform === "windows"))
        return null;
      if (path.startsWith("/") || path.split("/").includes("..")) return null;
      const script = `cat ${shQuote(`${root}/${path}`)}`;
      try {
        const read = await runProcessWithCodeTimeout(
          gitShellCommandArgv(script, runtime?.sshHost() || undefined),
          30_000,
        );
        return read.code === 0 ? read.stdout : null;
      } catch {
        return null;
      }
    },
    deployed: () => readDeployed() ?? readHead(checkout),
    ownRoot: () => checkout,
    defaultConnection: () =>
      connectionManager.list().find((each) => each.is_default)?.id ??
      connectionManager.list()[0]?.id ??
      null,
    panes: async (connectionId) => {
      const runtime = connectionManager.readyRuntime(connectionId);
      if (!runtime) return [];
      const listed = (await runtime.herdr.call("pane.list", {})) as {
        panes?: {
          pane_id: string;
          workspace_id?: string;
          cwd?: string;
          foreground_cwd?: string;
        }[];
      };
      return listed?.panes ?? [];
    },
    // A workspace's name and checkout: an item added from it gets its tag.
    workspaces: async (connectionId) => {
      const runtime = connectionManager.readyRuntime(connectionId);
      if (!runtime) return [];
      const listed = (await runtime.herdr.call("workspace.list", {})) as {
        workspaces?: {
          workspace_id: string;
          label?: string;
          worktree?: { checkout_path?: string; repo_root?: string } | null;
        }[];
      };
      return listed?.workspaces ?? [];
    },
    generation: (connectionId) =>
      connectionManager.list().find((each) => each.id === connectionId)
        ?.generation ?? null,
    log: (message, fields) => logger.warn(message, fields),
  };
  return workDeps;
}

/** The Work board (bridge.work.*), started on first use. */
function getWorkService(): WorkService {
  if (workService) return workService;
  workStore = openWorkStore(workDirectory());
  workService = createWorkService({
    store: workStore,
    ...workServiceDeps(),
  });
  workService.start();
  return workService;
}

/** Whether the Rust core serves the Work board now. */
function coreServesWork(): boolean {
  return !!coreFront && !bunOwns("work");
}

// Bun's board runs (its checks, its writes) only while Bun owns the work
// family: stopped when the core takes it, made again (the store read
// again: the core wrote it meanwhile) at its next use when it comes back.
onOwnershipChanged(() => {
  if (!bunOwns("work") && workService) {
    workService.stop();
    workService = null;
    // Bun's last change reaches the file the core reads (written behind).
    void workStore?.flush();
    workStore = null;
    logger.child("work").info("handed to the Rust core");
  }
});

/** A Work board call the core answers: its text, or its error. */
async function coreWorkCall(op: string, params: unknown): Promise<unknown> {
  return coreFront!.callInternal("work", op, params);
}

/** The Work board the voice companion uses: Bun's, or the core's. */
function voiceWork(): VoiceWorkBoard {
  if (!coreServesWork()) return voiceWorkBoard(getWorkService());
  return {
    tool: async (name: WorkUserToolName, params: unknown) =>
      (
        (await coreWorkCall("user_tool", { tool: name, params })) as {
          text: string;
        }
      ).text,
    // The file as the core last wrote it (read, never written here).
    items: () => openWorkStore(workDirectory()).items(),
  };
}

/** The reviews' forge reads: glab and gh with this machine's logins. */
const mrInboxFetchers = createInboxFetchers(runProcessWithCodeTimeout);

/**
 * What the reviews module asks of this server: Bun's own module's, and the
 * Rust core's through the mr_reviews reverse targets while it owns them.
 */
const mrReviewsHost = {
  // The order, pins and removals belong to this server: every page
  // follows them at once, whichever connection it shows.
  publish: (push) => {
    const line = JSON.stringify({ mr_reviews: push });
    for (const ws of clients) safeSend(ws, line, "mr-reviews");
  },
  connections: mrReviewConnections,
  tree: {
    read: () => readWorkspaceTree(),
    apply: (ops) => applyWorkspaceTreeOps(ops),
    onChanged: onWorkspaceTreeChanged,
  },
  defaultConnection: () => {
    const status = connectionManager.list().find((each) => each.is_default);
    return status
      ? {
          id: status.id,
          label: status.label,
          ready: !!connectionManager.readyRuntime(status.id),
        }
      : null;
  },
  openReview: ({ connectionId, workspaceId, root, url, title, paneId }) => {
    const params = {
      connectionId,
      workspaceId,
      root,
      target: { kind: "mr", url },
      title,
      ...(paneId ? { paneId, agent: "Claude" } : {}),
      raise: false,
    };
    return reviewsOnCore()
      ? coreReviews<ReviewSnapshot>("open", params)
      : getReviewService().open(params);
  },
  openRange: ({
    connectionId,
    workspaceId,
    root,
    base,
    head,
    title,
    compare,
  }) => {
    const params = {
      connectionId,
      workspaceId,
      root,
      target: { kind: "range", base, head, ...(compare ? { compare } : {}) },
      title,
      raise: false,
    };
    if (reviewsOnCore())
      return coreReviews<ReviewSnapshot>("open", params).then((snapshot) => ({
        sessionId: snapshot.session.id,
        snapshot,
      }));
    const snapshot = getReviewService().open(params);
    return { sessionId: snapshot.session.id, snapshot };
  },
  // An effort's part: the same worktree path as the workspace menu's.
  createWorktree: async ({ connectionId, workspaceId, cwd, branch }) => {
    const runtime = connectionManager.readyRuntime(connectionId);
    if (!runtime) throw new Error("this connection is not ready");
    const result: any = await createWorkspaceWorktree(
      runtime,
      {
        ...(workspaceId ? { workspace_id: workspaceId } : { cwd }),
        branch,
        focus: false,
      },
      () => true,
      undefined,
      undefined,
      undefined,
      // Never an existing checkout: the worktree command takes one as
      // done, and the part's pick would then run in it.
      { freshPath: "part" },
    );
    const path =
      result?.worktree?.path ??
      result?.worktree?.checkout_path ??
      result?.workspace?.worktree?.checkout_path ??
      result?.workspace?.cwd;
    if (typeof path !== "string" || !path)
      throw new Error("the worktree was made but its path is unknown");
    return {
      path,
      ...(typeof result?.workspace?.workspace_id === "string"
        ? { workspaceId: result.workspace.workspace_id }
        : {}),
    };
  },
  requestReview: ({ sessionId, paneId, focus }) => {
    const params = {
      sessionId,
      paneId,
      agent: "Claude",
      ...(focus ? { focus } : {}),
    };
    return reviewsOnCore()
      ? coreReviews("requestAgentReview", params)
      : getReviewService().requestAgentReview(params);
  },
  removeReview: (sessionId) => {
    if (reviewsOnCore()) return coreReviews("remove", { sessionId });
    getReviewService().remove({ sessionId });
  },
  effortReview: ({ effort, connectionId, workspaceId, root, title, open }) => {
    const matches = (session: ReviewSession) =>
      session.target.kind === "effort" && session.target.effort === effort;
    const params = {
      connectionId,
      workspaceId,
      root,
      target: { kind: "effort", effort },
      title,
      agent: "Claude",
      raise: false,
    };
    if (reviewsOnCore())
      return coreNewestReview(matches).then((found) =>
        found || !open ? found : coreReviews<ReviewSnapshot>("open", params),
      );
    const service = getReviewService();
    // Wherever it was opened: its head may have moved since.
    const found = service
      .list({ chats: true })
      .find(({ session }) => matches(session));
    if (found || !open) return found ?? null;
    return service.open(params);
  },
} satisfies Partial<Parameters<typeof createMrReviews>[0]>;

/** Whether the Rust core serves the reviews now. */
function coreServesMrReviews(): boolean {
  return !!coreFront && !bunOwns("mr_reviews");
}

// Bun's reviews run (their timers, their writes) only while Bun owns the
// mr_reviews family: stopped when the core takes it, made again (their
// state read again: the core wrote it meanwhile) at their next use.
onOwnershipChanged(() => {
  if (!bunOwns("mr_reviews") && mrReviews) {
    mrReviews.stop();
    mrReviews = null;
    logger.child("mr-reviews").info("handed to the Rust core");
  }
});
// The core's reviews follow the Workspaces tree too (a group deleted is no
// longer headed upstream).
onWorkspaceTreeChanged((tree) => {
  if (coreServesMrReviews())
    void coreFront!
      .callInternal("mr_reviews", "tree_changed", { tree })
      .catch(() => undefined);
});

let mrReviews: MrReviews | null = null;
/** The reviews inbox (bridge.mr_reviews.*), started on first use. */
function getMrReviews(): MrReviews {
  if (mrReviews) return mrReviews;
  mrReviews = createMrReviews({
    run: runProcessWithCodeTimeout,
    fetchers: mrInboxFetchers,
    ...mrReviewsHost,
  });
  mrReviews.start();
  return mrReviews;
}

/**
 * An effort's leader, as the Leader session button finds it: the Claude
 * pane of its head workspace on that connection, else null (its threads
 * wait for one).
 */
async function effortLeaderPane(
  connectionId: string,
  effort: string,
): Promise<string | null> {
  try {
    const asked = { id: effort };
    const answer = (
      coreServesMrReviews()
        ? await coreFront!.callInternal("mr_reviews", "call", {
            method: "bridge.mr_reviews.effort.leader",
            params: asked,
          })
        : await getMrReviews().handle("bridge.mr_reviews.effort.leader", asked)
    ) as { state?: string; connectionId?: string; paneId?: string };
    return answer.state === "ready" &&
      answer.connectionId === connectionId &&
      answer.paneId
      ? answer.paneId
      : null;
  } catch {
    return null;
  }
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

/** Whether the Rust core owns the reviews now (the review family). */
function reviewsOnCore(): boolean {
  return !!coreFront && !bunOwns("review");
}

type ReverseArgs = Record<string, unknown>;
const argText = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * The review family's reverse calls (contract/wire/core-channel.md): what
 * the core's review service asks of Bun while it owns the reviews.
 */
function reviewReverseTargets() {
  return {
    // The core takes the reviews: Bun's service stops and lets go of
    // reviews.sqlite before the core opens it.
    "review.release": async () => {
      const service = reviewService;
      reviewService = null;
      reviewStorageForHistory = null;
      service?.close();
      return {};
    },
    // A push of the core's service: what Bun does with it besides the
    // browsers (which the core's push reaches itself).
    // The core's sockets took the paths over: what reached Bun's
    // listeners before goes on to them. Bun's listeners stay, unreached
    // (stopping one would remove the path), until the family comes back.
    "review.socketsTaken": async () => {
      reviewSocketsTaken.resolve(true);
      logger.child("review").info("agent sockets handed to the Rust core", {
        sockets: [...reviewAgentSockets].join(" "),
      });
      return {};
    },
    "review.published": async (args: unknown) => {
      const push = (args ?? {}) as ReverseArgs;
      const sessionId = argText(push.sessionId);
      if (push.type === "prompts") reviewPushEffects(push as ReviewPush);
      if (push.type === "removed" && sessionId)
        historyChanged("reviews", sessionId);
      if (push.type === "session" && sessionId) {
        historyChanged("reviews", sessionId);
        const item = argText(push.workItem);
        if (item) {
          historyChanged("work", item);
          workQuestionsSeen(
            item,
            (Array.isArray(push.threads) ? push.threads : []) as Parameters<
              WorkService["questionsSeen"]
            >[1],
          );
        }
      }
      return {};
    },
    "review.host": (args: unknown) =>
      reviewHostCall((args ?? {}) as ReverseArgs),
    "review.forge": (args: unknown) =>
      reviewForgeCall((args ?? {}) as ReverseArgs),
    "review.connection": (args: unknown) =>
      reviewConnectionCall((args ?? {}) as ReverseArgs),
    "review.socket": (args: unknown, _ctx: unknown, signal: AbortSignal) =>
      reviewSocketCall((args ?? {}) as ReverseArgs, signal),
  };
}

/**
 * What the core's agent socket asks of Bun (`review.socket`): the
 * connections' checkouts, the boards, notifications, the agent messenger,
 * conversation mode's holder, prepared launches, and the Claude mod's
 * hub, as Bun's own socket gets them. A failure carries its status.
 */
async function reviewSocketCall(
  args: ReverseArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const input = (args.input ?? {}) as ReverseArgs;
  const host = reviewAgentHost();
  const connectionId = argText(input.connectionId);
  const paneId = argText(input.paneId);
  const form = () =>
    new URLSearchParams(
      Object.entries((input.form ?? {}) as Record<string, unknown>).map(
        ([key, value]) => [key, String(value)],
      ),
    );
  const connection = () => {
    const found = host.connections().find((each) => each.id === connectionId);
    if (!found) throw new ReviewError("this connection is not ready", 503);
    return found;
  };
  try {
    switch (args.op) {
      case "connections":
        return host.connections().map((each) => ({
          id: each.id,
          herdrSocketPath: each.herdrSocketPath,
          sshHost: each.sshHost,
          lastSteps: !!each.readLastStep,
        }));
      case "readRoot":
        return await connection().readRoot(argText(input.path));
      case "readDefaultBase":
        return await connection().readDefaultBase(argText(input.root));
      case "readLastStep":
        return (
          (await connection().readLastStep?.(
            argText(input.root),
            argText(input.workspaceId),
          )) ?? null
        );
      case "hasViewers":
        return host.hasViewers();
      case "notify":
        await host.notify(input as Parameters<typeof host.notify>[0]);
        return {};
      case "workspaces":
        return await host.workspaces(
          input as Parameters<typeof host.workspaces>[0],
        );
      case "reviews":
        return await host.reviews(input as Parameters<typeof host.reviews>[0]);
      case "work":
        return await host.work(input as Parameters<typeof host.work>[0]);
      case "messagesList":
        return await host.messages.list();
      case "messagesSend":
        return await host.messages.send(
          input as Parameters<typeof host.messages.send>[0],
        );
      case "claudeStart":
        return await host.claudeStart(
          input as Parameters<typeof host.claudeStart>[0],
        );
      case "launch":
        return (
          (await host.launch(input as Parameters<typeof host.launch>[0])) ??
          null
        );
      case "hold":
        return await host.holder.hold({
          connectionId,
          paneId,
          sessionId: argText(input.sessionId),
          signal,
          status: parseHolderStatus(form()),
          shell: parseHolderShell(form()),
        });
      case "fg": {
        const spec = parseSuspendedSpec(form());
        if (!spec) throw new ReviewError("invalid stopped session");
        return await host.holder.fg({
          connectionId,
          paneId,
          spec,
          status: parseHolderStatus(form()),
          shell: parseHolderShell(form()),
        });
      }
      case "holdOutput":
        return await host.holder.output(
          input as Parameters<typeof host.holder.output>[0],
        );
      case "handback":
        return await host.holder.handback({
          connectionId,
          paneId,
          sessionId: argText(input.sessionId),
        });
      case "mod":
        return await getReviewAgent().modRequest(
          connectionId,
          argText(input.command) as Parameters<
            ReviewAgentServer["modRequest"]
          >[1],
          form(),
          signal,
        );
    }
    throw new ReviewError(`unknown review socket op ${String(args.op)}`);
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    const code = (error as { code?: unknown }).code;
    throw new ChannelError(
      error instanceof Error ? error.message : String(error),
      typeof code === "string" ? code : undefined,
      typeof status === "number" ? { status } : undefined,
    );
  }
}

/** The review service's effects, for the core's (`review.host`). */
async function reviewHostCall(args: ReverseArgs): Promise<unknown> {
  const host = reviewServiceHost();
  const session = args.session as ReviewSession;
  const commit = typeof args.commit === "string" ? args.commit : undefined;
  const connectionId = argText(args.connection_id);
  const paneId = argText(args.pane_id);
  switch (args.op) {
    case "loadDiff":
      return host.loadDiff(
        session,
        commit,
        Array.isArray(args.paths)
          ? { paths: args.paths as string[] }
          : undefined,
      );
    case "loadSummary":
      return host.loadSummary(session, commit);
    case "loadFiles":
      return host.loadFiles(
        session,
        args.ends as { base: string; head: string },
        args.files as Parameters<typeof host.loadFiles>[2],
      );
    case "loadCommits":
      return host.loadCommits(session);
    case "loadPatchIds":
      return host.loadPatchIds(session, args.shas as string[]);
    case "loadState":
      return host.loadState(session);
    case "loadHeads":
      return host.loadHeads(
        connectionId,
        args.entries as { root: string; ref: string }[],
      );
    case "loadFile":
      return host.loadFile(session, argText(args.rev), argText(args.path));
    case "promptAgent":
      await host.promptAgent(connectionId, paneId, argText(args.text));
      return {};
    case "sessionPane":
      return host.sessionPane(connectionId, argText(args.session_id));
    case "paneSession":
      return host.paneSession(connectionId, paneId);
    case "agentCompactedSince":
      return host.agentCompactedSince(
        connectionId,
        paneId,
        argText(args.since),
      );
    case "noteCause":
      // All an agent is sent by a review is the user's doing.
      turnCauses.note(connectionId, paneId, { by: "user", via: "review" });
      return {};
  }
  throw new Error(`unknown review host op ${String(args.op)}`);
}

/** The forge of merge requests' reviews, for the core's (`review.forge`). */
async function reviewForgeCall(args: ReverseArgs): Promise<unknown> {
  const host = reviewServiceHost();
  const session = args.session as ReviewSession;
  const mr = args.mr as MergeRequestInfo;
  const context = () => host.gitlab.context(session);
  switch (args.op) {
    case "checkout":
      return host.gitlab.checkout(session);
    case "find":
      return (
        (await host.gitlab.find(
          session,
          args.checkout as Parameters<typeof host.gitlab.find>[1],
        )) ?? null
      );
    case "readMergeRequest":
      return readMergeRequest(context(), argText(args.url));
    case "readThreads":
      return readMergeRequestThreads(context(), mr, session.id);
    case "createDraftNote":
      return draftThread(
        await createDraftNote(
          context(),
          mr,
          args.anchor as ReviewAnchor,
          argText(args.note),
          (args.diff ?? undefined) as Parameters<typeof createDraftNote>[4],
        ),
        session.id,
        mr,
      );
    case "updateDraftNote":
      return draftThread(
        await updateDraftNote(
          context(),
          mr,
          Number(args.id),
          argText(args.note),
        ),
        session.id,
        mr,
      );
    case "deleteDraftNote":
      await deleteDraftNote(context(), mr, Number(args.id));
      return {};
    case "createDraftReply":
      return draftReply(
        await createDraftReply(
          context(),
          mr,
          argText(args.discussion),
          argText(args.note),
        ),
      );
  }
  throw new Error(`unknown review forge op ${String(args.op)}`);
}

/** A browser connection's reads, for the core's review calls. */
async function reviewConnectionCall(args: ReverseArgs): Promise<unknown> {
  if (args.op === "id") return connectionManager.defaultId();
  const connection = reviewRpcConnection(coreRuntime(args));
  const unavailable = () => new ReviewError("pages cannot be shown here", 503);
  switch (args.op) {
    case "resolveRoot":
      return connection.resolveRoot(argText(args.workspace_id));
    case "readDefaultBase":
      if (!connection.readDefaultBase) throw new Error("no default branch");
      return connection.readDefaultBase(argText(args.root));
    case "readRoot":
      if (!connection.readRoot) throw new Error("no repository reads");
      return connection.readRoot(argText(args.path));
    case "scanRepos":
      return connection.scanRepos
        ? connection.scanRepos(
            args.paths as string[],
            args.agent_paths as string[],
          )
        : [];
    case "renderedPage":
      if (!connection.renderedPage) throw unavailable();
      return connection.renderedPage(
        { root: argText(args.root), target: args.target as ReviewTarget },
        typeof args.page === "string" ? args.page : undefined,
        args.scripts === true,
      );
    case "renderedSvg":
      if (!connection.renderedSvg) throw unavailable();
      return connection.renderedSvg(
        argText(args.svg),
        typeof args.color === "string" ? args.color : undefined,
        args.scripts === true,
      );
    case "renderedStorage": {
      const write = parseStorageWrite(args.write);
      if (!connection.renderedStorage || !write)
        throw new ReviewError("invalid storage write");
      try {
        return connection.renderedStorage(argText(args.token), write);
      } catch (error) {
        if (error instanceof Error && error.name === "QuotaExceededError")
          throw Object.assign(new Error("the site's storage is full"), {
            code: "quota",
          });
        throw error;
      }
    }
    case "clearRenderedStorage":
      if (!connection.clearRenderedStorage)
        throw new ReviewError("invalid site");
      connection.clearRenderedStorage(argText(args.site));
      return {};
  }
  throw new Error(`unknown review connection op ${String(args.op)}`);
}

/**
 * While the core owns the reviews: what it asks of Bun's agents without
 * waiting (whether a host runs the review client, whether a pane's Claude
 * has the mod's tools), sent whenever it changes.
 */
let reviewAgentsTimer: ReturnType<typeof setInterval> | null = null;
/**
 * The agent sockets this server serves (`@local`, and each SSH connection
 * whose host forwards to one): Bun's, or the core's while it owns the
 * reviews.
 */
const reviewAgentSockets = new Set<string>();
let reviewAgentsSent = "";
function sendReviewAgents(): void {
  const front = coreFront;
  if (!front || !reviewsOnCore()) return;
  const host = reviewServiceHost();
  const channels: Record<string, boolean> = {};
  for (const status of connectionManager.list())
    channels[status.id] = host.agentChannel(status.id);
  const agents = {
    channels,
    tools: claudeModHub.toolsState(),
    socket_keys: [...reviewAgentSockets],
  };
  const state = JSON.stringify(agents);
  if (state === reviewAgentsSent) return;
  reviewAgentsSent = state;
  front
    .callInternal("review", "agents", agents)
    .catch(() => (reviewAgentsSent = ""));
}

/** Settles once the core listens on the agent sockets (true), or not. */
let reviewSocketsTaken = Promise.withResolvers<boolean>();

/**
 * Where a request to Bun's agent socket goes while the core takes the
 * family: the core's socket once it listens, after at most 15 s.
 */
async function reviewSocketElsewhere(
  socketKey: string,
): Promise<string | null> {
  if (!reviewsOnCore()) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const taken = await Promise.race([
    reviewSocketsTaken.promise,
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 15_000);
    }),
  ]);
  clearTimeout(timer);
  return taken && reviewsOnCore()
    ? getReviewAgent().socketPathFor(socketKey)
    : null;
}

let reviewsWereOnCore = false;
onOwnershipChanged(() => {
  const onCore = reviewsOnCore();
  if (onCore === reviewsWereOnCore) return;
  reviewsWereOnCore = onCore;
  const log = logger.child("review");
  if (onCore) {
    reviewAgentsSent = "";
    sendReviewAgents();
    reviewAgentsTimer = setInterval(sendReviewAgents, 1000);
    (reviewAgentsTimer as { unref?: () => void }).unref?.();
    log.info("handed to the Rust core");
    return;
  }
  if (reviewAgentsTimer) clearInterval(reviewAgentsTimer);
  reviewAgentsTimer = null;
  reviewSocketsTaken.resolve(false);
  reviewSocketsTaken = Promise.withResolvers<boolean>();
  // The core's service and sockets stop before Bun opens reviews.sqlite
  // and listens again.
  void (coreFront?.callInternal("review", "close", {}) ?? Promise.resolve())
    .catch(() => {})
    .then(() => {
      if (reviewsOnCore()) return;
      // Its listeners, unreached since the handover, go first.
      reviewAgent?.stop();
      listenReviewAgentSockets();
      log.info("served by Bun again");
    });
});

/** A browser connection's reads for the review calls (review/rpc.ts). */
function reviewRpcConnection(
  connection: LegacyConnectionRuntime,
): ReviewRpcConnection {
  return {
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
    renderedStorage: (token, write) =>
      renderedPages.writeStorage(connection.identity.id, token, write),
    clearRenderedStorage: (site) => renderedStorage.clear(site),
    renderedSvg: (svg, color, scripts) => {
      const mode = scripts ? "site" : "static";
      return {
        src: `${RENDERED_PREFIX}${renderedPages.mint({
          connectionId: connection.identity.id,
          mode,
          source: { kind: "inline", body: renderedSvgPage(svg, color) },
        })}/`,
        mode,
      };
    },
    renderedPage: async (place, page, scripts) => {
      if (place.target.kind !== "rendered")
        throw new ReviewError("not a rendered review");
      const settings = await readGuiSettings();
      let address: ReturnType<typeof renderedAddress>;
      try {
        address = renderedAddress({
          target: place.target,
          root: place.root,
          sites: settings.rendered_sites ?? [],
          page,
          scripts,
          // The root set in Settings wins over the one found.
          rootOf: (site) => {
            const explicit = settings.rendered_site_roots?.[site];
            if (explicit) return { root: explicit, explicit: true };
            const found = renderedPages.siteRoot(connection.identity.id, site);
            return found ? { root: found, explicit: false } : undefined;
          },
        });
      } catch (error) {
        throw new ReviewError(
          error instanceof Error ? error.message : String(error),
        );
      }
      const token = renderedPages.mint({
        connectionId: connection.identity.id,
        mode: address.mode,
        source: address.source,
        ...(address.home ? { home: address.home } : {}),
      });
      return {
        src: `${RENDERED_PREFIX}${token}/${address.rest}`,
        mode: address.mode,
        ...(address.site ? { site: address.site } : {}),
      };
    },
  };
}

/** An image pasted into a review comment, to the signed-in browser. */
async function serveReviewImage(url: URL): Promise<Response> {
  // An agent's image named by its path: it may change, so not kept.
  const named = url.searchParams.get("path");
  const image =
    named !== null
      ? await localImageFile(named)
      : reviewImageFile(
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
      "cache-control":
        named !== null
          ? "private, no-cache"
          : "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    },
  });
}

/**
 * Pages of rendered reviews (HTML files, sites), served to sandboxed frames
 * under `/rendered/<token>/` before the authentication gate: the token is
 * their credential (server/src/http/rendered-pages.ts).
 */
const renderedStorage = createSiteStorage(renderedStoragePath());
const renderedPages = createRenderedPages({
  storage: renderedStorage,
  findRoot: connectionRootFinder({
    sshHost: (connectionId) =>
      resolveReadyConnection(connectionManager, connectionId).runtime.sshHost(),
    home: homedir(),
    exists: (path) =>
      stat(path).then(
        () => true,
        () => false,
      ),
    runRemote: async (host, script) => {
      const result = await runProcessWithCodeTimeout(
        sshReadCommandArgv(
          host,
          `sh -c ${shQuote(script)}`,
          [],
          "rendered.root",
        ),
        15_000,
      );
      return { code: result.code, stdout: result.stdout };
    },
    shQuote,
  }),
  readFile: connectionFileReader({
    sshHost: (connectionId) =>
      resolveReadyConnection(connectionManager, connectionId).runtime.sshHost(),
    readLocal: async (root, path) => {
      const download = await downloadLocalFile(root, path);
      return {
        body: download.body,
        size: download.size,
        contentType: download.contentType,
      };
    },
    readRemote: async (host, root, path) => {
      const download = await downloadRemoteFile({
        host,
        rootPath: root,
        requestedPath: path,
        runProcessWithCodeTimeout,
        shQuote,
        // Read whole over SSH: refused above this before any byte comes.
        options: { maxBytes: RENDERED_BODY_MAX_BYTES },
      });
      return {
        body: download.body,
        size: download.size,
        contentType: download.contentType,
      };
    },
  }),
});

/**
 * What a review push does in Bun besides reaching the browsers: the
 * notification feed's prompts and the Work board's questions. Also run
 * for the pushes of the core's review service (`review.published`).
 */
function reviewPushEffects(push: ReviewPush): void {
  if (push.type === "prompts") notifyPrompts(push.connectionId, push.prompts);
  // A work item's review: the questions its owner asks on its
  // description, counted on its card.
  if (push.type === "session" && push.snapshot.session.target.kind === "work")
    workQuestionsSeen(push.snapshot.session.target.item, push.snapshot.threads);
}

/** A work item's review threads seen: by the core while it serves Work. */
function workQuestionsSeen(
  item: string,
  threads: Parameters<WorkService["questionsSeen"]>[1],
): void {
  if (coreServesWork())
    void coreWorkCall("questions_seen", { item, threads }).catch(
      () => undefined,
    );
  else workService?.questionsSeen(item, threads);
}

/** A review push to every browser, and what Bun does with it. */
function publishReview(push: ReviewPush): void {
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
  reviewPushEffects(push);
}

/**
 * What the review service asks of the rest of the server: git reads of a
 * checkout, agent panes and sessions, the Claude mod's word on a pane and
 * the forge. Bun's service gets it, and so does the Rust core's while it
 * owns the reviews (the `review.host` and `review.forge` reverse calls).
 */
function reviewServiceHost() {
  const runtimeOf = (connectionId: string) =>
    resolveReadyConnection(connectionManager, connectionId).runtime;
  /** A merge request's commit not in the checkout: the forge's diff, whole. */
  const forgeCommitDiff = async (
    runtime: ReturnType<typeof runtimeOf>,
    root: string,
    target: { url: string },
    commit: string,
  ) => {
    const context = reviewGlabContext(runtime, root);
    const mr = await readMergeRequest(context, target.url);
    const listed = (await readMergeRequestCommits(context, mr)).find((entry) =>
      entry.sha.startsWith(commit),
    );
    return readCommitDiff(context, mr, commit, listed?.parent ?? null);
  };
  return {
    loadCommits: async (session) => {
      const runtime = runtimeOf(session.connectionId);
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
      const runtime = runtimeOf(session.connectionId);
      return runtime.files.readReviewPatchIds(session.root, shas);
    },
    loadSummary: async (session, commit) => {
      const runtime = runtimeOf(session.connectionId);
      if (commit) {
        try {
          return await runtime.files.readReviewSummary(session.root, {
            commit,
          });
        } catch (error) {
          if (session.target.kind !== "mr") throw error;
          return forgeCommitDiff(runtime, session.root, session.target, commit);
        }
      }
      if (session.target.kind !== "mr")
        return runtime.files.readReviewSummary(session.root, {
          target: session.target,
        });
      // A merge request: its files from the checkout when it has its
      // commits, else GitLab's whole diff.
      const context = reviewGlabContext(runtime, session.root);
      const mr = await readMergeRequest(context, session.target.url);
      try {
        return await runtime.files.readReviewSummary(session.root, {
          target: { kind: "range", base: mr.baseSha, head: mr.headSha },
        });
      } catch {
        return readMergeRequestDiff(context, mr);
      }
    },
    loadFiles: (session, ends, files) => {
      const runtime = runtimeOf(session.connectionId);
      return runtime.files.readReviewFiles(session.root, ends, files);
    },
    loadDiff: async (session, commit, options) => {
      const runtime = runtimeOf(session.connectionId);
      if (commit) {
        try {
          return await runtime.files.readReviewCommitPatch(
            session.root,
            commit,
          );
        } catch (error) {
          if (session.target.kind !== "mr") throw error;
          return forgeCommitDiff(runtime, session.root, session.target, commit);
        }
      }
      if (session.target.kind !== "mr")
        return runtime.files.readReviewPatch(
          session.root,
          session.target,
          options?.paths,
        );
      // A merge request: diff its commits locally when the checkout has
      // them (one host command), else ask GitLab for the diff.
      const context = reviewGlabContext(runtime, session.root);
      const mr = await readMergeRequest(context, session.target.url);
      try {
        const diff = await runtime.files.readReviewPatch(
          session.root,
          { kind: "range", base: mr.baseSha, head: mr.headSha },
          options?.paths,
        );
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
    // A Claude whose Roamgate mod said it has the tools answers with them.
    agentTools: (connectionId, paneId) =>
      claudeModHub.hasTools(connectionId, paneId),
    agentWorkTools: (connectionId, paneId) =>
      claudeModHub.hasWorkTools(connectionId, paneId),
    // Its mod's system prompt section holds the rules: short deliveries.
    agentRules: (connectionId, paneId) =>
      claudeModHub.hasRules(connectionId, paneId),
    agentCompactedSince: async (connectionId, paneId, since) => {
      if (rangerChatSession(paneId)) return false;
      const runtime = connectionManager.readyRuntime(connectionId);
      if (!runtime || runtime.remotePlatform === "windows") return false;
      return runtime.agentSessions.compactedSince(paneId, since);
    },
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
        if (assistantOnCore())
          await coreFront!.callInternal("assistant", "deliver_chat_comments", {
            session_id: rangerChat,
            text,
          });
        else
          await (await getAssistantService()).deliverChatComments(
            rangerChat,
            text,
          );
        return;
      }
      const runtime = runtimeOf(connectionId);
      await promptPaneAgent(runtime, paneId, text, "review");
    },
    // The comments follow the agent's session to the pane it runs in now.
    sessionPane: async (connectionId, sessionId) => {
      // A Ranger chat is in no pane: its threads go to the chat itself.
      if (rangerChatSession(sessionId)) return sessionId;
      // An effort's threads go to its leader, whichever pane runs it now.
      if (sessionId.startsWith(EFFORT_SESSION_PREFIX))
        return effortLeaderPane(
          connectionId,
          sessionId.slice(EFFORT_SESSION_PREFIX.length),
        );
      // A work item's go to its owner's pane, on the owner's connection.
      if (sessionId.startsWith(WORK_SESSION_PREFIX)) {
        const item = sessionId.slice(WORK_SESSION_PREFIX.length);
        if (coreServesWork())
          return (
            (await coreWorkCall("owner_pane", {
              item,
              connection_id: connectionId,
            })) as { pane: string | null }
          ).pane;
        return getWorkService().ownerPane(item, connectionId);
      }
      const runtime = runtimeOf(connectionId);
      return runtime.agentSessions.sessionPane(sessionId);
    },
    paneSession: async (connectionId, paneId) => {
      if (rangerChatSession(paneId)) return null;
      const runtime = runtimeOf(connectionId);
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
        const runtime = runtimeOf(session.connectionId);
        return reviewGlabContext(runtime, session.root);
      },
      checkout: (session) => {
        const runtime = runtimeOf(session.connectionId);
        return readCheckout(reviewGlabContext(runtime, session.root));
      },
      find: (session, checkout) => {
        const runtime = runtimeOf(session.connectionId);
        return findBranchMergeRequest(
          reviewGlabContext(runtime, session.root),
          checkout,
          reviewProjectIds,
        );
      },
    },
    loadState: (session) => {
      const runtime = runtimeOf(session.connectionId);
      return runtime.files.readReviewState(session.root, session.target);
    },
    loadHeads: (connectionId, entries) => {
      const runtime = runtimeOf(connectionId);
      return runtime.files.readReviewHeads(entries);
    },
    loadFile: async (session, rev, path) => {
      const runtime = runtimeOf(session.connectionId);
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
  } satisfies Partial<Parameters<typeof createReviewService>[0]>;
}

/** The kept steps of each checkout the core's service last said. */
const coreKeptSteps = new Map<string, readonly string[]>();
/**
 * The steps of a checkout whose review has threads. While the core owns
 * the reviews, what it said last, asked again for the next time.
 */
function keptLastSteps(root: string): readonly string[] {
  if (!reviewsOnCore()) return getReviewService().keptSteps(root);
  void coreFront
    ?.callInternal("review", "call", { method: "keptSteps", params: { root } })
    .then((steps) => {
      if (Array.isArray(steps)) coreKeptSteps.set(root, steps as string[]);
    })
    .catch(() => {});
  return coreKeptSteps.get(root) ?? [];
}

/**
 * Bun's review service as its users hold it: each use reaches the one
 * open now, so a use while the core owns the reviews fails instead of
 * writing a closed copy.
 */
const liveReviewService = new Proxy({} as ReviewService, {
  get: (_target, key) => Reflect.get(getReviewService(), key),
});

/** The core's review service, while it owns the reviews. */
function coreReviews<T>(
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  if (!coreFront) throw new Error("no Rust core");
  return coreFront.callInternal(
    "review",
    "call",
    { method, params },
    signal,
  ) as Promise<T>;
}

/** The newest of the core's reviews `matches` takes (`newest`). */
async function coreNewestReview(
  matches: (session: ReviewSession) => boolean,
): Promise<ReviewSnapshot | null> {
  // Listed newest first.
  const listed = await coreReviews<ReviewSnapshot[]>("list", { chats: true });
  return listed.find(({ session }) => matches(session)) ?? null;
}

/**
 * A use of the review service that waits: Bun's, or the core's while it
 * owns the reviews (`internal.review.call`).
 */
async function reviewServiceCall(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (coreFront && reviewsOnCore())
    return coreFront.callInternal("review", "call", { method, params });
  const service = getReviewService();
  switch (method) {
    case "addThread":
      return service.addThread(params);
    case "replyInChat":
      return service.replyInChat(
        params as Parameters<ReviewService["replyInChat"]>[0],
      );
    case "prompts.list":
      return service.prompts.list(String(params.connectionId ?? ""));
  }
  throw new Error(`unknown review service method ${method}`);
}

let reviewService: ReviewService | null = null;
/** Bun's review service: refused while the Rust core owns the reviews. */
function getReviewService(): ReviewService {
  if (reviewService) return reviewService;
  if (reviewsOnCore())
    throw new ReviewError("the reviews are served by the Rust core now", 503);
  const storage = withHistoryHooks(
    openReviewStorage(reviewDirectory()),
    historyChanged,
  );
  reviewStorageForHistory = storage;
  reviewService = createReviewService({
    storage,
    publish: publishReview,
    ...reviewServiceHost(),
  });
  // A last step's snapshots stay while its review has threads.
  keepLastSteps(keptLastSteps);
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

/**
 * Agent sessions messaging each other (`roamgate-review sessions` and
 * `message`), across every ready connection.
 */
let agentMessenger: AgentMessenger | null = null;
function getAgentMessenger(): AgentMessenger {
  agentMessenger ??= createAgentMessenger({
    connections: () =>
      connectionManager.list().flatMap((status) => {
        const runtime = connectionManager.readyRuntime(status.id);
        return runtime && runtime.remotePlatform !== "windows"
          ? [runtime.identity.id]
          : [];
      }),
    runtime: (connectionId) => {
      const runtime = connectionManager.readyRuntime(connectionId);
      if (!runtime || runtime.remotePlatform === "windows") return null;
      return {
        conversation: {
          holds: (paneId) => !!runtime.conversation.lease(paneId),
          status: (paneId) => runtime.conversation.state(paneId).status,
          // Another agent's message: no idle stop for a while after it.
          prompt: (paneId, text) =>
            runtime.conversation.prompt(paneId, text, undefined, {
              peer: true,
            }),
        },
        claudeMod: runtime.claudeMod,
        herdr: runtime.herdr,
        read: async () => {
          const [workspaces, tabs, panes, agents] = await Promise.all([
            runtime.herdr.call("workspace.list", {}, 5000),
            runtime.herdr.call("tab.list", {}, 5000),
            runtime.herdr.call("pane.list", {}, 5000),
            runtime.agentSessions.listWithActivity({}),
          ]);
          return {
            workspaces: (workspaces as any)?.workspaces ?? [],
            tabs: (tabs as any)?.tabs ?? [],
            panes: (panes as any)?.panes ?? [],
            agents: (agents as any)?.agents ?? [],
          };
        },
      };
    },
    log: (message, fields) => logger.info(message, fields),
  });
  return agentMessenger;
}

/** An agent's workspace as the user knows it, for what they are told. */
async function agentWorkspaceLabel(
  connectionId: string,
  workspaceId: string,
): Promise<string> {
  const runtime = connectionManager.readyRuntime(connectionId);
  if (!runtime || !workspaceId) return "a session";
  try {
    const listed = await runtime.herdr.call("workspace.list", {});
    const found = (
      Array.isArray(listed?.workspaces) ? listed.workspaces : []
    ).find((each: any) => each?.workspace_id === workspaceId);
    return typeof found?.label === "string" && found.label.trim()
      ? found.label.trim().slice(0, 60)
      : "a session";
  } catch {
    return "a session";
  }
}

let reviewAgent: ReviewAgentServer | null = null;
/** The review client and its socket are set up on this machine. */
let reviewAgentInstalled = false;
/** SSH connections whose host has the review client and its socket. */
const reviewAgentHosts = new Set<string>();
/**
 * What the agent socket asks of the rest of the server besides the review
 * service and the Claude mod's hub: Bun's socket gets it, and so does the
 * Rust core's while it owns the reviews (the `review.socket` reverse call).
 */
function reviewAgentHost() {
  return {
    hasViewers: () => clients.size > 0,
    notify: notifyFromAgent,
    workspaces: workspaceFromAgent,
    messages: getAgentMessenger(),
    // The Reviews board's tools, for any agent session.
    reviews: async ({ connectionId, workspaceId, agent, tool, params }) => {
      const caller = `${agent || "Claude"} in ${await agentWorkspaceLabel(connectionId, workspaceId)}`;
      if (coreServesMrReviews())
        return (
          (await coreFront!.callInternal("mr_reviews", "board_tool", {
            tool,
            params,
            caller,
          })) as { text: string }
        ).text;
      return getMrReviews().boardTool(tool, params, caller);
    },
    // The Work board's tools, for any agent session.
    work: async ({
      connectionId,
      paneId,
      workspaceId,
      agent,
      tool,
      params,
    }) => {
      try {
        const caller = `${agent || "Claude"} in ${await agentWorkspaceLabel(connectionId, workspaceId)}`;
        const address = paneId ? `${connectionId}/${paneId}` : undefined;
        if (coreServesWork())
          return (
            (await coreWorkCall("tool", {
              tool,
              params,
              caller,
              ...(address ? { address } : {}),
            })) as { text: string }
          ).text;
        return await workTool(getWorkService(), tool, params, caller, address);
      } catch (error) {
        if (error instanceof WorkError)
          throw Object.assign(new Error(error.message), { code: error.code });
        throw error;
      }
    },
    // A claude started by hand in a pane: the claude start setting says
    // whether conversation mode takes it.
    claudeStart: async ({ connectionId, paneId, sessionId, source }) => {
      const runtime = connectionManager.readyRuntime(connectionId);
      if (!runtime)
        return { action: "terminal", reason: "this connection is not ready" };
      if (claudeStartMode(await readGuiSettings()) !== "conversation")
        return { action: "terminal", reason: "the setting says terminal" };
      const started = await runtime.conversation.autoStart(paneId, sessionId);
      logger.info("claude started in a pane", {
        connection: connectionId,
        pane: paneId,
        source,
        taken: started.ok,
        ...(started.ok ? {} : { reason: started.reason }),
      });
      return started.ok
        ? { action: "conversation" }
        : { action: "terminal", reason: started.reason };
    },
    // Profile starts typed into a pane (roamgate-hold --launch).
    launch: ({ connectionId, paneId, token }) =>
      launchRegistry().take(connectionId, paneId, token),
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
            readLastStep: (root: string, workspaceId: string) =>
              runtime.files.readLastStep(root, workspaceId),
          },
        ];
      }),
  } satisfies Partial<Parameters<typeof createReviewAgentServer>[0]>;
}

/** Bun listens again on the agent sockets it serves. */
function listenReviewAgentSockets(): void {
  for (const key of reviewAgentSockets) {
    try {
      if (key === LOCAL_SOCKET_KEY) getReviewAgent().installLocal();
      else getReviewAgent().listen(key);
    } catch (error) {
      logger.warn("review agent socket unavailable", {
        connection: key,
        error: sanitizeConnectionError(error),
      });
    }
  }
}

function getReviewAgent(): ReviewAgentServer {
  reviewAgent ??= createReviewAgentServer({
    service: liveReviewService,
    ready: () => hostSettling,
    claudeMod: claudeModHub,
    directory: reviewDirectory(),
    logger: logger.child("review"),
    elsewhere: reviewSocketElsewhere,
    ...reviewAgentHost(),
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
 * Withdraws a pane's notifications when their reason is gone: its agent
 * stopped waiting on the user, or the pane went away.
 */
function withdrawPaneNotifications(connectionId: string, event: unknown) {
  const name = herdrEventName(event)?.replaceAll("_", ".");
  const data = (event as { data?: Record<string, unknown> } | null)?.data;
  const paneId = data?.pane_id;
  if (typeof paneId !== "string" || !paneId) return;
  if (name === "pane.agent.status.changed") {
    if (data?.agent_status !== "blocked")
      notifications.clearBlockedPane(connectionId, paneId);
  } else if (name === "pane.closed" || name === "pane.exited")
    notifications.clearPane(connectionId, paneId);
}

/**
 * An agent's permission prompt or question waits on the user: one
 * notification each, with Allow and Deny on a permission; withdrawn once
 * it is answered or back in the terminal.
 */
function notifyPrompts(connectionId: string, prompts: AgentPermissionPrompt[]) {
  const before = notifiedPrompts.get(connectionId) ?? new Set<string>();
  const open = new Set(prompts.map((prompt) => prompt.id));
  for (const id of before) if (!open.has(id)) notifications.clearPrompt(id);
  if (open.size) notifiedPrompts.set(connectionId, open);
  else notifiedPrompts.delete(connectionId);
  for (const prompt of prompts) {
    if (before.has(prompt.id)) continue;
    void notifyPrompt(prompt);
  }
}

async function notifyPrompt(prompt: AgentPermissionPrompt) {
  const { connectionId, paneId } = prompt;
  const status = connectionManager
    .list()
    .find((each) => each.id === connectionId);
  if (!status) return;
  const { pane, workspaceLabel } = await paneWorkspace(connectionId, paneId);
  // Answered while its workspace was looked up: nothing to say any more.
  if (!notifiedPrompts.get(connectionId)?.has(prompt.id)) return;
  const question = prompt.questions?.[0]?.question;
  notifications.publish(
    {
      kind: "blocked",
      connectionId,
      runtimeGeneration: status.generation,
      paneId,
      ...(pane?.workspace_id ? { workspaceId: pane.workspace_id } : {}),
      ...(pane?.tab_id ? { tabId: pane.tab_id } : {}),
      ...(workspaceLabel ? { workspaceLabel } : {}),
      agent: prompt.agent,
      title: `${workspaceLabel ?? prompt.agent}: ${
        question
          ? `${prompt.agent} asks`
          : `${prompt.agent} wants ${prompt.tool}`
      }`,
      body: (question ?? prompt.summary).slice(0, 300),
    },
    prompt.questions
      ? {}
      : {
          actions: [
            { id: "allow", label: "Allow" },
            { id: "deny", label: "Deny" },
          ],
          prompt: { connectionId, promptId: prompt.id },
        },
  );
}

/** A pane's workspace and its label, for a notification; empty on errors. */
async function paneWorkspace(
  connectionId: string,
  paneId: string,
): Promise<{
  pane?: { workspace_id?: string; tab_id?: string };
  workspaceLabel?: string;
}> {
  const runtime = connectionManager.readyRuntime(connectionId);
  try {
    const [panes, workspaces] = (await Promise.all([
      runtime?.herdr.call("pane.list", {}),
      runtime?.herdr.call("workspace.list", {}),
    ])) as [
      { panes?: { pane_id: string; workspace_id?: string; tab_id?: string }[] },
      { workspaces?: { workspace_id: string; label?: string }[] },
    ];
    const pane = panes?.panes?.find((each) => each.pane_id === paneId);
    const workspaceLabel = workspaces?.workspaces?.find(
      (each) => each.workspace_id === pane?.workspace_id,
    )?.label;
    return { pane, ...(workspaceLabel ? { workspaceLabel } : {}) };
  } catch {
    // The notification still goes, without its workspace.
    return {};
  }
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
  if (agentSessionsOnCore())
    tellAgentSessions("note", {
      connection_id: connectionId,
      pane_id: paneId,
      text,
      ...(title ? { title } : {}),
    });
  else
    agentSeen.note(connectionId, paneId, { text, ...(title ? { title } : {}) });
  const status = connectionManager
    .list()
    .find((each) => each.id === connectionId);
  const { pane, workspaceLabel } = await paneWorkspace(connectionId, paneId);
  if (status)
    notifications.publish(
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
      { kind: "review" },
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

/**
 * Gives the connection's host the claude start hook (in Claude's user
 * settings) once the claude start setting is conversation for it. Once per
 * host and run; the hook stays (it does nothing while the setting says
 * terminal).
 */
async function ensureClaudeStartHook(connectionId: string) {
  const runtime = connectionManager.readyRuntime(connectionId);
  if (!runtime || runtime.remotePlatform === "windows") return;
  const host = runtime.sshHost();
  if (!host && process.platform === "win32") return;
  const key = host ? `ssh:${host}` : "local";
  if (claudeStartHooked.has(key)) return;
  if (claudeStartMode(await readGuiSettings()) !== "conversation") return;
  if (claudeStartHooked.has(key)) return;
  claudeStartHooked.add(key);
  const result = await runProcessWithCodeTimeout(
    host
      ? sshReadCommandArgv(
          host,
          claudeStartHookInstallCommand(),
          [],
          "claude.start_hook",
        )
      : claudeStartHookInstallArgv(),
    20_000,
  ).catch((error) => ({
    code: -1,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }));
  const outcome = result.stdout.trim();
  if (
    result.code === 0 &&
    ["installed", "present", "no-claude"].includes(outcome)
  ) {
    if (outcome !== "present")
      logger.info("claude start hook", { connection: connectionId, outcome });
    return;
  }
  claudeStartHooked.delete(key);
  logger.warn("claude start hook not installed", {
    connection: connectionId,
    outcome: outcome || `exit ${result.code}`,
    error: result.stderr.trim().slice(0, 300),
  });
}

/** Lets agents on an SSH host reach reviews over the master. */
function setupRemoteReviewAgent(
  connectionId: string,
  host: string,
  /** The master's, when the Rust core holds it (host.master_ready). */
  masterControlPath?: string,
) {
  // Until it is set up again, comments are not typed for a missing client.
  reviewAgentHosts.delete(connectionId);
  const controlPath = masterControlPath ?? sshMasterControlPath(host);
  if (!controlPath) return;
  let localSocket: string;
  try {
    // While the core owns the reviews it listens there (told the key).
    reviewAgentSockets.add(connectionId);
    if (reviewsOnCore()) {
      localSocket = getReviewAgent().socketPathFor(connectionId);
      sendReviewAgents();
    } else localSocket = getReviewAgent().listen(connectionId);
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
      if (reviewsOnCore()) sendReviewAgents();
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
  if (assistantOnCore()) {
    void coreFront!
      .callInternal("assistant", "resume", {})
      .catch(() => logger.warn("Ranger recovery could not be started"));
    return;
  }
  void assistantServiceTask
    ?.then((service) => service.resume())
    .catch(() => {
      logger.warn("Ranger recovery could not be started");
    });
}

/** The default connection's Herdr identity (setup's and the core's). */
function herdrSetupPing() {
  const runtime = connectionManager.defaultReadyRuntime();
  return runtime
    ? runtime.herdr.ping()
    : new HerdrClient(config.socketPath).ping();
}

/** What makes a managed Herdr impossible for the default connection. */
function herdrSetupGuard() {
  return herdrSetupGuardForProfile(
    config,
    connectionProfiles
      .list()
      .find((profile) => profile.id === connectionManager.defaultId()),
  );
}

const { handleHerdrStatus, handleHerdrSetup } = createHerdrSetupHandlers({
  ping: herdrSetupPing,
  guard: herdrSetupGuard,
});

/**
 * A generation's composition: Bun's whole runtime, or while the Rust core
 * owns the host family the part Bun keeps (`host`: Herdr through the core,
 * no transport or subscriptions of its own).
 */
function composeConnectionRuntime(
  identity: ConnectionIdentity,
  profileConfig: SshTunnelConfig,
  context: ConnectionRuntimeContext,
  options: { profileId?: string; host?: { herdr: HerdrClient } },
): LegacyConnectionRuntime {
  return createLegacyConnectionRuntime({
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
    conversationCore: conversationCoreFor(identity.id),
    claudeMod: claudeModHub,
    sessionIndexDir: defaultSessionIndexDir(),
    workspaceFront,
    // No terminal to fall back on: the prompt waits for a browser, and
    // its timeout denies.
    reviewRoots: (connectionId) =>
      reviewsOnCore()
        ? coreReviews<string[]>("roots", { connectionId })
        : getReviewService().roots(connectionId),
    askAgentPrompt: ({ connectionId, paneId, signal, ...prompt }) => {
      const asked = {
        ...prompt,
        connectionId,
        paneId,
        agent: "Claude",
        // A headless claude: there is no terminal to ask instead.
        noTerminal: true,
      };
      // The core's prompt goes when this one stops waiting.
      return reviewsOnCore()
        ? coreReviews<AgentPromptAnswer | null>(
            "prompts.request",
            asked,
            signal,
          ).catch((error) => {
            if (signal?.aborted) return null;
            throw error;
          })
        : getReviewService().prompts.request({ ...asked, signal });
    },
    onTaskEvent: (event) => {
      const connections = connectionProfiles.list();
      notifications.publish(
        {
          ...event,
          connectionId: identity.id,
          connectionLabel:
            connections.length > 1
              ? (connections.find((connection) => connection.id === identity.id)
                  ?.label ?? identity.label)
              : undefined,
          runtimeGeneration: context.generation,
        },
        { isCurrent: context.isCurrent },
      );
    },
    onPaneList: (result, startedAt) => {
      if (context.isCurrent())
        activity.paneList(identity.id, result, startedAt);
    },
    onOwnedAgentStatus: (paneId) => {
      if (!context.isCurrent()) return;
      activity.ownedAgentChanged(identity.id, paneId);
      // A conversation's turn ended (on a usage limit, maybe).
      pokeLimit(identity.id, paneId);
    },
    onEvent: (event, eventIdentity) => {
      if (!context.isCurrent()) return;
      // A conversation's lease changed: the pane's history may be
      // another file now (/clear), for the core's watchers too.
      const lease = event as {
        event?: unknown;
        data?: { pane_id?: unknown };
      };
      if (
        lease.event === "roamgate.conversation_lease" &&
        agentSessionsOnCore()
      )
        tellAgentSessions("refresh", {
          connection_id: eventIdentity.id,
          pane_id: lease.data?.pane_id,
        });
      withdrawPaneNotifications(eventIdentity.id, event);
      pokeLimitResumer(eventIdentity.id, event);
      activity.herdrEvent(eventIdentity.id, event);
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
    onClaudeStartSettingsChanged: () => {
      for (const status of connectionManager.list())
        void ensureClaudeStartHook(status.id);
    },
    onLimitResumeSettingsChanged: () => {
      for (const status of connectionManager.list()) pokeLimit(status.id);
    },
    onSshMasterReady:
      profileConfig.sshHost && !options.host
        ? () => {
            if (context.isCurrent() && profileConfig.sshHost)
              setupRemoteReviewAgent(identity.id, profileConfig.sshHost);
          }
        : undefined,
    onTransportExit:
      profileConfig.sshHost && options.profileId !== undefined
        ? (error) => {
            if (!context.isCurrent()) return;
            const profileId = options.profileId!;
            const reconnecting = bunConnectionProfiles.willRetry(
              profileId,
              error,
            );
            context.reportError(error, { reconnecting });
            bunConnectionProfiles.runtimeFailed(profileId, error);
          }
        : undefined,
    ...(options.host ? { host: options.host } : {}),
  });
}

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
      runtime = composeConnectionRuntime(identity, profileConfig, context, {
        profileId: profile.id,
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

const createBunConnectionProfiles = (bootstrap: ConnectionProfileBootstrap) =>
  new ConnectionProfileService({
    manager: connectionManager.bunManager(),
    store: connectionProfileStore,
    bootstrap,
    createRuntime: runtimeFactoryForProfile,
  });
let bunConnectionProfiles = createBunConnectionProfiles(connectionBootstrap);
/**
 * The profile service of whoever owns the host family: Bun's, or while the
 * Rust core owns it the list it says (its RPCs go to the core).
 */
const connectionProfiles = {
  list: () =>
    connectionManager.remoteConnections()?.profiles() ??
    bunConnectionProfiles.list(),
  bun: () => {
    if (connectionManager.remoteConnections())
      throw new Error("connections are the Rust core's now");
    return bunConnectionProfiles;
  },
  create: (value: unknown) => connectionProfiles.bun().create(value),
  update: (id: unknown, value: unknown) =>
    connectionProfiles.bun().update(id, value),
  remove: (id: unknown) => connectionProfiles.bun().remove(id),
  setDefault: (id: unknown) => connectionProfiles.bun().setDefault(id),
  connect: (id: unknown) => connectionProfiles.bun().connect(id),
  disconnect: (id: unknown) => connectionProfiles.bun().disconnect(id),
  test: (value: unknown) => connectionProfiles.bun().test(value),
};
// The host family on the Rust core (contract/wire/core-channel.md, The
// host family; connections/host-facade.ts). One switch for connections.json,
// the manager, the SSH masters and slots, and the Herdr subscriptions: Bun
// stops all its connections before the core starts its own, and the core
// stops all of its before Bun starts again, so a host never sees two
// masters or two sets of slots.
let hostRemote: RemoteConnections<LegacyConnectionRuntime> | null = null;
let hostSwitch: Promise<void> = Promise.resolve();
/** The server is stopping: nothing is handed over any more. */
let hostStopping = false;
/** Settles once the core took the connections (startup waits on it). */
let hostTaken = Promise.withResolvers<void>();
/**
 * Set while the connections are on their way to the core (at startup, or
 * a handover): browser calls wait for it, at most 10 s.
 */
let hostSettling: Promise<void> | null = null;
function settleHostWhile(work: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settling = Promise.race([
    work.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timer = realTimers.setTimeout(resolve, 10_000);
    }),
  ]).finally(() => {
    realTimers.clearTimeout(timer);
    if (hostSettling === settling) hostSettling = null;
  });
  hostSettling = settling;
}
/** startConnection ran: Bun starts its connections when it takes them back. */
let hostConnectionsStarted = false;
const HOST_HANDOVER_TIMEOUT_MS = 30_000;
const hostLog = logger.child("connections");

function hostCall(op: string, params: unknown, signal?: AbortSignal) {
  if (!coreFront) return Promise.reject(new Error("no Rust core"));
  return coreFront.callInternal("host", op, params, signal);
}

/**
 * The legacy connection as the core makes it, and the generations so far:
 * the next owner's continue from them, so a browser never sees one go back.
 */
function hostStartParams() {
  return {
    generations: Object.fromEntries(
      connectionManager.list().map((status) => [status.id, status.generation]),
    ),
    legacy: {
      socket_path: downstreamConnectionConfig.socketPath,
      client_socket_path: downstreamConnectionConfig.clientSocketPath,
      ssh_host: downstreamConnectionConfig.sshHost ?? null,
      session: downstreamConnectionConfig.session ?? null,
      has_explicit_socket_path:
        downstreamConnectionConfig.hasExplicitSocketPath,
      has_explicit_client_socket_path:
        downstreamConnectionConfig.hasExplicitClientSocketPath,
    },
    explicit_legacy_override: explicitLegacyOverride,
  };
}

async function handHostToCore() {
  hostLog.info("handing the connections to the Rust core");
  bunConnectionProfiles.stopSupervision();
  await connectionManager
    .bunManager()
    .stopAll()
    .catch(() => undefined);
  const remote = new RemoteConnections<LegacyConnectionRuntime>(
    connectionManager.defaultId(),
    hostLog,
  );
  // Until the core's first list: the connections Bun had, down.
  remote.update({
    default_connection_id: connectionManager.defaultId(),
    connections: bunConnectionProfiles.list(),
  });
  hostRemote = remote;
  connectionManager.useRemote(remote);
  setSshCommandFacade(sshCommandFacade(hostCall));
  try {
    const answer = (await hostCall(
      "start",
      hostStartParams(),
      AbortSignal.timeout(HOST_HANDOVER_TIMEOUT_MS),
    )) as HostStatusPush;
    if (hostRemote === remote) remote.update(answer);
    hostTaken.resolve();
  } catch (error) {
    hostLog.warn(
      "the Rust core did not take the connections; Bun serves them",
      {
        error: sanitizeConnectionError(error),
      },
    );
    if (hostRemote === remote) await takeHostBack();
  }
}

async function takeHostBack() {
  const remote = hostRemote;
  if (!remote) return;
  hostLog.info("taking the connections back from the Rust core");
  const generations = remote.list();
  hostRemote = null;
  hostTaken = Promise.withResolvers<void>();
  setSshCommandFacade(null);
  // The core stops its runtimes (the front's parts with them) and its SSH
  // processes; a core that is gone stopped them as it went.
  await hostCall(
    "stop",
    {},
    AbortSignal.timeout(HOST_HANDOVER_TIMEOUT_MS),
  ).catch(() => undefined);
  await Promise.all(
    remote.detachAll().map((runtime) => runtime.stop().catch(() => undefined)),
  );
  // Masters of a core that died with them still up.
  await sweepOrphanedSshMasters({ logger: logger.child("ssh") }).catch(
    () => undefined,
  );
  const bootstrap = loadConnectionBootstrap();
  connectionManager.useBun(
    createBunConnectionManager(bootstrap.defaultConnectionId),
  );
  bunConnectionProfiles = createBunConnectionProfiles(bootstrap);
  for (const status of generations)
    connectionManager
      .bunManager()
      .raiseGeneration(status.id, status.generation);
  if (hostConnectionsStarted)
    await bunConnectionProfiles.startConfigured().catch(() => undefined);
}

// A test clock moves no time while the connections go to the core: a
// deadline due meanwhile (a resumer's first look) finds them up, as it
// does when Bun starts its own.
activeTestClock()?.settleBefore(async () => {
  if (hostSettling) await hostSettling;
});

/** Who serves the connections follows the owners table and the core. */
function syncHostOwner(): Promise<void> {
  hostSwitch = hostSwitch.then(async () => {
    if (hostStopping) return;
    const wanted = !!coreFront && !bunOwns("host");
    if (wanted && !hostRemote) {
      const handover = handHostToCore();
      settleHostWhile(handover);
      await handover;
    } else if (!wanted && hostRemote) await takeHostBack();
  });
  return hostSwitch;
}
onOwnershipChanged(() => void syncHostOwner());

/**
 * The configured connections start: Bun's, unless the owners table gives
 * them to the core, which then gets a moment to connect and take them
 * (no SSH master is opened only to be closed again).
 */
async function startHostConnections() {
  hostConnectionsStarted = true;
  if (
    coreConfigured(process.env) &&
    readOwners(join(dataRoot(), "runtime")).owners.host === "rust"
  ) {
    // Real time: a test clock moves only when its harness says.
    settleHostWhile(hostTaken.promise);
    await hostSettling;
    await hostSwitch;
    if (hostRemote) return;
  }
  await bunConnectionProfiles.startConfigured();
}

/** At shutdown: the core's connections end while the channel is up. */
async function stopHostOnCore() {
  hostStopping = true;
  await hostSwitch;
  if (!hostRemote) return;
  await hostCall("stop", {}, AbortSignal.timeout(10_000)).catch(
    () => undefined,
  );
}

/** A reverse call's connection and generation. */
function hostTarget(args: unknown): { id: string; generation: number } {
  const { connection_id, generation } = (args ?? {}) as {
    connection_id?: unknown;
    generation?: unknown;
  };
  if (typeof connection_id !== "string" || typeof generation !== "number")
    throw new Error("needs a connection_id and a generation");
  return { id: connection_id, generation };
}

/** What the core's host family calls in Bun. */
const hostReverseTargets = {
  // Builds and starts the part of a generation Bun keeps.
  "host.runtime_start": async (args: unknown) => {
    const { id, generation } = hostTarget(args);
    const { identity, config } = (args ?? {}) as {
      identity?: ConnectionIdentity;
      config?: SshTunnelConfig;
    };
    const remote = hostRemote;
    if (!remote) throw new Error("the connections are Bun's");
    if (!identity || identity.id !== id || !config)
      throw new Error("host.runtime_start needs an identity and a config");
    const herdr = new RemoteHerdrClient(hostCall, id, generation);
    let runtime: LegacyConnectionRuntime | null = null;
    const context: ConnectionRuntimeContext = {
      generation,
      isCurrent: () =>
        hostRemote === remote &&
        runtime !== null &&
        remote.runtimeOf(id, generation) === runtime,
      // The core reports its transport's failures itself.
      reportError: () => undefined,
    };
    const built = composeConnectionRuntime(identity, config, context, {
      host: { herdr: herdr.asHerdrClient() },
    });
    runtime = built;
    remote.attach(id, generation, built);
    try {
      await built.startTransport();
      await built.startBackground();
    } catch (error) {
      remote.detach(id, generation);
      await built.stop().catch(() => undefined);
      throw error;
    }
    return { ok: true };
  },
  "host.runtime_stop": async (args: unknown) => {
    const { id, generation } = hostTarget(args);
    await hostRemote?.detach(id, generation)?.stop();
    return { ok: true };
  },
  "host.events": async (args: unknown) => {
    const { id, generation } = hostTarget(args);
    const { events } = (args ?? {}) as { events?: unknown };
    if (!Array.isArray(events)) throw new Error("host.events needs events");
    hostRemote?.runtimeOf(id, generation)?.hostEvents(events as HostEvent[]);
    return { ok: true };
  },
  "host.status": async (args: unknown) => {
    const push = (args ?? {}) as HostStatusPush;
    if (!Array.isArray(push.connections))
      throw new Error("host.status needs connections");
    if (!hostRemote) return { ok: false };
    hostRemote.update(push);
    if (push.status) onConnectionStatus(push.status);
    return { ok: true };
  },
  "host.master_ready": async (args: unknown) => {
    const { id, generation } = hostTarget(args);
    const { host, control_path } = (args ?? {}) as {
      host?: unknown;
      control_path?: unknown;
    };
    if (typeof host !== "string" || typeof control_path !== "string")
      throw new Error("host.master_ready needs a host and a control_path");
    if (hostRemote?.runtimeOf(id, generation))
      setupRemoteReviewAgent(id, host, control_path);
    return { ok: true };
  },
};

/** A terminal agent's status changed: it may have stopped on a limit. */
function pokeLimitResumer(connectionId: string, event: unknown) {
  if (!event || typeof event !== "object") return;
  const { event: name, data } = event as { event?: unknown; data?: unknown };
  if (
    name !== "pane.agent_status_changed" &&
    name !== "pane.agent_detected" &&
    name !== "pane.exited" &&
    name !== "pane.closed"
  )
    return;
  const paneId =
    data && typeof data === "object"
      ? (data as { pane_id?: unknown }).pane_id
      : undefined;
  pokeLimit(connectionId, typeof paneId === "string" ? paneId : undefined);
}

/**
 * Something changed in a pane (a turn ended): the resumer looks shortly,
 * Bun's own, or the Rust core's while it owns the family.
 */
function pokeLimit(connectionId: string, paneId?: string) {
  if (limitResumer) {
    limitResumer.poke(connectionId, paneId);
    return;
  }
  if (!coreFront || bunOwns("limit_resume")) return;
  void coreFront
    .callInternal("limit_resume", "poke", {
      connection_id: connectionId,
      ...(paneId ? { pane_id: paneId } : {}),
    })
    .catch(() => undefined);
}

/**
 * The pauses the Rust core last pushed, by connection, while it owns the
 * family (for limitPauses; its browsers get the pushes themselves).
 */
const rustLimitPauses = new Map<string, LimitPause[]>();

// Every connection's Claude sessions a usage limit stopped are resumed
// once it resets; the browsers are told of each pause as it changes.
// Bun's resumer runs only while Bun owns the limit_resume family (always,
// without a Rust core); it stops when the core takes it, and a fresh one
// (with the store read again: the core wrote it meanwhile) starts when it
// comes back.
const createBunLimitResumer = (store = limitResumeStore()) =>
  createLimitResumer({
    connections: () =>
      connectionManager.list().flatMap((status) => {
        const runtime = connectionManager.readyRuntime(status.id);
        // No transcripts to read on a Windows host (Agent history is Unix).
        if (!runtime || runtime.remotePlatform === "windows") return [];
        return [runtime.limitConnection];
      }),
    settings: async () => limitResumeSettings(await readGuiSettings()),
    store,
    onChange: (connectionId, pauses) => {
      let generation: number | undefined;
      try {
        generation =
          connectionManager.readyRuntimeLease(connectionId)?.generation;
      } catch {
        generation = undefined;
      }
      const line = serializeHerdrEventEnvelope(
        connectionId,
        { event: LIMIT_PAUSES_EVENT, data: { pauses } },
        generation,
      );
      for (const ws of clients) safeSend(ws, line, "limit-pauses");
    },
    log: (level, message, fields) =>
      logger.child("limit-resume")[level](message, fields),
  });
limitResumer = createBunLimitResumer();
let limitResumerStarted = false;
onOwnershipChanged(() => {
  const ours = bunOwns("limit_resume");
  if (!ours && limitResumer) {
    limitResumer.stop();
    limitResumer = null;
    logger.child("limit-resume").info("handed to the Rust core");
  } else if (ours && !limitResumer) {
    rustLimitPauses.clear();
    limitResumer = createBunLimitResumer(createLimitResumeStore());
    if (limitResumerStarted) limitResumer.start();
    logger.child("limit-resume").info("served by Bun again");
  }
});

// Ranger: while the Rust core owns the assistant family it runs the
// service (chats, runs, tasks); Bun's stops first (the core asks with
// `assistant.release` before it starts its own) and is made again, lazily,
// once the family comes back, after the core let go of it.
onOwnershipChanged(() => {
  const ours = bunOwns("assistant");
  if (!ours && assistantServiceTask) {
    void releaseBunAssistant();
  } else if (ours && coreFront && assistantReleasedToCore) {
    assistantReleasedToCore = false;
    void coreFront
      .callInternal("assistant", "release", {})
      .catch(() => undefined)
      .then(() => {
        logger.child("assistant").info("served by Bun again");
        resumeAssistantIfLoaded();
      });
  }
});

// Agent profiles: while the Rust core owns the family it is
// session-profiles.json's one writer and runs the return after a limit's
// reset. Bun's store keeps the choices in memory for its synchronous
// readers (conversation mode's starts, /model, MR reviews), sends each
// change of its own to the core, and takes the whole set the core tells
// back after each write (`profiles.sessions_changed`); it reads the file
// afresh when the family comes back.
let profilesOnCore = false;
onOwnershipChanged(() => {
  const onCore = !!coreFront && !bunOwns("agent_profiles");
  if (onCore === profilesOnCore) return;
  profilesOnCore = onCore;
  const log = logger.child("profiles");
  sessionProfiles().follow(
    onCore
      ? (change) => {
          void coreFront
            ?.callInternal("agent_profiles", "store", change)
            .catch((error) =>
              log.warn("a session's profile change did not reach the core", {
                error,
              }),
            );
        }
      : null,
  );
  log.info(onCore ? "handed to the Rust core" : "served by Bun again");
});

// The notifications family: while the Rust core owns it, it keeps the
// feed's events and file and sends Web Push; Bun keeps the feed's sockets
// (the Android app's), with the events the core sends back.
let notificationsOnCore = false;
onOwnershipChanged(() => {
  const ours = bunOwns("notifications");
  const log = logger.child("notifications");
  if (!ours && !notificationsOnCore && coreFront) {
    notificationsOnCore = true;
    webPush.stop();
    const front = coreFront;
    notifications
      .useCore({
        call: (op, params) => front.callInternal("notifications", op, params),
      })
      .catch((error: unknown) =>
        log.warn("the Rust core did not give its notification feed", {
          error,
        }),
      );
    log.info("handed to the Rust core");
  } else if (ours && notificationsOnCore) {
    notificationsOnCore = false;
    void notifications.useCore(null);
    webPush = createBunWebPush();
    log.info("served by Bun again");
  }
});

// A pending SSH retry may wait up to its capped backoff. When the host's
// network changes, a peer that was unreachable may be back: try now.
const stopNetworkWatch = watchNetworkChanges(() => {
  // The core watches the network itself while it owns the connections.
  if (connectionManager.remoteConnections()) return;
  logger.debug("network changed; retrying waiting connections");
  bunConnectionProfiles.retryNow();
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
  activity.socketClosed(ws);
  // The core's history watchers drop the socket too.
  if (coreFront?.tableOwner("agent_sessions") === "rust")
    tellAgentSessions("socket_closed", { socket_id: socketIdOf(ws) });
  // And the core's chats.
  if (conversationOnCore())
    void coreFront!
      .callInternal("conversation", "socket_closed", {
        socket_id: socketIdOf(ws),
      })
      .catch(() => undefined);
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

/**
 * The user's input through the pane API (the composer, a paste, words
 * said to the session on screen): a turn they start when it submits.
 */
function notePaneInput(
  connectionId: string,
  paneId: string,
  params: Record<string, unknown>,
) {
  const keys = Array.isArray(params.keys) ? params.keys : [params.keys];
  const submits =
    (typeof params.text === "string" && /[\r\n]$/.test(params.text)) ||
    keys.some((key) => typeof key === "string" && /^enter$/i.test(key));
  if (submits)
    turnCauses.note(connectionId, paneId, { by: "user", via: "terminal" });
  else turnCauses.noteUser(connectionId, paneId);
}

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
  // While the connections go to the Rust core, a call waits for them
  // (at most 10 s) rather than find them down for a moment.
  if (hostSettling) await hostSettling;
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
  const coreContext = (): CallContext => ({
    ...(route.scope === "connection"
      ? {
          connection_id: route.connectionId,
          connection_generation: route.generation,
        }
      : {}),
    socket_id: socketIdOf(ws),
    lane: currentSshLane(),
    // file.reveal opens a file manager only for a loopback browser.
    ...(ws.remoteAddress ? { client_ip: ws.remoteAddress } : {}),
    ...(clientSessions.get(ws)
      ? { session_id: sessionIdOf(clientSessions.get(ws)) }
      : {}),
  });
  const sendReply = (
    message: Record<string, unknown>,
    context: string,
  ): boolean => {
    void coreFront?.observeReply(method, params, coreContext(), message);
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
  // A family given to the Rust core: it answers.
  if (coreFront?.routesRpc(method)) {
    try {
      // The user's own turn, as Bun's chat handler notes it.
      if (
        (method === "agent_chat.send" || method === "agent_chat.voice") &&
        typeof params?.pane_id === "string" &&
        params.stop !== true
      )
        turnCauses.note(
          coreContext().connection_id ?? connectionManager.defaultId(),
          params.pane_id,
          { by: "user", via: "chat" },
        );
      const result = await coreFront.callRpc(method, params, coreContext());
      if (method === "bridge.assistant.get" && params && "since" in params) {
        sendReply(
          { id, result: assistantStateReply(ws, params, result) },
          "assistant",
        );
        return;
      }
      // The other browsers hear of a preference, as Bun's handler tells them.
      if (method === "bridge.ui_settings.update") {
        const line = JSON.stringify({ ui_settings: result });
        for (const client of clients)
          if (client !== ws) safeSend(client, line, "ui-settings");
      }
      sendReply({ id, result }, "core");
    } catch (error) {
      const message = (error as Error).message;
      const code = (error as { code?: unknown }).code;
      markRpcError(ws, id, message);
      sendReply(
        {
          id,
          error: typeof code === "string" ? { message, code } : { message },
        },
        "core-error",
      );
    }
    return;
  }
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
  if (method === "bridge.activity.timeline") {
    try {
      const result = await readActivityTimeline(
        {
          settings: async () => activitySettings(await readGuiSettings()),
          recording: () => activity.ready(),
          directory: () => dataRoot(),
          subjects: async () => subjectsFromSettings(await readGuiSettings()),
        },
        params,
      );
      sendReply({ id, result }, "activity-timeline");
    } catch (error) {
      sendError("activity-timeline-error", error);
    }
    return;
  }
  if (method === "bridge.archive.search" || method === "bridge.archive.open") {
    try {
      const result =
        method === "bridge.archive.search"
          ? await archiveRpc.search(params ?? {})
          : await archiveRpc.open(params ?? {});
      sendReply({ id, result }, "archive");
    } catch (error) {
      sendError("archive-error", error);
    }
    return;
  }
  if (method === "bridge.time_report") {
    // Provider failures are answers the Hours view shows, with their code.
    try {
      const value = await timeReport.handle(params);
      sendReply({ id, result: { ok: true, value } }, "time-report");
    } catch (error) {
      if (error instanceof TimeReportError)
        sendReply(
          {
            id,
            result: {
              ok: false,
              error: error.message,
              code: error.code,
              partial: error.partial,
            },
          },
          "time-report",
        );
      else sendError("time-report-error", error);
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
  if (method === "bridge.notifications.status") {
    sendReply({ id, result: notifications.status() }, "notifications-status");
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
        sendReply(
          { id, result: assistantStateReply(ws, params, result) },
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
  if (isMrReviewsMethod(method)) {
    // Machine-wide: the inbox reads the forges with this machine's logins.
    try {
      const result = await getMrReviews().handle(method, params ?? {});
      sendReply({ id, result }, "mr-reviews");
    } catch (error) {
      sendError("mr-reviews-error", error);
    }
    return;
  }
  if (isWorkMethod(method)) {
    // Machine-wide: the Work board is this server's, whichever connection
    // the page shows.
    try {
      const result = await handleWorkRpc(
        getWorkService(),
        method,
        params ?? {},
      );
      sendReply({ id, result }, "work");
    } catch (error) {
      sendError("work-error", error);
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
              agents: await annotateAgentSeen(
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
    /^(?:file\.|git\.|forge\.|worktree\.|agent_chat\.|agent_profile\.|agent_history\.|agent_session\.|agent_tasks?\.|agent_commands\.|agent_artifacts\.|settings\.(?:workspace_auto_sync|worktree_hooks)\.)/.test(
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
    statWorkspaceFile,
    searchWorkspaceFiles,
    revealWorkspaceFile,
    createWorkspaceDirectory,
    moveWorkspaceFile,
    readGitDiffSummary,
    readGitRefs,
    readWorkspacePullRequest,
    readGitDiffFile,
    readGitDiffFiles,
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
    readOlder: readAgentHistoryOlder,
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
      const result = await annotateAgentSeen(
        connection.identity.id,
        list,
        boot,
      );
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
  if (method === "activity.presence") {
    try {
      const result = await activity.presence(
        ws,
        connection.identity.id,
        params,
        coreContext,
      );
      sendReply({ id, result }, method);
    } catch (e) {
      sendError("activity-presence-error", e);
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
      // The user looks at the agent: what it notified about is seen.
      notifications.clearPane(
        connection.identity.id,
        String((params as { pane_id: string }).pane_id),
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
  if (
    method === "claude_mod.status" ||
    method === "claude_mod.install" ||
    method === "claude_mod.uninstall"
  ) {
    try {
      const action = method.slice("claude_mod.".length) as
        | "status"
        | "install"
        | "uninstall";
      sendReply(
        {
          id,
          result: await claudeModIntegration(connection.identity.id, action),
        },
        method,
      );
    } catch (e) {
      sendError(`${method}-error`, e);
    }
    return;
  }
  if (method.startsWith("limit_resume.")) {
    try {
      const connectionId = connection.identity.id;
      const paneId = typeof params?.pane_id === "string" ? params.pane_id : "";
      let result: unknown;
      if (method === "limit_resume.list")
        result = { pauses: limitResumer?.list(connectionId) ?? [] };
      else if (!limitResumer || !paneId)
        throw new Error(`${method} needs a pane_id`);
      else if (method === "limit_resume.resume_now")
        result = await limitResumer.resumeNow(connectionId, paneId);
      else if (method === "limit_resume.skip")
        result = await limitResumer.setSkip(
          connectionId,
          paneId,
          params?.skip !== false,
        );
      else throw new Error(`unknown method ${method}`);
      sendReply({ id, result }, method);
    } catch (e) {
      sendError(`${method}-error`, e);
    }
    return;
  }
  if (PROFILE_RPC_METHODS.has(method)) {
    try {
      sendReply(
        { id, result: await connection.profileRpc(method, params ?? {}) },
        method,
      );
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
  if (method === "agent_history.older") {
    try {
      const result = await readAgentHistoryOlder(params ?? {});
      sendReply({ id, result }, "agent-history-older");
    } catch (e) {
      sendError("agent-history-older-error", e);
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
  if (method === "file.stat") {
    try {
      const result = await statWorkspaceFile(params ?? {});
      sendReply({ id, result }, "file-stat");
    } catch (e) {
      sendError("file-stat-error", e);
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
      if (
        (method === "agent_chat.send" || method === "agent_chat.voice") &&
        typeof params?.pane_id === "string" &&
        params.stop !== true
      )
        turnCauses.note(connection.identity.id, params.pane_id, {
          by: "user",
          via: "chat",
        });
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
        reviewRpcConnection(connection),
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
  if (method === "git.refs") {
    try {
      const result = await readGitRefs(params ?? {});
      sendReply({ id, result }, "git-refs");
    } catch (e) {
      sendError("git-refs-error", e);
    }
    return;
  }
  if (method === "forge.status" || method === "forge.session") {
    // Read only, in the background lane: chips, the chat's header and its
    // list of requests. What they say never goes to an agent.
    try {
      const raw = params ?? {};
      const path =
        typeof raw.path === "string" && isHostPath(raw.path) ? raw.path : "";
      const context = (root: string) => ({
        root,
        host: connection.sshHost(),
        shQuote,
        runProcessWithCodeTimeout,
      });
      let result: unknown;
      if (method === "forge.status") {
        const ref = parseForgeRefParam(raw.ref);
        if (!ref) throw new Error("invalid merge request reference");
        result = await forgeCache.status(context(path), ref, {
          fresh: raw.fresh === true,
        });
      } else {
        const root =
          path ||
          (
            await connection.files.resolveWorkspaceGitRoot({
              workspace_id: raw.workspace_id,
            })
          ).root;
        const agentPath =
          typeof raw.agent_path === "string" && isHostPath(raw.agent_path)
            ? raw.agent_path
            : undefined;
        result = await forgeCache.session(context(root), agentPath, {
          fresh: raw.fresh === true,
        });
      }
      sendReply({ id, result }, "forge");
    } catch (e) {
      sendError("forge-error", e);
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
  if (method === "git.diff_files") {
    try {
      const result = await readGitDiffFiles(params ?? {});
      sendReply({ id, result }, "git-diff-files");
    } catch (e) {
      sendError("git-diff-files-error", e);
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
      // What each pane's live Claude mod says, over Herdr's screen reading.
      () => connection.claudeMod.panes(),
    )(method, params ?? {}, undefined, () => {
      if (isPaneInput && !requestIsCurrent())
        throw new Error(CONNECTION_CHANGED_DURING_REQUEST);
      if (inputTerminalId)
        terminalBridge.noteTerminalInput(ws, inputTerminalId);
      if (isPaneInput && typeof params?.pane_id === "string")
        notePaneInput(connection.identity.id, params.pane_id, params);
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

/** The connection file routes the workspace family serves, by endpoint. */
const FILE_ENDPOINT_PATHS: Partial<Record<string, string>> = {
  "file-download": "/api/file/download",
  "file-upload": "/api/file/upload",
  "file-delete": "/api/file/delete",
};

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
  // The workspace family given to the Rust core: it serves the file routes
  // of this connection, at their legacy path, with the connection in ctx.
  const filePath = FILE_ENDPOINT_PATHS[endpoint];
  if (filePath && coreFront?.routesHttp(filePath)) {
    const forwarded = new Request(
      new URL(`${filePath}${url.search}`, url.origin),
      req,
    );
    try {
      return publishConnectionHttpResponse(
        resolved,
        await coreFront.forwardHttp(forwarded, {
          connection_id: resolved.connectionId,
          connection_generation: resolved.generation,
          ...(sessionToken(req)
            ? { session_id: sessionIdOf(sessionToken(req)) }
            : {}),
        }),
      );
    } catch (error) {
      return publishConnectionHttpResponse(
        resolved,
        Response.json({ error: (error as Error).message }, { status: 500 }),
      );
    }
  }
  try {
    let response: Response;
    let localFile = false;
    if (endpoint === "herdr-info") {
      response = await connection.handleHerdrInfo();
    } else if (endpoint === "upload-image") {
      response = await connection.handleImageUpload(req);
    } else if (endpoint === "terminal-upload") {
      response = await connection.handleTerminalUpload(
        req,
        url.searchParams.get("filename"),
      );
    } else if (
      (endpoint === "agent-session-download" ||
        endpoint === "agent-session-atif") &&
      agentSessionsOnCore()
    ) {
      // Under its legacy path: the core serves the family's own paths.
      const legacy =
        endpoint === "agent-session-atif"
          ? "/api/agent-session/atif"
          : "/api/agent-session/download";
      response = await coreFront!.forwardHttp(
        new Request(new URL(`${legacy}${url.search}`, url), req),
        {
          connection_id: connection.identity.id,
          connection_generation: resolved.generation,
          ...(sessionToken(req)
            ? { session_id: sessionIdOf(sessionToken(req)) }
            : {}),
        },
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
      localFile = !connection.sshHost();
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
    return localFile
      ? publishLocalFileResponse(resolved, response)
      : publishConnectionHttpResponse(resolved, response);
  } catch (error) {
    return publishConnectionHttpResponse(
      resolved,
      Response.json({ error: (error as Error).message }, { status: 500 }),
    );
  }
}

/** The recorded channel of a server socket (contract record mode). */
function socketChannel(ws: ServerWebSocket<unknown>) {
  const data = ws.data as {
    voice?: true;
    notifications?: unknown;
    signalling?: unknown;
  };
  if (data.notifications) return "notifications" as const;
  if (data.signalling) return "signalling" as const;
  if (data.voice) return "voice" as const;
  return "ws" as const;
}

/** What each server socket carries (`server.upgrade`'s data). */
type ServeData = {
  sessionToken: string | null;
  voice?: true;
  /** The notification socket: the origin its links open on. */
  notifications?: { origin: string };
  /** A page's signalling for a call (voice-socket.ts). */
  signalling?: { call: number; token: string };
};

/**
 * What handleFetch uses of Bun's Server: Bun.serve's own, or the Bun
 * core's for a request a Rust front forwarded (core-channel/sidecar.ts).
 */
type FetchServer = {
  requestIP(req: Request): { address: string } | null;
  timeout(req: Request, seconds: number): void;
  upgrade(req: Request, options: { data: ServeData }): boolean;
};

/** The server's HTTP routing, Bun.serve's fetch handler. */
async function handleFetch(
  req: Request,
  server: FetchServer,
): Promise<Response | undefined> {
  const requestPathname = rawRequestPathname(req.url);
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return new Response("invalid request URL", { status: 400 });
  }

  // A rendered page's frame off its token: never the login page,
  // nor anything behind the gate.
  const stray = renderedStray(req, url);
  if (stray) return stray;

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

  // While the connections go to the Rust core, an API request waits
  // for them (at most 10 s) rather than find them down for a
  // moment. Logins and sockets go at once: a socket's calls wait the
  // same way.
  if (
    hostSettling &&
    url.pathname.startsWith("/api/") &&
    !/^\/api\/(?:login|logout)(?:\/|$)/.test(url.pathname)
  )
    await hostSettling;

  // A call handed to the Android app: its single-use token is the
  // credential, exchanged for the call's and a login.
  if (url.pathname === CALL_HANDOFF_PATH)
    return redeemCallHandoff(req, clientIp);

  // A rendered review's page: its frame is sandboxed with an opaque
  // origin and sends no cookie; the token in the path is the
  // credential.
  const renderedPage = renderedPages.handle(req, url);
  if (renderedPage) {
    // A large page or model read whole over SSH can take longer
    // than the default 10 s idle timeout before its first byte.
    server.timeout(req, DOWNLOAD_TIMEOUT_MS / 1000);
    return renderedPage;
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
      notifications.closeSession(token);
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

  // A family given to the Rust core: it serves the path (never a
  // WebSocket: Bun terminates them all).
  const forwardToCore = () =>
    coreFront!.forwardHttp(req, {
      ...(sessionToken(req)
        ? { session_id: sessionIdOf(sessionToken(req)) }
        : {}),
      client_ip: clientIp,
    });
  const coreServesHere = () =>
    !!coreFront?.routesHttp(url.pathname) && !req.headers.get("upgrade");
  if (
    coreFront &&
    !req.headers.get("upgrade") &&
    !coreRoutedInPlace(url.pathname) &&
    coreFront.routesHttp(url.pathname)
  ) {
    server.timeout(req, DOWNLOAD_TIMEOUT_MS / 1000);
    return forwardToCore();
  }

  if (url.pathname === "/ws") {
    // Never from another site, nor from a sandboxed page (its
    // origin is "null"): the bridge is Roamgate's own pages'.
    if (
      req.headers.get("sec-fetch-site") === "cross-site" ||
      req.headers.get("origin") === "null"
    )
      return new Response("forbidden", { status: 403 });
    if (server.upgrade(req, { data: { sessionToken: sessionToken(req) } }))
      return undefined;
    return new Response("websocket upgrade failed", { status: 400 });
  }
  if (url.pathname === "/api/notifications/push") {
    return webPush.handle(req);
  }
  if (url.pathname === "/api/notifications/ws") {
    // The Android app's notification feed: never from another site,
    // nor from a sandboxed page.
    const origin = req.headers.get("origin");
    if (req.headers.get("sec-fetch-site") === "cross-site" || origin === "null")
      return new Response("forbidden", { status: 403 });
    if (
      server.upgrade(req, {
        data: {
          sessionToken: sessionToken(req),
          notifications: {
            origin: publicOrigin(url, req.headers, clientIp),
          },
        },
      })
    )
      return undefined;
    return new Response("websocket upgrade failed", { status: 400 });
  }
  if (url.pathname === "/api/instance-settings") {
    return handleInstanceSettings(req);
  }
  if (url.pathname.startsWith("/api/history")) {
    const history = await handleHistory(req, url.pathname);
    if (history) return history;
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
    if (coreServesHere()) return forwardToCore();
    return handleUpdateCheck(req);
  }
  if (url.pathname === "/api/update/install" && req.method === "POST") {
    // Binary download and verification can exceed Bun's default ten-second
    // request timeout. Keep the larger budget scoped to update requests.
    server.timeout(req, UPDATE_HTTP_IDLE_TIMEOUT_SECONDS);
    if (coreServesHere()) return forwardToCore();
    return handleUpdateInstall(req);
  }
  if (url.pathname === "/api/review/image" && req.method === "GET") {
    if (coreServesHere()) return forwardToCore();
    return serveReviewImage(url);
  }
  if (url.pathname === "/api/herdr/status" && req.method === "GET") {
    if (coreServesHere()) return forwardToCore();
    return handleHerdrStatus();
  }
  if (url.pathname === "/api/herdr/setup" && req.method === "POST") {
    // Herdr download plus service start shares the update budget.
    server.timeout(req, UPDATE_HTTP_IDLE_TIMEOUT_SECONDS);
    if (coreServesHere()) return forwardToCore();
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
  if (url.pathname === "/api/voice/call/signalling") {
    // A call's WebRTC signalling, for the page that owns the call
    // (its `call_token`), from this site only.
    const call = Number(url.searchParams.get("call"));
    const token = url.searchParams.get("call_token") ?? "";
    if (voiceSocket.signallingRefused(req, call, token))
      return new Response("forbidden", { status: 403 });
    if (
      server.upgrade(req, {
        data: {
          sessionToken: sessionToken(req),
          signalling: { call, token },
        },
      })
    )
      return undefined;
    return new Response("websocket upgrade failed", { status: 400 });
  }
  if (url.pathname.startsWith("/api/voice")) {
    // Transcribing a long recording can outlast the default timeout.
    server.timeout(req, VOICE_HTTP_IDLE_TIMEOUT_SECONDS);
    const setup = await handleVoiceSetup(req, url.pathname);
    if (setup) return setup;
    const lowGpu = await handleVoiceLowGpu(req, url.pathname);
    if (lowGpu) return lowGpu;
    const response = await handleVoice(req, url.pathname);
    if (response) return response;
  }
  const connectionRoute = parseConnectionHttpRoute(requestPathname, req.method);
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
      (url.searchParams.get("inline") !== "1" ||
        isHtmlPath(url.searchParams.get("path") ?? ""))
    ) {
      // HTML preparation can require several bounded SSH resource
      // reads; a download's first byte waits for SSH, and a
      // directory's for its archive.
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
}

/** The server's WebSocket handlers, Bun.serve's `websocket`. */
const bridgeWebSocket: WebSocketHandler<ServeData> = {
  perMessageDeflate: WS_PER_MESSAGE_DEFLATE,
  // Bun drops sends past its own limit; the slow-socket policy in
  // websocket-send decides when a socket is too far behind.
  backpressureLimit: WS_BACKPRESSURE_HARD_LIMIT_BYTES,
  open(ws) {
    if (ws.data.notifications)
      return notifications.open(
        ws,
        ws.data.notifications.origin,
        ws.data.sessionToken ?? undefined,
        ws.remoteAddress,
      );
    if (ws.data.signalling) {
      const { call, token } = ws.data.signalling;
      return voiceSocket.openSignalling(ws, call, token);
    }
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
          herdr_task_notifications: config.taskNotificationSource === "herdr",
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
    if (ws.data.voice || ws.data.signalling || ws.data.notifications) return;
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
    if (ws.data.notifications) return notifications.message(ws, message);
    if (ws.data.signalling) return voiceSocket.signallingMessage(ws, message);
    if (ws.data.voice) {
      lastVoiceAt = Date.now();
      return voiceSocket.message(ws, message);
    }
    if (!clients.has(ws)) return;
    const text = typeof message === "string" ? message : message.toString();
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
  pong(ws) {
    if (ws.data.notifications) notifications.pong(ws);
  },
  close(ws, code, reason) {
    if (ws.data.notifications) return notifications.close(ws, code, reason);
    if (ws.data.signalling) return voiceSocket.closeSignalling(ws);
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
      // 4000 with a reason: the page gave up on the socket (its
      // heartbeat, a full send buffer); 1006: the link dropped.
      code,
      reason: reason || undefined,
      sent: flow.sent,
      unacked: flow.enabled ? flow.sent - flow.acked : "n/a",
      queued: flow.queued,
      rate: flow.rate,
      heaviest: flow.heaviest,
      last_ack_ms: flow.lastAckAgeMs ?? undefined,
      terminals: viewedTerminals.length ? viewedTerminals.join(",") : "none",
    });
  },
};

/**
 * Serves a Rust front's channel instead of a port (stage 2,
 * core-channel/sidecar.ts): the same routing and WebSocket handlers, the
 * front's requests and sockets. The process ends with the channel.
 */
function serveFront(channel: { path: string; token: string }): Promise<void> {
  const log = logger.child("core");
  let welcomed = () => {};
  const welcome = new Promise<void>((resolve) => {
    welcomed = resolve;
  });
  void startSidecar<ServerWebSocket<ServeData>>({
    path: channel.path,
    token: channel.token,
    version: APP_VERSION,
    scheme: config.tls ? "https" : "http",
    // Record mode: what the front forwards, recorded as when this server
    // holds the port (the front's own routes are not recorded here).
    fetch: recordFetch(recorder, "http", (req, server) =>
      handleFetch(req, server),
    ),
    websocket: recordWebSocket(recorder, socketChannel, bridgeWebSocket),
    onClose: (error) => {
      log.info("the front's channel closed: stopping", {
        error: error?.message,
      });
      void shutdownController.request(error ? 1 : 0);
    },
    log: (level, message) => log[level](message),
    onWelcome: () => welcomed(),
  })
    .then(() => log.info("serving a Rust front", { channel: channel.path }))
    .catch((error) => {
      log.error("the front's channel did not open", {
        channel: channel.path,
        error: (error as Error).message,
      });
      void shutdownController.request(1);
    });
  return welcome;
}

function main() {
  historyRuntime.start();
  // A Rust front's core opens no port: it serves the front's channel.
  const frontChannel = coreChannelOf(process.env);
  // A core starts its connections once the front holds the port, as a
  // server does once it listens: what they send at once reaches browsers.
  let frontWelcome: Promise<void> | null = null;
  const server = bindListenerBeforeConnectionStart({
    bindListener: () => {
      if (frontChannel) {
        frontWelcome = serveFront(frontChannel);
        return null;
      }
      return recordServe(
        recorder,
        "http",
        socketChannel,
      )<ServeData>({
        port: config.port,
        hostname: config.host,
        tls: config.tls,
        maxRequestBodySize: terminalUploadRequestBodyLimit(),
        fetch(req, server) {
          return handleFetch(req, server);
        },
        websocket: bridgeWebSocket,
      });
    },
    startConnection: async () => {
      if (frontWelcome) await frontWelcome;
      await startHostConnections();
      // Resume saved work even when no browser has opened Ranger yet.
      if (!assistantOnCore()) await getAssistantService();
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
  const listeningPort = server?.port ?? config.port;
  forwardReservedListeningPort = listeningPort;
  // Agent profiles: the settings read now (spawns that cannot wait use
  // them), and sessions a usage limit moved go back after its reset.
  void readGuiSettings().catch(() => undefined);
  limitResumerStarted = true;
  limitResumer?.start();
  setInterval(() => {
    // The core runs it while it owns the agent_profiles family.
    if (!bunOwns("agent_profiles")) return;
    void readGuiSettings()
      .then((settings) =>
        returnAfterReset({
          settings,
          store: sessionProfiles(),
          connections: connectionManager.list().flatMap((status) => {
            const runtime = connectionManager.readyRuntime(status.id);
            if (!runtime || runtime.remotePlatform === "windows") return [];
            return [
              {
                panes: runtime.profilePanes,
                switchPane: async (paneId: string, profile: string) =>
                  (await runtime.profileRpc("agent_profile.switch", {
                    pane_id: paneId,
                    profile,
                  })) as { ok: boolean; reason?: string },
              },
            ];
          }),
          log: (message, fields) =>
            logger.child("profiles").info(message, fields),
        }),
      )
      .catch((error) =>
        logger.child("profiles").warn("reset return failed", { error }),
      );
  }, 60_000).unref?.();
  const publicBrowserUrl = browserUrlFor(
    config.host,
    listeningPort,
    Boolean(config.tls),
  );
  if (!frontChannel)
    logger.info("listening", {
      url: publicBrowserUrl,
      websocket: "/ws",
      log_level: config.logLevel,
    });
  // The Rust core, when ROAMGATE_CORE_BIN names one; nothing otherwise.
  // A Rust front's core runs it too, as stage 1 does: the owners table
  // gives it its families behind either front.
  coreFront = startCoreFront({
    // The front's executable, which the update family replaces: a Rust
    // front names its own.
    env: {
      ...process.env,
      ROAMGATE_CLI_EXEC:
        (frontChannel && process.env.ROAMGATE_CLI_EXEC) || process.execPath,
      ROAMGATE_CLI_VERSION: APP_VERSION,
      ROAMGATE_CLI_STANDALONE:
        (frontChannel && process.env.ROAMGATE_CLI_STANDALONE) ||
        (isStandaloneBinary(process) ? "1" : "0"),
    },
    dataDir: dataRoot(),
    fromSource: !isStandaloneBinary(process),
    deliverPush: deliverCorePush,
    reverseTargets: { ...coreReverseTargets, ...hostReverseTargets },
  });
  setMrCacheCore(coreFront);
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
  if (!frontChannel) logger.info("browser URL", { url: publicBrowserUrl });
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
  // The front's addresses are the front's to say and open.
  if (!frontChannel && isAnyHost(config.host)) {
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
      reviewAgentSockets.add(LOCAL_SOCKET_KEY);
      if (reviewsOnCore()) {
        // Installed by the core's socket: tell it so in the same state.
        reviewAgentInstalled = true;
        sendReviewAgents();
      } else getReviewAgent().installLocal();
      reviewAgentInstalled = true;
    } catch (error) {
      logger.warn("review agent unavailable", {
        error: sanitizeConnectionError(error),
      });
    }
  }
  if (!frontChannel) openBrowser(config, browserUrl);
}

let managerStopTask: Promise<void> | null = null;
function stopManagerOnce(): Promise<void> {
  // Seen marks are written in batches: keep the last ones, the core's too.
  const seenWritten = agentSessionsOnCore()
    ? coreFront!.callInternal("agent_sessions", "flush", {}).then(
        () => {},
        () => {},
      )
    : agentSeen.flush();
  webPush.stop();
  notifications.stop();
  stopNetworkWatch();
  bunConnectionProfiles.stopSupervision();
  managerStopTask ??= (async () => {
    // End the attention spans before the connections go: a shutdown is not
    // a disconnect. The activity log first: where the core records it, the
    // core's recorder stops before the channel goes.
    await activity.stop();
    // The core's connections and SSH processes end before the channel does.
    await stopHostOnCore();
    // The core's seen marks are on disk before the channel goes.
    await seenWritten;
    // So is the core's Claude mod inbox.
    if (claudeModHub.onCore())
      await coreFront
        ?.callInternal("review", "mod_flush", {})
        .catch(() => undefined);
    // The core's conversations saved on their leases, on disk.
    if (conversationOnCore())
      await coreFront!
        .callInternal("conversation", "stop", {})
        .catch(() => undefined);
    // The core: what it owns stops writing before Bun's own goes.
    await coreFront?.stop();
    // Pause the harness before taking away the runtimes its reads depend on.
    await assistantServiceTask
      ?.then((assistant) => assistant.dispose())
      .catch(() => undefined);
    await Promise.all([connectionManager.stopAll(), cpuProfile?.stop()]);
    // The last changes go into the history before the stores close.
    await historyRuntime.stop();
    reviewAgent?.stop();
    reviewService?.close();
    // The stores write behind their changes: theirs are on disk before
    // the exit (which writes what is still pending at once).
    await Promise.all([seenWritten, notifications.flush()]);
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
  coreFront?.stopNow();
  claudeModHub.flush();
  voiceHelper.stop();
  activity.stopNow();
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
