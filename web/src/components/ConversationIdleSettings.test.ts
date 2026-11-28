import { expect, test } from "bun:test";
import type { AgentChatState } from "../../../shared/agentChat";
import { applyStateEvent } from "../agentChat";
import { conversationActivity } from "../agentChatOwnership";
import {
  idleStopLabel,
  idleStopOptions,
  permissionTimeoutLabel,
  permissionTimeoutOptions,
} from "./ConversationIdleSettings";

test("the idle stop choices read as durations, a custom value kept", () => {
  expect(idleStopLabel(0)).toBe("Never");
  expect(idleStopLabel(30)).toBe("After 30 minutes");
  expect(idleStopLabel(1)).toBe("After 1 minute");
  expect(idleStopLabel(60)).toBe("After 1 hour");
  expect(idleStopLabel(240)).toBe("After 4 hours");
  expect(idleStopOptions(30).map((option) => option.value)).toEqual([
    "0",
    "10",
    "15",
    "30",
    "60",
    "120",
    "240",
    "480",
  ]);
  expect(idleStopOptions(30).find((o) => o.value === "30")?.detail).toBe(
    "Default",
  );
  expect(idleStopOptions(45).map((option) => option.value)).toContain("45");
});

test("the permission timeout choices read as durations, 15 minutes the default", () => {
  expect(permissionTimeoutLabel(0)).toBe("Never");
  expect(permissionTimeoutLabel(30)).toBe("After 30 seconds");
  expect(permissionTimeoutLabel(60)).toBe("After 1 minute");
  expect(permissionTimeoutLabel(900)).toBe("After 15 minutes");
  expect(permissionTimeoutLabel(3600)).toBe("After 1 hour");
  expect(permissionTimeoutLabel(90)).toBe("After 90 seconds");
  const options = permissionTimeoutOptions(900);
  expect(options.find((o) => o.value === "900")?.detail).toBe("Default");
  expect(options[0]?.value).toBe("0");
  expect(permissionTimeoutOptions(45).map((o) => o.value)).toContain("45");
});

test("a waking conversation says so, and its sleep follows the bridge", () => {
  expect(conversationActivity("waking")).toBe("Waking Claude…");
  const state = {
    pane_id: "w1:p1",
    owner: "conversation",
    phase: "conversation",
    session_id: "s",
    cwd: "/",
    status: "stopped",
    tools_running: false,
    activity: null,
    queue: [],
    interrupted: null,
  } as AgentChatState;
  const asleep = applyStateEvent(state, {
    type: "asleep",
    asleep: { since: "2026-11-04T10:00:00.000Z" },
  });
  expect(asleep?.asleep).toEqual({ since: "2026-11-04T10:00:00.000Z" });
  expect(
    applyStateEvent(asleep, { type: "asleep", asleep: null })?.asleep,
  ).toBeNull();
});
