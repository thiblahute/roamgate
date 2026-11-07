import { useCallback, useEffect, useRef, useState } from "react";
import { Info, TimerReset } from "lucide-react";
import {
  DEFAULT_LIMIT_RESUME_MESSAGE,
  type LimitResumeSettings as Settings,
  MAX_LIMIT_RESUME_MARGIN_SECONDS,
  MAX_LIMIT_RESUME_MESSAGE_LENGTH,
} from "../../../shared/limitResume";
import {
  useConnectionClient,
  useConnectionReady,
} from "../useConnectionClient";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import "./LimitResumeSettings.css";

const DESCRIPTION =
  "When a Claude session stops on a usage limit (5-hour, weekly), " +
  "Roamgate reads when the limit resets and, that long after it, sends the " +
  "session this message as you would: typed into an idle terminal, or " +
  "queued in conversation mode (waking it if it sleeps). Only if the " +
  "session is still stopped on that limit, once per reset; a session you " +
  "resumed yourself is left alone. Each paused session also offers Resume " +
  "now and Don't resume.";

function parseSettings(value: unknown): Settings {
  const raw = (value ?? {}) as Record<string, unknown>;
  if (
    typeof raw.enabled !== "boolean" ||
    typeof raw.message !== "string" ||
    typeof raw.margin_seconds !== "number"
  )
    throw new Error("Invalid usage limit settings");
  return {
    enabled: raw.enabled,
    message: raw.message,
    margin_seconds: raw.margin_seconds,
  };
}

/** Configuration > Integrations: resuming sessions after a usage limit. */
export function LimitResumeSettings() {
  const client = useConnectionClient();
  const ready = useConnectionReady(client);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(false);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    const current = (each: number) =>
      mounted.current && client.isCurrent() && each === sequence.current;
    try {
      const result = parseSettings(
        await client.call("settings.limit_resume.get"),
      );
      if (!current(request)) return;
      setSettings(result);
      setDraft(result.message);
      setError(null);
    } catch (e) {
      if (!current(request)) return;
      setSettings(null);
      setError((e as Error).message);
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    setSettings(null);
    setError(null);
    setSaving(false);
    if (ready) void load();
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, [client, load, ready]);

  const save = async (change: Partial<Settings>) => {
    if (saving || !client.isCurrent()) return;
    setSaving(true);
    setError(null);
    const request = ++sequence.current;
    const current = (each: number) =>
      mounted.current && client.isCurrent() && each === sequence.current;
    try {
      const result = parseSettings(
        await client.call("settings.limit_resume.update", change),
      );
      if (!current(request)) return;
      setSettings(result);
      setDraft(result.message);
    } catch (e) {
      if (!current(request)) return;
      setError((e as Error).message);
    } finally {
      if (mounted.current && request === sequence.current) setSaving(false);
    }
  };

  const enabled = settings?.enabled ?? null;
  const disabled = settings === null || saving || !client.isCurrent();
  return (
    <>
      <div className="config-preference-row">
        <span className="config-item-icon">
          <TimerReset size={15} />
        </span>
        <div className="config-item-copy">
          <div className="configuration-setting-label">
            <strong id="limit-resume-label">
              Resume sessions after a usage limit
            </strong>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="configuration-help"
                  aria-label="About resuming sessions after a usage limit"
                  title={DESCRIPTION}
                >
                  <Info size={14} aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="configuration-help-content"
                aria-label="About resuming sessions after a usage limit"
                collisionPadding={12}
              >
                {DESCRIPTION}
              </PopoverContent>
            </Popover>
          </div>
          <span role="status">
            {saving
              ? "Saving..."
              : settings === null
                ? error
                  ? "Unavailable"
                  : "Loading..."
                : settings.enabled
                  ? `Resumed ${settings.margin_seconds} s after the limit resets`
                  : "Paused sessions wait for you"}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-labelledby="limit-resume-label"
          aria-checked={enabled === true}
          disabled={disabled}
          className={`settings-switch${enabled ? " is-on" : ""}`}
          onClick={() => {
            if (enabled !== null) void save({ enabled: !enabled });
          }}
        >
          <span />
        </button>
      </div>
      {settings ? (
        <div className="limit-resume-settings">
          <label className="form-field">
            <span>Seconds after the reset</span>
            <input
              type="number"
              min={0}
              max={MAX_LIMIT_RESUME_MARGIN_SECONDS}
              step={1}
              defaultValue={settings.margin_seconds}
              key={`margin-${settings.margin_seconds}`}
              disabled={disabled}
              onBlur={(event) => {
                const seconds = Number(event.target.value);
                if (
                  Number.isInteger(seconds) &&
                  seconds >= 0 &&
                  seconds <= MAX_LIMIT_RESUME_MARGIN_SECONDS &&
                  seconds !== settings.margin_seconds
                )
                  void save({ margin_seconds: seconds });
              }}
            />
          </label>
          <label className="form-field">
            <span>Message sent to the session</span>
            <textarea
              rows={3}
              value={draft}
              maxLength={MAX_LIMIT_RESUME_MESSAGE_LENGTH}
              disabled={disabled}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => {
                if (draft.trim() && draft.trim() !== settings.message)
                  void save({ message: draft });
                else setDraft(settings.message);
              }}
            />
          </label>
          {settings.message !== DEFAULT_LIMIT_RESUME_MESSAGE ? (
            <button
              type="button"
              className="limit-resume-default"
              disabled={disabled}
              onClick={() =>
                void save({ message: DEFAULT_LIMIT_RESUME_MESSAGE })
              }
            >
              Use the default message
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div className="configuration-error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}
    </>
  );
}
