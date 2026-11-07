import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { DEFAULT_LIMIT_RESUME_MESSAGE } from "../../../shared/limitResume";
import type { GuiSettings } from "../config/gui-settings";
import type { HerdrClient } from "./herdr-client";
import { createSettingsRpcHandler } from "./settings-rpc";

test("usage limit resume: on, a minute after the reset, the message; each key checked", async () => {
  let settings: GuiSettings = {
    version: 1,
    repositories: {},
    workspace_auto_sync: {},
    custom: {},
    ui: {},
  };
  const messages: any[] = [];
  let changed = 0;
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
    onLimitResumeSettingsChanged: () => {
      changed += 1;
    },
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
      `settings.limit_resume.${method}`,
      params,
    );
  await call("get");
  expect(messages.at(-1).result).toEqual({
    enabled: true,
    message: DEFAULT_LIMIT_RESUME_MESSAGE,
    margin_seconds: 60,
  });
  await call("update", { enabled: false, margin_seconds: 120 });
  expect(messages.at(-1).result).toEqual({
    enabled: false,
    message: DEFAULT_LIMIT_RESUME_MESSAGE,
    margin_seconds: 120,
  });
  await call("update", { message: "  Go on.  " });
  expect(settings.limit_resume).toEqual({
    enabled: false,
    margin_seconds: 120,
    message: "Go on.",
  });
  expect(changed).toBe(2);
  for (const params of [
    { enabled: "yes" },
    { margin_seconds: -1 },
    { margin_seconds: 3601 },
    { margin_seconds: 1.5 },
    { message: "" },
    { message: "x".repeat(4001) },
    { other: true },
  ]) {
    await call("update", params);
    expect(messages.at(-1).error.message).toMatch(
      /settings\.limit_resume\.update/,
    );
  }
  expect(changed).toBe(2);
  expect(settings.limit_resume?.message).toBe("Go on.");
});
