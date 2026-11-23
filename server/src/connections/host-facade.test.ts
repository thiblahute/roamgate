import { afterEach, describe, expect, test } from "bun:test";
import { sshCommandArgv, sshReadCommandArgv } from "../bridge/ssh-command";
import { annotateSshArgv } from "../bridge/ssh-metrics";
import {
  holdSshSession,
  isSshBackgroundShed,
  runInSshLane,
  runSshCommand,
  setSshCommandFacade,
} from "../bridge/ssh-sessions";
import {
  RemoteConnections,
  RemoteHerdrClient,
  SwitchingConnectionManager,
  sshCommandFacade,
} from "./host-facade";
import { ConnectionManager, type ConnectionRuntime } from "./manager";
import type { ConnectionProfileListItem } from "./profile-service";

type Call = { op: string; params: any };

function recorder(answer: (op: string, params: any) => unknown = () => ({})) {
  const calls: Call[] = [];
  const hostCall = async (op: string, params: unknown) => {
    calls.push({ op, params });
    return answer(op, params);
  };
  return { calls, hostCall };
}

afterEach(() => setSshCommandFacade(null));

describe("RemoteHerdrClient", () => {
  test("calls go to the core's client of the generation", async () => {
    const { calls, hostCall } = recorder(() => ({ panes: [] }));
    const herdr = new RemoteHerdrClient(hostCall, "work", 7);
    expect(
      await herdr.call("pane.list", { workspace_id: "w" }, 5000, undefined, {
        fresh: true,
      }),
    ).toEqual({ panes: [] });
    await herdr.ping();
    expect(calls).toEqual([
      {
        op: "herdr_call",
        params: {
          connection_id: "work",
          generation: 7,
          method: "pane.list",
          params: { workspace_id: "w" },
          timeout_ms: 5000,
          fresh: true,
        },
      },
      {
        op: "herdr_call",
        params: {
          connection_id: "work",
          generation: 7,
          method: "ping",
          params: {},
          timeout_ms: 5000,
          fresh: false,
        },
      },
    ]);
  });

  test("a failing check before sending sends nothing", async () => {
    const { calls, hostCall } = recorder();
    const herdr = new RemoteHerdrClient(hostCall, "work", 1);
    await expect(
      herdr.call("tab.close", {}, 5000, () => {
        throw new Error("connection changed");
      }),
    ).rejects.toThrow("connection changed");
    expect(calls).toEqual([]);
    expect(() => herdr.subscribe()).toThrow("held by the Rust core");
  });
});

describe("SSH commands through the core", () => {
  test("a built host command runs there with its input, lane and connection", async () => {
    const { calls, hostCall } = recorder(() => ({
      code: 0,
      stdout_b64: Buffer.from("out\n").toString("base64"),
      stderr: "",
    }));
    setSshCommandFacade(sshCommandFacade(hostCall));
    const argv = annotateSshArgv(
      sshReadCommandArgv("devbox", "git status", ["-p", "22"], "git.status"),
      { connection: "work" },
    );
    let spawned = false;
    const result = await runInSshLane("background", () =>
      runSshCommand(
        argv,
        async () => {
          spawned = true;
          return { code: 1, stdout: "", stderr: "" };
        },
        { timeoutMs: 4000 },
        { input: "in" },
      ),
    );
    expect(spawned).toBe(false);
    expect(result).toEqual({ code: 0, stdout: "out\n", stderr: "" });
    expect(calls).toEqual([
      {
        op: "run",
        params: {
          destination: "devbox",
          command: "git status",
          trusted_args: ["-p", "22"],
          tag: "git.status",
          read_only: true,
          connection_id: "work",
          timeout_ms: 4000,
          lane: "background",
          stdin_b64: Buffer.from("in").toString("base64"),
        },
      },
    ]);
  });

  test("binary output stays bytes, and a shed background command is one here too", async () => {
    let shed = false;
    const { hostCall } = recorder(() => {
      if (shed)
        throw Object.assign(new Error("64 waiting"), {
          code: "ssh_background_shed",
        });
      return { code: 0, stdout_b64: "AAEC", stderr: "" };
    });
    setSshCommandFacade(sshCommandFacade(hostCall));
    const binary = await runSshCommand(
      sshCommandArgv("devbox", "cat f"),
      async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: "" }),
      {},
      { binary: true },
    );
    expect(Buffer.isBuffer(binary.stdout)).toBe(true);
    expect([...(binary.stdout as Buffer)]).toEqual([0, 1, 2]);
    shed = true;
    const error = await runSshCommand(sshCommandArgv("devbox", "cat f"), () =>
      Promise.resolve({ code: 0, stderr: "" }),
    ).catch((error) => error);
    expect(isSshBackgroundShed(error)).toBe(true);
  });

  test("a command not built for a host still runs here", async () => {
    const { calls, hostCall } = recorder();
    setSshCommandFacade(sshCommandFacade(hostCall));
    const result = await runSshCommand(["git", "status"], async () => ({
      code: 0,
      stderr: "",
    }));
    expect(result.code).toBe(0);
    expect(calls).toEqual([]);
  });

  test("a held slot is the core's, released once", async () => {
    const { calls, hostCall } = recorder((op) =>
      op === "ssh_hold"
        ? {
            lease: 4,
            argv: ["ssh", "-S", "/m.ctl", "devbox", "x"],
            remaining_ms: 900,
          }
        : {},
    );
    setSshCommandFacade(sshCommandFacade(hostCall));
    const hold = await holdSshSession(
      sshCommandArgv("devbox", "tail -f log"),
      { timeoutMs: 1000 },
      { longLived: true },
    );
    expect(hold.argv).toEqual(["ssh", "-S", "/m.ctl", "devbox", "x"]);
    expect(hold.remainingMs).toBe(900);
    hold.release();
    hold.release();
    await Bun.sleep(0);
    expect(calls.map((call) => call.op)).toEqual(["ssh_hold", "ssh_release"]);
    expect(calls[0]!.params).toMatchObject({
      destination: "devbox",
      command: "tail -f log",
      long_lived: true,
      read_only: false,
      timeout_ms: 1000,
    });
    expect(calls[1]!.params).toEqual({ lease: 4 });
  });
});

