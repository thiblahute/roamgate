import {
  AUDIO_INLINE_PREVIEW_MAX_BYTES,
  AUDIO_MIME_TYPES,
  IMAGE_MIME_TYPES,
} from "../../../shared/filePreview";
import {
  FileDownloadError,
  fileDownloadRange,
  type FileDownloadOptions,
} from "./file-download";
import { sshCommandArgv, sshReadCommandArgv } from "../bridge/ssh-command";
import {
  DELETE_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
  LIST_LIMIT,
  LIST_TIMEOUT_MS,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_MAX_BYTES,
  PREVIEW_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
} from "./file-constants";
import {
  entrySort,
  missingFileMessage,
  relativeExplorerPath,
} from "./file-paths";
import type {
  FileDeleteResult,
  FileDownloadResult,
  FileExplorerEntry,
  FileListResult,
  FilePreviewResult,
  FileStatResult,
  FileUploadResult,
  RunProcessWithCodeTimeout,
} from "./file-types";
import { runProcessWithInputTimeout } from "./process";
import { decodePreviewBuffer, previewLimitForPath } from "./preview";
import { REMOTE_EXCLUSIVE_RENAME } from "./atomic-file-move";
import {
  DELETE_FILE_SH,
  DOWNLOAD_FILE_SH,
  LIST_FILES_SH,
  MUTATE_FILE_SH,
  READ_FILE_SH,
  RESOLVE_FILES_SH,
  STAT_FILE_SH,
  UPLOAD_FILE_SH,
  fillTemplate,
} from "../assets";

export function parseRemoteFileList(
  stdout: string,
  relativePath: string,
): FileListResult {
  let root = "";
  const entries: FileExplorerEntry[] = [];
  let truncated = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [kind, ...rest] = line.split("\t");
    if (kind === "ROOT") {
      root = Buffer.from(rest[0] ?? "", "base64").toString("utf8");
      continue;
    }
    if (kind === "TRUNCATED") {
      truncated = true;
      continue;
    }
    if (kind !== "ENTRY") continue;
    const [type, rawSize, rawMtime, rawName] = rest;
    const name = Buffer.from(rawName ?? "", "base64").toString("utf8");
    if (!name) continue;
    entries.push({
      name,
      path: relativeExplorerPath(relativePath, name),
      type: type === "directory" || type === "symlink" ? type : "file",
      size: Number(rawSize) || 0,
      mtime_ms: (Number(rawMtime) || 0) * 1000,
      hidden: name.startsWith("."),
    });
  }
  entries.sort(entrySort);
  return { root, path: relativePath, entries, truncated };
}

export function parseRemoteFileResolutions(stdout: string) {
  const paths: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [kind, rawPath] = line.split("\t");
    if (kind !== "FILE" || !rawPath) continue;
    const path = Buffer.from(rawPath, "base64").toString("utf8");
    if (path) paths.push(path);
  }
  return paths;
}

