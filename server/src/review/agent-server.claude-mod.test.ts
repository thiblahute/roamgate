import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { createClaudeModHub } from "../agent/claude-mod";
import { CLAUDE_MOD_MARKETPLACE_DIR } from "../agent/claude-mod-plugin";
import { createModClient } from "../../claude-mod/hooks/client";
import { createReviewAgentServer } from "./agent-server";
import { createReviewService } from "./service";
import { openReviewStorage } from "./storage";

/**
 * The Claude mod's client against the real review socket: the protocol end
 * to end, with only the engine faked.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function temp(prefix: string) {
  const path = mkdtempSync(join(realpathSync("/tmp"), prefix));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function setup() {
  const dir = temp("rg-mod-");
  const home = temp("rg-modh-");
  const hub = createClaudeModHub({ file: null, sweepMs: 3_600_000 });
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
  });
  const agent = createReviewAgentServer({
    service,
    directory: dir,
    home,
    claudeMod: hub,
    connections: () => [
      {
        id: "local",
        herdrSocketPath: "/herdr.sock",
        readRoot: async () => "/repo",
        readDefaultBase: async () => "origin/main",
      },
    ],
  });
  cleanups.push(() => {
    hub.dispose();
    agent.stop();
    service.close();
  });
  agent.installLocal();
  const socket = join(home, ".cache/roamgate/review.sock");
  return { hub, home, socket };
}

/** The mod's client, its engine faked: submits are recorded. */
function mod(socket: string, client: string, herdrSocket = "/herdr.sock") {
  const submitted: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const instance = createModClient({
    client,
    identity: {
      pane: "w1-2",
      workspace: "w1",
      herdr_socket: herdrSocket,
      session: "aaaaaaaa-0000-4000-8000-000000000001",
      cwd: "/work",
      claude: "2.1.319",
    },
    host: {
      async request(command, body) {
        const response = await fetch(`http://roamgate/v1/${command}`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          unix: socket,
        } as RequestInit);
        const parsed = (await response.json()) as Record<string, unknown>;
        if (!response.ok) throw new Error(String(parsed.error));
        return parsed;
      },
      socketExists: async () => existsSync(socket),
      async submit(text) {
        submitted.push(text);
        return "";
      },
      after(ms, fn) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          fn();
        }, ms);
        timers.add(timer);
        return {
          cancel() {
            clearTimeout(timer);
            timers.delete(timer);
          },
        };
      },
    },
  });
  cleanups.push(() => {
    instance.stop("test");
    for (const timer of timers) clearTimeout(timer);
  });
  return { instance, submitted };
}

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

test("Roamgate writes the mod's marketplace beside the review client", () => {
  const { home } = setup();
  const base = join(home, CLAUDE_MOD_MARKETPLACE_DIR);
  const marketplace = JSON.parse(
    readFileSync(join(base, ".claude-plugin/marketplace.json"), "utf8"),
  );
  expect(marketplace.plugins[0]).toMatchObject({
    name: "roamgate",
    source: "./roamgate",
  });
  expect(
    readFileSync(join(base, "roamgate/hooks/register.ts"), "utf8"),
  ).toContain("$.prompt.submit");
  expect(existsSync(join(base, "roamgate/hooks/client.ts"))).toBe(true);
});

test("a message reaches the mod over the socket, once, and leaves the inbox", async () => {
  const { hub, socket } = setup();
  const { instance, submitted } = mod(socket, "c1");
  instance.start();
  await until(() => hub.live("local", "w1-2"));
  expect(hub.pane("local", "w1-2")).toMatchObject({
    session_id: "aaaaaaaa-0000-4000-8000-000000000001",
    claude: "2.1.319",
    status: "idle",
  });
  expect(hub.deliver("local", "w1-2", "A comment from me", "review")).toEqual({
    id: 1,
  });
  await until(() => hub.waiting("local", "w1-2") === 0);
  expect(submitted).toEqual(["A comment from me"]);

  instance.report({ type: "turn_start" });
  await until(() => hub.pane("local", "w1-2")?.status === "working");
  instance.report({
    type: "turn_complete",
    reason: "answer",
    aborted: false,
    model: "claude-haiku-5-5",
    context: { percent: 3 },
    rate_limits: [{ kind: "five_hour", percent_used: 11 }],
  });
  await until(() => hub.pane("local", "w1-2")?.status === "idle");
  expect(hub.pane("local", "w1-2")?.usage?.model).toBe("claude-haiku-5-5");

  instance.stop("prompt_input_exit");
  await until(() => !hub.live("local", "w1-2"));
});

test("a mod whose pane is on a Herdr server Roamgate does not serve gets nothing", async () => {
  const { hub, socket } = setup();
  const { instance } = mod(socket, "c1", "/elsewhere/herdr.sock");
  instance.start();
  await Bun.sleep(200);
  expect(hub.live("local", "w1-2")).toBe(false);
});

test("the mod endpoints refuse a request from no pane", async () => {
  const { socket } = setup();
  const response = await fetch("http://roamgate/v1/mod_poll", {
    method: "POST",
    body: JSON.stringify({ client: "c1", protocol: 1 }),
    unix: socket,
  } as RequestInit);
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: string }).error).toContain(
    "inside a Herdr pane",
  );
});
