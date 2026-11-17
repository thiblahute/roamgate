import { Cpu } from "lucide-react";
import {
  MODEL_PROVIDER_SEPARATOR,
  shortModelName,
} from "../../../shared/agentModels";
import type { ConnectionClient } from "../api";
import { modelTitle, useSessionProfile } from "../sessionProfiles";
import "./ModelChip.css";

/**
 * The model a pane's agent runs, short ("Opus 5.5"), beside the chat
 * header's status: its title has the whole id and the session's profile.
 * Kept up to date with the session's profile (asked when the agent's
 * status changes, and every minute); nothing when the model is not known.
 */
export function ModelChip({
  client,
  paneId,
  enabled,
  agentStatus,
}: {
  client: ConnectionClient;
  paneId: string;
  /** The pane runs an agent whose transcript may name its model. */
  enabled: boolean;
  agentStatus: string | undefined;
}) {
  const profile = useSessionProfile(client, paneId, enabled, agentStatus);
  const data = profile.data;
  const model = enabled ? data?.model : undefined;
  if (!data || !model) return null;
  const name = shortModelName(model);
  return (
    <span
      className="agent-chat-model"
      title={modelTitle(data)}
      aria-label={`Model: ${name}`}
    >
      <Cpu size={12} aria-hidden="true" />
      <ModelLabel className="agent-chat-model-name" label={name} />
    </span>
  );
}

/**
 * A short model label ("igalia . GLM 5p3", shortModelName) in two parts,
 * so that a narrow chip cuts the provider first and keeps the model's name:
 * "ig... GLM 5p3", then "GLM 5p3", then "GLM 5...". A label without a
 * provider (or a profile's name) is one part.
 */
export function ModelLabel({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  const at = label.indexOf(MODEL_PROVIDER_SEPARATOR);
  const classes = `model-label${className ? ` ${className}` : ""}`;
  if (at <= 0) return <span className={classes}>{label}</span>;
  return (
    <span className={`${classes} has-provider`}>
      <span className="model-label-provider">
        {label.slice(0, at + MODEL_PROVIDER_SEPARATOR.length).trimEnd()}
      </span>
      <span className="model-label-name">
        {label.slice(at + MODEL_PROVIDER_SEPARATOR.length)}
      </span>
    </span>
  );
}
