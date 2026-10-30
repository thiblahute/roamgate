import {
  type AgentChatOtherWriter,
  otherWriterPlace,
} from "../../shared/agentChat";
import type { ConnectionSummary } from "./api";
import type { Tab, Workspace } from "./types";
import { workspaceDisplayName } from "./workspaceTreeBadges";

/**
 * Where another claude on the session is, as the sidebar and the tab bar
 * name it (Herdr's names when this page does not know the pane), with the
 * connection when it is not a local one: "roamgate / Tab 2 on desktop".
 */
export function otherWriterPlaceIn(
  writer: AgentChatOtherWriter,
  known: {
    workspaces: readonly Workspace[];
    tabs: readonly Tab[];
    connection?: Pick<ConnectionSummary, "label" | "type" | "ssh_destination">;
  },
): string {
  const workspace = writer.workspace_id
    ? known.workspaces.find((each) => each.workspace_id === writer.workspace_id)
    : undefined;
  const tab = writer.tab_id
    ? known.tabs.find((each) => each.tab_id === writer.tab_id)
    : undefined;
  const place = otherWriterPlace({
    pane_id: writer.pane_id,
    workspace_label: workspace
      ? workspaceDisplayName(workspace)
      : writer.workspace_label,
    // As the tab bar names it: its label, unless that is just its number.
    tab_label: tab
      ? tab.label && tab.label !== String(tab.number)
        ? tab.label
        : `Tab ${tab.number}`
      : writer.tab_label,
  });
  const connection = known.connection;
  const remote =
    !!connection && (connection.type === "ssh" || !!connection.ssh_destination);
  return remote && connection.label ? `${place} on ${connection.label}` : place;
}
