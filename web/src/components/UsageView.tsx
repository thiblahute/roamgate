import { Settings2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AccountChain } from "../../../shared/agentProfiles";
import { bridge } from "../api";
import {
  type AccountUsage,
  type AccountUsageBoard,
  useAccountUsage,
} from "../accountUsage";
import { openConfiguration } from "../configurationOpen";
import { shortcutMatches } from "../shortcutPreferences";
import {
  type LivePane,
  type NamedSession,
  nameSession,
  nextInChain,
  periodStart,
  resetWords,
  type SessionRun,
  shortCount,
  sortSessions,
  tightestWindow,
  type UsageProfile,
  usageOf,
  warnLevel,
} from "../usageView";
import {
  openServerSession,
  useAllServerAgentSessions,
} from "../useAllServerAgentSessions";
import { CloseButton } from "./CloseButton";
import { focusDialogElement } from "./dialogFocus";
import "./UsageView.css";

/** One move of the chain (agent_profile.account.switches). */
export type SwitchEntry = {
  at: number;
  kind: "default" | "session";
  from: string;
  to: string;
  why: string;
  reading?: string;
  ok: boolean;
  error?: string;
};

export type Period = "today" | "week";

const STATUS_WORDS: Record<AccountUsage["status"], string> = {
  fresh: "Fresh",
  cached: "Last reading",
  failed: "Reading failed",
  rate_limited: "Rate limited",
  auth_expired: "Not signed in",
  unknown: "No usage to read",
};

const AUTH_WORDS: Record<string, string> = {
  signed_in: "Signed in",
  signed_out: "Signed out",
  needs_relogin: "Sign in again",
  unknown: "Sign-in unknown",
};

const AGENT_WORDS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  agy: "Antigravity",
};

const WHY_WORDS: Record<string, string> = {
  account_line: "past a line",
  usage_limit: "usage limit",
  preferred_day: "preferred day",
};

/** What the view shows; everything it reads, given (tests, a harness). */
export type UsageViewData = {
  profiles: UsageProfile[];
  defaultName: string;
  chain?: AccountChain;
  board: AccountUsageBoard;
  /** Sessions by account profile name. */
  sessions: Record<string, NamedSession[]>;
  switches: SwitchEntry[];
  period: Period;
  now?: number;
};

export type UsageViewActions = {
  onPeriod: (period: Period) => void;
  onMakeDefault: (name: string) => void;
  onOpenSession: (session: NamedSession) => void;
  onOpenSettings: () => void;
};

function Meter({
  profile,
  label,
  utilization,
  resetsAt,
}: {
  profile: string;
  label: string;
  utilization: number;
  resetsAt?: string;
}) {
  const level = warnLevel(utilization);
  const percent = Math.round(utilization);
  return (
    <div className="usage-meter" data-level={level}>
      <span className="usage-meter-label">{label}</span>
      <span
        className="usage-meter-bar"
        role="meter"
        aria-label={`${profile} ${label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% used${resetsAt ? `, ${resetWords(resetsAt)}` : ""}`}
      >
        <span
          style={{ width: `${Math.min(100, Math.max(0, utilization))}%` }}
        />
      </span>
      <span className="usage-meter-value">{percent}%</span>
      <span className="usage-meter-reset">{resetWords(resetsAt)}</span>
    </div>
  );
}

