import { expect, test } from "bun:test";
import {
  isTasksCommand,
  onAgentTasksRequest,
  requestAgentTasks,
} from "./agentTasksOpen";

test("/tasks alone is the tasks command", () => {
  expect(isTasksCommand("/tasks")).toBe(true);
  expect(isTasksCommand("  /tasks \n")).toBe(true);
  expect(isTasksCommand("/tasks list")).toBe(false);
  expect(isTasksCommand("/task")).toBe(false);
  expect(isTasksCommand("show /tasks")).toBe(false);
});

test("a request reaches the views of its pane only, while they listen", () => {
  const calls: string[] = [];
  expect(requestAgentTasks("p1")).toBe(false);
  const stopChat = onAgentTasksRequest("p1", () => calls.push("chat"));
  const stopOther = onAgentTasksRequest("p2", () => calls.push("other"));
  expect(requestAgentTasks("p1")).toBe(true);
  expect(calls).toEqual(["chat"]);
  stopChat();
  expect(requestAgentTasks("p1")).toBe(false);
  expect(requestAgentTasks("p2")).toBe(true);
  expect(calls).toEqual(["chat", "other"]);
  stopOther();
  expect(requestAgentTasks("p2")).toBe(false);
});
