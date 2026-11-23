import {
  createTaskEventTracker,
  type TaskEvent,
} from "../notifications/task-events";
import {
  createHerdrNotificationListener,
  taskEventFromSemanticNotification,
  type TaskNotificationSource,
} from "../notifications/herdr-notification-listener";
import {
  assertEndpointCreationSource,
  createEmptyWorkspaceCreator,
} from "../bridge/endpoint-creation";
import type { ServerWebSocket } from "bun";
import type { AgentPromptAnswer } from "../../../shared/review";
import {
  createAgentSessionHandlers,
  withOwnedSessions,
} from "../agent/agent-sessions";
import {
  createHistoryWatcher,
  createRemoteStatSpawner,
  type HistoryWatcher,
} from "../agent/history-watch";
import { sshReadCommandArgv } from "../bridge/ssh-command";
import {
  type ConversationHerdr,
  conversationCloseEvent,
  createConversationHerdr,
  localPidAlive,
} from "../conversation/herdr";
import type { SpawnHeadless } from "../conversation/headless";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  holderCommand,
  launchCommand,
  resumeCommand,
} from "../conversation/holder-script";
import { handleProfileRpc, type ProfileRpcDeps } from "../profiles/rpc";
import { limitConnection } from "../limit-resume/connection";
import { isRecord } from "../agent/session-utils";
import {
  sessionProfiles,
  commandForSession,
  type LaunchSpec,
  launchRegistry,
  profileForSession,
} from "../profiles/profiles";
import { profileModels } from "../profiles/models";
import { latestSessionModel } from "../../../shared/agentProfiles";
import { REVIEW_HOME_DIR } from "../review/agent-server";
import { exitSentAsMessage } from "../conversation/handover";
import { createImageReader } from "../conversation/images";
import { createShellRunner } from "../conversation/shell";
import { createLeaseStore } from "../conversation/lease";
import {
  type ConversationCore,
  conversationFront,
  emptyConversationMirror,
} from "../conversation/core-front";
import { createSessionIndexStore } from "../agent/session-index-store";
import {
  type ConversationService,
  createConversationService,
} from "../conversation/service";
import type { ConversationPrompt } from "../conversation/session";
import { serializeHerdrEventEnvelope } from "./protocol";
import { createAgentSessionFileAccess } from "../agent/session-file-access";
import { HerdrClient } from "../bridge/herdr-client";
import {
  EndpointClient,
  type EndpointSnapshot,
} from "../bridge/endpoint-client";
import {
  assertSupportedHerdrProtocol,
  isTerminalHelloProtocol,
} from "../bridge/protocol-compat";
import { roamgateEnv } from "../config/environment";
import { createSettingsRpcHandler } from "../bridge/settings-rpc";
import { createForwardRpcHandler } from "../bridge/forward-rpc";
import type { SshForwards } from "../bridge/ssh-forward";
import {
  conversationIdleStopMinutes,
  onGuiSettingsChanged,
  readGuiSettings,
  terminalSurfaceCodecsEnabled,
} from "../config/gui-settings";
import {
  createSshTunnelManager,
  type SshTunnelConfig,
  type SshTunnelError,
} from "../bridge/ssh-tunnel";
import { dropCoalescedMessage } from "../bridge/websocket-send";
import { annotateSshArgv } from "../bridge/ssh-metrics";
import { createTerminalBridge } from "../bridge/terminal-bridge";
import { createHerdrInfoHandler } from "../http/herdr-info";
import { createImageUploadHandler } from "../http/image-upload";
import { createTerminalUploadHandler } from "../http/terminal-upload";
import {
  createRecoveryReporter,
  type Logger,
  silentLogger,
} from "../utils/logger";
import {
  runProcess as runProcessBase,
  runProcessWithCode as runProcessWithCodeBase,
  runProcessWithCodeTimeout as runProcessWithCodeTimeoutBase,
  shQuote,
} from "../utils/process-utils";
import { turnCauses } from "../voice/turn-causes";
import { createWorkspaceAutoSync } from "../workspace/auto-sync";
import type { WorkspaceFront } from "../workspace/front";
import { createFileHandlers } from "../workspace/files";
import {
  createLastStepBaselineStore,
  type LastStepBaselineStore,
} from "../workspace/git-diff";
import { createLastStepTurnTracker } from "../workspace/last-step-turns";
import {
  runBinaryProcessWithTimeout as runBinaryProcessWithTimeoutBase,
  spawnStreamingProcess,
} from "../workspace/process";
import { createStatusEnricher } from "../workspace/status";
import { createWorktreeHookRunner } from "../worktree/worktree-hooks";
import { createWorktreeParentStore } from "../worktree/parents";
import {
  createWorktreeRemovalCoordinator,
  createWorktreeRemovalRuntime,
} from "../worktree/remove";
import { createAgentStatusSubscriptionLoop } from "./agent-status-subscription";
import { type ClaudeModHub, overlayModPanes } from "../agent/claude-mod";
import { createTabAutoRenamer } from "./tab-auto-rename";
import { createAgentTabTitleReader } from "./agent-tab-title";
import { sanitizeConnectionError } from "./manager";
import { createEventSubscriptionLoop } from "./subscription-loop";
import type { HostEvent } from "./host-facade";
import { type ConnectionIdentity, LEGACY_DEFAULT_CONNECTION } from "./types";
import { unixOnlyHandlers } from "./unix-only";

/**
 * Conversation mode's Herdr adapter, telling `onReport` of every state it
 * reports. Herdr may keep its own (Herdr's Claude integration claims the
 * pane when the headless claude starts, and drops later reports from other
 * sources), so this is where the activity log learns the state.
 */
function withStatusReports(
  herdr: ConversationHerdr,
  onReport: (paneId: string) => void,
): ConversationHerdr {
  const told = (paneId: string) => {
    try {
      onReport(paneId);
    } catch {
      // An observer must not break the report.
    }
  };
  return {
    ...herdr,
    async reportAgent(params) {
      try {
        await herdr.reportAgent(params);
      } finally {
        told(params.paneId);
      }
    },
    async releaseAgent(paneId) {
      try {
        await herdr.releaseAgent(paneId);
      } finally {
        told(paneId);
      }
    },
  };
}

/** Keys typed in a terminal note the user's input at most this often. */
const TYPED_NOTE_MS = 10_000;

const DEFAULT_EVENTS = [
  "workspace.created",
  "workspace.updated",
  "workspace.renamed",
  "workspace.closed",
  "workspace.focused",
  "workspace.moved",
  "workspace.reordered",
  "tab.created",
  "tab.closed",
  "tab.renamed",
  "tab.focused",
  "pane.created",
  "pane.closed",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
  "layout.updated",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
];

type SafeSend = (
  ws: ServerWebSocket<unknown>,
  payload: string,
  context?: string,
) => boolean;

type MarkRpcError = (
  ws: ServerWebSocket<unknown>,
  id: string | null | undefined,
  detail?: string,
) => void;

