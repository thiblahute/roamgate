import { expect, test } from "bun:test";
import { modeView, paneShownView } from "./agentChatOwnership";
import {
  boxSuspends,
  foregroundConversation,
  isSuspendKey,
  suspendConversation,
} from "./conversationSuspend";
import type { ConnectionClient } from "./api";

const key = (over: Partial<Parameters<typeof isSuspendKey>[0]> = {}) => ({
  key: "z",
  ctrlKey: true,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...over,
});

test("Ctrl+Z alone is the suspend key", () => {
  expect(isSuspendKey(key())).toBe(true);
  expect(isSuspendKey(key({ key: "Z" }))).toBe(true);
  expect(isSuspendKey(key({ shiftKey: true }))).toBe(false);
  expect(isSuspendKey(key({ metaKey: true }))).toBe(false);
  expect(isSuspendKey(key({ altKey: true }))).toBe(false);
  expect(isSuspendKey(key({ ctrlKey: false }))).toBe(false);
  expect(isSuspendKey(key({ key: "y" }))).toBe(false);
});

test("in the message box, Ctrl+Z undoes text, unless Vim's normal mode or a Mac", () => {
  expect(boxSuspends({ text: "", vimNormal: false, platform: "linux" })).toBe(
    true,
  );
  expect(
    boxSuspends({ text: "  \n", vimNormal: false, platform: "windows" }),
  ).toBe(true);
  expect(
    boxSuspends({ text: "draft", vimNormal: false, platform: "linux" }),
  ).toBe(false);
  expect(
    boxSuspends({ text: "draft", vimNormal: false, platform: "windows" }),
  ).toBe(false);
  // Vim's normal mode: undo is u, and Vim's Ctrl+Z suspends it.
  expect(
    boxSuspends({ text: "draft", vimNormal: true, platform: "linux" }),
  ).toBe(true);
  // A Mac undoes with Cmd+Z.
  expect(
    boxSuspends({ text: "draft", vimNormal: false, platform: "mac" }),
  ).toBe(true);
});

test("suspending asks for the terminal stopped, and the pane shows its terminal", async () => {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  let phase = "conversation";
  const client = {
    connectionId: "c1",
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push([method, params]);
      if (method === "agent_chat.handover") {
        phase = "terminal";
        return {
          ok: true,
          owner: "terminal",
          session_id: "s1",
          suspended: true,
        };
      }
      return { phase };
    },
  } as unknown as ConnectionClient;
  const result = await suspendConversation(client, "w1:p1", "Fix the build");
  expect(result).toMatchObject({ ok: true, suspended: true });
  expect(calls[0]).toEqual([
    "agent_chat.handover",
    {
      pane_id: "w1:p1",
      to: "terminal",
      suspend: true,
      title: "Fix the build",
    },
  ]);
  // One view per mode: the terminal, once the session is the terminal's.
  expect(modeView({ phase: "terminal" })).toBe("terminal");
  expect(
    paneShownView({
      agent: true,
      claude: true,
      chat: { state: { phase: "terminal" }, unavailable: false },
      stored: "chat",
      chosen: "chat",
    }).view,
  ).toBe("terminal");
  // And back with fg: the chat.
  expect(modeView({ phase: "conversation" })).toBe("chat");
});

test("the page's fg asks the bridge, and says why when it cannot", async () => {
  const client = {
    connectionId: "c1",
    call: async (method: string) => {
      if (method === "agent_chat.fg") throw new Error("unreachable");
      return null;
    },
  } as unknown as ConnectionClient;
  expect(await foregroundConversation(client, "w1:p1")).toEqual({
    ok: false,
    reason: "unreachable",
  });
});
