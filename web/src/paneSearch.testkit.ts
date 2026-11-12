// The user's real workspaces (labels and directories only), on the desktop
// this browser shows and on the Mac (`local`), which it holds no session
// for: the workspace search's tests rank against them.
import type { ConnectionSummary } from "./api";
import type { ConnectionSessionView } from "./connectionSessions";
import {
  type PaneJumpEntry,
  paneSearchEntries,
  serverSessionPaneEntries,
  workspaceHistoryKey,
} from "./paneJump";
import type { Pane, Tab, Workspace } from "./types";
import type { ConnectionAgentSessions } from "./useAllServerAgentSessions";

type Row = [id: string, label: string, panes: [cwd: string, agent?: string][]];

const D = "/var/home/thiblahute/devel";
const T = "/Volumes/data/cloud.thibaultsaunier.com/Documents";
const M = "/Users/thiblahute/devel";

const DESKTOP: Row[] = [
  [
    "wM",
    "gst",
    [[`${D}/gstreamer/gstreamer`], [`${D}/gstreamer/gstreamer`, "claude"]],
  ],
  ["wJ", "clauth", [[`${D}/misc`, "claude"], [`${D}/misc`]]],
  ["wT", "misc", [[`${D}/misc`], [D], [`${D}/misc`, "claude"]]],
  [
    "wZ",
    "cps-iga177-hdr",
    [[`${D}/clients/sequence/cloud-project-system-iga177-hdr`, "claude"]],
  ],
  [
    "w17",
    "gst2-control-task",
    [
      [`${D}/gstreamer/2.0/gst2-control-task`],
      [`${D}/gstreamer/2.0/gst2-control-task`, "claude"],
    ],
  ],
  [
    "w1F",
    "sequence",
    [[`${D}/clients/sequence/cloud-project-system-iga-183`, "claude"]],
  ],
  [
    "w1K",
    "gst2-transactions",
    [
      [`${D}/misc/roamgate`],
      [`${D}/gstreamer/2.0/gst2-transactions`, "claude"],
    ],
  ],
  [
    "w1W",
    "bin-manages-internal-pads",
    [[`${D}/gstreamer/upstreaming/bin-manages-internal-pads`, "claude"]],
  ],
  [
    "w1X",
    "upstream-ges-child-instance-names",
    [[`${D}/gstreamer/upstreaming/ges-child-instance-names`, "claude"]],
  ],
  [
    "w25",
    "upstream-cuda-gl-interop-mig",
    [[`${D}/gstreamer/upstreaming/cuda-gl-interop-mig`, "claude"]],
  ],
  ["w27", "gstreamer-ocio", [[`${D}/gstreamer/gstreamer-ocio`, "claude"]]],
  [
    "w28",
    "ges-natural-size-follows-direction",
    [
      [
        `${D}/gstreamer/upstreaming/ges-natural-size-follows-direction`,
        "claude",
      ],
      [
        `${D}/gstreamer/upstreaming/ges-natural-size-follows-direction/subprojects/gst-plugins-rs`,
      ],
    ],
  ],
  [
    "w29",
    "cps-iga185",
    [[`${D}/clients/sequence/cloud-project-system-iga-185`, "claude"]],
  ],
  [
    "w2A",
    "Reviews · OpenColorIO",
    [[`${D}/misc/OpenColorIO.worktrees/review`, "claude"]],
  ],
  [
    "w2B",
    "Reviews · system-deps",
    [[`${D}/misc/system-deps.worktrees/review`]],
  ],
  ["w2C", "cerbero", [[`${D}/gstreamer/misc/cerbero`]]],
  ["w2F", "spotify-connect", [[`${D}/gstreamer/upstreaming/spotify-connect`]]],
  ["w2G", "wrapdb-soundtouch-pc", [[`${D}/gstreamer/misc/wrapdb`, "claude"]]],
  [
    "w2H",
    "soundtouch-pc-cxx-runtime",
    [[`${D}/gstreamer/misc/soundtouch`, "claude"]],
  ],
  [
    "w2K",
    "Reviews · gstreamer",
    [[`${D}/gstreamer/gstreamer.worktrees/review`, "claude"]],
  ],
  [
    "w2M",
    "Reviews · cloud-project-system",
    [[`${D}/clients/sequence/cloud-project-system.worktrees/review`]],
  ],
  [
    "w2N",
    "glfloat",
    [[`${D}/gstreamer/upstreaming/gl-float-formats`, "claude"]],
  ],
  [
    "w2P",
    "gl-float-transfer",
    [[`${D}/gstreamer/upstreaming/gl-float-transfer`, "claude"]],
  ],
  [
    "w2Q",
    "gstdots++",
    [[`${D}/gstreamer/gst-dots-viewer-gstscope-port`, "claude"]],
  ],
  [
    "w2R",
    "opengl-videoscope",
    [[`${D}/gstreamer/upstreaming/opengl-videoscope`, "claude"]],
  ],
  [
    "w2S",
    "upstream-validatefloatpixels",
    [[`${D}/gstreamer/upstreaming/validate-hdr-check-last-sample`, "claude"]],
  ],
  [
    "w2T",
    "ocio-plugin",
    [[`${D}/gstreamer/upstreaming/ocio-plugin`, "claude"]],
  ],
  [
    "w2V",
    "ges-ocio-tests",
    [[`${D}/gstreamer/upstreaming/ges-ocio-tests`, "claude"]],
  ],
  [
    "w2W",
    "ocio-ges-demo",
    [[`${D}/gstreamer/upstreaming/ocio-ges-demo`, "claude"]],
  ],
  [
    "w2X",
    "scanner-interface-properties",
    [[`${D}/gstreamer/upstreaming/scanner-interface-properties`, "claude"]],
  ],
  ["w2Y", "gst2", [[`${D}/gstreamer/2.0/gstreamer`, "claude"]]],
  ["w2Z", "gst2-bindings", [[`${D}/gstreamer/2.0/gst2-caps-python`, "claude"]]],
  [
    "w20",
    "gst2-doc-slides",
    [[`${D}/gstreamer/2.0/gst2-doc-slides`, "claude"]],
  ],
  [
    "w31",
    "sequence",
    [[`${D}/clients/sequence/cloud-project-system`, "claude"]],
  ],
  ["w32", "gst2", [[`${D}/gstreamer/2.0`, "claude"]]],
  ["w33", "llm", [["/var/home/thiblahute/llm", "claude"]]],
  [
    "w34",
    "hotdoc-interface-properties",
    [[`${D}/gstreamer/upstreaming/hotdoc-interface-properties`, "claude"]],
  ],
  [
    "w35",
    "roamgate",
    [[`${D}/misc/roamgate`, "claude"], [`${D}/misc/roamgate`]],
  ],
  ["w36", "gst2-video", [[`${D}/gstreamer/2.0/gst2-video`]]],
  [
    "w38",
    "ges-validate-ci",
    [[`${D}/gstreamer/gstreamer.worktrees/ges-validate-ci`, "claude"]],
  ],
  ["w39", "roamgate-dictation", [[`${D}/misc/roamgate-dictation`, "claude"]]],
  [
    "w3A",
    "Reviews · gst-plugins-rs",
    [[`${D}/gstreamer/gst-plugins-rs.worktrees/review`]],
  ],
];