export function createLegacyConnectionRuntime(args: {
  identity?: ConnectionIdentity;
  connectionGeneration?: number;
  config: SshTunnelConfig;
  logger?: Logger;
  safeSend: SafeSend;
  broadcast?: (payload: string, context?: string) => void;
  clientLabel: (ws: ServerWebSocket<unknown>) => string;
  markRpcError: MarkRpcError;
  onEvent: (event: unknown, identity: ConnectionIdentity) => void;
  /** Each agent pane listing, with the time it was started (activity log). */
  onPaneList?: (result: unknown, startedAt: number) => void;
  /**
   * Conversation mode told Herdr a state for an agent it runs (activity
   * log): Herdr may not apply it, so its own events do not tell.
   */
  onOwnedAgentStatus?: (paneId: string) => void;
  onTaskEvent?: (event: TaskEvent) => void;
  /** Defaults to `status`; the server entrypoint selects `herdr` by default. */
  taskNotificationSource?: TaskNotificationSource;
  onError?: (error: unknown, identity: ConnectionIdentity) => void;
  onTransportExit?: (error: SshTunnelError) => void;
  /** The SSH command master became ready (again). */
  onSshMasterReady?: () => void;
  /** The claude start setting changed (Configuration). */
  onClaudeStartSettingsChanged?: () => void;
  /** The usage limit resume settings changed (Configuration). */
  onLimitResumeSettingsChanged?: () => void;
  /** Shared across connections: local ports are a single machine-wide space. */
  forwards?: SshForwards;
  /** Test seam for deterministic shutdown coverage. */
  lastStepBaselines?: LastStepBaselineStore;
  resolveLastStepWorkspaceGitRoot?: (workspaceId: string) => Promise<string>;
  /**
   * The roots of the review sessions held for this connection: Changes may
   * show such a review in any workspace ("from elsewhere"), so its
   * repository is a root the workspace's Git reads accept.
   */
  reviewRoots?: (connectionId: string) => string[] | Promise<string[]>;
  lastStepTransitionDebounceMs?: number;
  /**
   * The workspace family's handover to the Rust core: while the core owns
   * it, this runtime's auto-sync, Last step turns and git status are the
   * core's (workspace/front.ts).
   */
  workspaceFront?: WorkspaceFront;
  /** Test seam for the background git status reads. */
  runGitStatusProcess?: typeof runProcessWithCodeTimeoutBase;
  /**
   * Where conversation mode's leases are kept; null (the default) keeps
   * them in memory only.
   */
  conversationLeaseFile?: string | null;
  /**
   * Where large sessions' indexes are kept across restarts; none given
   * keeps them in memory only.
   */
  sessionIndexDir?: string | null;
  /** Conversation mode's permission and question prompts, to the browser. */
  askAgentPrompt?: (
    input: ConversationPrompt & { connectionId: string; paneId: string },
  ) => Promise<AgentPromptAnswer | null>;
  /** Test seam: how the headless claude is started. */
  spawnHeadless?: SpawnHeadless;
  /**
   * Why a conversation's process must stay up now (a voice call, a
   * companion job on it), against idle stop; null: nothing.
   */
  conversationKeepAwake?: (
    connectionId: string,
    paneId: string,
  ) => string | null;
  /** Roamgate's Claude mods, across connections (agent/claude-mod.ts). */
  claudeMod?: ClaudeModHub | null;
  /**
   * The Rust core's conversation mode for this connection, while it owns
   * the conversation family (conversation/core-front.ts).
   */
  conversationCore?: ConversationCore;
  /**
   * Set while the Rust core owns the host family (host-facade.ts): its
   * Herdr client, whose calls go to the core's; the transport and the
   * Herdr subscriptions are the core's then, their events given to
   * `hostEvents`.
   */
  host?: { herdr: HerdrClient };
}) {
  const { config } = args;
  const remotePlatform = config.remotePlatform;
  const logger = args.logger ?? silentLogger;
  const identity = { ...(args.identity ?? LEGACY_DEFAULT_CONNECTION) };
  const socketPath = config.socketPath;
  const clientSocketPath = config.clientSocketPath;
  const sshHost = () => config.sshHost;
  // Label this runtime's ssh children with its connection in the debug log.
  const forConnection = (argv: string[]) =>
    annotateSshArgv(argv, { connection: identity.id });
  const runProcess: typeof runProcessBase = (argv, ...rest) =>
    runProcessBase(forConnection(argv), ...rest);
  const runProcessWithCode: typeof runProcessWithCodeBase = (argv, ...rest) =>
    runProcessWithCodeBase(forConnection(argv), ...rest);
  const runProcessWithCodeTimeout: typeof runProcessWithCodeTimeoutBase = (
    argv,
    ...rest
  ) => runProcessWithCodeTimeoutBase(forConnection(argv), ...rest);
  const runBinaryProcessWithTimeout: typeof runBinaryProcessWithTimeoutBase = (
    argv,
    ...rest
  ) => runBinaryProcessWithTimeoutBase(forConnection(argv), ...rest);
  const herdr =
    args.host?.herdr ??
    new HerdrClient(socketPath, {
      logger: logger.child("herdr"),
      connectionId: identity.id,
    });
  /** This connection's Claude mods: delivery, and what they say. */
  const claudeMod = {
    deliver: (paneId: string, text: string, kind?: string) =>
      args.claudeMod?.deliver(identity.id, paneId, text, kind) ?? null,
    live: (paneId: string) => !!args.claudeMod?.live(identity.id, paneId),
    hasTools: (paneId: string) =>
      !!args.claudeMod?.hasTools(identity.id, paneId),
    pane: (paneId: string) => args.claudeMod?.pane(identity.id, paneId) ?? null,
    panes: () => args.claudeMod?.panes(identity.id) ?? [],
  };
  const agentSessionFiles = createAgentSessionFileAccess({
    sshHost: config.sshHost,
    runBinaryProcessWithTimeout,
    shQuote,
  });
  // These helper groups run Unix shell commands over SSH.
  // Set below; the session resolver asks it which sessions it owns.
  // Bun's own conversation service while Bun owns the family; the
  // callers see conversationFront, the core's while it owns it.
  let localConversation: ConversationService<ServerWebSocket<unknown>> | null =
    null;
  const conversationCore: ConversationCore = args.conversationCore ?? {
    onCore: () => false,
    call: () => Promise.reject(new Error("no core")),
    mirror: emptyConversationMirror,
  };
  const conversation = conversationFront<ServerWebSocket<unknown>>(
    () => localConversation,
    conversationCore,
  );
  // Herdr as the agent session readers see it: conversation mode's and the
  // Claude mods' panes over Herdr's own answers (the Rust core's readers
  // call it too, through the agent_sessions.herdr_call reverse target).
  const agentHerdrCall = withOwnedSessions(
    (...args) => herdr.call(...args),
    () => conversation?.ownedPanes() ?? [],
    () => claudeMod.panes(),
  );
  const agentSessions = unixOnlyHandlers(
    remotePlatform,
    "Agent history",
    createAgentSessionHandlers({
      herdrCall: agentHerdrCall,
      files: agentSessionFiles,
      indexStore: createSessionIndexStore({
        dir: args.sessionIndexDir ?? null,
        scope: identity.id,
      }),
    }),
  );
  const sendConnectionEvent = (
    ws: ServerWebSocket<unknown>,
    event: { event: string; data: unknown },
    context: string,
  ) => {
    if (disposed) return;
    try {
      args.safeSend(
        ws,
        serializeHerdrEventEnvelope(
          identity.id,
          event,
          args.connectionGeneration,
        ),
        context,
      );
    } catch (error) {
      logger.warn("dropped a connection event", {
        connection: identity.id,
        error: sanitizeConnectionError(error),
      });
    }
  };
  /**
   * What is typed into a pane to start a profile's agent there: a one-use
   * token the pane's roamgate-hold trades for the program and environment.
   */
  function typedLaunch(paneId: string, spec: LaunchSpec): string {
    const token = launchRegistry().register(identity.id, paneId, spec);
    return config.sshHost
      ? launchCommand(token)
      : launchCommand(token, {
          bin: join(homedir(), REVIEW_HOME_DIR, "bin", "roamgate-hold"),
          socket: join(homedir(), REVIEW_HOME_DIR, "review.sock"),
        });
  }
  /** The end of the pane session's transcript, or null. */
  async function transcriptTail(paneId: string): Promise<string | null> {
    const path = await agentSessions.resolvePath({ pane_id: paneId });
    if (typeof path !== "string") return null;
    return new TextDecoder().decode(
      await agentSessionFiles.readTail(path, 64 * 1024),
    );
  }
  /** The session RPCs of profiles (server/src/profiles/rpc.ts). */
  const profileRpcDeps = (): ProfileRpcDeps => ({
    readSettings: readGuiSettings,
    store: sessionProfiles(),
    agentGet: async (paneId) => {
      // With what the pane's Claude mod says laid over Herdr's.
      const result = overlayModPanes(
        "agent.get",
        { target: paneId },
        await herdr.call("agent.get", { target: paneId }, 5000),
        claudeMod.panes(),
      );
      return isRecord(result) && isRecord(result.agent) ? result.agent : null;
    },
    conversationSession: (paneId) =>
      conversation?.ownedSession(paneId)?.session_id ?? null,
    conversationModel: (paneId) => conversation?.model(paneId) ?? null,
    restartProcess: (paneId) =>
      conversation
        ? conversation.restartProcess(paneId)
        : Promise.resolve({ ok: false, reason: "Not ready" }),
    restartTerminal: (paneId, sessionId) =>
      conversation
        ? conversation.restartTerminal(paneId, sessionId)
        : Promise.resolve({ ok: false, reason: "Not ready" }),
    transcriptTail: (paneId) => transcriptTail(paneId),
    typedLaunch: (paneId, spec) => typedLaunch(paneId, spec),
    sendConversation: async (paneId, text) => {
      if (!conversation) throw new Error("Not ready");
      return conversation.send(paneId, { text });
    },
    // A Claude mod submits it once Claude is idle; else it is typed.
    promptTerminal: async (paneId, text) => {
      if (claudeMod.deliver(paneId, text, "retry")) return;
      await herdr.call("agent.prompt", { target: paneId, text }, 5000);
    },
    modUsage: (paneId) => claudeMod.pane(paneId)?.usage ?? null,
    log: (message, fields) =>
      logger.info(message, { connection: identity.id, ...fields }),
  });
  const profileRpc = (method: string, params: Record<string, unknown>) =>
    handleProfileRpc(method, params, profileRpcDeps());
  /** The panes whose Claude session Herdr knows, for the reset return. */
  const profilePanes = async () => {
    const listed = await herdr.call("agent.list", {}, 10_000);
    const agents =
      isRecord(listed) && Array.isArray(listed.agents) ? listed.agents : [];
    return agents.flatMap((agent: unknown) => {
      if (!isRecord(agent) || typeof agent.pane_id !== "string") return [];
      const owned = conversation?.ownedSession(agent.pane_id)?.session_id;
      const session = isRecord(agent.agent_session)
        ? agent.agent_session
        : null;
      const sessionId =
        owned ??
        (session && typeof session.value === "string" ? session.value : null);
      return sessionId ? [{ paneId: agent.pane_id, sessionId }] : [];
    });
  };
  const createLocalConversation = () =>
    createConversationService<ServerWebSocket<unknown>>({
      connectionId: identity.id,
      herdr: withStatusReports(
        createConversationHerdr({
          call: (method, params, timeoutMs) =>
            herdr.call(method, params, timeoutMs),
          pidAlive: config.sshHost
            ? async (pid) => {
                const result = await runProcessWithCodeTimeout(
                  sshReadCommandArgv(
                    config.sshHost!,
                    `ps -p ${Math.trunc(pid)} >/dev/null`,
                    [],
                    "agent_chat.pid",
                  ),
                  10_000,
                );
                // Unsure (no answer from the host) counts as alive.
                return result.code !== 1;
              }
            : localPidAlive,
          // Unsure (no answer from the host) throws: nothing starts or resumes.
          listProcesses: async () => {
            const result = await runProcessWithCodeTimeout(
              config.sshHost
                ? sshReadCommandArgv(
                    config.sshHost,
                    "ps -eo pid=,args=",
                    [],
                    "agent_chat.ps",
                  )
                : ["ps", "-eo", "pid=,args="],
              10_000,
            );
            if (result.code !== 0)
              throw new Error(
                `Could not list the host's processes (ps exited ${result.code})`,
              );
            return result.stdout;
          },
        }),
        (paneId) => args.onOwnedAgentStatus?.(paneId),
      ),
      leases: createLeaseStore({
        connectionId: identity.id,
        file: args.conversationLeaseFile ?? null,
      }),
      // Kept beside the leases: the conversations stopped as shell jobs.
      suspendedFile: args.conversationLeaseFile
        ? join(
            dirname(args.conversationLeaseFile),
            "conversation-suspended.json",
          )
        : null,
      ...(args.spawnHeadless ? { spawn: args.spawnHeadless } : {}),
      ask: (paneId, prompt) =>
        args.askAgentPrompt
          ? args.askAgentPrompt({
              ...prompt,
              connectionId: identity.id,
              paneId,
            })
          : Promise.resolve(null),
      // `!` lines from the chat: on the pane's host, as typed in it.
      runShell: createShellRunner({
        ...(config.sshHost ? { sshHost: config.sshHost } : {}),
        shQuote,
        annotate: forConnection,
      }),
      readImage: createImageReader({
        sshHost: config.sshHost,
        run: (argv, timeoutMs) => runProcessWithCodeTimeout(argv, timeoutMs),
        shQuote,
      }),
      // A large transcript's records come from its slim index, never read whole.
      readTranscript: (paneId) =>
        agentSessions.readRecords({ pane_id: paneId }),
      // Only asked of a turn that has been silent a long while.
      transcriptStat: async (paneId) => {
        const path = await agentSessions.resolvePath({ pane_id: paneId });
        return typeof path === "string"
          ? agentSessionFiles.statFile(path)
          : null;
      },
      handover: {
        // What the TUI still runs on the side, when its footer cannot say.
        terminalTasks: async (paneId, agent = "claude") => {
          const read = (await agentSessions.readTasks({
            pane_id: paneId,
            agent,
          })) as { tasks?: { kind?: string; status?: string }[] };
          return (read.tasks ?? []).filter(
            (task) =>
              task.status === "running" &&
              (task.kind === "command" || task.kind === "monitor"),
          ).length;
        },
        // A live Claude mod knows whether Claude is idle; Herdr's screen
        // detection may lag behind a turn that just started.
        exactStatus: (paneId) =>
          claudeMod.live(paneId)
            ? (claudeMod.pane(paneId)?.status ?? null)
            : null,
        // An /exit Claude took as a message is in its transcript's end.
        exitSwallowed: async (paneId, command, sinceMs) => {
          const path = await agentSessions.resolvePath({ pane_id: paneId });
          if (typeof path !== "string") return false;
          const tail = new TextDecoder().decode(
            await agentSessionFiles.readTail(path, 64 * 1024),
          );
          return exitSentAsMessage(tail, command, sinceMs);
        },
      },
      send: (ws, envelope) => sendConnectionEvent(ws, envelope, "agent_chat"),
      // Idle stop: the setting, read at each check.
      idleStopMinutes: async () =>
        conversationIdleStopMinutes(await readGuiSettings()),
      keepAwake: (paneId) =>
        args.conversationKeepAwake?.(identity.id, paneId) ?? null,
      // Locally, this Roamgate's own holder and socket, whatever the pane's
      // $HOME; over SSH, the host's.
      holderCommand: config.sshHost
        ? (sessionId) => holderCommand(sessionId)
        : (sessionId) =>
            holderCommand(sessionId, {
              bin: join(homedir(), REVIEW_HOME_DIR, "bin", "roamgate-hold"),
              socket: join(homedir(), REVIEW_HOME_DIR, "review.sock"),
            }),
      resumeCommand,
      // Each session's profile (its choice, else the default).
      commandFor: (sessionId) => commandForSession(sessionId),
      // /model: the profile's models, and the choice its next starts use.
      models: {
        offered: async (sessionId) =>
          profileModels(profileForSession(await readGuiSettings(), sessionId)),
        lastAnswered: async (paneId) => {
          const tail = await transcriptTail(paneId);
          return tail ? latestSessionModel(tail) : null;
        },
        chosen: (sessionId) => sessionProfiles().get(sessionId)?.model ?? null,
        choose: (sessionId, model, resolved) =>
          sessionProfiles().chooseModel(sessionId, model, resolved),
      },
      launchCommand: (paneId, spec) => typedLaunch(paneId, spec),
      onLeaseChanged: (paneId) => conversationLeaseChanged(paneId),
      log: (message, fields) =>
        logger.info(message, { connection: identity.id, ...fields }),
    });
  /** A pane's lease changed (owner, or the session after /clear). */
  function conversationLeaseChanged(paneId: string) {
    // The pane's history may now be another file (/clear).
    historyWatcher?.refresh(paneId);
    // Herdr's view of the pane changes with it (see overlayOwnedPanes):
    // the browsers read it again.
    if (!disposed)
      args.onEvent(
        { event: "roamgate.conversation_lease", data: { pane_id: paneId } },
        identity,
      );
  }
  /** Bun's own service runs again (the family back, its files read afresh). */
  function startLocalConversation() {
    if (!localConversation && !disposed)
      localConversation = createLocalConversation();
  }
  // oxlint-disable-next-line prefer-const -- read by conversation above.
  let historyWatcher: HistoryWatcher<ServerWebSocket<unknown>> | undefined;
  historyWatcher = createHistoryWatcher<ServerWebSocket<unknown>>({
    resolvePath: (params) => agentSessions.resolvePath(params),
    send: (ws, event) => sendConnectionEvent(ws, event, "agent_history"),
    ...(config.sshHost
      ? {
          spawnRemote: createRemoteStatSpawner({
            host: config.sshHost,
            shQuote,
            annotate: forConnection,
          }),
        }
      : {}),
    log: (message, fields) =>
      logger.debug(message, { connection: identity.id, ...fields }),
  });
  const ownWorktreeParents = createWorktreeParentStore({
    connectionId: identity.id,
    herdr,
    sshHost,
  });
  const worktreeParents: typeof ownWorktreeParents = {
    ...ownWorktreeParents,
    enrichWorkspaceList: async (result) =>
      workspaceLink?.routed()
        ? workspaceLink.call("enrich", { result, git_status: false })
        : ownWorktreeParents.enrichWorkspaceList(result),
  };
  const { handleHerdrInfo } = createHerdrInfoHandler({
    ping: () => herdr.ping(),
  });
  const lastStepBaselines =
    args.lastStepBaselines ??
    createLastStepBaselineStore(
      {
        host: sshHost(),
        runProcessWithCodeTimeout,
        shQuote,
      },
      { refs: true },
    );
  const ownFiles = unixOnlyHandlers(
    remotePlatform,
    "Workspace file and Git access",
    createFileHandlers({
      herdr,
      sshHost,
      runProcessWithCodeTimeout,
      shQuote,
      lastStepBaselines,
      ...(args.reviewRoots
        ? { reviewRoots: () => args.reviewRoots!(identity.id) }
        : {}),
      streamProcess: (argv) => spawnStreamingProcess(forConnection(argv)),
    }),
  );
  // While the core owns the workspace family it keeps the Last steps.
  const files: typeof ownFiles = {
    ...ownFiles,
    readLastStep: async (root, workspaceId) =>
      workspaceLink?.routed()
        ? ((await workspaceLink.call("last_step", {
            workspace_id: workspaceId,
            root,
          })) as Awaited<ReturnType<typeof ownFiles.readLastStep>>)
        : ownFiles.readLastStep(root, workspaceId),
  };
  const ownStatus = createStatusEnricher({
    connectionId: identity.id,
    sshHost,
    runProcessWithCodeTimeout:
      args.runGitStatusProcess ?? runProcessWithCodeTimeout,
    shQuote,
    onGitStatusChanged: (updates) => {
      if (disposed) return;
      args.onEvent(
        {
          event: "workspace.git_status",
          data: { type: "workspace.git_status", statuses: updates },
        },
        identity,
      );
    },
    onRefreshError: (error) =>
      logger.warn("git status refresh failed", {
        connection: identity.id,
        error: sanitizeConnectionError(error),
      }),
  });
  // While the core owns the workspace family its badges are the core's.
  const status: typeof ownStatus = {
    ...ownStatus,
    enrichWorkspacesWithGitStatus: async (result) =>
      workspaceLink?.routed()
        ? workspaceLink.call("enrich", { result, git_status: true })
        : ownStatus.enrichWorkspacesWithGitStatus(result),
    invalidateGitStatus: (root) => {
      if (workspaceLink?.routed())
        void workspaceLink.call("invalidate", { root }).catch(() => undefined);
      else ownStatus.invalidateGitStatus(root);
    },
    invalidateWorkspaceGitStatus: (workspaceId) => {
      if (workspaceLink?.routed())
        void workspaceLink
          .call("invalidate", { workspace_id: workspaceId })
          .catch(() => undefined);
      else ownStatus.invalidateWorkspaceGitStatus(workspaceId);
    },
  };
  const workspaceAutoSync = createWorkspaceAutoSync({
    connectionId: identity.id,
    logger: logger.child("auto-sync"),
    formatError: sanitizeConnectionError,
    herdr,
    sshHost,
    runProcessWithCodeTimeout,
    shQuote,
    invalidateGitStatus: status.invalidateGitStatus,
    resolveWorkspaceGitRoot: async (workspaceId) =>
      files.resolveWorkspaceGitRoot({ workspace_id: workspaceId }),
  });
  const worktreeHooks = unixOnlyHandlers(
    remotePlatform,
    "Worktree hook access",
    createWorktreeHookRunner({
      connectionId: identity.id,
      herdr,
      sshHost,
      runProcess,
      runProcessWithCode,
      shQuote,
    }),
  );
  const worktreeRemovalCoordinator = createWorktreeRemovalCoordinator();
  const worktreeRemovalRuntime = createWorktreeRemovalRuntime({
    host: sshHost(),
    runProcessWithCodeTimeout,
    shQuote,
  });
  const handleImageUpload = createImageUploadHandler({ sshHost });
  const onUploadCleanupError = (error: unknown) =>
    logger.warn("terminal upload cleanup failed", {
      connection: identity.id,
      error: sanitizeConnectionError(error),
    });
  const handleTerminalUpload = createTerminalUploadHandler({
    sshHost,
    onCleanupError: onUploadCleanupError,
  });
  // The core's own while it owns the host family.
  const sshTunnel = args.host
    ? null
    : createSshTunnelManager({
        connectionId: identity.id,
        logger: logger.child("ssh"),
        formatError: sanitizeConnectionError,
        config,
        runProcess,
        onUnexpectedExit: args.onTransportExit,
        onMasterReady: () => {
          if (!disposed) args.onSshMasterReady?.();
        },
      });
  const handleSettingsRpc = createSettingsRpcHandler({
    connectionId: identity.id,
    connectionGeneration: args.connectionGeneration,
    herdr,
    sshHost,
    readWorktreeHooks: worktreeHooks.readWorktreeHooks,
    resolveWorkspaceGitRoot: async (workspaceId) =>
      files.resolveWorkspaceGitRoot({ workspace_id: workspaceId }),
    workspaceAutoSyncIsRunning: workspaceAutoSync.isRunning,
    onWorkspaceAutoSyncSettingsChanged: workspaceAutoSync.settingsChanged,
    onAgentAutoRenameSettingsChanged: () => tabAutoRenamer.settingsChanged(),
    onClaudeStartSettingsChanged: () => args.onClaudeStartSettingsChanged?.(),
    onLimitResumeSettingsChanged: () => args.onLimitResumeSettingsChanged?.(),
    onTerminalTransportSettingsChanged: (enabled) =>
      terminalTransportChanged(enabled),
    safeSend: args.safeSend,
    markRpcError: args.markRpcError,
  });
  function terminalTransportChanged(enabled: boolean) {
    if (disposed) return;
    terminalBridge.refreshSurfaceCodecs();
    args.onEvent(
      {
        event: "settings.terminal_transport.updated",
        data: { surface_codecs: enabled },
      },
      identity,
    );
  }
  // What the settings' other writer (the Rust core, while it owns the
  // settings family) changed itself: this connection follows as its own
  // handler would have.
  const stopSettingsListener = onGuiSettingsChanged((previous, next) => {
    if (disposed) return;
    if (
      previous?.auto_rename_agent_tabs !== next.auto_rename_agent_tabs &&
      previous !== null
    )
      tabAutoRenamer.settingsChanged();
    const enabled = terminalSurfaceCodecsEnabled(next, identity.id);
    if (
      previous !== null &&
      terminalSurfaceCodecsEnabled(previous, identity.id) !== enabled
    )
      terminalTransportChanged(enabled);
  });
  const handleForwardRpc = args.forwards
    ? createForwardRpcHandler({
        connectionId: identity.id,
        connectionGeneration: args.connectionGeneration,
        sshHost,
        runProcess,
        forwards: args.forwards,
        safeSend: args.safeSend,
        markRpcError: args.markRpcError,
      })
    : null;

  /** The pane showing a terminal, from Herdr's pane list. */
  const lookupPaneId = async (terminalId: string): Promise<string | null> => {
    try {
      const result = await herdr.call("pane.list", {}, 5000);
      const panes = (result as { panes?: unknown } | null)?.panes;
      if (!Array.isArray(panes)) return null;
      for (const pane of panes) {
        if (!pane || typeof pane !== "object" || Array.isArray(pane)) continue;
        const record = pane as { pane_id?: unknown; terminal_id?: unknown };
        if (
          record.terminal_id === terminalId &&
          typeof record.pane_id === "string" &&
          record.pane_id.length > 0
        ) {
          return record.pane_id;
        }
      }
      return null;
    } catch {
      return null;
    }
  };
  // When the user last typed in each terminal, for the voice companion's
  // events (voice/turn-causes.ts): an Enter is noted at once, other keys
  // at most every TYPED_NOTE_MS.
  const typedAt = new Map<string, number>();
  const noteTyped = (terminalId: string, input: Uint8Array) => {
    const submitted = input.includes(0x0d);
    const now = Date.now();
    const last = typedAt.get(terminalId);
    if (!submitted && last !== undefined && now - last < TYPED_NOTE_MS) return;
    typedAt.delete(terminalId);
    typedAt.set(terminalId, now);
    if (typedAt.size > 200) typedAt.delete(typedAt.keys().next().value!);
    void lookupPaneId(terminalId).then((paneId) => {
      if (!paneId) return;
      if (submitted)
        turnCauses.note(identity.id, paneId, { by: "user", via: "terminal" });
      else turnCauses.noteUser(identity.id, paneId);
    });
  };
  const terminalBridge = createTerminalBridge({
    connectionId: identity.id,
    onInput: noteTyped,
    broadcast: args.broadcast,
    logger: logger.child("terminal"),
    connectionGeneration: args.connectionGeneration,
    formatError: sanitizeConnectionError,
    clientSocketPath,
    surfaceCodecsEnabled: async () =>
      terminalSurfaceCodecsEnabled(await readGuiSettings(), identity.id),
    herdrProtocol: async () => {
      const protocol: unknown = (await herdr.ping()).protocol;
      assertSupportedHerdrProtocol(protocol);
      return protocol;
    },
    // Any request Herdr's main loop handles wakes it; a fresh tab list is a
    // cheap one, and keeps the reused one current.
    wakeHerdr: () => {
      herdr
        .call("tab.list", {}, 2000, undefined, { fresh: true })
        .catch(() => undefined);
    },
    // Creation checks Herdr's current state, never a reused answer.
    createEmptyWorkspace: createEmptyWorkspaceCreator(
      (method, params, timeoutMs) =>
        herdr.call(method, params, timeoutMs, undefined, { fresh: true }),
    ),
    validateCreationSource: async (source) => {
      const result = await herdr.call(
        "pane.get",
        { pane_id: source.pane_id },
        5000,
        undefined,
        { fresh: true },
      );
      assertEndpointCreationSource(source, result?.pane);
    },
    focusedWorkspaceId: async () => {
      const result = await herdr.call("workspace.list", {}, 5000);
      return (
        result?.workspaces?.find(
          (workspace: { focused?: boolean }) => workspace.focused,
        )?.workspace_id ?? null
      );
    },
    lookupPaneId,
    // While a handover runs, keys typed in a browser's terminal would land
    // in the exiting TUI or the bare shell.
    inputRefusal: async (terminalId) => {
      if (!conversation?.handingOver()) return null;
      const paneId = await lookupPaneId(terminalId);
      return paneId ? conversation.inputRefusal(paneId) : null;
    },
    safeSend: args.safeSend,
    dropCoalesced: dropCoalescedMessage,
    clientLabel: args.clientLabel,
    markRpcError: args.markRpcError,
    confirmRelayResize: async ({ cols, rows, paneId }) => {
      if (!paneId) return false;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          const result = await herdr.call("pane.layout", { pane_id: paneId });
          const area = result?.layout?.area;
          if (
            area &&
            Number(area.x) + Number(area.width) === cols &&
            Number(area.y) + Number(area.height) === rows
          ) {
            return true;
          }
        } catch {
          return false;
        }
        await Bun.sleep(50);
      }
      return false;
    },
  });

  const createTurns = () =>
    createLastStepTurnTracker({
      captureWorkspaceBaseline: async (workspaceId) => {
        if (remotePlatform === "windows") return;
        await lastStepBaselines.captureWorkspace(workspaceId, async () => {
          if (args.resolveLastStepWorkspaceGitRoot) {
            return args.resolveLastStepWorkspaceGitRoot(workspaceId);
          }
          const { root } = await files.resolveWorkspaceGitRoot({
            workspace_id: workspaceId,
          });
          return root;
        });
      },
      completeWorkspaceStep: async (workspaceId) => {
        // A finished agent turn is the likeliest moment for the tree to change.
        status.invalidateWorkspaceGitStatus(workspaceId);
        try {
          await lastStepBaselines.completeWorkspace(workspaceId);
        } finally {
          // File refresh depends on step completion, not Git snapshot availability.
          if (!disposed) {
            args.onEvent(
              {
                event: "workspace.last_step_completed",
                data: {
                  type: "workspace.last_step_completed",
                  workspace_id: workspaceId,
                },
              },
              identity,
            );
          }
        }
      },
      onCaptureError: (error, workspaceId) =>
        logger.warn("last-step baseline failed", {
          connection: identity.id,
          workspace: workspaceId,
          error: sanitizeConnectionError(error),
        }),
      onCompleteError: (error, workspaceId) =>
        logger.warn("last-step completion failed", {
          connection: identity.id,
          workspace: workspaceId,
          error: sanitizeConnectionError(error),
        }),
      transitionDebounceMs: args.lastStepTransitionDebounceMs ?? 150,
    });
  let lastStepTurns = createTurns();
  /** Bun's tracker stopped (the core took the family): made again on return. */
  let turnsStopped = false;
  const workspaceLink = args.workspaceFront?.attach({
    connectionId: identity.id,
    generation: args.connectionGeneration ?? 0,
    sshHost: config.sshHost ?? null,
    remotePlatform: remotePlatform ?? null,
    stopOwn: async () => {
      await workspaceAutoSync.stop();
      if (!turnsStopped) {
        turnsStopped = true;
        await lastStepTurns.stop();
      }
    },
    startOwn: () => {
      if (disposed) return;
      if (turnsStopped) {
        lastStepTurns = createTurns();
        turnsStopped = false;
      }
      if (remotePlatform !== "windows") workspaceAutoSync.start();
    },
  });
  const agentStatusRecovery = createRecoveryReporter({
    logger: logger.child("agent-status"),
    failureMessage: "agent status subscription failed",
    recoveryMessage: "agent status subscription recovered",
  });
  const taskNotificationSource = args.taskNotificationSource ?? "status";
  // Set when Herdr lacks endpoint support (< 0.9 or endpoints disabled); a
  // temporarily disconnected 0.9 server does not fall back, avoiding duplicates.
  let herdrNotificationsUnavailable = false;
  const relayTaskEvent = (event: TaskEvent) => {
    args.onTaskEvent?.(event);
    // Pages disable their own tracker when the bridge relays notifications.
    args.onEvent(
      {
        event: "roamgate.task_notification",
        data: {
          type: "roamgate.task_notification",
          kind: event.kind,
          agent: event.agent,
          title:
            event.title ??
            (event.kind === "blocked" ? "Agent needs input" : "Task completed"),
          body:
            event.body ??
            ([event.workspaceLabel?.trim(), event.tabLabel?.trim()]
              .filter(Boolean)
              .join(" \u00b7 ") ||
              null),
          workspace_id: event.workspaceId ?? null,
          tab_id: event.tabId ?? null,
          pane_id: event.paneId ?? null,
        },
      },
      identity,
    );
  };
  const pendingTaskEvents = new Map<string, TaskEvent>();
  const taskEvents = createTaskEventTracker(async (event) => {
    // Status events publish in status mode, or as the legacy-Herdr fallback.
    const publishes =
      taskNotificationSource === "status"
        ? Boolean(args.onTaskEvent)
        : herdrNotificationsUnavailable;
    const paneId = event.paneId;
    if (!publishes || disposed || !paneId) return;
    pendingTaskEvents.set(paneId, event);
    // Resolve labels on demand so push works without a browser and after renames.
    const [workspaceResult, tabResult] = await Promise.all([
      herdr
        .call("workspace.get", { workspace_id: event.workspaceId }, 5000)
        .catch(() => null),
      herdr
        .call("tab.list", { workspace_id: event.workspaceId }, 5000)
        .catch(() => null),
    ]);
    // An older lookup must not publish over a newer notification for this pane.
    if (disposed || pendingTaskEvents.get(paneId) !== event) return;
    pendingTaskEvents.delete(paneId);
    const workspaceLabel = workspaceResult?.workspace?.label;
    const tab = Array.isArray(tabResult?.tabs)
      ? tabResult.tabs.find(
          (tab: { tab_id?: unknown; workspace_id?: unknown } | null) =>
            tab?.tab_id === event.tabId &&
            tab?.workspace_id === event.workspaceId,
        )
      : undefined;
    const labeled: TaskEvent = {
      ...event,
      workspaceLabel:
        typeof workspaceLabel === "string" ? workspaceLabel : undefined,
      tabLabel: typeof tab?.label === "string" ? tab.label : undefined,
    };
    if (taskNotificationSource === "status") args.onTaskEvent?.(labeled);
    else if (herdrNotificationsUnavailable) relayTaskEvent(labeled);
  });
  const herdrNotificationRecovery = createRecoveryReporter({
    logger: logger.child("notifications"),
    failureMessage: "Herdr notification shell failed",
    recoveryMessage: "Herdr notification shell recovered",
  });
  const herdrNotifications =
    taskNotificationSource === "herdr"
      ? createHerdrNotificationListener({
          clientSocketPath,
          // Same gate as endpoint terminal sessions (see navigationMode).
          isAvailable: async () =>
            roamgateEnv("DISABLE_ENDPOINT") !== "1" &&
            isTerminalHelloProtocol((await herdr.ping()).protocol),
          onUnavailable: () => {
            if (!herdrNotificationsUnavailable)
              logger.info(
                "Herdr notifications need Herdr >= 0.9; using agent status",
                { connection: identity.id },
              );
            herdrNotificationsUnavailable = true;
          },
          onConnected: () => {
            herdrNotificationsUnavailable = false;
            if (
              !herdrNotificationRecovery.recovered({ connection: identity.id })
            ) {
              logger.info("listening for Herdr notifications", {
                connection: identity.id,
              });
            }
          },
          onError: (error) =>
            herdrNotificationRecovery.failure(sanitizeConnectionError(error), {
              connection: identity.id,
            }),
          onNotification: (notification) => {
            if (disposed) return;
            const event = taskEventFromSemanticNotification(notification);
            logger.debug("Herdr notification", {
              connection: identity.id,
              kind: notification.kind,
              forwarded: event !== null,
            });
            if (event) relayTaskEvent(event);
          },
        })
      : null;
  let taskListRevision = 0;
  let paneListStartedAt = 0;
  const agentStatusSubscriptions = createAgentStatusSubscriptionLoop({
    herdr,
    connectionId: identity.id,
    onSubscribeError: (error) =>
      agentStatusRecovery.failure(sanitizeConnectionError(error), {
        connection: identity.id,
      }),
    onListError: (error) =>
      agentStatusRecovery.failure(sanitizeConnectionError(error), {
        connection: identity.id,
        operation: "pane list",
      }),
    onPaneListStart: () => {
      paneListStartedAt = Date.now();
      taskListRevision = taskEvents.beginPaneList();
      if (workspaceLink?.routed()) return workspaceLink.paneListStart();
      return lastStepTurns.beginPaneList();
    },
    onPaneList: (result, revision) => {
      taskEvents.reconcilePaneList(result, taskListRevision);
      if (workspaceLink?.routed())
        workspaceLink.paneList(result, revision ?? 0);
      else lastStepTurns.reconcilePaneList(result, revision);
      args.onPaneList?.(result, paneListStartedAt);
    },
    log: (message) => {
      agentStatusRecovery.recovered({ connection: identity.id });
      logger.debug(message, { connection: identity.id });
    },
  });

  const tabAutoRenamer = createTabAutoRenamer({
    herdr,
    getAgentTitleForPane: createAgentTabTitleReader({
      herdrCall: (method, params) => herdr.call(method, params, 5000),
      readSummary: agentSessions.readSummary,
      sshHost: config.sshHost,
      remotePlatform,
      run: runBinaryProcessWithTimeout,
    }),
    isEnabled: async () =>
      (await readGuiSettings()).auto_rename_agent_tabs !== false,
    pollIntervalMs: 30_000,
    log: (message) => logger.debug(message, { connection: identity.id }),
  });

  const onHerdrEvent = (event: unknown) => {
    // A closed pane takes its conversation lease (and process) with it.
    const closed = conversationCloseEvent(event);
    if (closed === "sweep") void conversation?.sweep();
    else if (closed) conversation?.paneClosed(closed.paneId);
    taskEvents.handleHerdrEvent(event);
    if (workspaceLink?.routed()) workspaceLink.herdrEvent(event);
    else lastStepTurns.handleHerdrEvent(event);
    agentStatusSubscriptions.handleHerdrEvent(event);
    tabAutoRenamer.handleHerdrEvent(event);
    if ((event as { event?: string })?.event === "workspace.focused")
      terminalBridge.refreshPopupObserverFocus();
    args.onEvent(event, identity);
  };
  const onHerdrError = (error: unknown) => args.onError?.(error, identity);
  herdr.on("event", onHerdrEvent);
  herdr.on("error", onHerdrError);

  const eventSubscriptionRecovery = createRecoveryReporter({
    logger: logger.child("events"),
    failureMessage: "event subscription failed",
    recoveryMessage: "event subscription recovered",
  });
  /** The event subscription was acknowledged (again). */
  const subscriptionReady = () => {
    // Browser snapshots may start before the subscription ACK. Reconcile
    // after every ACK (including reconnect) to close that missed-event gap.
    // The browser's generic refresh path queues another snapshot if busy.
    args.onEvent({ event: "session.resync_required", data: {} }, identity);
    // Panes closed while no event could come.
    void conversation?.sweep();
  };
  const subscriptionLoop = createEventSubscriptionLoop({
    subscribe: () => herdr.subscribe(DEFAULT_EVENTS),
    onReady: () => {
      subscriptionReady();
      if (!eventSubscriptionRecovery.recovered({ connection: identity.id })) {
        logger.info("subscribed to Herdr events", { connection: identity.id });
      }
    },
    onSubscribeError: (error) =>
      eventSubscriptionRecovery.failure(sanitizeConnectionError(error), {
        connection: identity.id,
        retry_ms: 2_000,
      }),
    onSubscriptionClosed: () =>
      eventSubscriptionRecovery.failure("subscription closed", {
        connection: identity.id,
        retry_ms: 2_000,
      }),
  });

  let transportStart: Promise<void> | null = null;
  let transportStarted = false;
  let backgroundStarted = false;
  let disposed = false;
  let stopTask: Promise<void> | null = null;

  async function recoveryIdentity(
    signal?: AbortSignal,
  ): Promise<string | null> {
    signal?.throwIfAborted();
    if (disposed) throw new Error("connection runtime is disposed");
    if (roamgateEnv("DISABLE_ENDPOINT") === "1") return null;
    const ping = await herdr.call("ping", {}, 5_000);
    signal?.throwIfAborted();
    if (disposed) throw new Error("connection runtime is disposed");
    if (!isTerminalHelloProtocol(ping.protocol)) return null;
    // A passive handshake reads the existing server boot identity without a
    // terminal attachment or another long-lived background connection.
    const client = new EndpointClient(clientSocketPath, false, "notifications");
    let bootId: string | null = null;
    client.on("snapshot", (snapshot: EndpointSnapshot) => {
      bootId = snapshot.bootId || null;
    });
    client.on("error", () => {});
    const abort = () => client.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      await client.connect(80, 24);
      signal?.throwIfAborted();
      if (disposed) throw new Error("connection runtime is disposed");
      return bootId;
    } finally {
      signal?.removeEventListener("abort", abort);
      client.close();
    }
  }

  async function startTransport() {
    if (disposed) throw new Error("connection runtime is disposed");
    if (transportStarted) return;
    if (transportStart) return transportStart;
    transportStart = (sshTunnel?.startAutoSshTunnel() ?? Promise.resolve())
      .then(() => {
        if (!disposed) transportStarted = true;
      })
      .finally(() => {
        transportStart = null;
      });
    return transportStart;
  }

  function startBackground() {
    if (disposed) throw new Error("connection runtime is disposed");
    if (backgroundStarted) return;
    backgroundStarted = true;
    if (remotePlatform !== "windows")
      void handleTerminalUpload.startCleanup().catch(onUploadCleanupError);
    // Auto-sync and Last step turns: this runtime's, or the core's.
    if (workspaceLink) workspaceLink.ready();
    else if (remotePlatform !== "windows") workspaceAutoSync.start();
    // The core subscribes while it owns the host family (hostEvents).
    if (!args.host) {
      subscriptionLoop.start();
      agentStatusSubscriptions.start();
    }
    tabAutoRenamer.start();
    herdrNotifications?.start();
  }

  function stop() {
    if (stopTask) return stopTask;
    if (disposed) return Promise.resolve();
    disposed = true;
    backgroundStarted = false;
    stopSettingsListener();
    handleTerminalUpload.stopCleanup();
    tabAutoRenamer.dispose();
    herdr.off("event", onHerdrEvent);
    herdr.off("error", onHerdrError);
    taskEvents.stop();
    pendingTaskEvents.clear();
    herdrNotifications?.stop();
    status.dispose();
    const autoSyncStop = workspaceAutoSync.stop();
    // A forward outlives nothing: its ssh process rides the same credentials
    // and host as the connection that asked for it. Listed as lost, not
    // removed, so a reconnect does not make forwards vanish unexplained.
    args.forwards?.loseConnection(identity.id);
    terminalBridge.dispose();
    // The headless processes go with the connection; their leases stay and
    // the next turn starts them again.
    localConversation?.dispose();
    historyWatcher?.dispose();
    const subscriptionStop = subscriptionLoop.stop();
    const agentStatusStop = agentStatusSubscriptions.stop();
    const lastStepStop = (
      turnsStopped ? Promise.resolve() : lastStepTurns.stop()
    ).then(() => lastStepBaselines.dispose());
    const workspaceStop = workspaceLink?.stopped() ?? Promise.resolve();
    const transportCleanup =
      sshTunnel?.cleanupAutoSshTunnel() ?? Promise.resolve();
    const transportStop =
      transportStart?.catch(() => undefined) ?? Promise.resolve();
    stopTask = Promise.all([
      autoSyncStop,
      subscriptionStop,
      agentStatusStop,
      lastStepStop,
      workspaceStop,
      transportCleanup,
      transportStop,
    ]).then(() => undefined);
    return stopTask;
  }

  /**
   * What the core's subscriptions saw while it owns the host family, in
   * order (host-facade.ts `HostEvent`): Herdr's events reach the same
   * listeners as a subscription's here, and its agent status listings the
   * same trackers.
   */
  const paneListStarts = new Map<
    number,
    { startedAt: number; taskRevision: number; stepRevision: number }
  >();
  function hostEvents(events: HostEvent[]) {
    if (disposed) return;
    for (const each of events) {
      if (disposed) return;
      try {
        if (each.kind === "herdr") herdr.emit("event", each.event);
        else if (each.kind === "ready") subscriptionReady();
        else if (each.kind === "pane_list_start") {
          // A listing that never ends (its runtime went) leaves no trace.
          if (paneListStarts.size > 32) paneListStarts.clear();
          paneListStarts.set(each.list, {
            startedAt: each.started_at,
            taskRevision: taskEvents.beginPaneList(),
            stepRevision: workspaceLink?.routed()
              ? workspaceLink.paneListStart()
              : lastStepTurns.beginPaneList(),
          });
        } else if (each.kind === "pane_list") {
          const started = paneListStarts.get(each.list);
          paneListStarts.delete(each.list);
          if (!started) continue;
          taskEvents.reconcilePaneList(each.result, started.taskRevision);
          if (workspaceLink?.routed())
            workspaceLink.paneList(each.result, started.stepRevision);
          else
            lastStepTurns.reconcilePaneList(each.result, started.stepRevision);
          args.onPaneList?.(each.result, started.startedAt);
        }
      } catch (error) {
        logger.warn("a host event failed", {
          connection: identity.id,
          kind: each.kind,
          error: sanitizeConnectionError(error),
        });
      }
    }
  }

  if (!conversationCore.onCore()) startLocalConversation();
  // The core's runs: it reads again what the holders run.
  else void conversationCore.call("attach", {}).catch(() => undefined);
  return {
    identity,
    socketPath,
    clientSocketPath,
    remotePlatform,
    sshHost,
    herdr,
    worktreeParents,
    handleHerdrInfo,
    handleImageUpload,
    handleTerminalUpload,
    handleSettingsRpc,
    handleForwardRpc,
    files,
    status,
    workspaceAutoSync,
    worktreeHooks,
    worktreeRemovalCoordinator,
    worktreeRemovalRuntime,
    terminalBridge,
    agentSessions,
    agentHerdrCall,
    tabAutoRenamer,
    conversation,
    /**
     * The core took conversation mode (Bun's service saves what it read
     * and goes), or gave it back (Bun's runs again, reading the files).
     */
    /** What the core's conversation mode tells this connection's front. */
    conversationLeaseChanged,
    conversationOwnedStatus: (paneId: string) =>
      args.onOwnedAgentStatus?.(paneId),
    conversationOwnerChanged(onCore: boolean) {
      if (onCore) {
        localConversation?.dispose();
        localConversation = null;
      } else startLocalConversation();
    },
    typedLaunch,
    profileRpc,
    /** What the profile RPCs need of this connection (the core's too). */
    profileHost: profileRpcDeps,
    profilePanes,
    /** The usage limit resumer's view of this connection. */
    limitConnection: limitConnection({
      id: identity.id,
      herdr,
      conversation,
      transcriptTail,
      claudeMod,
    }),
    /** This connection's Claude mods. */
    claudeMod,
    historyWatcher: historyWatcher!,
    recoveryIdentity,
    taskNotificationSource,
    startTransport,
    startBackground,
    stop,
    hostEvents,
  };
}

export type LegacyConnectionRuntime = ReturnType<
  typeof createLegacyConnectionRuntime
>;
