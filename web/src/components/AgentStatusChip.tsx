import {
  type BackgroundTaskLike,
  agentPresence,
  backgroundCountLabel,
  backgroundTooltip,
  backgroundWork,
  showsBackground,
  statusWord,
} from "../agentBackground";

/**
 * The chat header's status: Herdr's, or, once the turn is over while side
 * tasks still run, "Idle · 2 subagents running" in its own colour, which
 * opens the Tasks sheet.
 */
export function AgentStatusChip({
  status,
  tasks,
  onOpenTasks,
}: {
  status: string;
  tasks: readonly BackgroundTaskLike[];
  onOpenTasks?: () => void;
}) {
  const work = backgroundWork(tasks);
  if (!showsBackground(status, work))
    return (
      <span className={`agent-history-status is-${status.toLowerCase()}`}>
        {status}
      </span>
    );
  const label = `${statusWord(status)} · ${backgroundCountLabel(work)}`;
  return (
    <button
      type="button"
      className={`agent-history-status is-${agentPresence(status, work)} has-background`}
      title={backgroundTooltip(status, work)}
      aria-label={`${label}. Show the background tasks`}
      onClick={onOpenTasks}
    >
      <span className="agent-history-status-pulse" aria-hidden="true" />
      {label}
    </button>
  );
}
