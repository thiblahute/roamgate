import { useCallback, useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Gauge,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  type AccountChain,
  MODEL_SLOTS,
  type ProfileAccountView,
} from "../../../shared/agentProfiles";
import {
  useConnectionClient,
  useConnectionReady,
} from "../useConnectionClient";
import { type AccountUsage, useAccountUsage } from "../accountUsage";
import "./AgentProfilesSettings.css";

/** A profile as settings.profiles.get shows it: secret files by path. */
export type ProfileEnvRow = {
  name: string;
  value?: string;
  file?: string;
  problem?: string;
};
export type ProfileRow = {
  name: string;
  agent: string;
  command?: string;
  builtin: boolean;
  env: ProfileEnvRow[];
  unset: string[];
  label?: string;
  /** An account profile's sign-in: its id, directory and state. */
  account?: ProfileAccountView;
};
type ProfilesState = {
  profiles: ProfileRow[];
  default: string;
  return_after_reset: boolean;
  chain?: AccountChain;
};
type Models = {
  models: string[];
  source: "server" | "aliases";
  missing: { slot: string; model: string }[];
  error?: string;
};

const SLOT_NAMES = new Set<string>(MODEL_SLOTS.map((slot) => slot.env));
const SECRET_NAME = /TOKEN|KEY|SECRET|PASSWORD/i;

/** What settings.profiles.update takes: the user's own profiles. */
export function profilesUpdate(state: ProfilesState) {
  return {
    list: state.profiles
      .filter((each) => !each.builtin)
      .map(({ name, agent, command, env, unset, account }) => ({
        name,
        agent,
        ...(command ? { command } : {}),
        env: env.map(({ name: key, value, file }) =>
          file !== undefined ? { name: key, file } : { name: key, value },
        ),
        unset,
        // The account's id only: its directory and state are the server's.
        ...(account ? { account: { id: account.id } } : {}),
      })),
    default: state.default,
    return_after_reset: state.return_after_reset,
    ...(state.chain ? { chain: state.chain } : {}),
  };
}

function parseState(value: unknown): ProfilesState {
  const raw = (value ?? {}) as Partial<ProfilesState>;
  if (!Array.isArray(raw.profiles) || typeof raw.default !== "string")
    throw new Error("Invalid profiles");
  return {
    profiles: raw.profiles,
    default: raw.default,
    return_after_reset: raw.return_after_reset === true,
    ...(raw.chain ? { chain: raw.chain } : {}),
  };
}

const AUTH_WORDS: Record<string, string> = {
  signed_in: "Signed in",
  signed_out: "Signed out",
  needs_relogin: "Sign in again",
  unknown: "Sign-in unknown",
};

/** What agent_profile.account.login.start answers. */
export type AccountLoginStart =
  | {
      kind: "link";
      login: string;
      url: string;
      paste: "code" | "address";
    }
  | { kind: "terminal"; message: string };

function blankProfile(): ProfileRow {
  return { name: "", agent: "claude", builtin: false, env: [], unset: [] };
}

