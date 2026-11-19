import { expect, test } from "bun:test";
import { type AgentTask, nextAgentTasksState } from "./agentTasks";

const task = (id: string): AgentTask => ({
  id,
  kind: "command",
  title: id,
  status: "running",
});
const shown = {
  tasks: [task("theirs")],
  runningNow: [],
  session: "other-session",
  loaded: true,
};

test("a partial read of another session never keeps the tasks shown", () => {
  const next = nextAgentTasksState(shown, {
    tasks: [task("mine")],
    session: "this-session",
    partial: true,
  });
  expect(next.session).toBe("this-session");
  expect(next.tasks.map((each) => each.id)).toEqual(["mine"]);
});

test("a partial read of the same session keeps its tasks, not what runs now", () => {
  const next = nextAgentTasksState(shown, {
    tasks: [],
    running_now: [{ ...task("fg"), foreground: true }],
    session: "other-session",
    partial: true,
  });
  expect(next.tasks.map((each) => each.id)).toEqual(["theirs"]);
  expect(next.runningNow.map((each) => each.id)).toEqual(["fg"]);
});
