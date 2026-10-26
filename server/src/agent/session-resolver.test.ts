import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSessionFileAccess,
  localAgentSessionFiles,
} from "./session-file-access";
import {
  createAgentSessionResolverContext,
  resolveAgentSession,
} from "./session-resolver";

const tempDirectories: string[] = [];
const originalPiDirectory = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
  if (originalPiDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiDirectory;
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("agent session resolver context", () => {
  test("keeps session path caches isolated per connection context", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-gui-session-cache-"));
    tempDirectories.push(root);
    process.env.PI_CODING_AGENT_DIR = root;
    const sessionId = `session-${crypto.randomUUID()}`;
    const sessionDirectory = join(root, "sessions", "project");
    const sessionPath = join(sessionDirectory, `${sessionId}.jsonl`);
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(sessionPath, "{}\n");
    const herdrCall = async () => ({
      agent: {
        agent: "pi",
        workspace_id: "w1",
        tab_id: "t1",
        cwd: "/repo",
        agent_session: {
          source: "herdr:pi",
          agent: "pi",
          kind: "id",
          value: sessionId,
        },
      },
    });
    const first = createAgentSessionResolverContext();
    const second = createAgentSessionResolverContext();

    const firstResult = await resolveAgentSession(
      { pane_id: "p1" },
      herdrCall,
      localAgentSessionFiles,
      first,
    );
    expect(firstResult.path).toBe(sessionPath);
    expect(first.pathCache.get(`pi:${sessionId}`)).toBe(sessionPath);
    expect(second.pathCache.size).toBe(0);

    const secondResult = await resolveAgentSession(
      { pane_id: "p1" },
      herdrCall,
      localAgentSessionFiles,
      second,
    );
    expect(secondResult.path).toBe(sessionPath);
    expect(second.pathCache.get(`pi:${sessionId}`)).toBe(sessionPath);
    expect(first.pathCache).not.toBe(second.pathCache);
  });
});

describe("session search", () => {
  test("follows a session folder that is a link", async () => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-session-link-"));
    tempDirectories.push(root);
    process.env.PI_CODING_AGENT_DIR = root;
    const sessionId = `session-${crypto.randomUUID()}`;
    const kept = join(root, "kept", "project");
    await mkdir(kept, { recursive: true });
    await mkdir(join(root, "sessions"));
    await symlink(kept, join(root, "sessions", "project"));
    // A link to itself: skipped, not followed forever.
    await symlink(
      join(root, "sessions", "loop"),
      join(root, "sessions", "loop"),
    );
    await writeFile(join(kept, `${sessionId}.jsonl`), "{}\n");
    const result = await resolveAgentSession(
      { pane_id: "p1" },
      async () => ({
        agent: {
          agent: "pi",
          workspace_id: "w1",
          tab_id: "t1",
          cwd: "/repo",
          agent_session: {
            source: "herdr:pi",
            agent: "pi",
            kind: "id",
            value: sessionId,
          },
        },
      }),
      localAgentSessionFiles,
      createAgentSessionResolverContext(),
    );
    expect(result.path).toBe(
      join(root, "sessions", "project", `${sessionId}.jsonl`),
    );
  });
});

describe("Claude transcripts", () => {
  const id = "69775585-98cc-4cb1-9275-4956ebb07add";

  test("a resumed session is followed to the transcript it went on in", async () => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-claude-successor-"));
    tempDirectories.push(root);
    const reported = join(root, `${id}.jsonl`);
    const resumed = join(root, "b6a8466c-831a-4cf8-9659-d65d02fa7db3.jsonl");
    const other = join(root, "0e3b0c44-298f-4c14-9a3b-2c1d9e5f0a11.jsonl");
    await writeFile(reported, `{"sessionId":"${id}"}\n`);
    await writeFile(resumed, `{"sessionId":"${id}"}\n{"sessionId":"b6a8"}\n`);
    await writeFile(other, '{"sessionId":"0e3b"}\n');
    const old = new Date(Date.now() - 60_000);
    await utimes(reported, old, old);

    expect(await localAgentSessionFiles.findClaudeSuccessor(reported, id)).toBe(
      resumed,
    );
    expect(
      await localAgentSessionFiles.findClaudeSuccessor(resumed, id),
    ).toBeNull();
  });

  test("a remote lookup is kept and its successor checked at most every 30s", async () => {
    const calls = { find: 0, successor: 0 };
    const reported = "/remote/p/old.jsonl";
    const resumed = "/remote/p/new.jsonl";
    let successor: string | null = null;
    const files = {
      remote: true,
      async statFile(path: string) {
        return { path, mtimeMs: 1, size: 1 };
      },
      async findClaudeSessionById() {
        calls.find += 1;
        return { path: reported, mtimeMs: 1, size: 1 };
      },
      async findClaudeSuccessor() {
        calls.successor += 1;
        return successor;
      },
    } as unknown as AgentSessionFileAccess;
    const herdrCall = async () => ({
      agent: {
        agent: "claude",
        workspace_id: "w1",
        tab_id: "t1",
        cwd: "/repo",
        agent_session: { agent: "claude", kind: "id", value: id },
      },
    });
    const context = createAgentSessionResolverContext();
    const read = () =>
      resolveAgentSession({ pane_id: "p1" }, herdrCall, files, context);

    expect((await read()).path).toBe(reported);
    successor = resumed;
    expect((await read()).path).toBe(reported);
    expect(calls).toEqual({ find: 1, successor: 1 });

    context.successorChecked.clear();
    expect((await read()).path).toBe(resumed);
    expect((await read()).path).toBe(resumed);
    expect(calls).toEqual({ find: 1, successor: 2 });
  });
});