type FakeRuntime = ConnectionRuntime & { stopped: number };

function fakeRuntime(id: string): FakeRuntime {
  const runtime: FakeRuntime = {
    identity: { id, label: id, source: "ssh-profile" },
    stopped: 0,
    startTransport: async () => undefined,
    startBackground: () => undefined,
    stop: async () => {
      runtime.stopped += 1;
    },
  };
  return runtime;
}

function item(
  id: string,
  state: ConnectionProfileListItem["state"],
  generation: number,
): ConnectionProfileListItem {
  return {
    id,
    label: id,
    source: "ssh-profile",
    is_default: id === "work",
    state,
    generation,
    type: "ssh",
    read_only: false,
  } as unknown as ConnectionProfileListItem;
}

describe("the core's connections", () => {
  test("a runtime is leased only while the core says its generation is ready", () => {
    const remote = new RemoteConnections<FakeRuntime>("work");
    remote.update({
      default_connection_id: "work",
      connections: [item("work", "connecting", 2)],
    });
    const runtime = fakeRuntime("work");
    remote.attach("work", 2, runtime);
    expect(remote.readyRuntimeLease("work")).toBeNull();
    remote.update({
      default_connection_id: "work",
      connections: [item("work", "ready", 2)],
    });
    const lease = remote.readyRuntimeLease("work")!;
    expect(lease.generation).toBe(2);
    expect(lease.runtime).toBe(runtime);
    expect(lease.isCurrent()).toBe(true);
    remote.update({
      default_connection_id: "work",
      connections: [item("work", "reconnecting", 3)],
    });
    expect(lease.isCurrent()).toBe(false);
    expect(remote.readyRuntimeLease("work")).toBeNull();
    expect(remote.detach("work", 3)).toBeNull();
    expect(remote.detach("work", 2)).toBe(runtime);
    expect(() => remote.status("gone")).toThrow("unknown connection: gone");
  });

  test("the switching manager reads whoever serves, and refuses Bun's operations meanwhile", async () => {
    const bun = new ConnectionManager<FakeRuntime>("local");
    bun.register({
      identity: { id: "local", label: "Local", source: "local-profile" },
      createRuntime: () => fakeRuntime("local"),
    });
    const manager = new SwitchingConnectionManager(bun);
    expect(manager.list().map((status) => status.id)).toEqual(["local"]);
    expect(manager.defaultId()).toBe("local");
    const remote = new RemoteConnections<FakeRuntime>("work");
    remote.update({
      default_connection_id: "work",
      connections: [item("work", "ready", 1)],
    });
    const runtime = fakeRuntime("work");
    remote.attach("work", 1, runtime);
    manager.useRemote(remote);
    expect(manager.defaultId()).toBe("work");
    expect(manager.list().map((status) => status.id)).toEqual(["work"]);
    expect(manager.defaultReadyRuntime()).toBe(runtime);
    expect(manager.has("local")).toBe(false);
    expect(() => manager.start("work")).toThrow("Rust core's");
    await manager.stopAll();
    expect(runtime.stopped).toBe(1);
    manager.useBun(bun);
    expect(manager.defaultId()).toBe("local");
  });
});