const MAC: Row[] = [
  [
    "w11",
    "pronote-mcp",
    [[`${M}/misc/pronote-mcp.worktrees/initial-server`, "claude"]],
  ],
  ["w13", "whatsapp", [[`${T}/tasks/subtasks/whatsapp`, "claude"]]],
  ["w15", "matrix-mcp", [[`${M}/misc/matrix-mcp.worktrees/next`, "claude"]]],
  ["w17", "youtube-mcp", [[`${M}/misc`, "claude"]]],
  ["w18", "olmo-reporter", [[`${M}/misc`, "claude"]]],
  ["w19", "blog", [[M, "claude"]]],
  [
    "w1A",
    "received-payements",
    [[`${T}/Admin/saunierSPA/banco/letters`, "claude"]],
  ],
  [
    "w1E",
    "GStreamer docgen templating",
    [[`${M}/gstreamer/gstreamer_docgen`, "claude"]],
  ],
  [
    "w1F",
    "instalador AC",
    [
      [
        `${T}/tasks-worktrees/areglos-casa/instalador-aire-acondicionado`,
        "claude",
      ],
    ],
  ],
  [
    "w1G",
    "android-auto-maker",
    [[`${T}/tasks/subtasks/android-auto-maker`, "claude"]],
  ],
  ["w1J", "clauth-repo", [[`${M}/misc`, "claude"]]],
  ["w1K", "vacation", [[`${T}/tasks-worktrees/vacation`, "claude"]]],
  ["w2", "roamgate", [[`${M}/misc/roamgate`, "claude"]]],
  ["w3", "Igalia", [["/Users/thiblahute/Documents/igalia", "claude"]]],
  ["w6", "mentoring", [["/Users/thiblahute/Documents/igalia/mentoring", "pi"]]],
  ["w8", "invoice", [[`${T}/Admin/saunierSPA/facturas`, "claude"]]],
  [
    "w9",
    "sequence",
    [[`${M}/clients/sequence/cloud-project-system`, "claude"]],
  ],
  ["wA", "talks", [[`${T}/travail/talks`, "claude"]]],
  ["wB", "misc", [[`${M}/misc`, "claude"]]],
  ["wC", "reports", [[`${M}/clients/reports`, "claude"]]],
  [
    "wF",
    "tasks",
    [
      [`${T}/tasks`, "claude"],
      [`${M}/misc/matrix-mcp`, "claude"],
    ],
  ],
  ["wG", "areglos-casa", [[`${T}/tasks-worktrees/areglos-casa`, "claude"]]],
  ["wH", "paiements", [[`${T}/tasks-worktrees/paiements`, "claude"]]],
  [
    "wJ",
    "cleanup-hard-drive",
    [[`${T}/tasks/subtasks/cleanup-hard-drive`, "claude"]],
  ],
  ["wM", "gst2", [[`${M}/gstreamer/2.0/gstreamer`, "claude"]]],
  ["wN", "gst", [[`${M}/gstreamer/gstreamer`, "claude"]]],
  ["wQ", "ocio-mac", [[`${M}/gstreamer/gstreamer-ocio`, "claude"]]],
  ["wR", "hdd-warranty", [[`${T}/tasks/subtasks/hdd-warranty`, "claude"]]],
  ["wS", "www", [[`${M}/gstreamer/misc/www`, "claude"]]],
  ["wV", "clauth", [[`${T}/tasks/subtasks/clauth`, "claude"]]],
  ["wW", "pi", [[`${T}/tasks/subtasks/pi`, "pi"]]],
  ["wX", "mails", [[`${T}/tasks/subtasks/mails`, "claude"]]],
  ["wY", "www_docs-gen", [[`${M}/gstreamer/misc/www_docs-gen`, "claude"]]],
  [
    "wZ",
    "server-maintenance",
    [[`${T}/tasks/subtasks/server-maintenance`, "claude"]],
  ],
];

