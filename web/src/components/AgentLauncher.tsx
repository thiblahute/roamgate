import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Pencil, X } from "lucide-react";
import {
  defaultAgentLaunchCommand,
  readAgentLaunchCommand,
  saveAgentLaunchCommand,
  validateAgentLaunchCommand,
} from "../agentLauncher";
import {
  connectionClientScopeKey,
  useConnectionClient,
} from "../useConnectionClient";
import {
  parseAgentIntegrations,
  type AgentIntegration,
} from "../agentIntegrations";
import { AgentIcon } from "./AgentIcon";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import "./AgentLauncher.css";

export function AgentLauncher({
  workspaceId,
  paneId,
  tabId,
  terminalId,
  disabled,
  visible,
  onOpen,
  onSelectCommand,
}: {
  workspaceId: string;
  paneId: string;
  tabId: string;
  terminalId: string;
  disabled: boolean;
  visible: boolean;
  onOpen: () => void;
  onSelectCommand: (command: string) => void;
}) {
  const client = useConnectionClient();
  const scope = connectionClientScopeKey(
    client,
    client.serverRuntimeGeneration,
    workspaceId,
    paneId,
    tabId,
    terminalId,
  );
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AgentIntegration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AgentIntegration | null>(null);
  const [command, setCommand] = useState("");
  const [reload, setReload] = useState(0);

  // A fresh token also invalidates pane/connection A-B-A replacements.
  const target = useMemo(
    () => ({ scope, visible, disabled }),
    [scope, visible, disabled],
  );
  const identity = useRef<object | null>(target);
  identity.current = target;
  useEffect(() => {
    identity.current = target;
    return () => {
      identity.current = null;
    };
  }, [target]);

  useEffect(() => {
    setOpen(false);
    setSelected(null);
    setItems(null);
    setError(null);
  }, [target]);

  // The agent profiles (Configuration > Integrations > Agent profiles).
  const [profiles, setProfiles] = useState<
    { name: string; agent: string; label: string; default: boolean }[]
  >([]);
  useEffect(() => {
    if (!open || !visible) return;
    let cancelled = false;
    void client.call("settings.profiles.get").then(
      (result) => {
        if (cancelled || !client.isCurrent()) return;
        const list = Array.isArray(result?.profiles) ? result.profiles : [];
        setProfiles(
          list.map((each: Record<string, unknown>) => ({
            name: String(each.name),
            agent: String(each.agent),
            label: String(each.label ?? each.name),
            default: each.name === result.default,
          })),
        );
      },
      () => {
        if (!cancelled) setProfiles([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, open, visible]);

  useEffect(() => {
    if (!open || !visible) return;
    let cancelled = false;
    setItems(null);
    setError(null);
    void client.call("integration.list").then(
      (result) => {
        if (!cancelled && identity.current === target && client.isCurrent()) {
          try {
            setItems(
              parseAgentIntegrations(result).map((item) => ({
                ...item,
                command: defaultAgentLaunchCommand(item.target, item.command),
              })),
            );
          } catch (e) {
            setError((e as Error).message);
          }
        }
      },
      (e: Error) => {
        if (!cancelled && identity.current === target && client.isCurrent())
          setError(e.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, target, open, reload, visible]);

  const selectCommand = async (item: AgentIntegration, profile?: string) => {
    if (
      disabled ||
      !visible ||
      identity.current !== target ||
      !client.isCurrent()
    )
      return;
    try {
      const value = readAgentLaunchCommand(
        client.connectionId,
        item.target,
        item.command,
      );
      // Claude with its default command starts with an agent profile (the
      // default, or the one picked) when it is not plain claude: the
      // server gives a one-use start the pane's roamgate-hold fetches.
      if (
        item.target === "claude" &&
        (value === item.command || profile) &&
        (profile || profiles.length > 1)
      ) {
        const launch = (await client.call("agent_profile.launch", {
          pane_id: paneId,
          ...(profile ? { profile } : {}),
        })) as { text?: string | null };
        if (identity.current !== target || !client.isCurrent()) return;
        if (typeof launch?.text === "string" && launch.text) {
          onSelectCommand(launch.text);
          setOpen(false);
          return;
        }
      }
      validateAgentLaunchCommand(value);
      onSelectCommand(value);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveCommand = (value: string) => {
    if (
      !selected ||
      disabled ||
      !visible ||
      identity.current !== target ||
      !client.isCurrent()
    )
      return;
    try {
      saveAgentLaunchCommand(
        client.connectionId,
        selected.target,
        value,
        selected.command,
      );
      setSelected(null);
      setError(null);
    } catch (e) {
      setError(`Could not save command: ${(e as Error).message}`);
    }
  };

  return (
    <Popover
      open={open && visible}
      onOpenChange={(next) => {
        setSelected(null);
        if (next) onOpen();
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="agent-launcher-trigger"
          aria-label="Agent terminals"
          title="Agent terminals"
          disabled={disabled || !visible}
        >
          <Bot size={19} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="agent-launcher-panel"
        side="top"
        aria-label="Agent terminals"
      >
        <div className="agent-launcher-heading">
          <span>Agent terminals</span>
          <button
            type="button"
            aria-label="Close agent terminals"
            onClick={() => setOpen(false)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        {error ? (
          <div role="alert">
            <p>{error}</p>
            {!items ? (
              <button
                type="button"
                onClick={() => setReload((value) => value + 1)}
              >
                Retry detection
              </button>
            ) : null}
          </div>
        ) : null}
        {!items && !error ? (
          <p role="status">Detecting installed agents...</p>
        ) : null}
        {items?.length === 0 ? (
          <p role="status">No agents found on this server.</p>
        ) : null}
        {selected ? (
          <form
            className="agent-launcher-editor"
            aria-label={`${selected.label} launch command`}
            onSubmit={(event) => {
              event.preventDefault();
              saveCommand(command);
            }}
          >
            <label>
              {selected.label} launch command
              <input
                autoFocus
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                disabled={disabled}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </label>
            <div className="agent-launcher-editor-actions">
              <button
                type="button"
                disabled={disabled}
                onClick={() => saveCommand(selected.command)}
              >
                Reset
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelected(null);
                  setError(null);
                }}
              >
                Cancel
              </button>
              <button type="submit" disabled={disabled || !command.trim()}>
                Save
              </button>
            </div>
          </form>
        ) : (
          <div className="agent-launcher-list">
            {items?.map((item) => (
              <div className="agent-launcher-row" key={item.target}>
                <button
                  type="button"
                  className="agent-launcher-agent"
                  aria-label={item.label}
                  disabled={disabled || !client.isCurrent()}
                  onClick={() => void selectCommand(item)}
                >
                  <AgentIcon agent={item.target} compact />
                  {item.label}
                </button>
                <button
                  type="button"
                  className="agent-launcher-edit"
                  aria-label={`Edit ${item.label} command`}
                  title="Edit launch command"
                  disabled={disabled || !client.isCurrent()}
                  onClick={() => {
                    setCommand(
                      readAgentLaunchCommand(
                        client.connectionId,
                        item.target,
                        item.command,
                      ),
                    );
                    setSelected(item);
                    setError(null);
                  }}
                >
                  <Pencil size={16} aria-hidden="true" />
                </button>
              </div>
            ))}
            {items?.some((item) => item.target === "claude")
              ? profiles
                  .filter((each) => each.agent === "claude" && !each.default)
                  .map((each) => (
                    <div
                      className="agent-launcher-row"
                      key={`profile-${each.name}`}
                    >
                      <button
                        type="button"
                        className="agent-launcher-agent"
                        aria-label={`Agent with ${each.name}`}
                        title={`Start an agent with the ${each.name} profile`}
                        disabled={disabled || !client.isCurrent()}
                        onClick={() => {
                          const claude = items?.find(
                            (item) => item.target === "claude",
                          );
                          if (claude) void selectCommand(claude, each.name);
                        }}
                      >
                        <AgentIcon compact />
                        {`Agent: ${each.name}`}
                        {each.label !== each.name ? (
                          <small>{each.label}</small>
                        ) : null}
                      </button>
                    </div>
                  ))
              : null}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