export async function listRemoteFiles({
  host,
  rootPath,
  relativePath,
  showHidden,
  runProcessWithCodeTimeout,
  shQuote,
}: {
  host: string;
  rootPath: string;
  relativePath: string;
  showHidden: boolean;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}) {
  const command = fillTemplate(LIST_FILES_SH, {
    root: shQuote(rootPath),
    rel: shQuote(relativePath),
    show_hidden: showHidden ? "1" : "0",
    limit: LIST_LIMIT,
  });
  const result = await runProcessWithCodeTimeout(
    sshReadCommandArgv(host, `bash -lc ${shQuote(command)}`, [], "files.list"),
    LIST_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `file list exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  return parseRemoteFileList(result.stdout, relativePath);
}

export async function resolveRemoteFilePaths({
  host,
  rootPath,
  requestedPaths,
  runProcessWithCodeTimeout,
  shQuote,
}: {
  host: string;
  rootPath: string;
  requestedPaths: string[];
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}) {
  const requests = requestedPaths.map((path) => shQuote(path)).join(" ");
  const command = fillTemplate(RESOLVE_FILES_SH, {
    root: shQuote(rootPath),
    requests,
  });
  const result = await runProcessWithCodeTimeout(
    sshReadCommandArgv(
      host,
      `bash -lc ${shQuote(command)}`,
      [],
      "files.resolve",
    ),
    PREVIEW_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `file resolve exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  return parseRemoteFileResolutions(result.stdout);
}

export function parseRemoteFilePreview(
  stdout: string,
  requestedPath: string,
): FilePreviewResult {
  const lines = stdout.split(/\r?\n/);
  const meta = lines.shift() ?? "";
  const [kind, rawRoot, rawSize, rawMtime, rawRelative, rawType] =
    meta.split("\t");
  if (kind !== "META") {
    throw new Error(
      (stdout || "invalid file preview response").trim().slice(0, 1000),
    );
  }
  const root = Buffer.from(rawRoot ?? "", "base64").toString("utf8");
  const relativePath = rawRelative
    ? Buffer.from(rawRelative, "base64").toString("utf8")
    : requestedPath.replace(/^\/+/, "");
  if (rawType === "directory") {
    return {
      root,
      path: relativePath,
      type: "directory",
      size: 0,
      mtime_ms: (Number(rawMtime) || 0) * 1000,
      truncated: false,
      text: null,
      binary: false,
    };
  }
  const base64 = lines.join("");
  const raw = Buffer.from(base64, "base64");
  const size = Number(rawSize) || raw.length;
  const previewLimit = previewLimitForPath(relativePath, size);
  const truncated =
    size > previewLimit || raw.length > previewLimit || raw.length < size;
  const bytes = truncated ? raw.subarray(0, previewLimit) : raw;
  const decoded = decodePreviewBuffer(bytes, truncated, relativePath);
  return {
    root,
    path: relativePath,
    size,
    mtime_ms: (Number(rawMtime) || 0) * 1000,
    truncated,
    ...decoded,
  };
}

/** file.read's exit when the file asked for is not there. */
const MISSING_FILE_EXIT = 15;

export async function readRemoteFile({
  host,
  rootPath,
  requestedPath,
  runProcessWithCodeTimeout,
  shQuote,
}: {
  host: string;
  rootPath: string;
  requestedPath: string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}) {
  const command = fillTemplate(READ_FILE_SH, {
    root: shQuote(rootPath),
    request: shQuote(requestedPath),
    text_limit: PREVIEW_MAX_BYTES,
    image_limit: PREVIEW_IMAGE_MAX_BYTES,
    missing_exit: MISSING_FILE_EXIT,
    image_patterns: Array.from(
      IMAGE_MIME_TYPES.keys(),
      (extension) => `*.${extension}`,
    ).join("|"),
  });
  const result = await runProcessWithCodeTimeout(
    sshReadCommandArgv(host, `bash -lc ${shQuote(command)}`, [], "files.read"),
    PREVIEW_TIMEOUT_MS,
  );
  if (result.code === MISSING_FILE_EXIT)
    throw new Error(missingFileMessage(requestedPath, rootPath));
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `file read exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  return parseRemoteFilePreview(result.stdout, requestedPath);
}

/** file.stat's answer from the host: "STAT\t<size>\t<mtime s>\t<type>". */
export function parseRemoteFileStat(stdout: string): FileStatResult {
  const line = stdout.split(/\r?\n/).find((each) => each.startsWith("STAT\t"));
  const [, rawSize, rawMtime, rawType] = (line ?? "").split("\t");
  if (!line) {
    throw new Error(
      (stdout || "invalid file stat response").trim().slice(0, 1000),
    );
  }
  const type = rawType === "directory" ? "directory" : "file";
  return {
    type,
    size: type === "directory" ? 0 : Number(rawSize) || 0,
    // Seconds, as readRemoteFile's: the two compare.
    mtime_ms: (Number(rawMtime) || 0) * 1000,
  };
}

/**
 * The size and modification time of a file on the host, checked against
 * the checkout as readRemoteFile does: one stat, nothing read.
 */
export async function statRemoteFile({
  host,
  rootPath,
  requestedPath,
  runProcessWithCodeTimeout,
  shQuote,
}: {
  host: string;
  rootPath: string;
  requestedPath: string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}): Promise<FileStatResult> {
  const command = fillTemplate(STAT_FILE_SH, {
    root: shQuote(rootPath),
    request: shQuote(requestedPath),
  });
  const result = await runProcessWithCodeTimeout(
    sshReadCommandArgv(host, `sh -c ${shQuote(command)}`, [], "files.stat"),
    PREVIEW_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `file stat exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  return parseRemoteFileStat(result.stdout);
}

export function parseRemoteFileDownload(stdout: string, requestedPath: string) {
  const lines = stdout.split(/\r?\n/);
  const meta = lines.shift() ?? "";
  const [kind, rawSize, rawRelative, rawName, rawContentType] =
    meta.split("\t");
  if (kind !== "META") {
    throw new Error(
      (stdout || "invalid file download response").trim().slice(0, 1000),
    );
  }
  const path = rawRelative
    ? Buffer.from(rawRelative, "base64").toString("utf8")
    : requestedPath.replace(/^\/+/, "");
  const filename = rawName
    ? Buffer.from(rawName, "base64").toString("utf8")
    : path.split("/").filter(Boolean).pop() || "download";
  const contentType = rawContentType
    ? Buffer.from(rawContentType, "base64").toString("utf8")
    : "application/octet-stream";
  const body = Buffer.from(lines.join(""), "base64");
  return {
    filename,
    path,
    size: Number(rawSize) || body.length,
    body,
    contentType,
  };
}

/** A process whose output is read as it comes, such as a file sent whole. */
export type StreamedProcess = {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  stderr: Promise<string>;
  kill: () => void;
};

export type StreamProcess = (argv: string[]) => Promise<StreamedProcess>;

/**
 * The bytes of a file a process prints, exactly `size` of them: it fails
 * before the response starts when the process does before its first byte,
 * and errors the body (the browser then drops the download) when the file
 * changed while it was sent.
 */
async function streamedFile(
  proc: StreamedProcess,
  size: number,
): Promise<ReadableStream<Uint8Array>> {
  const reader = proc.stdout.getReader();
  const failure = async () => {
    const code = await proc.exited;
    const stderr = (await proc.stderr.catch(() => "")).trim();
    return new Error(
      code === 16 || code === 0
        ? "File changed during download"
        : (stderr || `file download exited ${code}`).slice(0, 1000),
    );
  };
  let first: Awaited<ReturnType<typeof reader.read>>;
  try {
    first = await reader.read();
  } catch (error) {
    proc.kill();
    throw error;
  }
  if (first.done && (size > 0 || (await proc.exited) !== 0))
    throw await failure();
  let sent = 0;
  const take = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    chunk: Uint8Array,
  ) => {
    sent += chunk.byteLength;
    if (sent > size) {
      proc.kill();
      controller.error(new Error("File changed during download"));
      return;
    }
    controller.enqueue(chunk);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.done) controller.close();
      else take(controller, first.value);
    },
    async pull(controller) {
      const next = await reader.read().catch(() => null);
      if (next && !next.done) {
        take(controller, next.value);
        return;
      }
      const code = await proc.exited;
      if (next && code === 0 && sent === size) controller.close();
      else controller.error(await failure());
    },
    cancel() {
      proc.kill();
      void reader.cancel().catch(() => {});
    },
  });
}

