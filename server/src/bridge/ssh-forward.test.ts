/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import {
  chooseLocalPort,
  createSshForwards,
  FORWARD_BIND_HOST,
  forwardId,
  sshForwardArgv,
  validateForwardPort,
  type ForwardProcess,
} from "./ssh-forward";

function deferredProcess() {
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    exit = resolve;
  });
  const killed: number[] = [];
  const proc: ForwardProcess = {
    exited,
    stderr: Promise.resolve("bind: Address already in use"),
    kill: (signal) => killed.push(signal ?? 0),
  };
  return { proc, exit, killed };
}

describe("forward argv", () => {
  test("binds loopback locally and resolves localhost on the far host", () => {
    const argv = sshForwardArgv("user@host", 5173, 3000);
    expect(argv).toContain("-N");
    expect(argv).toContain("-L");
    // The far side of the pair is the remote's own localhost: that is where a
    // dev server printing http://localhost:3000 is actually listening.
    expect(argv).toContain(`${FORWARD_BIND_HOST}:5173:localhost:3000`);
    // A refused bind must exit rather than run on without the forward.
    expect(argv).toContain("ExitOnForwardFailure=yes");
    expect(argv[argv.length - 1]).toBe("user@host");
  });

  test("refuses a destination that is not a plain ssh target", () => {
    expect(() => sshForwardArgv("-oProxyCommand=evil", 1, 2)).toThrow();
  });
});

describe("port handling", () => {
  test("rejects anything outside a usable port", () => {
    expect(validateForwardPort(3000)).toBe(3000);
    expect(validateForwardPort("3000")).toBe(3000);
    for (const bad of [0, -1, 65536, 1.5, "http", null, undefined]) {
      expect(() => validateForwardPort(bad)).toThrow();
    }
  });

  test("prefers the remote's own number, then walks upwards", () => {
    expect(chooseLocalPort(3000, () => true)).toBe(3000);
    // The address in the terminal output is the address the user types, so
    // matching numbers matter more than picking anything free.
    expect(chooseLocalPort(3000, (port) => port >= 3002)).toBe(3002);
  });

  test("gives up rather than binding something wildly unrelated", () => {
    expect(() => chooseLocalPort(3000, () => false, 4)).toThrow(
      /No free local port/,
    );
  });
});

describe("forward supervisor", () => {
  test("reports a forward only once it has survived startup", () => {
    const { proc } = deferredProcess();
    const forwards = createSshForwards({
      spawn: () => proc,
      isPortFree: () => true,
    });
    const record = forwards.open({
      connectionId: "desktop",
      destination: "user@desktop",
      remotePort: 5173,
    });

    expect(record).toMatchObject({
      id: forwardId("desktop", 5173),
      localPort: 5173,
      state: "starting",
    });
    forwards.markOpen(record.id);
    expect(forwards.list()[0].state).toBe("open");
  });

  test("a refused bind fails that forward alone, with ssh's reason", async () => {
    const first = deferredProcess();
    const second = deferredProcess();
    const spawned: ForwardProcess[] = [first.proc, second.proc];
    const forwards = createSshForwards({
      spawn: () => spawned.shift()!,
      isPortFree: () => true,
    });
    const changes: number[] = [];
    forwards.onChange((list) => changes.push(list.length));

    const a = forwards.open({
      connectionId: "desktop",
      destination: "user@desktop",
      remotePort: 5173,
    });
    const b = forwards.open({
      connectionId: "desktop",
      destination: "user@desktop",
      remotePort: 3000,
    });
    first.exit(255);
    // The exit handler awaits ssh's stderr before classifying, so let the
    // macrotask queue drain rather than guessing a microtask count.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const byId = new Map(forwards.list().map((r) => [r.id, r]));
    expect(byId.get(a.id)?.state).toBe("failed");
    expect(byId.get(a.id)?.error).toBeTruthy();
    // The sibling keeps running: one process each is the point.
    expect(byId.get(b.id)?.state).not.toBe("failed");
    expect(changes.length).toBeGreaterThan(0);
  });

  test("a second request for the same port reuses the live forward", () => {
    const { proc } = deferredProcess();
    let spawns = 0;
    const forwards = createSshForwards({
      spawn: () => {
        spawns++;
        return proc;
      },
      isPortFree: () => true,
    });
    const request = {
      connectionId: "desktop",
      destination: "user@desktop",
      remotePort: 5173,
    };

    const first = forwards.open(request);
    const again = forwards.open(request);
    expect(spawns).toBe(1);
    expect(again.id).toBe(first.id);
    expect(forwards.list()).toHaveLength(1);
  });

  test("two forwards never land on the same local port", () => {
    const procs = [deferredProcess().proc, deferredProcess().proc];
    const forwards = createSshForwards({
      spawn: () => procs.shift()!,
      isPortFree: () => true,
    });
    forwards.open({
      connectionId: "a",
      destination: "user@a",
      remotePort: 5173,
    });
    const second = forwards.open({
      connectionId: "b",
      destination: "user@b",
      remotePort: 5173,
    });
    // Same remote number on two connections: the second has to move.
    expect(second.localPort).toBe(5174);
  });

  test("closing a connection kills its forwards and leaves others alone", () => {
    const desktop = deferredProcess();
    const laptop = deferredProcess();
    const procs = [desktop.proc, laptop.proc];
    const forwards = createSshForwards({
      spawn: () => procs.shift()!,
      isPortFree: () => true,
    });
    forwards.open({
      connectionId: "desktop",
      destination: "user@desktop",
      remotePort: 5173,
    });
    forwards.open({
      connectionId: "laptop",
      destination: "user@laptop",
      remotePort: 8080,
    });

    forwards.closeConnection("desktop");
    expect(desktop.killed).toHaveLength(1);
    expect(laptop.killed).toHaveLength(0);
    expect(forwards.list().map((r) => r.connectionId)).toEqual(["laptop"]);
  });
});
