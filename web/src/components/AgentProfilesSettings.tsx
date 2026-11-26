import { useCallback, useEffect, useState } from "react";
import {
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
  MODEL_SLOTS,
  type ProfileAccountView,
} from "../../../shared/agentProfiles";
import {
  useConnectionClient,
  useConnectionReady,
} from "../useConnectionClient";
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
          </li>
        ))}
      </ul>
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
