import { type AgentCommand, commandForSession } from "../profiles/profiles";
import { randomUUID } from "node:crypto";
import { mrProjectKey } from "../../../shared/mrReviews";
import type { MrConnection } from "./clones";
import type { MrInboxService } from "./inbox";
import { MrReviewsError } from "./rpc";
import type { MrProjectRecord, MrStore } from "./store";

/**
 * One Claude per review workspace, one Claude session per request: the
 * workspace's first pane runs `claude` on the session of the request the
 * worktree is on. Switching request resumes that request's session once
 * the checkout is done; a Claude in the middle of a turn is never stopped:
 * the user waits for it or leaves it on its request. A Claude the user
 * started there by hand (a session that is no request's) is never touched.
 * Only the user's clicks start or switch it; it reviews only when asked.
 */

export type MrClaudeState =
  /** Claude runs this request's session and waits for a prompt. */
  | { state: "ready"; paneId: string; session: string }
  /** Started or resumed; not ready yet (a trust question, its start). */
  | { state: "starting"; paneId: string; session: string }
  /** Claude is busy with another request's turn. */
  | { state: "busy"; paneId: string; with: string | null }
  /** A Claude that is no request's runs in the pane: left alone. */
  | { state: "foreign"; paneId: string }
  /** No Claude for this request (it has none yet, or it was left). */
  | { state: "none"; paneId: string | null };

type PaneAgent = {
  name: string | null;
  status: string;
  session: string | null;
};

const BUSY = new Set(["working", "blocked"]);

/** The claude command typed into the pane's shell, kept in the terminal. */
export function claudeCommand(
  session: string,
  resume: boolean,
  /** The claude start setting: conversation lets its hook take it. */
  mode: "terminal" | "conversation" = "terminal",
  // Tests run a stand-in by its absolute path.
  bin = process.env.ROAMGATE_MR_CLAUDE_COMMAND || "claude",
): string {
  if (!/^[0-9a-f-]{36}$/i.test(session)) throw new Error("invalid session id");
  if (!/^[\w./-]+$/.test(bin)) throw new Error("invalid claude command");
  // A session never written to has nothing to resume: start it by its id.
  const run = resume
    ? `sh -c '${bin} --resume ${session} || ${bin} --session-id ${session}'`
    : `${bin} --session-id ${session}`;
  // env, not VAR=value (old fish); the leading space keeps it out of the
  // history. In terminal mode the claude start hook leaves it there; in
  // conversation mode the hook takes it, as any claude started by hand.
  return mode === "terminal"
    ? ` env ROAMGATE_CLAUDE_START=terminal ${run}\r`
    : ` ${run}\r`;
}

/**
 * The session's profile when it is not plain claude: started through the
 * pane's roamgate-hold, which fetches its environment (never typed). A
 * test's stand-in command (ROAMGATE_MR_CLAUDE_COMMAND) keeps the typed one.
 */
export function profileLaunch(
  conn: Pick<MrConnection, "launch">,
  paneId: string,
  session: string,
  resume: boolean,
  mode: "terminal" | "conversation",
  command: () => AgentCommand = () => commandForSession(session),
): string | null {
  if (process.env.ROAMGATE_MR_CLAUDE_COMMAND || !conn.launch) return null;
  const profile = command();
  if (profile.plain) return null;
  return conn.launch(paneId, {
    argv: [profile.program, resume ? "--resume" : "--session-id", session],
    env: profile.env,
    unset: profile.unset,
    agent: profile.agent,
    terminal: mode === "terminal",
  });
}

