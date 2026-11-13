import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ROAMGATE_TOOLS,
  roamgateTool,
  type ToolIdentity,
  toolRequest,
} from "../../claude-mod/hooks/tools";
import { REVIEW_CLIENT_SCRIPT } from "./agent-client";
import { createReviewAgentServer } from "./agent-server";
import { REVIEW_SKILL } from "./agent-skill";
import { createReviewService } from "./service";
import { openReviewStorage } from "./storage";

/**
 * What agents are told about the review (plan: review into the inspector,
 * phase 8): the skill, the client's help and the Claude mod's tool
 * descriptions. Each claim they make about where and how the user sees a
 * review is pinned here with the behavior that makes it true today (the
 * classic review pane), so a change of surface has to update both.
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

const IDENTITY: ToolIdentity = {
  pane: "w1-2",
  workspace: "w1",
  herdr_socket: "/herdr.sock",
  cwd: "/work",
  claude_session: "aaaaaaaa-0000-4000-8000-000000000001",
};

function setup() {
  const dir = temp("rg-tx-");
  const home = temp("rg-txh-");
  const published: Record<string, unknown>[] = [];
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: (event) => {
      published.push(event as Record<string, unknown>);
    },
    loadDiff: async () => ({ files: [], truncated: false }),
  });
  const agent = createReviewAgentServer({
    service,
    directory: dir,
    home,
    connections: () => [
      {
        id: "local",
        herdrSocketPath: "/herdr.sock",
        readRoot: async () => "/repo",
        readDefaultBase: async () => "origin/main",
      },
    ],
    notify: async () => {},
  });
  cleanups.push(() => {
    agent.stop();
    service.close();
  });
  agent.installLocal();
  const socket = join(home, ".cache/roamgate/review.sock");
  /** A tool call as the mod makes it: its JSON answer. */
  async function call(name: string, input: Record<string, unknown> = {}) {
    const { command, body } = toolRequest(roamgateTool(name)!, input, IDENTITY);
    const response = await fetch(`http://roamgate/v1/${command}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      unix: socket,
    } as RequestInit);
    const parsed = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(parsed.error));
    return parsed;
  }
  return { service, published, call };
}

test("the skill and the review_open tool say a review opens on the branch against its default branch, popping up for the user", async () => {
  // What they say.
  expect(REVIEW_SKILL).toContain(
    "Use Roamgate's review pane (review overlay) to go through code with the user",
  );
  expect(REVIEW_SKILL).toContain(
    "The user reads diffs in Roamgate's review overlay and comments on lines.",
  );
  expect(REVIEW_SKILL).toContain(
    "Without a target it reviews `<default branch>..HEAD`.",
  );
  expect(REVIEW_SKILL).toContain("The overlay pops up in the user's browser.");
  expect(REVIEW_SKILL).toContain("between them in the overlay.");
  const open = roamgateTool("review_open")!;
  expect(open.description).toStartWith(
    "Open a Roamgate review for the user: by default the branch here against its default branch.",
  );

  // What it does: the default branch..HEAD, raised in the user's browser
  // with the agent's message.
  const { service, published, call } = setup();
  const opened = (await call("review_open", { message: "Ready" })) as {
    session: { id: string };
  };
  expect(service.get({ sessionId: opened.session.id }).session.target).toEqual({
    kind: "range",
    base: "origin/main",
    head: "HEAD",
  });
  expect(published).toContainEqual(
    expect.objectContaining({
      type: "open",
      sessionId: opened.session.id,
      connectionId: "local",
      message: "Ready",
    }),
  );
});

test("the skill names the mod's tools, those behind tool search apart", () => {
  const named = (text: string) =>
    [...text.matchAll(/`((?:reviews?|agent)_[a-z_]+)`/g)].map((m) => m[1]);
  const paragraph = REVIEW_SKILL.slice(
    REVIEW_SKILL.indexOf("**Prefer Roamgate's tools when you have them.**"),
    REVIEW_SKILL.indexOf("## Two kinds of comment"),
  );
  const [direct = "", deferred = ""] = paragraph.split("behind tool");
  expect(named(direct).sort()).toEqual(
    ROAMGATE_TOOLS.filter((tool) => !tool.deferred)
      .map((tool) => tool.name)
      .sort(),
  );
  expect(named(deferred).sort()).toEqual(
    ROAMGATE_TOOLS.filter((tool) => tool.deferred)
      .map((tool) => tool.name)
      .sort(),
  );
});

test("the client's help says it talks to the review pane", async () => {
  const dir = temp("rg-txc-");
  const client = join(dir, "roamgate-review");
  writeFileSync(client, REVIEW_CLIENT_SCRIPT);
  chmodSync(client, 0o755);
  const proc = Bun.spawn(["python3", client, "--help"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH, HOME: dir },
  });
  const [code, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ]);
  expect(code).toBe(0);
  expect(stdout).toContain("Talk to the Roamgate review pane. Output is JSON.");
  expect(REVIEW_CLIENT_SCRIPT).toContain(
    '"""roamgate-review: talk to the Roamgate review pane.',
  );
});

test("the skill and the tools never offer to publish to a forge: drafts only (user decision 2026-11-13)", () => {
  expect(REVIEW_SKILL).toContain(
    "Never offer to publish, submit, resolve or post",
  );
  // Where it mentions GitLab, nothing of the agent's goes there but as drafts
  // the user puts and submits.
  expect(REVIEW_SKILL).not.toMatch(/sends? (it|them) to GitLab/);
  for (const tool of ROAMGATE_TOOLS)
    expect(tool.description).not.toMatch(
      /\b(publish|submit)\b(?! (the|your) review (on|there))(?!ted)/i,
    );
});
