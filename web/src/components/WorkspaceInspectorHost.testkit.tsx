import type { WorkspaceInspectorHost } from "./WorkspaceInspectorHost";

type Props = Parameters<typeof WorkspaceInspectorHost>[0];

/** The checkout shared by the inspector frame and command suites. */
export function inspectorWorkspace(
  overrides: Partial<NonNullable<Props["workspace"]>> = {},
): NonNullable<Props["workspace"]> {
  return {
    workspace_id: "w1",
    number: 1,
    label: "Repo",
    focused: true,
    pane_count: 1,
    tab_count: 1,
    agent_status: "",
    worktree: { repo_name: "repo", checkout_path: "/repo" },
    ...overrides,
  } as NonNullable<Props["workspace"]>;
}

/** Defaults for the host's independent DOM suites; each suite overrides its callbacks. */
export function inspectorProps(overrides: Partial<Props> = {}): Props {
  return {
    state: {
      scope: { kind: "workspace", connectionId: "local", workspaceId: "w1" },
      open: true,
      view: "files",
      dock: "right",
      size: 480,
      expanded: false,
    } as Props["state"],
    visible: true,
    workspace: inspectorWorkspace(),
    fileSelection: {
      entry: null,
      preview: null,
      loading: false,
      error: null,
    } as Props["fileSelection"],
    onSelectFileTab: () => {},
    previewRequestRef: { current: 0 },
    diffSelection: {
      entry: null,
      file: null,
      loading: false,
      error: null,
      entries: [],
      files: {},
      fileErrors: {},
    } as unknown as Props["diffSelection"],
    connectionClient: {
      connectionId: "local",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
      call: async () => ({}),
    } as unknown as Props["connectionClient"],
    onFileSelectionChange: () => {},
    onDiffSelectionChange: () => {},
    onOpenDiffFile: () => {},
    annotations: [],
    onCreateAnnotation: () => {},
    onReanchorFileAnnotations: () => {},
    onReanchorDiffAnnotations: () => {},
    onEditAnnotation: () => {},
    onOpenDocument: () => {},
    onRefreshFile: () => {},
    onViewChange: () => {},
    onDockChange: () => {},
    onExpandedChange: () => {},
    onClose: () => {},
    onBack: () => {},
    ...overrides,
  };
}
