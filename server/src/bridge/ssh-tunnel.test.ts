import { describe, expect, test } from "bun:test";
import {
  assertSshTunnelPlatformSupported,
  classifySshTunnelFailure,
  createSshTunnelManager as createPlatformSshTunnelManager,
  readBoundedStderr,
  SshTunnelError,
} from "./ssh-tunnel";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached");
    await Bun.sleep(1);
  }
}

function createSshTunnelManager(
  args: Parameters<typeof createPlatformSshTunnelManager>[0],
) {
  return createPlatformSshTunnelManager({
    ...args,
    dependencies: { ...args.dependencies, platform: "linux" },
  });
}

function config() {
  return {
    socketPath: "/tmp/herdr-control.sock",
    clientSocketPath: "/tmp/herdr-client.sock",
    sshHost: "test-host",
    session: undefined,
    hasExplicitSocketPath: false,
    hasExplicitClientSocketPath: false,
  };
}

describe("SSH tunnel readiness lifecycle", () => {
  test("rejects Windows before constructing an invalid stream-local forward", () => {
    let failure: unknown;
    try {
      assertSshTunnelPlatformSupported("win32");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SshTunnelError);
    expect(failure).toMatchObject({
      retryable: false,
      kind: "unsupported",
      message: expect.stringContaining(
        "cannot create a local Windows named pipe",
      ),
    });
    expect(() => assertSshTunnelPlatformSupported("linux")).not.toThrow();
  });

  test("classifies permanent and transient OpenSSH failures without raw stderr", () => {
    expect(
      classifySshTunnelFailure(255, "Permission denied (publickey)."),
    ).toMatchObject({
      retryable: false,
      kind: "authentication",
      message: expect.not.stringContaining("publickey"),
    });
    expect(
      classifySshTunnelFailure(255, "REMOTE HOST IDENTIFICATION HAS CHANGED!"),
    ).toMatchObject({ retryable: false, kind: "host-key" });
    expect(
      classifySshTunnelFailure(255, "ssh: connect: Connection refused"),
    ).toMatchObject({ retryable: true, kind: "unreachable" });
    expect(classifySshTunnelFailure(1, "unknown banner")).toMatchObject({
      retryable: true,
      kind: "exited",
      exitCode: 1,
    });
  });

  test("cleanup during remote-home resolution prevents process startup", async () => {
    const home = deferred<{ stdout: string; stderr: string }>();
    let spawns = 0;
    const manager = createSshTunnelManager({
      config: config(),
      runProcess: () => home.promise,
      dependencies: {
        remove: () => undefined,
        spawn: () => {
          spawns += 1;
          return {
            exited: new Promise<number>(() => {}),
            kill: () => undefined,
          };
        },
      },
    });

    const starting = manager.startAutoSshTunnel();
    const cleanup = manager.cleanupAutoSshTunnel();
    home.resolve({ stdout: "/home/test", stderr: "" });
    await Promise.all([starting, cleanup]);

    expect(spawns).toBe(0);
  });

  test("the remote HOME probe runs with a deadline", async () => {
    const probe = deferred<{ timeoutMs?: number } | undefined>();
    const manager = createSshTunnelManager({
      config: config(),
      runProcess: async (_argv, _input, options) => {
        probe.resolve(options);
        return { stdout: "/home/test", stderr: "" };
      },
      dependencies: {
        remove: () => undefined,
        spawn: () => ({
          exited: new Promise<number>(() => {}),
          kill: () => undefined,
        }),
      },
    });

    const starting = manager.startAutoSshTunnel();
    expect(await probe.promise).toEqual({ timeoutMs: 20_000 });
    await manager.cleanupAutoSshTunnel();
    await starting.catch(() => undefined);
  });

  test("cleanup cancels readiness polling and the starting process", async () => {
    const exited = deferred<number>();
    let killed = 0;
    let cancelledPolls = 0;
    let scheduledPolls = 0;
    const manager = createSshTunnelManager({
      config: config(),
      runProcess: async () => ({ stdout: "/home/test", stderr: "" }),
      dependencies: {
        exists: () => false,
        remove: () => undefined,
        spawn: () => ({
          exited: exited.promise,
          kill: () => {
            killed += 1;
            exited.resolve(143);
          },
        }),
        schedulePoll: () => {
          scheduledPolls += 1;
          let cancelled = false;
          return {
            cancel: () => {
              if (cancelled) return;
              cancelled = true;
              cancelledPolls += 1;
            },
          };
        },
      },
    });

    const starting = manager.startAutoSshTunnel();
    await waitUntil(() => scheduledPolls === 1);
    const cleanup = manager.cleanupAutoSshTunnel();
    await Promise.all([starting, cleanup]);

    expect(killed).toBe(1);
    expect(cancelledPolls).toBe(1);
  });

  test("process exit cancels the outstanding readiness poll", async () => {
    const exited = deferred<number>();
    let cancelledPolls = 0;
    let scheduledPolls = 0;
    const manager = createSshTunnelManager({
      config: config(),
      runProcess: async () => ({ stdout: "/home/test", stderr: "" }),
      dependencies: {
        exists: () => false,
        remove: () => undefined,
        spawn: () => ({ exited: exited.promise, kill: () => undefined }),
        schedulePoll: () => {
          scheduledPolls += 1;
          let cancelled = false;
          return {
            cancel: () => {
              if (cancelled) return;
              cancelled = true;
              cancelledPolls += 1;
            },
          };
        },
      },
    });

    const starting = manager.startAutoSshTunnel();
    await waitUntil(() => scheduledPolls === 1);
    exited.resolve(255);

    await expect(starting).rejects.toThrow(
      "SSH tunnel exited unexpectedly (code 255)",
    );
    expect(cancelledPolls).toBe(1);
  });

  test("retains the stderr tail for permanent failure classification", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("warning ".repeat(3000)));
        controller.enqueue(encoder.encode(" Permission denied (publickey)."));
        controller.close();
      },
    });

    const stderr = await readBoundedStderr(stream);
    expect(stderr).toContain("Permission denied");
    expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(16 * 1024);
    expect(classifySshTunnelFailure(255, stderr)).toMatchObject({
      retryable: false,
      kind: "authentication",
    });
  });

  test("reports a classified exit after readiness exactly once", async () => {
    const exited = deferred<number>();
    const failures: Array<{ retryable: boolean; kind: string }> = [];
    const manager = createSshTunnelManager({
      config: {
        ...config(),
        remoteSocketPath: "/remote/control.sock",
        remoteClientSocketPath: "/remote/render.sock",
      },
      runProcess: async () => ({ stdout: "/unused", stderr: "" }),
      onUnexpectedExit: (error) => failures.push(error),
      dependencies: {
        exists: () => true,
        remove: () => undefined,
        spawn: () => ({
          exited: exited.promise,
          stderr: Promise.resolve("ssh: connect: Connection refused"),
          kill: () => undefined,
        }),
      },
    });

    await manager.startAutoSshTunnel();
    exited.resolve(255);
    await waitUntil(() => failures.length === 1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      retryable: true,
      kind: "unreachable",
    });
    await manager.cleanupAutoSshTunnel();
    expect(failures).toHaveLength(1);
  });

  test("uses explicit profile forwards and cleans only its owned runtime directory", async () => {
    const exited = deferred<number>();
    const removed: string[] = [];
    const removedDirectories: string[] = [];
    let argv: string[] = [];
    let remoteHomeCalls = 0;
    let killed = 0;
    const profileConfig = {
      ...config(),
      socketPath: "/tmp/private-a/control.sock",
      clientSocketPath: "/tmp/private-a/render.sock",
      remoteSocketPath: "/remote/herdr.sock",
      remoteClientSocketPath: "/remote/herdr-client.sock",
      ownedRuntimeDirectory: "/tmp/private-a",
      hasExplicitSocketPath: true,
      hasExplicitClientSocketPath: true,
    };
    const manager = createSshTunnelManager({
      config: profileConfig,
      runProcess: async () => {
        remoteHomeCalls += 1;
        return { stdout: "/unused", stderr: "" };
      },
      dependencies: {
        exists: () => true,
        remove: (path) => removed.push(path),
        removeDirectory: (path) => removedDirectories.push(path),
        spawn: (value) => {
          argv = value;
          return {
            exited: exited.promise,
            kill: () => {
              killed += 1;
              exited.resolve(143);
            },
          };
        },
      },
    });

    await manager.startAutoSshTunnel();
    expect(remoteHomeCalls).toBe(0);
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("StrictHostKeyChecking=yes");
    expect(argv).not.toContain("StrictHostKeyChecking=no");
    expect(argv.slice(-2)).toEqual(["--", "test-host"]);
    expect(argv).toContain("/tmp/private-a/control.sock:/remote/herdr.sock");
    expect(argv).toContain(
      "/tmp/private-a/render.sock:/remote/herdr-client.sock",
    );

    await manager.cleanupAutoSshTunnel();
    expect(killed).toBe(1);
    expect(removed).toEqual([
      "/tmp/private-a/control.sock",
      "/tmp/private-a/render.sock",
      "/tmp/private-a/control.sock",
      "/tmp/private-a/render.sock",
    ]);
    expect(removedDirectories).toEqual(["/tmp/private-a"]);
  });

  test("awaits process exit before removing owned tunnel paths", async () => {
    const exited = deferred<number>();
    const removed: string[] = [];
    const manager = createSshTunnelManager({
      config: {
        ...config(),
        remoteSocketPath: "/remote/control.sock",
        remoteClientSocketPath: "/remote/render.sock",
        ownedRuntimeDirectory: "/tmp/private-wait",
      },
      runProcess: async () => ({ stdout: "/unused", stderr: "" }),
      dependencies: {
        exists: () => true,
        remove: (path) => removed.push(path),
        removeDirectory: (path) => removed.push(path),
        spawn: () => ({
          exited: exited.promise,
          kill: () => undefined,
        }),
        processStopTimeoutMs: 100,
      },
    });
    await manager.startAutoSshTunnel();

    const cleanup = manager.cleanupAutoSshTunnel();
    await Promise.resolve();
    expect(removed).toEqual([
      "/tmp/herdr-control.sock",
      "/tmp/herdr-client.sock",
    ]);
    exited.resolve(143);
    await cleanup;
    expect(removed).toEqual([
      "/tmp/herdr-control.sock",
      "/tmp/herdr-client.sock",
      "/tmp/herdr-control.sock",
      "/tmp/herdr-client.sock",
      "/tmp/private-wait",
    ]);
  });

  test("uses force kill after a failed graceful termination", async () => {
    const exited = deferred<number>();
    const signals: Array<number | undefined> = [];
    const manager = createSshTunnelManager({
      config: {
        ...config(),
        remoteSocketPath: "/remote/control.sock",
        remoteClientSocketPath: "/remote/render.sock",
      },
      runProcess: async () => ({ stdout: "/unused", stderr: "" }),
      dependencies: {
        exists: () => true,
        remove: () => undefined,
        spawn: () => ({
          exited: exited.promise,
          kill: (signal) => {
            signals.push(signal);
            if (signal === undefined) throw new Error("graceful kill failed");
            exited.resolve(137);
          },
        }),
        processStopTimeoutMs: 1,
        processForceKillTimeoutMs: 20,
      },
    });
    await manager.startAutoSshTunnel();
    await manager.cleanupAutoSshTunnel();
    expect(signals).toEqual([undefined, 9]);
  });

  test("preserves owned paths when forced process exit cannot be confirmed", async () => {
    const removed: string[] = [];
    const signals: Array<number | undefined> = [];
    const manager = createSshTunnelManager({
      config: {
        ...config(),
        remoteSocketPath: "/remote/control.sock",
        remoteClientSocketPath: "/remote/render.sock",
        ownedRuntimeDirectory: "/tmp/private-stuck",
      },
      runProcess: async () => ({ stdout: "/unused", stderr: "" }),
      dependencies: {
        exists: () => true,
        remove: (path) => removed.push(path),
        removeDirectory: (path) => removed.push(path),
        spawn: () => ({
          exited: new Promise<number>(() => undefined),
          kill: (signal) => signals.push(signal),
        }),
        processStopTimeoutMs: 1,
        processForceKillTimeoutMs: 1,
      },
    });
    await manager.startAutoSshTunnel();

    await expect(manager.cleanupAutoSshTunnel()).rejects.toThrow(
      "did not exit after forced termination",
    );

    expect(signals).toEqual([undefined, 9]);
    expect(removed).toEqual([
      "/tmp/herdr-control.sock",
      "/tmp/herdr-client.sock",
    ]);
  });

  test("a superseding start cancels the previous readiness poll", async () => {
    const exits = [deferred<number>(), deferred<number>()];
    let spawnIndex = 0;
    let killed = 0;
    let cancelledPolls = 0;
    let scheduledPolls = 0;
    const manager = createSshTunnelManager({
      config: config(),
      runProcess: async () => ({ stdout: "/home/test", stderr: "" }),
      dependencies: {
        exists: () => false,
        remove: () => undefined,
        spawn: () => {
          const index = spawnIndex++;
          return {
            exited: exits[index].promise,
            kill: () => {
              killed += 1;
              exits[index].resolve(143);
            },
          };
        },
        schedulePoll: () => {
          scheduledPolls += 1;
          let cancelled = false;
          return {
            cancel: () => {
              if (cancelled) return;
              cancelled = true;
              cancelledPolls += 1;
            },
          };
        },
      },
    });

    const first = manager.startAutoSshTunnel();
    await waitUntil(() => scheduledPolls === 1);
    const second = manager.startAutoSshTunnel();
    await waitUntil(() => scheduledPolls === 2);
    const cleanup = manager.cleanupAutoSshTunnel();
    await Promise.all([first, second, cleanup]);

    expect(killed).toBe(2);
    expect(cancelledPolls).toBe(2);
  });
});

