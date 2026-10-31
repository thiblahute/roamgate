import { cn } from "../utils";
import { AgentIcon } from "./AgentIcon";
import { agentStateKind } from "./agentSession";
import "./AgentStatusIcon.css";

export function AgentStatusIcon({
  agent,
  status,
  className,
  background = false,
}: {
  agent?: string;
  status?: string;
  className?: string;
  /** Idle while its side tasks still run: a hollow, breathing dot. */
  background?: boolean;
}) {
  const stateKind =
    background && agentStateKind(status) === "idle"
      ? "background"
      : agentStateKind(status);
  return (
    <span className={cn("agent-status-icon", className)} aria-hidden="true">
      <AgentIcon agent={agent} compact />
      <span className={`agent-status-icon-dot is-${stateKind}`} />
    </span>
  );
}
