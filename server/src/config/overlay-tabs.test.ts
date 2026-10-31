import { describe, expect, test } from "bun:test";
import { overlayTabIdsIn } from "./overlay-tabs";

describe("overlayTabIdsIn", () => {
  test("reads the connection's overlay tabs from the interface setting", () => {
    const ui = {
      overlayTabs: {
        version: 1,
        connections: {
          local: { w1: "w1:t2", w2: "w2:t1" },
          other: { w1: "x" },
        },
      },
    };
    expect([...overlayTabIdsIn(ui, "local")].sort()).toEqual([
      "w1:t2",
      "w2:t1",
    ]);
    expect(overlayTabIdsIn(ui, "missing").size).toBe(0);
  });

  test("a malformed value hides nothing", () => {
    expect(overlayTabIdsIn({}, "local").size).toBe(0);
    expect(overlayTabIdsIn({ overlayTabs: "x" }, "local").size).toBe(0);
    expect(
      overlayTabIdsIn(
        { overlayTabs: { version: 1, connections: { local: ["w1:t2"] } } },
        "local",
      ).size,
    ).toBe(0);
    expect(
      overlayTabIdsIn(
        { overlayTabs: { version: 1, connections: { local: { w1: 3 } } } },
        "local",
      ).size,
    ).toBe(0);
  });
});