function AccountCard({
  profile,
  usage,
  position,
  isDefault,
  sessions,
  actions,
}: {
  profile: UsageProfile;
  usage: AccountUsage | undefined;
  position: number | null;
  isDefault: boolean;
  sessions: NamedSession[];
  actions: UsageViewActions;
}) {
  const account = profile.account;
  const tokensIn = sessions.reduce((sum, each) => sum + each.tokensIn, 0);
  const tokensOut = sessions.reduce((sum, each) => sum + each.tokensOut, 0);
  const signIn = account?.clauth
    ? "clauth manages this sign-in"
    : AUTH_WORDS[account?.auth ?? "unknown"];
  return (
    <article className="usage-card" aria-label={profile.name}>
      <header className="usage-card-head">
        <div>
          <h3>
            {profile.name}
            {isDefault ? <span className="usage-badge">Default</span> : null}
            {position !== null ? (
              <span className="usage-badge is-quiet">#{position} in chain</span>
            ) : null}
          </h3>
          <p>
            {[
              AGENT_WORDS[profile.agent] ?? profile.agent,
              usage?.usage?.plan,
              usage?.usage?.email,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p>
            {signIn}
            {usage ? ` · ${STATUS_WORDS[usage.status]}` : ""}
            {usage?.error ? ` (${usage.error})` : ""}
          </p>
        </div>
        {isDefault ? null : (
          <button
            type="button"
            className="usage-button"
            onClick={() => actions.onMakeDefault(profile.name)}
          >
            Make default
          </button>
        )}
      </header>
      <div className="usage-meters">
        {usage?.usage?.windows.length ? (
          usage.usage.windows.map((window) => (
            <Meter
              key={window.label}
              profile={profile.name}
              label={window.label}
              utilization={window.utilization}
              resetsAt={window.resets_at}
            />
          ))
        ) : (
          <p className="usage-note">No reading yet.</p>
        )}
      </div>
      <div className="usage-sessions">
        <h4>
          Sessions{" "}
          <small>
            {sessions.length
              ? `${sessions.length}, ${shortCount(tokensIn)} in, ${shortCount(tokensOut)} out`
              : "none"}
          </small>
        </h4>
        {sessions.length ? (
          <ul>
            {sessions.map((session) => (
              <li key={`${session.session_id}-${session.started_at}`}>
                <span className="usage-session-name">
                  {session.live ? (
                    <button
                      type="button"
                      className="usage-link"
                      title="Open it"
                      onClick={() => actions.onOpenSession(session)}
                    >
                      {session.name}
                    </button>
                  ) : (
                    session.name
                  )}
                </span>
                <span className="usage-session-place">{session.place}</span>
                <span className="usage-session-tokens">
                  {shortCount(session.tokensIn)} in,{" "}
                  {shortCount(session.tokensOut)} out
                </span>
                <span className="usage-session-when">
                  {new Date(session.started_at).toLocaleString(undefined, {
                    weekday: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                  {session.pinned ? " · pinned" : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

/** The Usage view's content, from what it is given. */
export function UsageViewBody({
  data,
  actions,
}: {
  data: UsageViewData;
  actions: UsageViewActions;
}) {
  const accounts = data.profiles.filter((profile) => profile.account);
  const chain = data.chain;
  const next = nextInChain(
    chain,
    data.profiles,
    data.defaultName,
    data.board,
    data.now,
  );
  const defaultProfile = accounts.find(
    (profile) => profile.name === data.defaultName,
  );
  const defaultWindow = defaultProfile
    ? tightestWindow(usageOf(data.board, defaultProfile), data.now)
    : null;
  const ordered = [
    ...(chain?.accounts ?? [])
      .map((name) => accounts.find((profile) => profile.name === name))
      .filter((profile): profile is UsageProfile => !!profile),
    ...accounts.filter((profile) => !chain?.accounts.includes(profile.name)),
  ];
  return (
    <div className="usage-body">
      <section className="usage-summary" aria-label="Account chain">
        {chain?.accounts.length ? (
          <>
            <p className="usage-chain-order">
              {chain.accounts.map((name, index) => (
                <span
                  key={name}
                  className={name === data.defaultName ? "is-default" : ""}
                >
                  {index ? " → " : ""}
                  {name}
                </span>
              ))}
            </p>
            <p>
              Auto-switch {chain.auto_switch ? "on" : "off"} · lines 5h{" "}
              {chain.five_hour_line}%, week {chain.weekly_line}%
              {next ? ` · next: ${next}` : " · no account has headroom"}
            </p>
          </>
        ) : (
          <p>No account chain: sessions stay on the account they start on.</p>
        )}
        <p>
          Default: <strong>{data.defaultName}</strong>
          {defaultWindow
            ? ` (${Math.round(defaultWindow.utilization)}% ${defaultWindow.label})`
            : ""}
        </p>
        <button
          type="button"
          className="usage-button"
          onClick={actions.onOpenSettings}
        >
          <Settings2 size={14} aria-hidden="true" /> Edit the chain
        </button>
      </section>
      <fieldset className="usage-period" aria-label="Sessions of">
        {(["today", "week"] as const).map((period) => (
          <label key={period}>
            <input
              type="radio"
              name="usage-period"
              checked={data.period === period}
              onChange={() => actions.onPeriod(period)}
            />
            <span>{period === "today" ? "Today" : "This week"}</span>
          </label>
        ))}
      </fieldset>
      {ordered.length ? (
        <div className="usage-cards">
          {ordered.map((profile) => {
            const at = chain?.accounts.indexOf(profile.name) ?? -1;
            return (
              <AccountCard
                key={profile.name}
                profile={profile}
                usage={usageOf(data.board, profile)}
                position={at >= 0 ? at + 1 : null}
                isDefault={profile.name === data.defaultName}
                sessions={data.sessions[profile.name] ?? []}
                actions={actions}
              />
            );
          })}
        </div>
      ) : (
        <p className="usage-note">
          No account profile yet: add one in Configuration, Integrations, Agent
          profiles.
        </p>
      )}
      <section className="usage-switches" aria-label="Recent switches">
        <h3>Recent switches</h3>
        {data.switches.length ? (
          <ul>
            {data.switches.map((entry) => (
              <li key={`${entry.at}-${entry.from}-${entry.to}`}>
                <span className="usage-switch-when">
                  {new Date(entry.at).toLocaleString(undefined, {
                    weekday: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
                <span>
                  {entry.kind === "default" ? "Default" : "A session"}:{" "}
                  {entry.from} → {entry.to}
                </span>
                <span className="usage-switch-why">
                  {WHY_WORDS[entry.why] ?? entry.why}
                  {entry.reading ? `, ${entry.reading}` : ""}
                  {entry.ok ? "" : ` (not moved: ${entry.error ?? "refused"})`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="usage-note">No switch yet.</p>
        )}
      </section>
    </div>
  );
}

type Loaded = {
  profiles: UsageProfile[];
  defaultName: string;
  chain?: AccountChain;
  runs: Record<string, SessionRun[]>;
  switches: SwitchEntry[];
};

/** The Usage view: reads the profiles, sessions and switches once when it
 * opens (and when the period changes); usage comes from the shared store
 * the server's pushes keep current. */
export function UsageView({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const board = useAccountUsage();
  const [period, setPeriod] = useState<Period>("week");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const livePanes = useAllServerAgentSessions(true).panes;

  const load = useCallback(async () => {
    try {
      const settings = (await bridge.call("settings.profiles.get")) as {
        profiles: UsageProfile[];
        default: string;
        chain?: AccountChain;
      };
      const accounts = settings.profiles.filter((profile) => profile.account);
      const since = periodStart(period);
      const runs: Record<string, SessionRun[]> = {};
      await Promise.all(
        accounts.map(async (profile) => {
          const reply = (await bridge.call("agent_profile.account.sessions", {
            profile: profile.name,
            since,
          })) as { sessions: SessionRun[] };
          runs[profile.name] = reply.sessions;
        }),
      );
      const switches = (
        (await bridge.call("agent_profile.account.switches", {
          limit: 10,
        })) as { switches: SwitchEntry[] }
      ).switches;
      setLoaded({
        profiles: settings.profiles,
        defaultName: settings.default,
        chain: settings.chain,
        runs,
        switches,
      });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => focusDialogElement(dialogRef.current), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        shortcutMatches(event, "usage.open") ||
        (event.key === "Escape" && !event.isComposing)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const panes: LivePane[] = livePanes;
  const sessions = useMemo(() => {
    const named: Record<string, NamedSession[]> = {};
    for (const [name, runs] of Object.entries(loaded?.runs ?? {}))
      named[name] = sortSessions(runs.map((run) => nameSession(run, panes)));
    return named;
  }, [loaded, panes]);

  const actions: UsageViewActions = {
    onPeriod: setPeriod,
    onMakeDefault: (name) => {
      void bridge
        .call("settings.profiles.get")
        .then((current) => {
          const state = current as {
            profiles: (UsageProfile & { builtin?: boolean })[];
            default: string;
            return_after_reset: boolean;
            chain?: AccountChain;
          };
          return bridge.call("settings.profiles.update", {
            list: state.profiles.filter((profile) => !profile.builtin),
            default: name,
            return_after_reset: state.return_after_reset,
            ...(state.chain ? { chain: state.chain } : {}),
          });
        })
        .then(() => load())
        .catch((e: Error) => setError(e.message));
    },
    onOpenSession: (session) => {
      if (!session.live) return;
      onClose();
      void openServerSession(
        {
          connectionId: session.live.connectionId,
          runtimeGeneration: session.live.runtimeGeneration,
          serverLabel: session.live.serverLabel,
        },
        session.live.workspace_id,
        session.live.pane_id,
      );
    },
    onOpenSettings: () => {
      onClose();
      openConfiguration("Integrations");
    },
  };

  return (
    <div
      className="modal-backdrop usage-view-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal usage-view"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Usage"
      >
        <div className="modal-head">
          <div>
            <h2>Usage</h2>
            <p>Accounts, the account chain, and the sessions that spent them</p>
          </div>
          <CloseButton onClick={onClose} />
        </div>
        {error ? (
          <p role="alert" className="usage-note">
            {error}
          </p>
        ) : null}
        {loaded ? (
          <UsageViewBody
            data={{
              profiles: loaded.profiles,
              defaultName: loaded.defaultName,
              chain: loaded.chain,
              board,
              sessions,
              switches: loaded.switches,
              period,
            }}
            actions={actions}
          />
        ) : error ? null : (
          <p className="usage-note">Loading...</p>
        )}
      </div>
    </div>
  );
}