export async function downloadRemoteFile({
  host,
  rootPath,
  requestedPath,
  runProcessWithCodeTimeout,
  shQuote,
  options = {},
  streamProcess,
}: {
  host: string;
  rootPath: string;
  requestedPath: string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
  options?: FileDownloadOptions;
  /**
   * Runs the command a whole file is sent by, its bytes streamed as they
   * come. Without it the file is read whole, in base64, before it is sent.
   */
  streamProcess?: StreamProcess;
}): Promise<FileDownloadResult> {
  const blockSize = 64 * 1024;
  /**
   * The script finding the file (in the checkout unless asked by absolute
   * path) and printing it: its metadata line then its base64, a slice of
   * it, or only its raw bytes (`stream`, once its size is known).
   */
  function downloadCommand(
    metadataOnly = false,
    slice?: { start: number; end: number; size: number },
    stream?: { size: number },
  ) {
    return fillTemplate(DOWNLOAD_FILE_SH, {
      root: shQuote(rootPath),
      request: shQuote(requestedPath),
      checked: !!(slice || stream),
      metadata_only: metadataOnly,
      inline: !!options.inline,
      audio_patterns: Array.from(
        AUDIO_MIME_TYPES.keys(),
        (extension) => `*.${extension}`,
      ).join("|"),
      audio_max_bytes: AUDIO_INLINE_PREVIEW_MAX_BYTES,
      capped: options.maxBytes !== undefined,
      max_bytes: Math.floor(options.maxBytes ?? 0),
      slice: !!slice,
      slice_size: slice?.size ?? 0,
      stream: !!stream,
      stream_size: Math.floor(stream?.size ?? 0),
      block_size: blockSize,
      skip_blocks: slice ? Math.floor(slice.start / blockSize) : 0,
      count_blocks: slice
        ? Math.ceil(slice.end / blockSize) - Math.floor(slice.start / blockSize)
        : 0,
    });
  }
  async function readDownload(
    metadataOnly = false,
    slice?: { start: number; end: number; size: number },
  ) {
    const command = downloadCommand(metadataOnly, slice);
    const result = await runProcessWithCodeTimeout(
      sshReadCommandArgv(
        host,
        `bash -lc ${shQuote(command)}`,
        [],
        "files.download",
      ),
      DOWNLOAD_TIMEOUT_MS,
    );
    if (result.code === 15) {
      throw new FileDownloadError(
        "Audio is too large to preview. Use Download.",
        413,
      );
    }
    if (result.code === 17) {
      const size = Number(result.stderr.trim());
      throw new FileDownloadError(
        "File is too large to read here. Use Download.",
        413,
        Number.isSafeInteger(size) ? size : undefined,
      );
    }
    if (result.code !== 0) {
      throw new Error(
        (
          result.stderr ||
          result.stdout ||
          `file download exited ${result.code}`
        )
          .trim()
          .slice(0, 1000),
      );
    }
    return parseRemoteFileDownload(result.stdout, requestedPath);
  }

  if (!options.inline && !options.range && !streamProcess)
    return readDownload();
  const metadata = await readDownload(true);
  if (metadata.contentType === "application/gzip") return readDownload();
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) {
    throw new Error("Invalid file download size");
  }
  if (!options.inline && !options.range && streamProcess) {
    // A whole file goes out as the host sends it: no size limit, no
    // deadline, and no copy of it held here.
    const argv = sshReadCommandArgv(
      host,
      `bash -lc ${shQuote(downloadCommand(false, undefined, { size: metadata.size }))}`,
      [],
      "files.download",
    );
    return {
      ...metadata,
      body: await streamedFile(await streamProcess(argv), metadata.size),
    };
  }
  const range = fileDownloadRange(metadata.path, metadata.size, options);
  const start = range?.start ?? 0;
  const end = range ? range.end + 1 : metadata.size;
  const download = await readDownload(false, {
    start,
    end,
    size: metadata.size,
  });
  // Read only intersecting blocks; trim their edges without byte-at-a-time dd.
  const body = download.body.subarray(
    start % blockSize,
    (start % blockSize) + end - start,
  );
  if (body.length !== end - start || download.path !== metadata.path) {
    throw new Error("File changed during download");
  }
  return {
    ...download,
    acceptRanges: true,
    ...(range
      ? { contentRange: `bytes ${start}-${end - 1}/${metadata.size}` }
      : {}),
    size: body.length,
    body,
  };
}

