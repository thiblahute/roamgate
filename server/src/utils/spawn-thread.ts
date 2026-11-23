/**
 * Runs a command from a thread of its own, never from the event loop's.
 *
 * Bun.spawn walks PATH with a stat per directory, then vforks: the thread
 * that spawns waits until the child has exec'd. In a toolbox, /usr is a
 * fuse-overlayfs mount, so on a busy disk both the walk and the exec wait on
 * FUSE, and a server spawning git and sh a few times a second stalled every
 * call for up to seconds at a time (2026-11-23: every stall sampled was the
 * main thread in stat or vfork, request_wait_answer). This thread takes those
 * waits instead: it spawns, collects the output, and hands it back.
 */

/** A command run by spawnOffLoop, shaped as the part of Bun's process used. */
export interface ThreadProcess {
  /** The exit code (128 + the signal for a killed one, as Bun gives). */
  readonly exited: Promise<number>;
  readonly stdout: Promise<Uint8Array<ArrayBuffer>>;
  readonly stderr: Promise<Uint8Array<ArrayBuffer>>;
  /** The child's pid once spawned; rejects as exited does when it was not. */
  readonly pid: Promise<number>;
  kill(): void;
}

export interface ThreadSpawnOptions {
  cwd?: string;
  /** The whole environment; this process's when absent. */
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is closed after; none when absent. */
  stdin?: string | Uint8Array;
  /** Bun's timeout: the child is killed once it runs this long. */
  timeoutMs?: number;
}

/** Told of each command spawnOffLoop runs (the contract recorder). */
export interface ThreadSpawnObserver {
  started(argv: string[], cwd: string | undefined, pid: number): void;
  exited(argv: string[], pid: number, code: number, ms: number): void;
}

const observers = new Set<ThreadSpawnObserver>();

export function observeThreadSpawns(observer: ThreadSpawnObserver): () => void {
  observers.add(observer);
  return () => observers.delete(observer);
}

// Plain JavaScript, run from a Blob URL: a standalone binary has no file of
// its own to give Worker.
const WORKER_SOURCE = `
const procs = new Map();
const bytes = (stream) =>
  new Response(stream).arrayBuffer().catch(() => new ArrayBuffer(0));
self.onmessage = async ({ data }) => {
  if (data.kill !== undefined) {
    try { procs.get(data.kill)?.kill(); } catch {}
    return;
  }
  const { id, argv, cwd, env, stdin, timeout } = data;
  let proc;
  try {
    proc = Bun.spawn(argv, {
      cwd, env, timeout,
      stdin: stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    postMessage({ id, error: String(error?.message ?? error), code: error?.code });
    return;
  }
  procs.set(id, proc);
  postMessage({ id, pid: proc.pid });
  const [stdout, stderr, code] = await Promise.all([
    bytes(proc.stdout),
    bytes(proc.stderr),
    proc.exited,
  ]);
  procs.delete(id);
  postMessage({ id, code, stdout, stderr }, [stdout, stderr]);
};
`;

type Pending = {
  argv: string[];
  cwd: string | undefined;
  begun: number;
  pid: number | null;
  resolvePid: (pid: number) => void;
  resolve: (result: {
    code: number;
    stdout: Uint8Array<ArrayBuffer>;
    stderr: Uint8Array<ArrayBuffer>;
  }) => void;
  reject: (error: Error) => void;
};

type Reply =
  | { id: number; pid: number }
  | { id: number; error: string; code?: string }
  | { id: number; code: number; stdout: ArrayBuffer; stderr: ArrayBuffer };

/** Bun's Worker, which a pending command holds the process open with. */
type SpawnWorker = Worker & { ref(): void; unref(): void };

let worker: SpawnWorker | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();

function failAll(error: Error) {
  const waiting = [...pending.values()];
  pending.clear();
  for (const item of waiting) item.reject(error);
}