/** Configuration > Integrations: the agent profiles and their default. */
export function AgentProfilesSettings() {
  const client = useConnectionClient();
  const ready = useConnectionReady(client);
  const [state, setState] = useState<ProfilesState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<{
    index: number | null;
    draft: ProfileRow;
  } | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const usage = useAccountUsage();

  const load = useCallback(async () => {
    try {
      const result = parseState(await client.call("settings.profiles.get"));
      if (!client.isCurrent()) return;
      setState(result);
      setError(null);
    } catch (e) {
      if (client.isCurrent()) setError((e as Error).message);
    }
  }, [client]);

  useEffect(() => {
    if (ready) void load();
  }, [load, ready]);

  const save = async (next: ProfilesState) => {
    setSaving(true);
    setError(null);
    try {
      const result = parseState(
        await client.call("settings.profiles.update", profilesUpdate(next)),
      );
      if (client.isCurrent()) setState(result);
      return true;
    } catch (e) {
      if (client.isCurrent()) setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  if (!state)
    return (
      <div className="config-preference-row">
        <span className="config-item-icon">
          <Gauge size={15} />
        </span>
        <div className="config-item-copy">
          <strong>Agent profiles</strong>
          <span role="status">{error ? "Unavailable" : "Loading..."}</span>
        </div>
      </div>
    );

  return (
    <section className="agent-profiles" aria-label="Agent profiles">
      <div className="config-preference-row">
        <span className="config-item-icon">
          <Gauge size={15} />
        </span>
        <div className="config-item-copy">
          <strong>Agent profiles</strong>
          <span>
            How Roamgate starts Claude: the default runs new sessions,
            conversation mode and Roamgate's helpers; any session can run with
            another (its menu, or the command menu's Run with).
          </span>
        </div>
        <button
          type="button"
          className="ghost"
          disabled={saving || !!editing}
          onClick={() => setEditing({ index: null, draft: blankProfile() })}
        >
          <Plus size={14} aria-hidden="true" /> Add
        </button>
      </div>
      <ul className="agent-profiles-list">
        {state.profiles.map((profile, index) => (
          <li key={profile.name}>
            <label className="agent-profiles-default">
              <input
                type="radio"
                name="default-profile"
                checked={state.default === profile.name}
                disabled={saving}
                onChange={() => void save({ ...state, default: profile.name })}
              />
              <span>
                <strong>{profile.name}</strong>
                {profile.label && profile.label !== profile.name ? (
                  <small>{profile.label}</small>
                ) : null}
                {state.default === profile.name ? <small>Default</small> : null}
              </span>
            </label>
            <span className="agent-profiles-env">
              {profile.command ? `${profile.command} ` : ""}
              {profile.env.length
                ? profile.env.map((each) => each.name).join(", ")
                : profile.builtin
                  ? "claude, as installed"
                  : ""}
              {profile.env.some((each) => each.problem) ? (
                <em role="alert">
                  {profile.env.find((each) => each.problem)?.problem}
                </em>
              ) : null}
            </span>
            <button
              type="button"
              className="ghost"
              aria-label={`Edit ${profile.name}`}
              disabled={saving || !!editing}
              onClick={() =>
                setEditing({
                  index,
                  draft: { ...profile, builtin: false },
                })
              }
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
            {profile.account ? (
              <span className="agent-profiles-account">
                <small data-auth={profile.account.auth ?? "unknown"}>
                  {AUTH_WORDS[profile.account.auth ?? "unknown"]}
                </small>
                <button
                  type="button"
                  className="ghost"
                  aria-label={`Sign ${profile.name} in`}
                  title={
                    profile.account.auth === "signed_in"
                      ? "Sign in again"
                      : "Sign in"
                  }
                  disabled={saving || !!signingIn}
                  onClick={() => setSigningIn(profile.name)}
                >
                  <LogIn size={14} aria-hidden="true" />
                </button>
                {profile.account.auth === "signed_in" &&
                profile.agent !== "agy" ? (
                  <button
                    type="button"
                    className="ghost"
                    aria-label={`Sign ${profile.name} out`}
                    title="Sign out"
                    disabled={saving || !!signingIn}
                    onClick={async () => {
                      try {
                        await client.call("agent_profile.account.logout", {
                          profile: profile.name,
                        });
                        await load();
                      } catch (e) {
                        if (client.isCurrent()) setError((e as Error).message);
                      }
                    }}
                  >
                    <LogOut size={14} aria-hidden="true" />
                  </button>
                ) : null}
              </span>
            ) : null}
            {profile.builtin ? null : (
              <button
                type="button"
                className="ghost"
                aria-label={`Remove ${profile.name}`}
                disabled={saving || !!editing}
                onClick={() =>
                  void save({
                    ...state,
                    profiles: state.profiles.filter((_, at) => at !== index),
                    default:
                      state.default === profile.name ? "Claude" : state.default,
                  })
                }
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            )}
            {profile.account ? (
              <AccountUsageRow
                profile={profile.name}
                usage={usage.get(`${profile.agent}/${profile.account.id}`)}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {state.profiles.some((profile) => profile.account) ? (
        <ChainEditor
          state={state}
          saving={saving}
          onSave={(chain) => void save({ ...state, chain })}
        />
      ) : null}
      <label className="agent-profiles-return">
        <input
          type="checkbox"
          checked={state.return_after_reset}
          disabled={saving}
          onChange={(event) =>
            void save({ ...state, return_after_reset: event.target.checked })
          }
        />
        After a usage limit sent a session to another profile, go back to the
        default once the limit resets
      </label>
      {signingIn ? (
        <AccountLogin
          profile={signingIn}
          onDone={() => {
            setSigningIn(null);
            void load();
          }}
        />
      ) : null}
      {editing ? (
        <ProfileEditor
          draft={editing.draft}
          saving={saving}
          onCancel={() => setEditing(null)}
          onSave={async (draft) => {
            const profiles = [...state.profiles];
            if (editing.index === null) profiles.push(draft);
            else profiles[editing.index] = draft;
            const renamed =
              editing.index !== null &&
              state.profiles[editing.index]!.name === state.default
                ? draft.name
                : state.default;
            if (await save({ ...state, profiles, default: renamed }))
              setEditing(null);
          }}
        />
      ) : null}
      {error ? (
        <div className="configuration-error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}
    </section>
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function blankChain(): AccountChain {
  return {
    accounts: [],
    auto_switch: false,
    five_hour_line: 95,
    weekly_line: 98,
    walk: "chain",
  };
}

/** The account chain: its accounts in order, its lines, the preferred
 * account and its days, the last resort, the walk order, auto-switch. */
function ChainEditor({
  state,
  saving,
  onSave,
}: {
  state: ProfilesState;
  saving: boolean;
  onSave: (chain: AccountChain) => void;
}) {
  const chain = state.chain ?? blankChain();
  const accounts = state.profiles.filter((profile) => profile.account);
  const outside = accounts.filter(
    (profile) => !chain.accounts.includes(profile.name),
  );
  const set = (change: Partial<AccountChain>) =>
    onSave({ ...chain, ...change });
  const move = (index: number, by: number) => {
    const next = [...chain.accounts];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    set({ accounts: next });
  };
  /** An account's own line; empty: the chain's. */
  const ownLine = (name: string, key: "five_hour" | "weekly", raw: string) => {
    const lines = { ...(chain.lines ?? {}) };
    const own = { ...(lines[name] ?? {}) };
    const value = Number(raw);
    if (raw.trim() && value >= 1 && value <= 100) own[key] = value;
    else delete own[key];
    if (Object.keys(own).length) lines[name] = own;
    else delete lines[name];
    const next: AccountChain = { ...chain, lines };
    if (!Object.keys(lines).length) next.lines = undefined;
    onSave(next);
  };
  const choice = (key: "preferred" | "last_resort", value: string) => {
    const next = { ...chain };
    if (value) next[key] = value;
    else delete next[key];
    onSave(next);
  };
  return (
    <fieldset className="agent-profiles-chain" disabled={saving}>
      <legend>Account chain</legend>
      <label className="agent-profiles-return">
        <input
          type="checkbox"
          checked={chain.auto_switch}
          onChange={(event) => set({ auto_switch: event.target.checked })}
        />
        Switch on its own: the default account moves to the next one past a
        line, with the sessions on it; a session stopped by a usage limit goes
        on with the next account
      </label>
      <ol>
        {chain.accounts.map((name, index) => (
          <li key={name}>
            <span>{name}</span>
            <input
              type="number"
              min={1}
              max={100}
              className="agent-profiles-chain-line"
              aria-label={`${name}: 5-hour line %`}
              title="Its own 5-hour line (empty: the chain's)"
              placeholder={String(chain.five_hour_line)}
              defaultValue={chain.lines?.[name]?.five_hour ?? ""}
              onBlur={(event) => ownLine(name, "five_hour", event.target.value)}
            />
            <input
              type="number"
              min={1}
              max={100}
              className="agent-profiles-chain-line"
              aria-label={`${name}: weekly line %`}
              title="Its own weekly line (empty: the chain's)"
              placeholder={String(chain.weekly_line)}
              defaultValue={chain.lines?.[name]?.weekly ?? ""}
              onBlur={(event) => ownLine(name, "weekly", event.target.value)}
            />
            <button
              type="button"
              className="ghost"
              aria-label={`Move ${name} up`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              <ArrowUp size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ghost"
              aria-label={`Move ${name} down`}
              disabled={index === chain.accounts.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDown size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ghost"
              aria-label={`Take ${name} out of the chain`}
              onClick={() =>
                set({
                  accounts: chain.accounts.filter((each) => each !== name),
                })
              }
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
      {outside.length ? (
        <label>
          Add
          <select
            value=""
            onChange={(event) =>
              event.target.value &&
              set({ accounts: [...chain.accounts, event.target.value] })
            }
          >
            <option value="">an account...</option>
            {outside.map((profile) => (
              <option key={profile.name} value={profile.name}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="agent-profiles-chain-row">
        <label>
          5-hour line %
          <input
            type="number"
            min={1}
            max={100}
            defaultValue={chain.five_hour_line}
            onBlur={(event) =>
              set({ five_hour_line: Number(event.target.value) || 95 })
            }
          />
        </label>
        <label>
          Weekly line %
          <input
            type="number"
            min={1}
            max={100}
            defaultValue={chain.weekly_line}
            onBlur={(event) =>
              set({ weekly_line: Number(event.target.value) || 98 })
            }
          />
        </label>
        <label>
          Order
          <select
            value={chain.walk}
            onChange={(event) =>
              set({ walk: event.target.value as AccountChain["walk"] })
            }
          >
            <option value="chain">The chain's</option>
            <option value="soonest_reset">Soonest weekly reset</option>
            <option value="most_headroom">Most headroom</option>
          </select>
        </label>
      </div>
      <div className="agent-profiles-chain-row">
        <label>
          Preferred
          <select
            value={chain.preferred ?? ""}
            onChange={(event) => choice("preferred", event.target.value)}
          >
            <option value="">None</option>
            {chain.accounts.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <span className="agent-profiles-chain-days">
          {DAYS.map((day, index) => (
            <label key={day}>
              <input
                type="checkbox"
                checked={(chain.preferred_days ?? []).includes(index)}
                onChange={(event) => {
                  const days = new Set(chain.preferred_days ?? []);
                  if (event.target.checked) days.add(index);
                  else days.delete(index);
                  set({ preferred_days: [...days].sort((a, b) => a - b) });
                }}
              />
              {day}
            </label>
          ))}
        </span>
        <label>
          Last resort
          <select
            value={chain.last_resort ?? ""}
            onChange={(event) => choice("last_resort", event.target.value)}
          >
            <option value="">None</option>
            {chain.accounts.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
      </div>
    </fieldset>
  );
}

const USAGE_STATUS: Record<AccountUsage["status"], string> = {
  fresh: "",
  cached: "last reading",
  failed: "reading failed",
  rate_limited: "rate limited",
  auth_expired: "not signed in",
  unknown: "no usage to read",
};

function resetWords(at: string | undefined) {
  if (!at) return "";
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  const sameDay = when.toDateString() === new Date().toDateString();
  return `resets ${when.toLocaleString(undefined, sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

type SessionRun = {
  session_id: string;
  profile: string;
  started_at: number;
  ended_at: number | null;
  tokens: { input_tokens?: number; output_tokens?: number } | null;
};

/** An account's usage bars (5h, 7d, per-model weeks) and the sessions
 * that spent it this week. */
function AccountUsageRow({
  profile,
  usage,
}: {
  profile: string;
  usage: AccountUsage | undefined;
}) {
  const client = useConnectionClient();
  const [runs, setRuns] = useState<SessionRun[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const status = usage ? USAGE_STATUS[usage.status] : "";
  const loadRuns = async () => {
    if (runs) {
      setRuns(null);
      return;
    }
    try {
      const result = (await client.call("agent_profile.account.sessions", {
        profile,
      })) as { sessions: SessionRun[] };
      if (client.isCurrent()) setRuns(result.sessions);
    } catch (e) {
      if (client.isCurrent()) setProblem((e as Error).message);
    }
  };
  return (
    <div className="agent-profiles-usage">
      {usage?.usage?.windows.map((window) => (
        <span key={window.label} className="agent-profiles-usage-window">
          <small>{window.label}</small>
          <span
            className="agent-profiles-usage-bar"
            role="meter"
            aria-label={`${profile} ${window.label}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(window.utilization)}
          >
            <span
              style={{
                width: `${Math.min(100, Math.max(0, window.utilization))}%`,
              }}
              data-high={window.utilization >= 80 ? "" : undefined}
            />
          </span>
          <small>
            {Math.round(window.utilization)}% {resetWords(window.resets_at)}
          </small>
        </span>
      ))}
      {usage?.usage?.plan || usage?.usage?.email ? (
        <small>
          {[usage.usage.plan, usage.usage.email].filter(Boolean).join(", ")}
        </small>
      ) : null}
      {status ? <small>{status}</small> : null}
      <button type="button" className="ghost" onClick={() => void loadRuns()}>
        {runs ? "Hide sessions" : "Sessions this week"}
      </button>
      {runs ? (
        runs.length ? (
          <ul className="agent-profiles-usage-sessions">
            {runs.map((run) => (
              <li key={`${run.session_id}-${run.started_at}`}>
                <code>{run.session_id.slice(0, 8)}</code>{" "}
                <small>
                  {new Date(run.started_at).toLocaleString()}
                  {run.tokens
                    ? `, ${run.tokens.input_tokens ?? 0} in, ${run.tokens.output_tokens ?? 0} out`
                    : ""}
                </small>
              </li>
            ))}
          </ul>
        ) : (
          <small>No session ran on it this week.</small>
        )
      ) : null}
      {problem ? <em role="alert">{problem}</em> : null}
    </div>
  );
}

/** An account profile's sign-in: the link to open and the code to paste
 * back, or for agy, a check once it is signed in inside agy. */
function AccountLogin({
  profile,
  onDone,
}: {
  profile: string;
  onDone: () => void;
}) {
  const client = useConnectionClient();
  const [started, setStarted] = useState<AccountLoginStart | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [auth, setAuth] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    client
      .call("agent_profile.account.login.start", { profile })
      .then((result) => {
        if (live && client.isCurrent()) setStarted(result as AccountLoginStart);
      })
      .catch((e: Error) => {
        if (live && client.isCurrent()) setProblem(e.message);
      });
    return () => {
      live = false;
    };
  }, [client, profile]);

  const complete = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const result = (await client.call(
        "agent_profile.account.login.complete",
        {
          profile,
          ...(started?.kind === "link"
            ? { login: started.login, code: pasted.trim() }
            : {}),
        },
      )) as { auth: string };
      if (!client.isCurrent()) return;
      setAuth(result.auth);
      if (result.auth === "signed_in") onDone();
    } catch (e) {
      if (client.isCurrent()) setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="agent-profiles-editor agent-profiles-login"
      aria-label={`Sign ${profile} in`}
      onSubmit={(event) => {
        event.preventDefault();
        void complete();
      }}
    >
      <strong>Sign {profile} in</strong>
      {started?.kind === "link" ? (
        <>
          <span>
            Open this link in your browser and sign in to the account; the page
            then gives{" "}
            {started.paste === "code"
              ? "a code"
              : "nothing (it does not load): copy its address from the address bar"}
            .
          </span>
          <span className="agent-profiles-login-link">
            <a href={started.url} target="_blank" rel="noreferrer noopener">
              Open the sign-in page
            </a>
            <button
              type="button"
              className="ghost"
              aria-label="Copy the sign-in link"
              onClick={() => void navigator.clipboard?.writeText(started.url)}
            >
              <Copy size={14} aria-hidden="true" />
            </button>
          </span>
          <label>
            {started.paste === "code"
              ? "The code the page shows"
              : "The address the page ended on"}
            <input
              value={pasted}
              required
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setPasted(event.target.value)}
            />
          </label>
        </>
      ) : started?.kind === "terminal" ? (
        <span>{started.message}</span>
      ) : problem ? null : (
        <span role="status">Starting...</span>
      )}
      {auth && auth !== "signed_in" ? (
        <em role="alert">{AUTH_WORDS[auth] ?? auth}</em>
      ) : null}
      {problem ? <em role="alert">{problem}</em> : null}
      <div className="agent-profiles-editor-actions">
        <button type="button" className="ghost" onClick={onDone}>
          Close
        </button>
        <button type="submit" disabled={busy || !started}>
          {started?.kind === "terminal" ? "Check the sign-in" : "Sign in"}
        </button>
      </div>
    </form>
  );
}

function ProfileEditor({
  draft: initial,
  saving,
  onCancel,
  onSave,
}: {
  draft: ProfileRow;
  saving: boolean;
  onCancel: () => void;
  onSave: (draft: ProfileRow) => void;
}) {
  const client = useConnectionClient();
  const [draft, setDraft] = useState(initial);
  const [unsetText, setUnsetText] = useState(initial.unset.join(", "));
  const [models, setModels] = useState<Models | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const saved = initial.name;

  const loadModels = useCallback(
    async (refresh: boolean) => {
      if (!saved) return;
      setModelsBusy(true);
      try {
        const result = (await client.call("settings.profiles.models", {
          name: saved,
          refresh,
        })) as Models;
        if (client.isCurrent()) setModels(result);
      } catch (e) {
        if (client.isCurrent())
          setModels({
            models: [],
            source: "server",
            missing: [],
            error: (e as Error).message,
          });
      } finally {
        setModelsBusy(false);
      }
    },
    [client, saved],
  );
  useEffect(() => {
    void loadModels(false);
  }, [loadModels]);

  const envValue = (name: string) =>
    draft.env.find((each) => each.name === name);
  const setEnv = (name: string, row: ProfileEnvRow | null) =>
    setDraft((current) => {
      const env = current.env.filter((each) => each.name !== name);
      return { ...current, env: row ? [...env, row] : env };
    });
  const others = draft.env.filter((each) => !SLOT_NAMES.has(each.name));
  const listId = `profile-models-${saved || "new"}`;

  return (
    <form
      className="agent-profiles-editor"
      aria-label={saved ? `Edit ${saved}` : "New profile"}
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          ...draft,
          name: draft.name.trim(),
          env: draft.env.filter((each) => each.name.trim()),
        });
      }}
    >
      <label>
        Name
        <input
          value={draft.name}
          required
          maxLength={40}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>
      <label>
        Agent
        <select
          value={draft.agent}
          onChange={(event) =>
            setDraft({ ...draft, agent: event.target.value })
          }
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="agy">Antigravity</option>
        </select>
      </label>
      <label>
        Program <small>(empty: claude)</small>
        <input
          value={draft.command ?? ""}
          placeholder="claude"
          spellCheck={false}
          onChange={(event) =>
            setDraft({ ...draft, command: event.target.value || undefined })
          }
        />
      </label>
      <label>
        Account <small>(an id: its own sign-in; empty: none)</small>
        <input
          value={draft.account?.id ?? ""}
          placeholder="work"
          pattern="[a-z0-9][a-z0-9_\-]{0,39}"
          maxLength={40}
          spellCheck={false}
          onChange={(event) =>
            setDraft({
              ...draft,
              account: event.target.value
                ? { id: event.target.value }
                : undefined,
            })
          }
        />
      </label>
      <fieldset>
        <legend>
          Models{" "}
          {saved ? (
            <button
              type="button"
              className="ghost"
              aria-label="Refresh the model list"
              title={
                models?.source === "aliases"
                  ? "Claude's own aliases"
                  : "Ask the profile's server for its models again"
              }
              disabled={modelsBusy}
              onClick={() => void loadModels(true)}
            >
              <RefreshCw size={12} aria-hidden="true" />
            </button>
          ) : (
            <small>(save once to list the server's models)</small>
          )}
        </legend>
        <datalist id={listId}>
          {(models?.models ?? []).map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
        {models?.error ? <em role="alert">{models.error}</em> : null}
        {models?.missing.length ? (
          <em role="alert">
            Not offered by the server any more:{" "}
            {models.missing.map((each) => each.model).join(", ")}
          </em>
        ) : null}
        {MODEL_SLOTS.map((slot) => (
          <label key={slot.env}>
            {slot.label} <small>{slot.env}</small>
            <input
              list={listId}
              spellCheck={false}
              value={envValue(slot.env)?.value ?? ""}
              onChange={(event) =>
                setEnv(
                  slot.env,
                  event.target.value
                    ? { name: slot.env, value: event.target.value }
                    : null,
                )
              }
            />
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Environment</legend>
        <small>
          A secret (a token) belongs in a file only you can read (chmod 600):
          choose File and give its path; Roamgate reads it when it starts the
          agent and never shows it.
        </small>
        {others.map((row, at) => (
          <div className="agent-profiles-env-row" key={at}>
            <input
              aria-label="Variable"
              value={row.name}
              spellCheck={false}
              onChange={(event) => {
                const name = event.target.value;
                setDraft((current) => ({
                  ...current,
                  env: current.env.map((each) =>
                    each === row ? { ...each, name } : each,
                  ),
                }));
              }}
            />
            <select
              aria-label={`${row.name} kind`}
              value={row.file !== undefined ? "file" : "text"}
              onChange={(event) =>
                setEnv(
                  row.name,
                  event.target.value === "file"
                    ? { name: row.name, file: "" }
                    : { name: row.name, value: "" },
                )
              }
            >
              <option value="text">Text</option>
              <option value="file">File</option>
            </select>
            <input
              aria-label={`${row.name} value`}
              type={
                row.file === undefined && SECRET_NAME.test(row.name)
                  ? "password"
                  : "text"
              }
              spellCheck={false}
              placeholder={
                row.file !== undefined ? "~/.config/roamgate/secrets/token" : ""
              }
              value={row.file ?? row.value ?? ""}
              onChange={(event) =>
                setEnv(
                  row.name,
                  row.file !== undefined
                    ? { name: row.name, file: event.target.value }
                    : { name: row.name, value: event.target.value },
                )
              }
            />
            {row.problem ? <em role="alert">{row.problem}</em> : null}
            <button
              type="button"
              className="ghost"
              aria-label={`Remove ${row.name}`}
              onClick={() => setEnv(row.name, null)}
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="ghost"
          onClick={() =>
            setDraft((current) => ({
              ...current,
              env: [
                ...current.env,
                { name: `VAR_${current.env.length + 1}`, value: "" },
              ],
            }))
          }
        >
          <Plus size={12} aria-hidden="true" /> Variable
        </button>
        <label>
          Also remove <small>(variable names, comma separated)</small>
          <input
            spellCheck={false}
            value={unsetText}
            onChange={(event) => {
              setUnsetText(event.target.value);
              setDraft({
                ...draft,
                unset: event.target.value.split(/[,\s]+/).filter(Boolean),
              });
            }}
          />
        </label>
      </fieldset>
      <div className="agent-profiles-editor-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={saving || !draft.name.trim()}>
          Save
        </button>
      </div>
    </form>
  );
}