describe("SSH command master alongside the tunnel", () => {
  function fakeMaster(stopError?: Error) {
    const calls: string[] = [];
    const master = {
      ensure: async () => {
        calls.push("ensure");
        return true;
      },
      stop: async () => {
        calls.push("stop");
        if (stopError) throw stopError;
      },
      isRunning: () => true,
    };
    return { calls, master };
  }

  function managerWith(
    master: ReturnType<typeof fakeMaster>["master"],
    events: string[],
    masterControlPath: string | null = "/tmp/private-m/m.ctl",
  ) {
    const created: Array<[string, string]> = [];
    let exitTunnel = () => {};
    const manager = createSshTunnelManager({
      config: {
        ...config(),
        remoteSocketPath: "/remote/control.sock",
        remoteClientSocketPath: "/remote/render.sock",
        ownedRuntimeDirectory: "/tmp/private-m",
        masterControlPath: masterControlPath ?? undefined,
      },
      runProcess: async () => ({ stdout: "/unused", stderr: "" }),
      dependencies: {
        exists: () => true,
        remove: () => undefined,
        removeDirectory: (path) => events.push(`rmdir ${path}`),
        spawn: () => {
          const exited = deferred<number>();
          exitTunnel = () => exited.resolve(255);
          events.push("tunnel");
          return { exited: exited.promise, kill: () => exited.resolve(143) };
        },
        createMaster: (destination, controlPath) => {
          created.push([destination, controlPath]);
          return master;
        },
      },
    });
    return { manager, created, exitTunnel: () => exitTunnel() };
  }

  test("starts one master per runtime and keeps it across tunnel restarts", async () => {
    const events: string[] = [];
    const { calls, master } = fakeMaster();
    const { manager, created } = managerWith(master, events);
    expect(created).toEqual([["test-host", "/tmp/private-m/m.ctl"]]);

    await manager.startAutoSshTunnel();
    await manager.startAutoSshTunnel();
    expect(calls).toEqual(["ensure", "ensure"]);
    expect(events).toEqual(["tunnel", "tunnel"]);

    await manager.cleanupAutoSshTunnel();
    expect(calls).toEqual(["ensure", "ensure", "stop"]);
    expect(events.at(-1)).toBe("rmdir /tmp/private-m");
  });

  test("preserves the runtime directory when the master cannot be stopped", async () => {
    const events: string[] = [];
    const { master } = fakeMaster(new Error("master did not exit"));
    const { manager } = managerWith(master, events);
    await manager.startAutoSshTunnel();
    await expect(manager.cleanupAutoSshTunnel()).rejects.toThrow(
      "master did not exit",
    );
    expect(events).not.toContain("rmdir /tmp/private-m");
  });

  test("runs without a master when the runtime has no control path", async () => {
    const events: string[] = [];
    const { calls, master } = fakeMaster();
    const { manager, created } = managerWith(master, events, null);
    await manager.startAutoSshTunnel();
    await manager.cleanupAutoSshTunnel();
    expect(created).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("Herdr relay on the tunnel", () => {
  type Spawned = {
    argv: string[];
    relay: boolean;
    exited: ReturnType<typeof deferred<number>>;
    ready: ReturnType<typeof deferred<boolean>>;
  };

  function relayManager(
    overrides: { socketWaitTimeoutMs?: number; herdrRelay?: boolean } = {},
  ) {
    const spawned: Spawned[] = [];
    const exits: unknown[] = [];
    const manager = createSshTunnelManager({
      config: { ...config(), herdrRelay: overrides.herdrRelay ?? true },
      runProcess: async () => ({ stdout: "/home/test", stderr: "" }),
      onUnexpectedExit: (error) => exits.push(error),
      dependencies: {
        exists: () => true,
        remove: () => undefined,
        relayToken: () => "t0ken",
        socketWaitTimeoutMs: overrides.socketWaitTimeoutMs ?? 8000,
        spawn: (argv, options) => {
          const entry: Spawned = {
            argv,
            relay: options?.relay === true,
            exited: deferred<number>(),
            ready: deferred<boolean>(),
          };
          spawned.push(entry);
          return {
            exited: entry.exited.promise,
            stderr: Promise.resolve(""),
            ...(entry.relay ? { relayReady: entry.ready.promise } : {}),
            kill: () => entry.exited.resolve(143),
          };
        },
      },
    });
    return { manager, spawned, exits };
  }

  const relaySocket = "/home/test/.cache/roamgate/herdr-relay-t0ken.sock";

  test("forwards the control socket to the relay and waits for it to listen", async () => {
    const { manager, spawned } = relayManager();
    let started = false;
    const starting = manager.startAutoSshTunnel().then(() => {
      started = true;
    });
    await waitUntil(() => spawned.length === 1);
    const [first] = spawned;
    expect(first.relay).toBe(true);
    expect(first.argv).not.toContain("-N");
    expect(first.argv).toContain(`/tmp/herdr-control.sock:${relaySocket}`);
    // The render socket stays a direct forward.
    expect(first.argv).toContain(
      "/tmp/herdr-client.sock:/home/test/.config/herdr/herdr-client.sock",
    );
    const command = first.argv.at(-1)!;
    expect(first.argv.at(-2)).toBe("test-host");
    expect(command).toStartWith("exec python3 -c ");
    expect(command).toContain("'/home/test/.config/herdr/herdr.sock'");
    expect(command).toEndWith(`'${relaySocket}'`);

    await Bun.sleep(5);
    expect(started).toBe(false);
    first.ready.resolve(true);
    await starting;
    expect(started).toBe(true);
    await manager.cleanupAutoSshTunnel();
  });

  test("falls back to the direct forward when the relay does not start", async () => {
    const { manager, spawned } = relayManager();
    const starting = manager.startAutoSshTunnel();
    await waitUntil(() => spawned.length === 1);
    // No python3 on the host: the login shell's 127, output ended.
    spawned[0].ready.resolve(false);
    spawned[0].exited.resolve(127);
    await starting;
    expect(spawned).toHaveLength(2);
    const [, direct] = spawned;
    expect(direct.relay).toBe(false);
    expect(direct.argv).toContain("-N");
    expect(direct.argv.slice(-2)).toEqual(["--", "test-host"]);
    expect(direct.argv).toContain(
      "/tmp/herdr-control.sock:/home/test/.config/herdr/herdr.sock",
    );

    // Later tunnels of this runtime skip it.
    direct.exited.resolve(255);
    await manager.startAutoSshTunnel();
    expect(spawned).toHaveLength(3);
    expect(spawned[2].relay).toBe(false);
    await manager.cleanupAutoSshTunnel();
  });

  test("falls back when the relay never says it listens", async () => {
    const { manager, spawned } = relayManager({ socketWaitTimeoutMs: 20 });
    await manager.startAutoSshTunnel();
    expect(spawned).toHaveLength(2);
    expect(spawned[1].relay).toBe(false);
    await manager.cleanupAutoSshTunnel();
  });

  test("a connection failure keeps the relay for the next attempt", async () => {
    const { manager, spawned } = relayManager();
    const starting = manager.startAutoSshTunnel();
    await waitUntil(() => spawned.length === 1);
    spawned[0].exited.resolve(255);
    await expect(starting).rejects.toBeInstanceOf(SshTunnelError);
    expect(spawned).toHaveLength(1);

    const again = manager.startAutoSshTunnel();
    await waitUntil(() => spawned.length === 2);
    expect(spawned[1].relay).toBe(true);
    spawned[1].ready.resolve(true);
    await again;
    await manager.cleanupAutoSshTunnel();
  });

  test("a relay that exits later is left out of the reconnect", async () => {
    const { manager, spawned, exits } = relayManager();
    const starting = manager.startAutoSshTunnel();
    await waitUntil(() => spawned.length === 1);
    spawned[0].ready.resolve(true);
    await starting;
    spawned[0].exited.resolve(1);
    await waitUntil(() => exits.length === 1);

    await manager.startAutoSshTunnel();
    expect(spawned[1].relay).toBe(false);
    await manager.cleanupAutoSshTunnel();
  });

  test("forwards directly when the runtime does not ask for the relay", async () => {
    const { manager, spawned } = relayManager({ herdrRelay: false });
    await manager.startAutoSshTunnel();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].relay).toBe(false);
    expect(spawned[0].argv).toContain("-N");
    await manager.cleanupAutoSshTunnel();
  });
});
