import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localAgentSessionFiles,
  useArchivedSessionFiles,
} from "../agent/session-file-access";
import { runSync } from "./engine";
import { createArchivedSessionReader } from "./file-access";
import { normalizeArchiveSettings } from "./settings";

let root: string;
const SESSION = "bbbbbbbb-1111-2222-3333-444444444444";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "roamgate-archive-fa-"));
});
afterEach(() => {
  useArchivedSessionFiles(null);
  rmSync(root, { recursive: true, force: true });
});

test("a transcript the agent deleted is read from the archive", async () => {
  const settings = normalizeArchiveSettings({ host: "testhost" });
  const runtime = {
    homeDir: root,
    platform: "linux",
    env: {},
    dataDir: join(root, "data"),
  };
  const dir = join(root, ".claude", "projects", "-Users-t-proj");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${SESSION}.jsonl`);
  const body = `${JSON.stringify({ type: "user", message: { content: "hello" } })}\n${JSON.stringify({ type: "assistant", message: { content: "world" } })}\n`;
  writeFileSync(path, body);
  await runSync({
    settings,
    runtime,
    archiveDir: join(root, "archive"),
    localOnly: true,
    log: () => {},
  });
  rmSync(path);
  expect(await localAgentSessionFiles.statFile(path)).toBeNull();
  useArchivedSessionFiles(
    createArchivedSessionReader({
      settings: async () => settings,
      archiveDir: () => join(root, "archive"),
      runtime: () => runtime,
    }),
  );
  const file = await localAgentSessionFiles.statFile(path);
  expect(file?.size).toBe(Buffer.byteLength(body));
  expect(await localAgentSessionFiles.readText(path)).toBe(body);
  expect(
    Buffer.from(
      (await localAgentSessionFiles.readRange?.(path, 2, 9)) ?? [],
    ).toString(),
  ).toBe(body.slice(2, 9));
  expect(
    Buffer.from(await localAgentSessionFiles.readTail(path, 5)).toString(),
  ).toBe(body.slice(-5));
  expect(
    await localAgentSessionFiles.statFile(join(dir, "never-archived.jsonl")),
  ).toBeNull();
  expect(
    readFileSync(join(root, "archive", "index.sqlite")).length,
  ).toBeGreaterThan(0);
});
