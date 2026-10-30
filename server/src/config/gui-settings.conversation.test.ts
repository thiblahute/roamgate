import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationIdleStopMinutes } from "./gui-settings";

const base = {
  version: 1 as const,
  repositories: {},
  workspace_auto_sync: {},
  custom: {},
  ui: {},
};

test("idle stop defaults to 30 minutes; bad values in the file are dropped", async () => {
  expect(conversationIdleStopMinutes(base)).toBe(30);
  expect(
    conversationIdleStopMinutes({
      ...base,
      conversation: { idle_stop_minutes: 0 },
    }),
  ).toBe(0);
  const home = await mkdtemp(join(tmpdir(), "roamgate-settings-"));
  const path = join(home, "settings.json");
  const source = JSON.stringify(import.meta.resolve("./gui-settings"));
  const read = async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { conversationIdleStopMinutes, updateGuiSettings } from ${source}; console.log(conversationIdleStopMinutes(await updateGuiSettings((s) => s)));`,
      ],
      {
        env: { ...process.env, HOME: home, ROAMGATE_SETTINGS_PATH: path },
        stdout: "pipe",
      },
    );
    const minutes = (await new Response(child.stdout).text()).trim();
    return { minutes, file: JSON.parse(await readFile(path, "utf8")) };
  };
  try {
    await writeFile(
      path,
      JSON.stringify({ version: 1, conversation: { idle_stop_minutes: 90 } }),
    );
    expect((await read()).minutes).toBe("90");
    await writeFile(
      path,
      JSON.stringify({ version: 1, conversation: { idle_stop_minutes: -5 } }),
    );
    const bad = await read();
    expect(bad.minutes).toBe("30");
    expect(bad.file.conversation?.idle_stop_minutes).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
