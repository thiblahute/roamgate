import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localAgentSessionFiles } from "./session-file-access";
import { runVectors } from "../../../contract/vectors/vectors";
import * as sessionResolver from "./session-resolver";
import * as sessionFileAccess from "./session-file-access";

const id = "00000000-0000-4000-8000-000000000001";
const previousHome = process.env.CODEX_HOME;
const roots: string[] = [];

afterEach(async () => {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "codex session's-"));
  roots.push(root);
  process.env.CODEX_HOME = root;
  const directory = join(root, "sessions", "2026", "10", "20");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-2026-10-20T20-19-45-${id}.jsonl`);
  await writeFile(
    path,
    JSON.stringify({ type: "session_meta", payload: { id, cwd: "/repo" } }) +
      "\n",
  );
  return { root, path };
}

describe("Codex transcript lookup", () => {
  test("uses CODEX_HOME, exact IDs and archived sessions", async () => {
    const { root, path } = await setup();
    expect((await localAgentSessionFiles.findCodexSessionById(id))?.path).toBe(
      path,
    );
    await expect(
      localAgentSessionFiles.findCodexSessionById(id.slice(0, 8)),
    ).rejects.toThrow("complete");
    await rm(path);
    const archive = join(root, "archived_sessions");
    await mkdir(archive);
    const archived = join(archive, `rollout-${id}.jsonl`);
    await writeFile(archived, "{}\n");
    expect((await localAgentSessionFiles.findCodexSessionById(id))?.path).toBe(
      archived,
    );
    await writeFile(path, "{}\n");
    await expect(
      localAgentSessionFiles.findCodexSessionById(id),
    ).rejects.toThrow("Multiple");
  });
});

// The cases are contract/vectors/codex-session.json, the Rust side's too.
runVectors("codex-session", {
  "session-resolver": sessionResolver,
  "session-file-access": sessionFileAccess,
});