export function parseRemoteFileUpload(stdout: string): FileUploadResult {
  const [kind, rawPath, rawSize, rawOverwritten] = stdout.trim().split("\t");
  if (kind !== "META") {
    throw new Error(
      (stdout || "invalid file upload response").trim().slice(0, 1000),
    );
  }
  return {
    path: rawPath ? Buffer.from(rawPath, "base64").toString("utf8") : "",
    size: Number(rawSize) || 0,
    overwritten: rawOverwritten === "1",
  };
}

export async function uploadRemoteFile({
  host,
  rootPath,
  directory,
  filename,
  body,
  shQuote,
}: {
  host: string;
  rootPath: string;
  directory: string;
  filename: string;
  body: Buffer;
  shQuote: (value: string) => string;
}) {
  const command = fillTemplate(UPLOAD_FILE_SH, {
    root: shQuote(rootPath),
    rel: shQuote(directory),
    name: shQuote(filename),
  });
  const result = await runProcessWithInputTimeout(
    sshCommandArgv(host, `bash -lc ${shQuote(command)}`, [], "files.upload"),
    body.toString("base64"),
    UPLOAD_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `file upload exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  return parseRemoteFileUpload(result.stdout);
}

export function parseRemoteFileDelete(stdout: string): FileDeleteResult {
  const [kind, rawPath, type] = stdout.trim().split("\t");
  if (kind !== "META") {
    throw new Error(
      (stdout || "invalid file delete response").trim().slice(0, 1000),
    );
  }
  return {
    path: rawPath ? Buffer.from(rawPath, "base64").toString("utf8") : "",
    type: type === "directory" || type === "symlink" ? type : "file",
  };
}

export async function deleteRemoteFile({
  host,
  rootPath,
  requestedPath,
  runProcessWithCodeTimeout,
  shQuote,
}: {
  host: string;
  rootPath: string;
  requestedPath: string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}) {
  const command = fillTemplate(DELETE_FILE_SH, {
    root: shQuote(rootPath),
    rel: shQuote(requestedPath),
  });
  const result = await runProcessWithCodeTimeout(
    sshCommandArgv(host, `bash -lc ${shQuote(command)}`, [], "files.delete"),
    DELETE_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `file delete exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  return parseRemoteFileDelete(result.stdout);
}

export async function mutateRemoteFile({
  host,
  rootPath,
  directory,
  name,
  path,
  runProcessWithCodeTimeout,
  shQuote,
}: {
  host: string;
  rootPath: string;
  directory: string;
  name: string;
  path?: string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}) {
  const command = fillTemplate(MUTATE_FILE_SH, {
    root: shQuote(rootPath),
    directory: shQuote(directory || "."),
    name: shQuote(name),
    move: path !== undefined,
    source_directory: shQuote(
      path?.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".",
    ),
    rename: shQuote(REMOTE_EXCLUSIVE_RENAME),
  });
  const result = await runProcessWithCodeTimeout(
    sshCommandArgv(host, `bash -lc ${shQuote(command)}`),
    DELETE_TIMEOUT_MS,
  );
  if (result.code !== 0)
    throw new Error(
      (result.stderr || result.stdout || `file operation exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  return { path: relativeExplorerPath(directory, name) };
}
