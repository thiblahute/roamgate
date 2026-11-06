import { Cpu } from "lucide-react";
import { shortModelName } from "../../../shared/agentModels";
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
      <span className="agent-chat-model-name">{name}</span>
    </span>
  );
}
