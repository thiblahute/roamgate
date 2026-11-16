import { useCallback, useEffect, useRef, useState } from "react";
import { Info, Puzzle } from "lucide-react";
import {
  useConnectionClient,
  useConnectionReady,
} from "../useConnectionClient";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import "./ClaudeModSettings.css";

const DESCRIPTION =
  "Roamgate's Claude Code mod runs inside each Claude session in a Herdr " +
  "pane on this host. What Roamgate has for a session (review and chat " +
  "comments, other sessions' messages, companion errands, the usage-limit " +
  "resume) is submitted once Claude is idle instead of typed into the " +
  "terminal, and Roamgate learns exactly when turns start and end, when " +
  "Claude waits on you, and its model, context and plan usage. Install runs " +
  "Claude Code's own `claude plugin install` on the host; sessions started " +
  "after it (or after /reload-plugins) load it. Without it, Roamgate types " +
  "as before.";

type State = {
  available: boolean;
  reason?: string;
  claude_version?: string;
  min_claude: string;
  installed: boolean;
  enabled: boolean;
  from_roamgate: boolean;
  sessions: number;
};

function parseState(value: unknown): State {
  const raw = (value ?? {}) as Record<string, unknown>;
  if (
    typeof raw.available !== "boolean" ||
    typeof raw.installed !== "boolean" ||
    typeof raw.enabled !== "boolean"
  )
    throw new Error("Invalid Claude mod state");
  return raw as unknown as State;
}

function describe(state: State): string {
  const sessions =
    state.sessions === 1 ? "1 session" : `${state.sessions} sessions`;
  if (state.installed && state.enabled)
    return state.from_roamgate
      ? `Installed · ${sessions} connected`
      : `Installed from another folder · ${sessions} connected`;
  if (state.installed) return "Installed, turned off in Claude Code";
  if (!state.available) return state.reason ?? "Unavailable on this host";
  return `Not installed (Claude Code ${state.claude_version ?? "?"})`;
}

/** Configuration > Integrations: Roamgate's Claude Code mod on this host. */
export function ClaudeModSettings() {
  const client = useConnectionClient();
  const ready = useConnectionReady(client);
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState<"install" | "uninstall" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(false);

  const call = useCallback(
    async (method: string) => {
      const request = ++sequence.current;
      const current = () =>
        mounted.current && client.isCurrent() && request === sequence.current;
      try {
        const result = parseState(await client.call(method));
        if (!current()) return;
        setState(result);
        // An action that did not take says why.
        setError(
          method === "claude_mod.status" ? null : (result.reason ?? null),
        );
      } catch (e) {
        if (!current()) return;
        setError((e as Error).message);
      }
    },
    [client],
  );

  useEffect(() => {
    mounted.current = true;
    setState(null);
    setError(null);
    setBusy(null);
    if (ready) void call("claude_mod.status");
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, [call, ready]);

  const act = async (action: "install" | "uninstall") => {
    if (busy || !client.isCurrent()) return;
    setBusy(action);
    try {
      await call(`claude_mod.${action}`);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const installed = !!state?.installed && state.enabled;
  return (
    <>
      <div className="config-preference-row">
        <span className="config-item-icon">
          <Puzzle size={15} />
        </span>
        <div className="config-item-copy">
          <div className="configuration-setting-label">
            <strong id="claude-mod-label">Claude Code mod</strong>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="configuration-help"
                  aria-label="About Roamgate's Claude Code mod"
                  title={DESCRIPTION}
                >
                  <Info size={14} aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="configuration-help-content"
                aria-label="About Roamgate's Claude Code mod"
                collisionPadding={12}
              >
                {DESCRIPTION}
              </PopoverContent>
            </Popover>
          </div>
          <span role="status">
            {busy === "install"
              ? "Installing..."
              : busy === "uninstall"
                ? "Removing..."
                : state
                  ? describe(state)
                  : error
                    ? "Unavailable"
                    : "Loading..."}
          </span>
        </div>
        {state && (installed || state.available || state.installed) ? (
          <button
            type="button"
            className="claude-mod-action"
            aria-labelledby="claude-mod-label claude-mod-action"
            id="claude-mod-action"
            disabled={!!busy || !client.isCurrent()}
            onClick={() => void act(installed ? "uninstall" : "install")}
          >
            {installed ? "Remove" : "Install"}
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="configuration-error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}
    </>
  );
}
