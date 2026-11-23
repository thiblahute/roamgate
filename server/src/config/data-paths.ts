import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  type Dirent,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function dataRoot(
  homeDir = homedir(),
  platform: string = process.platform,
  appDataDir = process.env.APPDATA,
): string {
  return join(
    platform === "win32"
      ? (appDataDir ?? join(homeDir, "AppData", "Roaming"))
      : join(homeDir, ".config"),
    "roamgate",
  );
}

export function legacyDataRoot(
  homeDir = homedir(),
  platform: string = process.platform,
  appDataDir = process.env.APPDATA,
): string {
  return join(dirname(dataRoot(homeDir, platform, appDataDir)), "herdr-gui");
}

function statIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function statFollowingIfPresent(path: string) {
  try {
    return statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// The platform configuration directories belong to the user, not Roamgate.
// Dotfile managers and folder redirection commonly make them symlinks or
// junctions, so they are followed; links inside Roamgate's tree never are.
function userConfigRoots(): Set<string> {
  return new Set(
    [dirname(dataRoot()), join(homedir(), ".config")].map((root) =>
      resolve(root),
    ),
  );
}

// Check the configuration parent, product directory and file; never follow a
// legacy symlink, including dangling links. Explicit override paths do not migrate.
export function assertSafeDataPath(path: string): void {
  const configRoots = userConfigRoots();
  for (const entry of [dirname(dirname(path)), dirname(path), path]) {
    const stat = configRoots.has(resolve(entry))
      ? statFollowingIfPresent(entry)
      : statIfPresent(entry);
    if (stat?.isSymbolicLink())
      throw new Error(`data path contains a symlink: ${entry}`);
    if (stat && (entry === path ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`data path has an unexpected file type: ${entry}`);
    }
  }
}

/**
 * Write a complete private file through a synced temporary file. Publishing
 * links it and keeps a concurrent winner; replacing renames over the target.
 */
function writeDataFile(
  path: string,
  contents: string | Buffer,
  mode: number,
  replace: boolean,
): void {
  assertSafeDataPath(path);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.roamgate-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    writeFileSync(fd, contents);
    fchmodSync(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertSafeDataPath(path);
    if (replace) {
      renameSync(temporaryPath, path);
    } else {
      try {
        linkSync(temporaryPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        assertSafeDataPath(path);
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporaryPath, { force: true });
  }
  // Persist the new directory entry too. Windows cannot open directories, and
  // some filesystems reject directory fsync; the file itself is already synced.
  if (process.platform === "win32") return;
  try {
    const directoryFd = openSync(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    );
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch {
    // Best effort, as for the connection registry.
  }
}

/** Publish a complete private file without replacing a concurrent winner. */
export function publishDataFile(
  path: string,
  contents: string | Buffer,
  mode = 0o600,
): void {
  writeDataFile(path, contents, mode, false);
}

/** Atomically replace a private file, unlike publishDataFile which never overwrites. */
export function replaceDataFile(
  path: string,
  contents: string | Buffer,
  mode = 0o600,
): void {
  writeDataFile(path, contents, mode, true);
}

async function statIfPresentAsync(path: string, follow: boolean) {
  try {
    return await (follow ? stat(path) : lstat(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** assertSafeDataPath, off the event loop. */
async function assertSafeDataPathAsync(path: string): Promise<void> {
  const configRoots = userConfigRoots();
  for (const entry of [dirname(dirname(path)), dirname(path), path]) {
    const found = await statIfPresentAsync(
      entry,
      configRoots.has(resolve(entry)),
    );
    if (found?.isSymbolicLink())
      throw new Error(`data path contains a symlink: ${entry}`);
    if (found && (entry === path ? !found.isFile() : !found.isDirectory())) {
      throw new Error(`data path has an unexpected file type: ${entry}`);
    }
  }
}

/**
 * replaceDataFile without blocking the event loop: a file rewritten often
 * (a sync on a busy disk can take a second) is written this way, every step
 * on Node's thread pool.
 */
export async function replaceDataFileAsync(
  path: string,
  contents: string | Buffer,
  mode = 0o600,
): Promise<void> {
  await assertSafeDataPathAsync(path);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.roamgate-${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(contents);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertSafeDataPathAsync(path);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  if (process.platform === "win32") return;
  try {
    const handle = await open(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort, as for the synchronous writer.
  }
}

/**
 * A private file a server store rewrites whole on each change, written
 * behind the changes off the event loop: write() says what the file holds
 * now, and the contents are made and written soon by replaceDataFileAsync,
 * one write at a time, the changes made meanwhile in the next one, so a
 * burst of changes is a write or two. A synchronous write and sync on the
 * event loop stalls every call (the call's microphone too) for as long as
 * a busy disk takes to sync, tens of seconds on a full one.
 */
export type DataFileWriter = {
  /** The file is to hold what `contents` makes when it is written. */
  write(contents: () => string | Buffer): void;
  /** Resolves once every write asked so far is done (or failed). */
  flush(): Promise<void>;
};

type BehindFile = {
  path: string;
  mode: number;
  /** Asked for, its write not yet over: the exit writes it. */
  unwritten: (() => string | Buffer) | null;
};

const behindFiles = new Set<BehindFile>();
let behindExitHooked = false;

function hookBehindExit() {
  if (behindExitHooked) return;
  behindExitHooked = true;
  // A process that ends with changes not yet written writes them now; a
  // write under way never gets to its rename.
  process.on("exit", () => {
    for (const file of behindFiles) {
      if (!file.unwritten) continue;
      try {
        replaceDataFile(file.path, file.unwritten(), file.mode);
      } catch {
        // Nothing more can be done on the way out.
      }
    }
  });
}

/** See DataFileWriter. After a failed write, the next change writes again. */
export function dataFileWriter(
  path: string,
  options: { mode?: number; onError?: (error: unknown) => void } = {},
): DataFileWriter {
  const file: BehindFile = {
    path,
    mode: options.mode ?? 0o600,
    unwritten: null,
  };
  behindFiles.add(file);
  hookBehindExit();
  /** Asked for and not yet started. */
  let next: (() => string | Buffer) | null = null;
  let writing: Promise<void> | null = null;
  async function drain() {
    // Changes made in this same run of code go in the first write (a
    // microtask, not a timer: fake timers in tests leave it alone).
    await Promise.resolve();
    while (next) {
      const make = next;
      next = null;
      try {
        await replaceDataFileAsync(file.path, make(), file.mode);
      } catch (error) {
        options.onError?.(error);
      }
      if (!next) file.unwritten = null;
    }
    writing = null;
  }
  return {
    write(contents) {
      next = contents;
      file.unwritten = contents;
      writing ??= drain();
    },
    async flush() {
      while (writing) await writing;
    },
  };
}

/**
 * A private file a server store appends lines to (a history), written in
 * order off the event loop: a small append waited seconds on a busy disk.
 * pending() is what is not yet in the file, for reads meanwhile; what was
 * not yet handed to a write at exit is appended then.
 */
export type DataFileAppender = {
  append(text: string): void;
  /** Appended, not yet known to be in the file. */
  pending(): string;
  /** Resolves once every append asked so far is done (or failed). */
  flush(): Promise<void>;
};

const appendingFiles = new Set<{
  path: string;
  mode: number;
  queued: () => string;
}>();
let appendExitHooked = false;

/** See DataFileAppender. A failed append is dropped, as a convenience log's. */
export function dataFileAppender(
  path: string,
  options: { mode?: number; onError?: (error: unknown) => void } = {},
): DataFileAppender {
  const mode = options.mode ?? 0o600;
  /** Being appended now, then waiting for the next append. */
  let inFlight = "";
  let queued = "";
  let writing: Promise<void> | null = null;
  appendingFiles.add({ path, mode, queued: () => queued });
  if (!appendExitHooked) {
    appendExitHooked = true;
    process.on("exit", () => {
      for (const file of appendingFiles) {
        const text = file.queued();
        if (!text) continue;
        try {
          mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 });
          appendFileSync(file.path, text, { mode: file.mode });
        } catch {
          // Nothing more can be done on the way out.
        }
      }
    });
  }
  async function drain() {
    while (queued) {
      inFlight = queued;
      queued = "";
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await appendFile(path, inFlight, { mode });
      } catch (error) {
        options.onError?.(error);
      }
      inFlight = "";
    }
    writing = null;
  }
  return {
    append(text) {
      if (!text) return;
      queued += text;
      writing ??= drain();
    },
    pending: () => inFlight + queued,
    async flush() {
      while (writing) await writing;
    },
  };
}

/** The temporary file name writeDataFile and replaceDataFileAsync use. */
const DATA_TEMPORARY_NAME = /^\.roamgate-[0-9a-f-]{36}\.tmp$/;

/**
 * Remove the temporary files a killed process left between writing and
 * renaming them: regular files named like the writers' own, anywhere under
 * the root, last changed before this process started. Symlinks are never
 * followed and no other file is touched. Returns how many were removed.
 */
export async function removeLeftoverDataTemporaries(
  root: string = dataRoot(),
  startedAt: number = performance.timeOrigin,
): Promise<number> {
  let removed = 0;
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile() || !DATA_TEMPORARY_NAME.test(entry.name)) continue;
      try {
        const found = await lstat(path);
        if (!found.isFile() || found.mtimeMs >= startedAt) continue;
        await rm(path);
        removed += 1;
      } catch {
        // Gone already, or not ours to remove: leave it.
      }
    }
  };
  await visit(root);
  return removed;
}

/** Copy only missing files. Originals and concurrent/new values always win. */
export function migrateDataFile(
  path: string,
  legacyPath: string,
  validate?: (contents: Buffer) => void,
): string {
  assertSafeDataPath(path);
  if (statIfPresent(path)) return path;
  assertSafeDataPath(legacyPath);
  if (!statIfPresent(legacyPath)) return path;
  const fd = openSync(
    legacyPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile())
      throw new Error(`legacy data is not a regular file: ${legacyPath}`);
    const contents = readFileSync(fd);
    validate?.(contents);
    publishDataFile(path, contents, stat.mode & 0o600);
  } finally {
    closeSync(fd);
  }
  return path;
}

export function defaultDataFile(
  name: "auth-token" | "settings.json" | "connections.json",
  homeDir = homedir(),
  platform: string = process.platform,
  appDataDir = process.env.APPDATA,
): string {
  // Settings and connections historically used ~/.config on Windows too.
  const legacyRoot =
    name === "auth-token"
      ? legacyDataRoot(homeDir, platform, appDataDir)
      : join(homeDir, ".config", "herdr-gui");
  const path = join(dataRoot(homeDir, platform, appDataDir), name);
  if (name === "connections.json") {
    const cleared = `${path}.legacy-cleared`;
    assertSafeDataPath(cleared);
    if (statIfPresent(cleared)) return path;
  }
  return migrateDataFile(
    path,
    join(legacyRoot, name),
    name === "settings.json"
      ? (contents) => {
          JSON.parse(contents.toString("utf8"));
        }
      : undefined,
  );
}
