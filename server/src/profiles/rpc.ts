import {
  allProfiles,
  isPlainProfile,
  latestSessionModel,
  latestUsageLimit,
  profileModelLabel,
  profileNamed,
  profileServesModel,
  switchModel,
  type UsageLimit,
} from "../../../shared/agentProfiles";
import { isRecord } from "../agent/session-utils";
import type { GuiSettings } from "../config/gui-settings";
import {
  type LaunchSpec,
  profileCommand,
  profileForSession,
  profilesOf,
  type SessionProfiles,
} from "./profiles";

/** What the session RPCs need of a connection. */
export type ProfileRpcDeps = {
  readSettings: () => Promise<GuiSettings>;
  store: SessionProfiles;
  /** Herdr's agent in the pane (agent.get), or null. */
  agentGet: (paneId: string) => Promise<Record<string, unknown> | null>;
  /** The session conversation mode owns in the pane, if it does. */
  conversationSession: (paneId: string) => string | null;
  restartProcess: (
    paneId: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  restartTerminal: (
    paneId: string,
    sessionId?: string,
  ) => Promise<{ ok: boolean; reason?: string }>;
  /** The end of the pane session's transcript, or null. */
  transcriptTail: (paneId: string) => Promise<string | null>;
  typedLaunch: (paneId: string, spec: LaunchSpec) => string;
  /** Sends a message to the session: conversation mode's queue. */
  sendConversation: (paneId: string, text: string) => Promise<unknown>;
  /** Types a prompt into the terminal's idle Claude (agent.prompt). */
  promptTerminal: (paneId: string, text: string) => Promise<unknown>;
  now?: () => number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
};

export class ProfileRpcError extends Error {}

/** What a retry sends: Claude Code's own word for going on. */
export const RETRY_TEXT = "continue";

/**
 * A refusal said of the agent, not of its program: a Claude Code session
 * may run another profile's model, so "Claude is working" becomes "The
 * agent is working". Commands (`claude --resume`) are left as they are.
 */
export function agentNeutral(reason: string): string {
  const text = reason
    .replace(/\bClaude's\b/g, "the agent's")
    .replace(/\bClaude\b(?! Code)/g, "the agent");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sessionOf(agent: Record<string, unknown> | null): string | null {
  const session =
    agent && isRecord(agent.agent_session) ? agent.agent_session : null;
  return session && session.kind === "id" && typeof session.value === "string"
    ? session.value
    : null;
}

function paneIdOf(params: Record<string, unknown>): string {
  const paneId = params.pane_id;
  if (typeof paneId !== "string" || !paneId)
    throw new ProfileRpcError("pane_id is required");
  return paneId;
}

/** The pane's Claude session and who runs it; null when none. */
async function paneSession(deps: ProfileRpcDeps, paneId: string) {
  const owned = deps.conversationSession(paneId);
  if (owned) return { sessionId: owned, owner: "conversation" as const };
  const agent = await deps.agentGet(paneId).catch(() => null);
  if (!agent || agent.agent !== "claude") return null;
  const sessionId = sessionOf(agent);
  return sessionId
    ? {
        sessionId,
        owner: "terminal" as const,
        status:
          typeof agent.agent_status === "string" ? agent.agent_status : "",
      }
    : null;
}

export const PROFILE_RPC_METHODS = new Set([
  "agent_profile.get",
  "agent_profile.switch",
  "agent_profile.launch",
  "agent_profile.retry",
]);

/**
 * agent_profile.get: the pane session's profile, the others, and the
 * usage limit it stopped on. agent_profile.switch: runs the session with
 * another profile now (same session, resumed). agent_profile.launch: what
 * to type to start a new session with a profile.
 */
export async function handleProfileRpc(
  method: string,
  params: Record<string, unknown>,
  deps: ProfileRpcDeps,
): Promise<unknown> {
  const now = deps.now ?? Date.now;
  const settings = await deps.readSettings();
  const profiles = profilesOf(settings);
  const offered = allProfiles(profiles.list);
  const defaultName =
    profileNamed(profiles.list, profiles.default)?.name ?? offered[0]!.name;
  const listed = offered.map((profile) => ({
    name: profile.name,
    agent: profile.agent,
    label: profileModelLabel(profile),
    default: profile.name === defaultName,
  }));
  const paneId = paneIdOf(params);

  if (method === "agent_profile.launch") {
    const wanted =
      typeof params.profile === "string" ? params.profile : defaultName;
    const profile = profileNamed(profiles.list, wanted);
    if (!profile) throw new ProfileRpcError(`No profile is named ${wanted}`);
    if (isPlainProfile(profile)) return { text: null, profile: profile.name };
    const command = profileCommand(profile);
    const typed = deps.typedLaunch(paneId, {
      argv: [command.program],
      env: command.env,
      unset: command.unset,
      agent: command.agent,
      terminal: false,
    });
    return { text: typed.trim(), profile: profile.name };
  }

  const pane = await paneSession(deps, paneId);
  if (method === "agent_profile.get") {
    if (!pane)
      return { session_id: null, profiles: listed, default: defaultName };
    const profile = profileForSession(settings, pane.sessionId, deps.store);
    let limit: UsageLimit | null = null;
    if (params.limit !== false) {
      const tail = await deps.transcriptTail(paneId).catch(() => null);
      limit = tail ? latestUsageLimit(tail, now()) : null;
      // Started with a model of its own after a switch (switchModel): once
      // it answered on its profile, Claude Code resumes on that by itself.
      const forced = deps.store.get(pane.sessionId)?.model;
      const answered = forced && tail ? latestSessionModel(tail) : null;
      if (answered && profileServesModel(profile, answered))
        deps.store.settleModel(pane.sessionId);
    }
    const choice = deps.store.get(pane.sessionId);
    return {
      session_id: pane.sessionId,
      owner: pane.owner,
      profile: profile.name,
      label: profileModelLabel(profile),
      default: defaultName,
      profiles: listed,
      limit,
      ...(choice?.return_at && profiles.return_after_reset
        ? { returns_at: choice.return_at, returns_to: choice.return_to }
        : {}),
    };
  }

  if (method === "agent_profile.retry") {
    // After a usage limit (or a change of account): the same profile
    // tries again, as typing "continue" would.
    if (!pane) throw new ProfileRpcError("No agent session runs in this pane");
    if (pane.owner === "conversation")
      await deps.sendConversation(paneId, RETRY_TEXT);
    else {
      if (pane.status && pane.status !== "idle" && pane.status !== "done")
        return { ok: false, reason: "The agent is not idle in the terminal" };
      await deps.promptTerminal(paneId, RETRY_TEXT);
    }
    deps.log?.("session retried after a usage limit", {
      pane: paneId,
      session: pane.sessionId,
      owner: pane.owner,
    });
    return { ok: true, at: now() };
  }

  if (method === "agent_profile.switch") {
    if (!pane) throw new ProfileRpcError("No agent session runs in this pane");
    if (
      typeof params.session_id === "string" &&
      params.session_id !== pane.sessionId
    )
      throw new ProfileRpcError("The pane now runs another session");
    const wanted = typeof params.profile === "string" ? params.profile : "";
    const profile = profileNamed(profiles.list, wanted);
    if (!profile) throw new ProfileRpcError(`No profile is named ${wanted}`);
    // A secret that cannot be read refuses here, before Claude exits.
    profileCommand(profile);
    const previous = deps.store.get(pane.sessionId);
    const resetsAt =
      typeof params.resets_at === "number" && params.resets_at > now()
        ? params.resets_at
        : null;
    const back =
      resetsAt !== null && profile.name !== defaultName
        ? { at: resetsAt, to: defaultName }
        : undefined;
    // Claude Code resumes a session on the model it last answered with:
    // one this profile's endpoint lacks is replaced for the next start.
    const tail = await deps.transcriptTail(paneId).catch(() => null);
    const model = switchModel(tail, profile);
    deps.store.set(
      pane.sessionId,
      profile.name === defaultName ? null : profile.name,
      back,
      model,
    );
    const result =
      pane.owner === "conversation"
        ? await deps.restartProcess(paneId)
        : await deps.restartTerminal(paneId, pane.sessionId);
    if (!result.ok) {
      // Nothing changed: the session keeps what it ran with.
      deps.store.set(
        pane.sessionId,
        previous?.profile ?? null,
        previous?.return_at !== undefined && previous.return_to
          ? { at: previous.return_at, to: previous.return_to }
          : undefined,
        previous?.model,
      );
      return {
        ok: false,
        reason: agentNeutral(result.reason ?? "The switch was refused"),
      };
    }
    deps.log?.("session switched profile", {
      pane: paneId,
      session: pane.sessionId,
      profile: profile.name,
      owner: pane.owner,
      ...(back ? { returns_at: new Date(back.at).toISOString() } : {}),
    });
    return {
      ok: true,
      session_id: pane.sessionId,
      profile: profile.name,
      label: profileModelLabel(profile),
    };
  }
  throw new ProfileRpcError(`unknown method ${method}`);
}

/**
 * Sessions sent to another profile by a usage limit go back to their
 * default once it resets (when the setting says so): each pane running
 * one is switched, if idle; otherwise its next start uses the default.
 */
export async function returnAfterReset(args: {
  settings: GuiSettings;
  store: SessionProfiles;
  /** Each connection: the panes and sessions Herdr knows, and a switch. */
  connections: {
    panes: () => Promise<{ paneId: string; sessionId: string }[]>;
    switchPane: (
      paneId: string,
      profile: string,
    ) => Promise<{ ok: boolean; reason?: string }>;
  }[];
  log?: (message: string, fields?: Record<string, unknown>) => void;
}): Promise<void> {
  if (!profilesOf(args.settings).return_after_reset) return;
  const due = args.store.due();
  if (!due.length) return;
  for (const { sessionId, to } of due) {
    let found = false;
    for (const connection of args.connections) {
      const panes = await connection.panes().catch(() => []);
      const pane = panes.find((each) => each.sessionId === sessionId);
      if (!pane) continue;
      found = true;
      const result = await connection
        .switchPane(pane.paneId, to)
        .catch((error: unknown) => ({ ok: false, reason: String(error) }));
      // Refused (it works now): tried again at the next check.
      args.log?.("usage limit reset: back to the default profile", {
        pane: pane.paneId,
        session: sessionId,
        ok: result.ok,
        ...(result.ok ? {} : { reason: result.reason }),
      });
      break;
    }
    // Running nowhere: its next start is on the default.
    if (!found) args.store.set(sessionId, null);
  }
}