function topology(prefix: string, rows: Row[]) {
  const workspaces: Workspace[] = [];
  const tabs: Tab[] = [];
  const panes: Pane[] = [];
  rows.forEach(([id, label, cwds], index) => {
    workspaces.push({
      workspace_id: id,
      number: index + 1,
      label,
      focused: false,
      pane_count: cwds.length,
      tab_count: 1,
      agent_status: "unknown",
    });
    tabs.push({
      tab_id: `${id}:t1`,
      workspace_id: id,
      number: 1,
      label: "1",
      focused: false,
      pane_count: cwds.length,
      agent_status: "unknown",
    });
    cwds.forEach(([cwd, agent], paneIndex) =>
      panes.push({
        pane_id: `${prefix}${id}:p${paneIndex + 1}`,
        terminal_id: `${prefix}${id}:term${paneIndex + 1}`,
        workspace_id: id,
        tab_id: `${id}:t1`,
        focused: false,
        cwd,
        agent,
        agent_status: agent ? "idle" : "unknown",
        revision: 1,
      }),
    );
  });
  return { workspaces, tabs, panes };
}

const desktopTopology = topology("", DESKTOP);
export const desktopSnapshot = {
  layout: null,
  ...desktopTopology,
  recentPaneIds: ["w35:p1"],
};

const macSessions: ConnectionAgentSessions = {
  connection_id: "local",
  connection_generation: 1,
  ...topology("", MAC),
  agents: null,
};

function summary(id: string, label: string): ConnectionSummary {
  return {
    id,
    label,
    source: "profile",
    is_default: false,
    state: "ready",
    generation: 1,
  };
}

const connections = [summary("desktop", "Desktop"), summary("local", "Mac")];
const activeOnly: ConnectionSessionView[] = [
  {
    connection: connections[0]!,
    active: true,
    recentPaneIds: [],
    error: null,
    loaded: true,
    ...desktopTopology,
  },
];

/**
 * Where the user has been lately: workspaces whose directories hold the
 * words searched for, as they do in real use.
 */
export const realHistory = {
  activeConnectionId: "desktop",
  keys: [
    ["desktop", "w35"],
    ["desktop", "w39"],
    ["desktop", "w1K"],
    ["local", "wG"],
    ["local", "w1F"],
    ["local", "wV"],
    ["desktop", "wT"],
    ["desktop", "w27"],
    ["local", "wZ"],
    ["desktop", "w31"],
    ["local", "wF"],
  ].map(([connection, workspace]) =>
    workspaceHistoryKey(connection!, workspace!),
  ),
};

/** The phone's workspace search over the desktop and the Mac. */
export function searchRealWorkspaces(query: string): PaneJumpEntry[] {
  return paneSearchEntries(
    desktopSnapshot,
    query,
    "w35:p1",
    activeOnly,
    "workspaces",
    realHistory,
    undefined,
    serverSessionPaneEntries(connections, [macSessions], "desktop"),
  );
}

/** `Mac:tasks`, or `tasks` on the desktop. */
export function workspaceLabel(entry: PaneJumpEntry): string {
  return entry.serverLabel
    ? `${entry.serverLabel}:${entry.title}`
    : entry.title;
}
