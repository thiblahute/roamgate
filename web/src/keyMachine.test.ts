import { expect, test } from "bun:test";
import {
  createKeyMachine,
  resetKeyMachines,
  runKeyCommand,
} from "./keyMachine";

/*
 * The one key machine every host runs (plan: review into the inspector,
 * phase 3): the review pane, the inspector (gt / gT), Changes' cursor and
 * the lists of threads.
 */

const feedAll = (
  machine: ReturnType<typeof createKeyMachine>,
  keys: string[],
) => keys.map((key) => machine.feed(key)).pop()!;

test("counts and g / z / d sequences, a bare modifier in between waits", () => {
  const machine = createKeyMachine();
  expect(feedAll(machine, ["1", "2", "G"])).toMatchObject({
    type: "command",
    key: "G",
    count: 12,
  });
  expect(feedAll(machine, ["g", "Shift", "N"])).toMatchObject({
    key: "gN",
    count: null,
  });
  expect(feedAll(machine, ["3", "z", "z"])).toMatchObject({
    key: "zz",
    count: 3,
  });
  // An unknown sequence reads its second key alone.
  expect(feedAll(machine, ["g", "j"])).toMatchObject({ key: "j" });
  expect(machine.feed("g").type).toBe("wait");
  expect(machine.state()).toEqual({ count: "", pending: "g" });
  machine.reset();
  expect(machine.state()).toEqual({ count: "", pending: "" });
});

test("a host's own sequences: gt and gT are the inspector's, nobody else's", () => {
  const inspector = createKeyMachine(["gt", "gT"]);
  expect(feedAll(inspector, ["2", "g", "t"])).toMatchObject({
    key: "gt",
    count: 2,
  });
  expect(feedAll(createKeyMachine(), ["g", "t"])).toMatchObject({ key: "t" });
});

test("a sequence the host has no meaning for is its second key alone; resetting forgets every machine's", () => {
  const done: string[] = [];
  const handle = (key: string) => {
    if (key === "gc" || key === "x") return false;
    done.push(key);
    return true;
  };
  expect(runKeyCommand({ key: "gc", count: null }, handle)).toBe(true);
  expect(runKeyCommand({ key: "x", count: null }, handle)).toBe(false);
  expect(runKeyCommand({ key: "Enter", count: null }, handle)).toBe(true);
  expect(done).toEqual(["c", "Enter"]);

  const view = createKeyMachine();
  expect(view.feed("g").type).toBe("wait");
  // The inspector took gt: the view's g is dropped, g g is not gg.
  resetKeyMachines();
  expect(view.feed("g").type).toBe("wait");
  expect(view.feed("g")).toMatchObject({ key: "gg" });
});
