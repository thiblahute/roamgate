export type FileExplorerEntry = {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink";
  size: number;
  mtime_ms: number;
  hidden: boolean;
  ignored?: boolean;
};

export type FileListResult = {
  root: string;
  path: string;
  entries: FileExplorerEntry[];
  truncated: boolean;
};

export type FilePreviewDecoded = {
  text: string | null;
  binary: boolean;
  mime_type?: string | null;
  image_data_url?: string;
};

export type FilePreviewResult = FilePreviewDecoded & {
  root: string;
  path: string;
  // Omitted for regular files; "directory" marks a directory target, which
  // has no previewable content (text stays null).
  type?: "file" | "directory";
  size: number;
  mtime_ms: number;
  truncated: boolean;
};

/** A file's size and modification time, as file.read gives them. */
export type FileStatResult = {
  type: "file" | "directory";
  size: number;
  mtime_ms: number;
};

export type FileDownloadResult = {
  acceptRanges?: boolean;
  contentRange?: string;
  filename: string;
  path: string;
  size: number;
  body: BodyInit;
  contentType: string;
};

export type FileUploadResult = {
  path: string;
  size: number;
  overwritten: boolean;
};

export type FileDeleteResult = {
  path: string;
  type: FileExplorerEntry["type"];
};

export type FileResolution = {
  candidate: string;
  path: string;
};

export type GitDiffKind =
  | "staged"
  | "unstaged"
  | "untracked"
  | "conflicted"
  | "branch"
  | "last-step"
  /** A file's staged and unstaged changes together, `git diff HEAD` (D8). */
  | "combined";

export type GitDiffMode = "working" | "branch-main" | "last-step";

export type GitDiffEntry = {
  path: string;
  old_path?: string;
  kind: GitDiffKind;
  status: string;
  additions?: number;
  deletions?: number;
  binary?: boolean;
  generated?: boolean;
  file_size?: number;
  mtime_ms?: number;
  size?: number;
};

export type RunProcessWithCodeTimeout =
  typeof import("../utils/process-utils").runProcessWithCodeTimeout;
