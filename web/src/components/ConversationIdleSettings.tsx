import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftRight, Info, Moon, ShieldAlert } from "lucide-react";
import {
  CONVERSATION_AGENTS,
  type ConversationAgent,
  DEFAULT_IDLE_STOP_MINUTES,
  DEFAULT_PERMISSION_TIMEOUT_SECONDS,
  agentDisplayName,
  isConversationAgent,
  isIdleStopMinutes,
  isPermissionTimeoutSeconds,
} from "../../../shared/agentChat";
import {
  useConnectionClient,
  useConnectionReady,
} from "../useConnectionClient";
import { ThemedSelect, type ThemedSelectOption } from "./ThemedSelect";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const IDLE_STOP_DESCRIPTION =
  "A Claude in conversation mode that sits idle this long has its " +
  "background process stopped to free its memory; the pane and the chat " +
  "stay. The next message of any kind starts it again (the chat says " +
  "Waking Claude...) and delivers it. Never while it works, asks you " +
  "something, runs background work, is on a voice call or a companion " +
  "job, or got another session's message in the last 10 minutes.";

const PRESETS = [0, 10, 15, 30, 60, 120, 240, 480];

/** How a number of minutes reads in the list. */
export function idleStopLabel(minutes: number): string {
  if (minutes === 0) return "Never";
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `After ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `After ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function idleStopOptions(current: number | null): ThemedSelectOption[] {
  const values =
    current !== null && !PRESETS.includes(current)
      ? [...PRESETS, current].sort((a, b) => a - b)
      : PRESETS;
  return values.map((minutes) => ({
    value: String(minutes),
    label: idleStopLabel(minutes),
    ...(minutes === DEFAULT_IDLE_STOP_MINUTES ? { detail: "Default" } : {}),
  }));
}

const PERMISSION_TIMEOUT_DESCRIPTION =
  "A permission an agent in conversation mode asks for that nobody " +
  "answers this long is denied by Roamgate: the agent is told nobody " +
  "answered, to do the work another way if it can, and otherwise to say " +
  "in the chat what it needs and go on with the rest. Never: the request " +
  "waits until you answer it. Questions keep their own 30 minutes.";

const PERMISSION_PRESETS = [0, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** How a number of seconds reads in the list. */
export function permissionTimeoutLabel(seconds: number): string {
  if (seconds === 0) return "Never";
  const unit = (count: number, word: string) =>
    `After ${count} ${word}${count === 1 ? "" : "s"}`;
  if (seconds % 3600 === 0) return unit(seconds / 3600, "hour");
  if (seconds % 60 === 0) return unit(seconds / 60, "minute");
  return unit(seconds, "second");
}

export function permissionTimeoutOptions(
  current: number | null,
): ThemedSelectOption[] {
  const values =
    current !== null && !PERMISSION_PRESETS.includes(current)
      ? [...PERMISSION_PRESETS, current].sort((a, b) => a - b)
      : PERMISSION_PRESETS;
  return values.map((seconds) => ({
    value: String(seconds),
    label: permissionTimeoutLabel(seconds),
    ...(seconds === DEFAULT_PERMISSION_TIMEOUT_SECONDS
      ? { detail: "Default" }
      : {}),
  }));
}

/** Configuration > Integrations: when an idle conversation's process stops. */
export function ConversationIdleSettings() {
  const client = useConnectionClient();
  const ready = useConnectionReady(client);
  const [minutes, setMinutes] = useState<number | null>(null);
  const [permissionSeconds, setPermissionSeconds] = useState<number | null>(
    null,
  );
  const [fallbackAgent, setFallbackAgent] = useState<ConversationAgent | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const result = await client.call("settings.conversation.get");
      if (!isIdleStopMinutes(result?.idle_stop_minutes))
        throw new Error("Invalid idle stop setting");
      if (
        !mounted.current ||
        !client.isCurrent() ||
        request !== sequence.current
      )
        return;
      setMinutes(result.idle_stop_minutes);
      setPermissionSeconds(
        isPermissionTimeoutSeconds(result?.permission_timeout_seconds)
          ? result.permission_timeout_seconds
          : null,
      );
      setFallbackAgent(
        isConversationAgent(result?.fallback_agent)
          ? result.fallback_agent
          : null,
      );
      setError(null);
    } catch (e) {
      if (
        !mounted.current ||
        !client.isCurrent() ||
        request !== sequence.current
      )
        return;
      setMinutes(null);
      setError((e as Error).message);
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    pending.current = false;
    setSaving(false);
    setMinutes(null);
    setPermissionSeconds(null);
    setError(null);
    if (ready) void load();
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, [client, load, ready]);

  const save = async (value: number) => {
    if (pending.current || !client.isCurrent()) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    const request = ++sequence.current;
    try {
      const result = await client.call("settings.conversation.update", {
        idle_stop_minutes: value,
      });
      if (
        !mounted.current ||
        !client.isCurrent() ||
        request !== sequence.current
      )
        return;
      if (!isIdleStopMinutes(result?.idle_stop_minutes))
        throw new Error("Invalid idle stop setting");
      setMinutes(result.idle_stop_minutes);
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

  const savePermissionTimeout = async (value: number) => {
    if (pending.current || !client.isCurrent()) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    const request = ++sequence.current;
    try {
      const result = await client.call("settings.conversation.update", {
        permission_timeout_seconds: value,
      });
      if (
        !mounted.current ||
        !client.isCurrent() ||
        request !== sequence.current
      )
        return;
      if (!isPermissionTimeoutSeconds(result?.permission_timeout_seconds))
        throw new Error("Invalid permission timeout setting");
      setPermissionSeconds(result.permission_timeout_seconds);
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

  const saveFallback = async (value: ConversationAgent | null) => {
    if (pending.current || !client.isCurrent()) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    const request = ++sequence.current;
    try {
      const result = await client.call("settings.conversation.update", {
        fallback_agent: value,
      });
      if (
        !mounted.current ||
        !client.isCurrent() ||
        request !== sequence.current
      )
        return;
      setFallbackAgent(
        isConversationAgent(result?.fallback_agent)
          ? result.fallback_agent
          : null,
      );
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
          <Moon size={15} />
        </span>
        <div className="config-item-copy">
          <div className="configuration-setting-label">
            <strong id="idle-stop-label">Stop idle conversations</strong>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="configuration-help"
                  aria-label="About stopping idle conversations"
                  title={IDLE_STOP_DESCRIPTION}
                >
                  <Info size={14} aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="configuration-help-content"
                aria-label="About stopping idle conversations"
                collisionPadding={12}
              >
                {IDLE_STOP_DESCRIPTION}
              </PopoverContent>
            </Popover>
          </div>
          <span role="status">
            {saving
              ? "Saving..."
              : minutes === null
                ? error
                  ? "Unavailable"
                  : "Loading..."
                : minutes === 0
                  ? "Claude keeps running in idle conversations"
                  : `Claude stops after ${minutes} idle minute${minutes === 1 ? "" : "s"}; a message wakes it`}
          </span>
        </div>
        <ThemedSelect
          aria-label="Stop idle conversations"
          value={minutes === null ? "" : String(minutes)}
          options={idleStopOptions(minutes)}
          disabled={minutes === null || saving || !client.isCurrent()}
          onChange={(value) => {
            const next = Number(value);
            if (isIdleStopMinutes(next) && next !== minutes) void save(next);
          }}
        />
      </div>
      <div className="config-preference-row">
        <span className="config-item-icon">
          <ShieldAlert size={15} />
        </span>
        <div className="config-item-copy">
          <div className="configuration-setting-label">
            <strong id="permission-timeout-label">
              Deny unanswered permissions
            </strong>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="configuration-help"
                  aria-label="About denying unanswered permissions"
                  title={PERMISSION_TIMEOUT_DESCRIPTION}
                >
                  <Info size={14} aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="configuration-help-content"
                aria-label="About denying unanswered permissions"
                collisionPadding={12}
              >
                {PERMISSION_TIMEOUT_DESCRIPTION}
              </PopoverContent>
            </Popover>
          </div>
          <span role="status">
            {permissionSeconds === null
              ? minutes === null
                ? ""
                : "Unavailable"
              : permissionSeconds === 0
                ? "A permission request waits until you answer it"
                : `${permissionTimeoutLabel(permissionSeconds)} unanswered, a permission is denied and the agent works around it`}
          </span>
        </div>
        <ThemedSelect
          aria-label="Deny unanswered permissions"
          value={permissionSeconds === null ? "" : String(permissionSeconds)}
          options={permissionTimeoutOptions(permissionSeconds)}
          disabled={permissionSeconds === null || saving || !client.isCurrent()}
          onChange={(value) => {
            const next = Number(value);
            if (isPermissionTimeoutSeconds(next) && next !== permissionSeconds)
              void savePermissionTimeout(next);
          }}
        />
      </div>
      <div className="config-preference-row">
        <span className="config-item-icon">
          <ArrowLeftRight size={15} />
        </span>
        <div className="config-item-copy">
          <div className="configuration-setting-label">
            <strong id="fallback-agent-label">At a usage limit</strong>
          </div>
          <span role="status">
            {fallbackAgent
              ? `A conversation that hits its usage limit continues on ${agentDisplayName(fallbackAgent)}`
              : "A conversation that hits its usage limit waits for the reset"}
          </span>
        </div>
        <ThemedSelect
          aria-label="At a usage limit"
          value={fallbackAgent ?? "none"}
          options={[
            { value: "none", label: "Wait", detail: "Wait for the reset" },
            ...CONVERSATION_AGENTS.map((agent) => ({
              value: agent,
              label: agentDisplayName(agent),
              detail: `Continue with ${agentDisplayName(agent)}`,
            })),
          ]}
          disabled={minutes === null || saving || !client.isCurrent()}
          onChange={(value) => {
            const next = value === "none" ? null : (value as ConversationAgent);
            if (next !== fallbackAgent) void saveFallback(next);
          }}
        />
      </div>
      {error ? (
        <div className="configuration-error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}
    </>
  );
}
