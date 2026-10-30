import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { GuiSettings } from "../config/gui-settings";
import type { HerdrClient } from "./herdr-client";
import { createSettingsRpcHandler } from "./settings-rpc";

test("idle stop: 30 minutes by default, a whole number from 0 (off) to a day", async () => {
  let settings: GuiSettings = {
    version: 1,
    repositories: {},
    workspace_auto_sync: {},
    custom: {},
    ui: {},
  };
  const messages: any[] = [];
  const handler = createSettingsRpcHandler({
    connectionId: "desk",
    readSettings: async () => settings,
    updateSettings: async (update) => {
      settings = await update(settings);
      return settings;
    },
    herdr: {} as HerdrClient,
    sshHost: () => undefined,
    readWorktreeHooks: async () => null,
    resolveWorkspaceGitRoot: async () => ({ workspace: {}, root: "/tmp" }),
    workspaceAutoSyncIsRunning: () => false,
    onWorkspaceAutoSyncSettingsChanged: () => {},
    safeSend: (_ws, payload) => {
      messages.push(JSON.parse(payload));
      return true;
    },
    markRpcError: () => {},
  });
  const call = (method: string, params: Record<string, unknown> = {}) =>
    handler(
      {} as ServerWebSocket<unknown>,
      "1",
      `settings.conversation.${method}`,
      params,
    );
  await call("get");
  expect(messages.at(-1).result).toEqual({ idle_stop_minutes: 30 });
  await call("update", { idle_stop_minutes: 0 });
  expect(messages.at(-1).result).toEqual({ idle_stop_minutes: 0 });
  expect(settings.conversation).toEqual({ idle_stop_minutes: 0 });
  await call("update", { idle_stop_minutes: 45 });
  expect(messages.at(-1).result).toEqual({ idle_stop_minutes: 45 });
  for (const params of [
    {},
    { idle_stop_minutes: -1 },
    { idle_stop_minutes: 2.5 },
    { idle_stop_minutes: "30" },
    { idle_stop_minutes: 24 * 60 + 1 },
    { idle_stop_minutes: 30, other: 1 },
  ]) {
    await call("update", params);
    expect(messages.at(-1).error.message).toMatch(
      /settings\.conversation\.update/,
    );
  }
  expect(settings.conversation).toEqual({ idle_stop_minutes: 45 });
});