function spawnWorker(): SpawnWorker {
  if (worker) return worker;
  const url = URL.createObjectURL(
    new Blob([WORKER_SOURCE], { type: "application/javascript" }),
  );
  const created = new Worker(url) as SpawnWorker;
  // Waiting on a command keeps the process alive, not the idle thread.
  created.unref();
  created.onmessage = ({ data }: MessageEvent<Reply>) => {
    const item = pending.get(data.id);
    if (!item) return;
    if ("pid" in data) {
      item.pid = data.pid;
      item.resolvePid(data.pid);
      for (const observer of observers)
        observer.started(item.argv, item.cwd, data.pid);
      return;
    }
    pending.delete(data.id);
    if (pending.size === 0) created.unref();
    if ("error" in data) {
      const error = new Error(data.error) as NodeJS.ErrnoException;
      if (data.code) error.code = data.code;
      item.reject(error);
      return;
    }
    if (item.pid !== null)
      for (const observer of observers)
        observer.exited(
          item.argv,
          item.pid,
          data.code,
          Math.round(performance.now() - item.begun),
        );
    item.resolve({
      code: data.code,
      stdout: new Uint8Array(data.stdout),
      stderr: new Uint8Array(data.stderr),
    });
  };
  created.onerror = (event) => {
    // The thread is gone: what it ran is lost, the next command starts another.
    if (worker === created) worker = null;
    failAll(new Error(`spawn thread failed: ${event.message}`));
  };
  worker = created;
  return created;
}

const decoder = new TextDecoder();

/** Output as text, as `new Response(proc.stdout).text()` gives it. */
export function threadText(
  bytes: Promise<Uint8Array<ArrayBuffer>>,
): Promise<string> {
  return bytes.then((value) => decoder.decode(value));
}

// Under bun test, expect(promise).rejects (and .resolves) waits for the
// promise without taking the worker's messages: a command the promise runs
// on the thread never comes back, and the test hangs (2026-11-23). Tests run
// their commands on the event loop, as before; this file's own test uses
// the thread. Bun inlines direct NODE_ENV reads when compiling.
const { NODE_ENV: nodeEnvironment } = process.env;
let threaded = nodeEnvironment !== "test";

/** Whether commands run from the thread (tests of this file turn it on). */
export function useSpawnThread(enabled: boolean): void {
  threaded = enabled;
}

/** The same command run by Bun.spawn on the event loop (tests). */
function spawnOnLoop(
  argv: string[],
  options: ThreadSpawnOptions,
): ThreadProcess {
  try {
    const proc = Bun.spawn(argv, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeout: options.timeoutMs,
      stdin:
        typeof options.stdin === "string"
          ? new TextEncoder().encode(options.stdin)
          : (options.stdin ?? "ignore"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const bytes = (stream: ReadableStream<Uint8Array>) =>
      new Response(stream)
        .arrayBuffer()
        .then((buffer) => new Uint8Array(buffer));
    return {
      exited: proc.exited,
      stdout: bytes(proc.stdout),
      stderr: bytes(proc.stderr),
      pid: Promise.resolve(proc.pid),
      kill() {
        try {
          proc.kill();
        } catch {}
      },
    };
  } catch (error) {
    const failed = Promise.reject(error as Error);
    failed.catch(() => {});
    return {
      exited: failed,
      stdout: failed,
      stderr: failed,
      pid: failed,
      kill() {},
    };
  }
}

/** Bun.spawn's one-shot use, its stat walk and vfork off the event loop. */
export function spawnOffLoop(
  argv: string[],
  options: ThreadSpawnOptions = {},
): ThreadProcess {
  if (!threaded) return spawnOnLoop(argv, options);
  const id = ++nextId;
  let resolvePid!: (pid: number) => void;
  let rejectPid!: (error: Error) => void;
  const pid = new Promise<number>((resolve, reject) => {
    resolvePid = resolve;
    rejectPid = reject;
  });
  const result = new Promise<{
    code: number;
    stdout: Uint8Array<ArrayBuffer>;
    stderr: Uint8Array<ArrayBuffer>;
  }>((resolve, reject) => {
    pending.set(id, {
      argv,
      cwd: options.cwd,
      begun: performance.now(),
      pid: null,
      resolvePid,
      resolve,
      reject: (error) => {
        rejectPid(error);
        reject(error);
      },
    });
  });
  // Nobody may ask for the pid or every stream.
  pid.catch(() => {});
  const thread = spawnWorker();
  thread.ref();
  thread.postMessage({
    id,
    argv,
    cwd: options.cwd,
    env: { ...(options.env ?? process.env) },
    stdin:
      typeof options.stdin === "string"
        ? new TextEncoder().encode(options.stdin)
        : options.stdin,
    timeout: options.timeoutMs,
  });
  const exited = result.then((value) => value.code);
  const stdout = result.then((value) => value.stdout);
  const stderr = result.then((value) => value.stderr);
  for (const promise of [exited, stdout, stderr]) promise.catch(() => {});
  return {
    exited,
    stdout,
    stderr,
    pid,
    kill() {
      worker?.postMessage({ kill: id });
    },
  };
}
