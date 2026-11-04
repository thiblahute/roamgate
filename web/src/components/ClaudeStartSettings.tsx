import { useCallback, useEffect, useRef, useState } from "react";
import { Info, MessagesSquare } from "lucide-react";
import {
  useConnectionClient,
  useConnectionReady,
} from "../useConnectionClient";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const CLAUDE_START_DESCRIPTION =
  "When you start claude in a Herdr pane (here or on an SSH host), " +
  "conversation mode takes the session as soon as Claude is up, as if you " +
  "had switched it to the chat. Roamgate adds a SessionStart hook to " +
  "~/.claude/settings.json on each host for this. " +
  "ROAMGATE_CLAUDE_START=terminal claude keeps one claude in the terminal; " +
  "Enter in the pane takes a session back.";

export function ClaudeStartSettings() {
  const client = useConnectionClient();
  const ready = useConnectionReady(client);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const result = await client.call("settings.claude_start.get");
      if (result?.mode !== "conversation" && result?.mode !== "terminal")
        throw new Error("Invalid claude start setting");
      if (
        !mounted.current ||
        !client.isCurrent() ||
        request !== sequence.current
      )
        return;
      setEnabled(result.mode === "conversation");
      setError(null);
    } catch (e) {
      if (
        !mounted.current ||
        !client.isCurrent() ||
        request !== sequence.current
      )
        return;
      setEnabled(null);
      setError((e as Error).message);
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    pending.current = false;
    setSaving(false);
    setEnabled(null);
    setError(null);
    if (ready) void load();
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, [client, load, ready]);

  const save = async (value: boolean) => {
    if (pending.current || !client.isCurrent()) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    const request = ++sequence.current;
    try {
      const result = await client.call("settings.claude_start.update", {
        mode: value ? "conversation" : "terminal",
      });
      if (
        !mounted.current ||
        !client.isCurrent() ||
        request !== sequence.current
      )
        return;
      if (result?.mode !== "conversation" && result?.mode !== "terminal")
        throw new Error("Invalid claude start setting");
      setEnabled(result.mode === "conversation");
    } catch (e) {
      if (
        !mounted.current ||
        !client.isCurrent() ||
        request !== sequence.current
      )
        return;
      setError((e as Error).message);
    } finally {
      if (mounted.current && request === sequence.current) {
        pending.current = false;
        setSaving(false);
      }
    }
  };

  return (
    <>
      <div className="config-preference-row">
        <span className="config-item-icon">
          <MessagesSquare size={15} />
        </span>
        <div className="config-item-copy">
          <div className="configuration-setting-label">
            <strong id="claude-start-label">
              Start claude in conversation mode
            </strong>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="configuration-help"
                  aria-label="About starting claude in conversation mode"
                  title={CLAUDE_START_DESCRIPTION}
                >
                  <Info size={14} aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="configuration-help-content"
                aria-label="About starting claude in conversation mode"
                aria-describedby="claude-start-description"
                collisionPadding={12}
              >
                {CLAUDE_START_DESCRIPTION}
              </PopoverContent>
            </Popover>
          </div>
          <span role="status">
            {saving
              ? "Saving..."
              : enabled === null
                ? error
                  ? "Unavailable"
                  : "Loading..."
                : enabled
                  ? "A claude started in a pane opens in the chat"
                  : "A claude started in a pane stays in the terminal"}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          id="claude-start-toggle"
          aria-labelledby="claude-start-label"
          aria-describedby="claude-start-description"
          aria-checked={enabled === true}
          disabled={enabled === null || saving || !client.isCurrent()}
          className={"settings-switch" + (enabled ? " is-on" : "")}
          onClick={() => {
            if (enabled !== null) void save(!enabled);
          }}
        >
          <span />
        </button>
      </div>
      <p id="claude-start-description" hidden>
        {CLAUDE_START_DESCRIPTION}
      </p>
      {error ? (
        <div className="configuration-error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}
    </>
  );
}
