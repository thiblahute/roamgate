import {
  type BackgroundWork,
  agentPresence,
  backgroundTooltip,
  showsBackground,
  statusWord,
} from "../agentBackground";
import type { PaneJumpEntry } from "../paneJump";
import { useStoreSelector } from "../store";
import { agentClass } from "../utils";
import { useAgentBackground } from "../workspaceTreeTasks";

type Entry = Pick<
  PaneJumpEntry,
  "agent" | "agentStatus" | "paneId" | "connectionId" | "source"
>;

/**
 * What an entry's agent still runs once its turn is over, as the Workspaces
 * list last read it; null when nothing does or the turn goes on.
 */
export function usePaneJumpBackground(): (
  entry: Entry,
) => BackgroundWork | null {
  const activeConnectionId = useStoreSelector(
    (state) => state.activeConnectionId,
  );
  const lookup = useAgentBackground();
  return (entry) => {
    if (entry.agent !== "claude") return null;
    const work = lookup(
      entry.connectionId ?? entry.source?.connectionId ?? activeConnectionId,
      entry.paneId,
    );
    return showsBackground(entry.agentStatus, work) ? work : null;
  };
}

/** The dot beside an entry's agent icon: hollow and breathing when idle with work running. */
export function PaneJumpStatusDot({
  entry,
  background,
}: {
  entry: Entry;
  background: BackgroundWork | null;
}) {
  const inBackground =
    !!background &&
    agentPresence(entry.agentStatus, background) === "background";
  return (
    <span
      className={`pane-jump-status status-${
        inBackground ? "background" : (entry.agentStatus ?? "unknown")
      }`}
      title={
        background
          ? backgroundTooltip(entry.agentStatus, background)
          : undefined
      }
    />
  );
}

/** "idle", or "idle · 2 running" with what runs in its tooltip. */
export function PaneJumpStatusLabel({
  entry,
  background,
}: {
  entry: Entry & { agentStatus: string };
  background: BackgroundWork | null;
}) {
  if (!background)
    return (
      <span
        className={`${agentClass(entry.agentStatus)} pane-jump-agent-status`}
      >
        {entry.agentStatus}
      </span>
    );
  const presence = agentPresence(entry.agentStatus, background);
  return (
    <span
      className={`${
        presence === "background"
          ? "badge badge-background"
          : agentClass(entry.agentStatus)
      } pane-jump-agent-status`}
      title={backgroundTooltip(entry.agentStatus, background)}
    >
      {`${statusWord(entry.agentStatus)} · ${background.running} running`}
    </span>
  );
}