export function createMrClaude(deps: {
  inbox: Pick<MrInboxService, "item">;
  store: MrStore;
  connections: () => MrConnection[];
  /** The review pane's "review with the agent" (its own review flow). */
  requestReview: (params: {
    sessionId: string;
    paneId: string;
    focus?: string;
  }) => Promise<unknown>;
  /** The claude start setting (claude_start_mode). */
  startMode?: () => Promise<"terminal" | "conversation">;
  sleep?: (ms: number) => Promise<void>;
  /** How long a start or an exit is waited for. */
  waitMs?: number;
  pollMs?: number;
}) {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = deps.waitMs ?? 20_000;
  const pollMs = deps.pollMs ?? 500;

  function project(key: string): {
    conn: MrConnection;
    record: MrProjectRecord;
    projectKey: string;
  } {
    const item = deps.inbox.item(key);
    if (!item)
      throw new MrReviewsError("no such request in the inbox", "not_found");
    const projectKey = mrProjectKey(item);
    const record = deps.store.get().projects[projectKey];
    if (!record?.workspaceId)
      throw new MrReviewsError("open the request's review first", "invalid");
    const conn = deps.connections().find((c) => c.id === record.connectionId);
    if (!conn)
      throw new MrReviewsError(
        "the review's connection is not ready",
        "unavailable",
      );
    return { conn, record, projectKey };
  }

  /** The workspace's Claude pane: the one used before, else its first. */
  async function paneOf(
    conn: MrConnection,
    record: MrProjectRecord,
    projectKey: string,
  ) {
    const listed = await conn.herdr("pane.list", {});
    const panes: any[] = (
      Array.isArray(listed?.panes) ? listed.panes : []
    ).filter((pane: any) => pane?.workspace_id === record.workspaceId);
    const pane =
      panes.find((each) => each.pane_id === record.claudePane) ?? panes[0];
    if (!pane?.pane_id) return null;
    if (pane.pane_id !== record.claudePane)
      deps.store.update((state) => {
        const entry = state.projects[projectKey];
        if (entry) entry.claudePane = pane.pane_id;
      });
    return String(pane.pane_id);
  }

  async function agentOf(
    conn: MrConnection,
    paneId: string,
    started?: string,
  ): Promise<PaneAgent> {
    let agent: any = null;
    try {
      const result = await conn.herdr("agent.get", { target: paneId });
      agent = result?.agent ?? null;
    } catch (error) {
      if (!/not.?found/i.test(String(error))) throw error;
    }
    const name = typeof agent?.agent === "string" ? agent.agent : null;
    const isClaude = !!name && /claude/i.test(name);
    const told =
      typeof agent?.agent_session?.value === "string"
        ? agent.agent_session.value
        : null;
    return {
      name: isClaude ? "claude" : name,
      status: String(agent?.agent_status ?? agent?.status ?? "unknown"),
      session: told ?? (isClaude ? (started ?? null) : null),
    };
  }

  /** The request whose Claude session this is, if any. */
  function requestOf(session: string | null): string | null {
    if (!session) return null;
    const found = Object.entries(deps.store.get().reviews).find(
      ([, review]) => review.claudeSession === session,
    );
    return found?.[0] ?? null;
  }

  async function waitFor(
    conn: MrConnection,
    paneId: string,
    done: (agent: PaneAgent) => boolean,
    started?: string,
  ): Promise<PaneAgent> {
    let agent = await agentOf(conn, paneId, started);
    for (let waited = 0; waited < waitMs && !done(agent); waited += pollMs) {
      await sleep(pollMs);
      agent = await agentOf(conn, paneId, started);
    }
    return agent;
  }

  /**
   * Puts this request's Claude in the pane. `start`: a request without a
   * session gets a new one; else only an existing session is resumed.
   */
  async function ensure(
    key: string,
    options: { start: boolean; wait?: boolean },
  ): Promise<MrClaudeState> {
    const { conn, record, projectKey } = project(key);
    const paneId = await paneOf(conn, record, projectKey);
    if (!paneId) return { state: "none", paneId: null };
    let session = deps.store.get().reviews[key]?.claudeSession ?? null;
    // Conversation mode holds the pane: its own switch, never /exit.
    const held = conn.conversation?.owned(paneId) ?? null;
    if (held) {
      if (session && held === session)
        return { state: "ready", paneId, session };
      const other = requestOf(held);
      if (!other) return { state: "foreign", paneId };
      if (!session && !options.start) return { state: "none", paneId };
      const next = session ?? randomUUID();
      if (!session) {
        if (!deps.store.get().reviews[key])
          throw new MrReviewsError(
            "open the request's review first",
            "invalid",
          );
        deps.store.update((state) => {
          state.reviews[key]!.claudeSession = next;
        });
      }
      let switched = await conn.conversation!.switch(paneId, next);
      for (
        let waited = 0;
        options.wait && !switched.ok && switched.busy && waited < waitMs;
        waited += pollMs
      ) {
        await sleep(pollMs);
        switched = await conn.conversation!.switch(paneId, next);
      }
      if (switched.ok) {
        deps.store.update((state) => {
          const entry = state.projects[projectKey];
          if (entry) entry.claudeStarted = next;
        });
        return { state: "ready", paneId, session: next };
      }
      if (switched.busy) return { state: "busy", paneId, with: other };
      throw new MrReviewsError(switched.reason, "busy");
    }
    const started = deps.store.get().projects[projectKey]?.claudeStarted;
    let agent = await agentOf(conn, paneId, started);
    if (agent.name === "claude") {
      if (session && agent.session === session)
        return {
          state: agent.status === "unknown" ? "starting" : "ready",
          paneId,
          session,
        };
      const other = requestOf(agent.session);
      if (!other) return { state: "foreign", paneId };
      if (BUSY.has(agent.status)) {
        if (!options.wait) return { state: "busy", paneId, with: other };
        agent = await waitFor(
          conn,
          paneId,
          (each) => !BUSY.has(each.status),
          started,
        );
        if (BUSY.has(agent.status))
          return { state: "busy", paneId, with: other };
      }
      if (!session && !options.start) {
        // Nothing to resume: the other request's Claude stays.
        return { state: "none", paneId };
      }
      await conn.herdr("pane.send_text", { pane_id: paneId, text: "/exit\r" });
      agent = await waitFor(conn, paneId, (each) => each.name !== "claude");
      if (agent.name === "claude")
        throw new MrReviewsError(
          "Claude did not exit in the review workspace",
          "busy",
        );
    } else if (agent.name) {
      // Another agent runs there: the user's.
      return { state: "foreign", paneId };
    }
    if (!session && !options.start) return { state: "none", paneId };
    const resume = !!session;
    if (!session) {
      session = randomUUID();
      deps.store.update((state) => {
        const review = state.reviews[key];
        if (review) review.claudeSession = session!;
      });
      if (!deps.store.get().reviews[key])
        throw new MrReviewsError("open the request's review first", "invalid");
    }
    const running = session;
    deps.store.update((state) => {
      const entry = state.projects[projectKey];
      if (entry) entry.claudeStarted = running;
    });
    const mode = (await deps.startMode?.()) ?? "terminal";
    await conn.herdr("pane.send_text", {
      pane_id: paneId,
      text:
        profileLaunch(conn, paneId, session, resume, mode) ??
        claudeCommand(session, resume, mode),
    });
    const up = await waitFor(
      conn,
      paneId,
      (each) =>
        each.name === "claude" &&
        (each.status === "idle" || each.status === "done"),
      running,
    );
    return up.name === "claude" &&
      (up.status === "idle" || up.status === "done")
      ? { state: "ready", paneId, session }
      : { state: "starting", paneId, session };
  }

  return {
    ensure,
    /** What runs in the request's review workspace, without changing it. */
    async status(key: string): Promise<MrClaudeState> {
      const { conn, record, projectKey } = project(key);
      const paneId = await paneOf(conn, record, projectKey);
      if (!paneId) return { state: "none", paneId: null };
      const session = deps.store.get().reviews[key]?.claudeSession ?? null;
      const held = conn.conversation?.owned(paneId) ?? null;
      if (held) {
        if (session && held === session)
          return { state: "ready", paneId, session };
        return requestOf(held)
          ? { state: "none", paneId }
          : { state: "foreign", paneId };
      }
      const agent = await agentOf(
        conn,
        paneId,
        deps.store.get().projects[projectKey]?.claudeStarted,
      );
      if (agent.name !== "claude")
        return agent.name
          ? { state: "foreign", paneId }
          : { state: "none", paneId };
      if (session && agent.session === session)
        return { state: "ready", paneId, session };
      const other = requestOf(agent.session);
      if (!other) return { state: "foreign", paneId };
      return BUSY.has(agent.status)
        ? { state: "busy", paneId, with: other }
        : { state: "none", paneId };
    },
    /**
     * "Review with Claude": its Claude, then the review pane's own review
     * request, so its threads land in Roamgate's review of the request.
     */
    async review(key: string, focus?: string): Promise<MrClaudeState> {
      const state = await ensure(key, { start: true, wait: false });
      if (state.state !== "ready") return state;
      const review = deps.store.get().reviews[key];
      if (!review)
        throw new MrReviewsError("open the request's review first", "invalid");
      await deps.requestReview({
        sessionId: review.sessionId,
        paneId: state.paneId,
        ...(focus ? { focus } : {}),
      });
      return state;
    },
  };
}

export type MrClaude = ReturnType<typeof createMrClaude>;
