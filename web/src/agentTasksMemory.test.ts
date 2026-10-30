import { afterEach, describe, expect, test } from "bun:test";
import {
  backPlace,
  forgetPlaces,
  openingPlace,
  placeKey,
  readScroll,
  restoredAgent,
  scrollTarget,
  sheetPlace,
  taskPlace,
} from "./agentTasksMemory";

afterEach(forgetPlaces);

describe("places", () => {
  test("are kept per connection, pane and session", () => {
    const place = sheetPlace(placeKey("c1", "p1", "s1"));
    place.taskId = "t1";
    expect(sheetPlace(placeKey("c1", "p1", "s1")).taskId).toBe("t1");
    expect(sheetPlace(placeKey("c1", "p1", "s2")).taskId).toBeNull();
    expect(sheetPlace(placeKey("c2", "p1", "s1")).taskId).toBeNull();
    expect(sheetPlace(placeKey("c1", "p2", "s1")).taskId).toBeNull();
  });

  test("the oldest left go first", () => {
    sheetPlace("first").taskId = "kept?";
    for (let index = 0; index < 60; index++) sheetPlace(`other ${index}`);
    expect(sheetPlace("first").taskId).toBeNull();
  });

  test("a task's place is made once, then kept", () => {
    const place = sheetPlace("k");
    const own = taskPlace(place, "t1");
    own.cursor = "agent:a";
    expect(taskPlace(place, "t1").cursor).toBe("agent:a");
    expect(taskPlace(place, "t2").cursor).toBeNull();
  });
});

describe("opening", () => {
  const ids = ["t1", "t2", "t3"];

  test("comes back to the task left, or the list", () => {
    expect(openingPlace({ taskId: "t2", returnTo: null }, ids, null)).toEqual({
      taskId: "t2",
      returnTo: null,
    });
    expect(openingPlace({ taskId: null, returnTo: null }, ids, null)).toEqual({
      taskId: null,
      returnTo: null,
    });
  });

  test("a task gone gives the list", () => {
    expect(openingPlace({ taskId: "gone", returnTo: "t1" }, ids, null)).toEqual(
      { taskId: null, returnTo: null },
    );
  });

  test("a task asked for opens over the place left", () => {
    expect(openingPlace({ taskId: "t2", returnTo: null }, ids, "t3")).toEqual({
      taskId: "t3",
      returnTo: "t2",
    });
    expect(openingPlace({ taskId: "t3", returnTo: null }, ids, "t3")).toEqual({
      taskId: "t3",
      returnTo: null,
    });
    expect(openingPlace({ taskId: null, returnTo: null }, ids, "t3")).toEqual({
      taskId: "t3",
      returnTo: null,
    });
    // One gone opens the place left.
    expect(openingPlace({ taskId: "t2", returnTo: null }, ids, "gone")).toEqual(
      { taskId: "t2", returnTo: null },
    );
  });

  test("a task opened over another keeps it beneath when reopened", () => {
    expect(openingPlace({ taskId: "t3", returnTo: "t2" }, ids, null)).toEqual({
      taskId: "t3",
      returnTo: "t2",
    });
    expect(openingPlace({ taskId: "t3", returnTo: "gone" }, ids, null)).toEqual(
      { taskId: "t3", returnTo: null },
    );
  });

  test("back goes to the place beneath, then the list", () => {
    expect(backPlace({ taskId: "t3", returnTo: "t2" }, ids)).toEqual({
      taskId: "t2",
      returnTo: null,
    });
    expect(backPlace({ taskId: "t2", returnTo: null }, ids)).toEqual({
      taskId: null,
      returnTo: null,
    });
    expect(backPlace({ taskId: "t3", returnTo: "gone" }, ids)).toEqual({
      taskId: null,
      returnTo: null,
    });
  });
});

test("a workflow agent comes back unless the workflow lost it", () => {
  const workflow = {
    phases: [
      { title: "", agents: [{ agentId: "a1", label: "a", state: "done" }] },
    ],
  } as const;
  const view = {
    phases: workflow.phases.map((phase) => ({
      ...phase,
      agents: [...phase.agents],
    })),
  };
  expect(restoredAgent("a1", view)).toBe("a1");
  expect(restoredAgent("gone", view)).toBeNull();
  // Not read yet: the server says.
  expect(restoredAgent("a1", undefined)).toBe("a1");
  expect(restoredAgent(null, view)).toBeNull();
});

describe("scroll", () => {
  test("reads whether it was at the end", () => {
    expect(
      readScroll({ scrollTop: 590, scrollHeight: 1000, clientHeight: 400 }),
    ).toEqual({ top: 590, atEnd: true });
    expect(
      readScroll({ scrollTop: 100, scrollHeight: 1000, clientHeight: 400 }),
    ).toEqual({ top: 100, atEnd: false });
  });

  test("goes back to the end, which may have moved, or the same place", () => {
    const grown = { scrollTop: 0, scrollHeight: 1500, clientHeight: 400 };
    expect(scrollTarget({ top: 600, atEnd: true }, grown)).toBe(1100);
    expect(scrollTarget({ top: 300, atEnd: false }, grown)).toBe(300);
    const shrunk = { scrollTop: 0, scrollHeight: 500, clientHeight: 400 };
    expect(scrollTarget({ top: 300, atEnd: false }, shrunk)).toBe(100);
    expect(scrollTarget({ top: -5, atEnd: false }, shrunk)).toBe(0);
  });
});
