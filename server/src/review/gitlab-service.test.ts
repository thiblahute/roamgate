import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewDiff } from "../../../shared/review";
import { parseUnifiedDiff } from "./patch";
import { createReviewService, type ReviewService } from "./service";
import { openReviewStorage } from "./storage";

/** The merge request reviews of GitLab mode, against a fake glab. */

const directories: string[] = [];
const services: ReviewService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

type FakeDraft = {
  id: number;
  note: string;
  position: Record<string, unknown> | null;
};

type Options = {
  /** The project GitLab answers in the merge request's web_url. */
  webProject?: string;
  /** Every glab call fails, as when GitLab is unreachable. */
  fail?: () => boolean;
  /** Holds a write (POST/PUT/DELETE) until it resolves. */
  hold?: (method: string, argv: string[]) => Promise<void> | undefined;
  /** A write GitLab refuses. */
  refuse?: (method: string, argv: string[]) => boolean;
  dir?: string;
  /** What loadDiff answers. */
  diff?: ReviewDiff;
  promptAgent?: (pane: string, text: string) => void;
  /** The merge request's updated_at. */
  updatedAt?: () => string;
};

function make(options: Options = {}) {
  const dir =
    options.dir ??
    (() => {
      const path = mkdtempSync(join(tmpdir(), "roamgate-glsvc-"));
      directories.push(path);
      return path;
    })();
  const writes: { method: string; argv: string[] }[] = [];
  const reads: string[] = [];
  const drafts: FakeDraft[] = [];
  let next = 100;
  const field = (argv: string[], name: string) =>
    argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => options.diff ?? { files: [], truncated: false },
    deliveryDelayMs: 0,
    ...(options.promptAgent
      ? {
          promptAgent: async (
            _connection: string,
            pane: string,
            text: string,
          ) => options.promptAgent!(pane, text),
        }
      : {}),
    gitlab: {
      checkout: async () => {
        throw new Error("no checkout here");
      },
      find: async () => null,
      context: () => ({
        root: "/repo",
        shQuote: (value) => value,
        runProcessWithCodeTimeout: async (argv) => {
          if (argv.some((arg) => arg.includes("glab config get host")))
            return { code: 0, stdout: "glab gitlab.example\n", stderr: "" };
          if (options.fail?.())
            return { code: 1, stdout: "", stderr: "connection timed out" };
          const method = argv[argv.indexOf("--method") + 1]!;
          const path = argv.find((arg) => arg.startsWith("projects/"))!;
          if (method !== "GET") {
            writes.push({ method, argv });
            await options.hold?.(method, argv);
            if (options.refuse?.(method, argv))
              return { code: 1, stdout: "", stderr: "502 Bad Gateway" };
            const id = Number(/draft_notes\/(\d+)/.exec(path)?.[1] ?? 0);
            if (method === "DELETE") {
              const at = drafts.findIndex((draft) => draft.id === id);
              if (at >= 0) drafts.splice(at, 1);
              return { code: 0, stdout: "", stderr: "" };
            }
            if (method === "PUT") {
              const draft = drafts.find((entry) => entry.id === id)!;
              draft.note = field(argv, "note") ?? draft.note;
              return { code: 0, stdout: JSON.stringify(draft), stderr: "" };
            }
            const draft: FakeDraft = {
              id: next++,
              note: field(argv, "note") ?? "",
              position: field(argv, "position[new_path]")
                ? { new_path: field(argv, "position[new_path]") }
                : null,
            };
            drafts.push(draft);
            return { code: 0, stdout: JSON.stringify(draft), stderr: "" };
          }
          reads.push(path);
          const body = path.includes("/discussions")
            ? [
                {
                  id: "d1",
                  notes: [{ id: 1, body: "Hm", author: { username: "x" } }],
                },
              ]
            : path.includes("/draft_notes")
              ? drafts
              : {
                  web_url: options.webProject
                    ? `https://gitlab.example/${options.webProject}/-/merge_requests/3`
                    : "u",
                  title: "t",
                  state: "opened",
                  ...(options.updatedAt
                    ? { updated_at: options.updatedAt() }
                    : {}),
                  diff_refs: {
                    base_sha: "b".repeat(40),
                    start_sha: "b".repeat(40),
                    head_sha: "c".repeat(40),
                  },
                };
          return { code: 0, stdout: JSON.stringify(body), stderr: "" };
        },
      }),
    },
  });
  services.push(service);
  return { service, writes, reads, drafts, dir };
}

function openMr(
  service: ReviewService,
  project: string,
  extra: Record<string, unknown> = {},
) {
  return service.open({
    connectionId: "c",
    root: "/repo",
    target: {
      kind: "mr",
      url: `https://gitlab.example/${project}/-/merge_requests/3`,
    },
    ...extra,
  }).session;
}

const agent = { author: "claude" };

test("the security guard holds before GitLab answered", async () => {
  let down = true;
  const { service } = make({ fail: () => down });
  const secure = openMr(service, "gnome/security");
  const plain = openMr(service, "gnome/glib");
  await service.refreshGitlab({ sessionId: secure.id });
  // Told by the URL, GitLab or not.
  await expect(
    service.addThread({
      sessionId: secure.id,
      ...agent,
      kind: "discussion",
      text: "x",
    }),
  ).rejects.toThrow("security merge request");
  await expect(
    service.assertAgentAllowed({ sessionId: secure.id, ...agent }),
  ).rejects.toThrow("security merge request");
  // Any other merge request waits for GitLab to tell.
  await expect(
    service.assertAgentAllowed({ sessionId: plain.id, ...agent }),
  ).rejects.toThrow("has not told yet");
  expect(service.agentMayRead({ sessionId: plain.id })).toBe(false);
  down = false;
  await service.assertAgentAllowed({ sessionId: plain.id, ...agent });
  expect(service.agentMayRead({ sessionId: plain.id })).toBe(true);
  // The user is never refused.
  await service.assertAgentAllowed({ sessionId: secure.id, author: "you" });
});

test("a numeric project id is judged by the project GitLab names", async () => {
  const secure = make({ webProject: "gnome/security" });
  const byId = openMr(secure.service, "1234");
  await expect(
    secure.service.assertAgentAllowed({ sessionId: byId.id, ...agent }),
  ).rejects.toThrow("security merge request");
  expect(
    secure.service.get({ sessionId: byId.id }).mergeRequest?.security,
  ).toBe(true);
  // GitLab answered, but without naming the project: still unknown.
  const unnamed = make();
  const other = openMr(unnamed.service, "1234");
  await expect(
    unnamed.service.assertAgentAllowed({ sessionId: other.id, ...agent }),
  ).rejects.toThrow("has not told yet");
  const named = make({ webProject: "gnome/glib" });
  const fine = openMr(named.service, "1234");
  await named.service.assertAgentAllowed({ sessionId: fine.id, ...agent });
});

test("watch and handoff never carry a security merge request's review", async () => {
  const prompts: string[] = [];
  const { service } = make({
    promptAgent: (_pane, text) => prompts.push(text),
  });
  const local = service.open({
    connectionId: "c",
    root: "/repo",
    workspaceId: "w",
    agent: "claude",
    target: { kind: "worktree" },
  }).session;
  const secure = openMr(service, "gnome/security", {
    root: "/other",
    workspaceId: "w",
    agent: "claude",
    paneId: "p1",
  });
  await service.refreshGitlab({ sessionId: secure.id });
  // Any change in the workspace: not the security review's.
  const any = service.watch({
    sessionId: local.id,
    agent: "claude",
    mode: "any",
    timeoutMs: 100,
  });
  await service.update({ sessionId: secure.id, summary: "CVE details" });
  await service.addThread({
    sessionId: secure.id,
    kind: "discussion",
    text: "overflow in parse()",
  });
  expect((await any).outcome).toBe("timeout");
  // Its discussions waiting on the agent: not handed either.
  const unanswered = await service.watch({
    sessionId: local.id,
    agent: "claude",
    timeoutMs: 50,
  });
  expect(unanswered.outcome).toBe("timeout");
  expect(unanswered.threads).toEqual([]);
  // A handoff of it is refused before it wakes anyone.
  const waiting = service.watch({
    sessionId: local.id,
    agent: "claude",
    timeoutMs: 100,
  });
  await expect(service.handoff({ sessionId: secure.id })).rejects.toThrow(
    "security merge request",
  );
  const woken = await waiting;
  expect(woken.outcome).toBe("timeout");
  expect(woken.summary).toBeUndefined();
  // The agent's watch of it is refused too, and nothing reached its pane.
  expect(() =>
    service.watch({ sessionId: secure.id, agent: "claude", timeoutMs: 10 }),
  ).toThrow("security merge request");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(prompts.join("\n")).not.toContain("CVE");
  expect(prompts.join("\n")).not.toContain("overflow");
});

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Lets the pending glab answers and awaits run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

async function agentDraft(
  service: ReviewService,
  sessionId: string,
  text: string,
) {
  return service.addThread({
    sessionId,
    ...agent,
    kind: "draft",
    anchor: { path: "a.c", line: 2, side: "new" },
    text,
  });
}

test("two pushes at once send each draft once", async () => {
  const gate = deferred();
  const { service, writes, drafts } = make({
    webProject: "g/p",
    hold: () => gate.promise,
  });
  const review = openMr(service, "g/p");
  await service.refreshGitlab({ sessionId: review.id });
  await agentDraft(service, review.id, "agent draft");
  const first = service.pushLocalDrafts({ sessionId: review.id });
  const second = service.pushLocalDrafts({ sessionId: review.id });
  await settle();
  gate.release();
  await Promise.all([first, second]);
  expect(writes.filter((write) => write.method === "POST")).toHaveLength(1);
  expect(drafts.map((draft) => draft.note)).toEqual(["agent draft"]);
});

test("a draft edited or deleted while it is sent stays as the user left it", async () => {
  let gate = deferred();
  const { service, drafts, writes } = make({
    webProject: "g/p",
    hold: (method) => (method === "POST" ? gate.promise : undefined),
  });
  const review = openMr(service, "g/p");
  await service.refreshGitlab({ sessionId: review.id });
  const edited = await agentDraft(service, review.id, "old");
  let push = service.pushLocalDrafts({ sessionId: review.id });
  await settle();
  await service.edit({
    sessionId: review.id,
    commentId: edited.comments[0]!.id,
    text: "NEW",
  });
  gate.release();
  await expect(push).rejects.toThrow("changed while it was sent");
  // The old text is taken back from GitLab; the edit stays here.
  expect(drafts).toEqual([]);
  const local = () =>
    service.get({ sessionId: review.id }).threads.filter((t) => !t.gitlab);
  expect(local().map((t) => t.comments[0]!.body)).toEqual(["NEW"]);
  gate = deferred();
  push = service.pushLocalDrafts({ sessionId: review.id });
  await settle();
  gate.release();
  await push;
  expect(drafts.map((draft) => draft.note)).toEqual(["NEW"]);
  expect(local()).toEqual([]);

  // Deleted while it is sent: taken back. Deleted before its turn: not sent.
  const first = await agentDraft(service, review.id, "first");
  const second = await agentDraft(service, review.id, "second");
  gate = deferred();
  push = service.pushLocalDrafts({ sessionId: review.id });
  await settle();
  await service.deleteComment({
    sessionId: review.id,
    commentId: first.comments[0]!.id,
  });
  await service.deleteComment({
    sessionId: review.id,
    commentId: second.comments[0]!.id,
  });
  gate.release();
  await push;
  expect(drafts.map((draft) => draft.note)).toEqual(["NEW"]);
  expect(local()).toEqual([]);
  expect(writes.some((write) => write.argv.includes("note=second"))).toBe(
    false,
  );
});

test("an overall comment GitLab refused is kept, and sent with the drafts", async () => {
  let down = false;
  const first = make({
    webProject: "g/p",
    refuse: () => down,
  });
  const review = openMr(first.service, "g/p");
  await first.service.refreshGitlab({ sessionId: review.id });
  down = true;
  await expect(
    first.service.update({ sessionId: review.id, summary: "long overall" }),
  ).rejects.toThrow("502");
  first.service.close();
  services.splice(services.indexOf(first.service), 1);
  // After a restart it is still there, still to send.
  const again = make({ webProject: "g/p", dir: first.dir });
  const kept = again.service.get({ sessionId: review.id }).session;
  expect(kept.summary).toBe("long overall");
  expect(kept.summaryUnsent).toBe(true);
  await again.service.refreshGitlab({ sessionId: review.id });
  await again.service.pushLocalDrafts({ sessionId: review.id });
  expect(again.drafts.map((draft) => draft.note)).toEqual(["long overall"]);
  expect(
    again.service.get({ sessionId: review.id }).session.summaryUnsent,
  ).toBeUndefined();
});

test("overall comments saved at once make one draft", async () => {
  const gate = deferred();
  const { service, writes, drafts } = make({
    webProject: "g/p",
    hold: () => gate.promise,
  });
  const review = openMr(service, "g/p");
  await service.refreshGitlab({ sessionId: review.id });
  const saves = Promise.all([
    service.update({ sessionId: review.id, summary: "a" }),
    service.update({ sessionId: review.id, summary: "ab" }),
  ]);
  await settle();
  gate.release();
  await saves;
  // The second save finds the first one's draft, already with its text.
  expect(writes.map((write) => write.method)).toEqual(["POST"]);
  expect(drafts.map((draft) => draft.note)).toEqual(["ab"]);
  expect(
    service.get({ sessionId: review.id }).session.summaryUnsent,
  ).toBeUndefined();
});

test("a range comment goes to GitLab as a line range from the diff", async () => {
  const { service, writes } = make({
    webProject: "g/p",
    diff: {
      truncated: false,
      files: parseUnifiedDiff(
        "diff --git a/a.c b/a.c\n--- a/a.c\n+++ b/a.c\n@@ -1,2 +1,3 @@\n ctx1\n+add2\n ctx2\n",
      ),
    },
  });
  const review = openMr(service, "g/p");
  await service.refreshGitlab({ sessionId: review.id });
  // The user's comment, sent at once, and an agent's, sent with the push.
  await service.addThread({
    sessionId: review.id,
    kind: "draft",
    anchor: { path: "a.c", line: 1, endLine: 3, side: "new", contextOld: 1 },
    text: "range",
  });
  await service.addThread({
    sessionId: review.id,
    ...agent,
    kind: "draft",
    anchor: { path: "a.c", line: 1, endLine: 2, side: "new" },
    text: "agent range",
  });
  await service.pushLocalDrafts({ sessionId: review.id });
  const [user, pushed] = writes.map((write) => write.argv);
  expect(user).toContain("position[line_range][end][old_line]=2");
  expect(user).toContain("position[line_range][end][new_line]=3");
  expect(user).toContain("position[old_line]=2");
  expect(user).toContain("position[new_line]=3");
  expect(pushed).toContain("position[line_range][end][type]=new");
  expect(pushed).toContain("position[new_line]=2");
  expect(pushed!.some((arg) => arg.startsWith("position[old_line]="))).toBe(
    false,
  );
});

test("a poll of an unchanged merge request reads only the merge request", async () => {
  let updatedAt = "2026-11-02T10:00:00Z";
  const { service, reads } = make({
    webProject: "g/p",
    updatedAt: () => updatedAt,
  });
  const review = openMr(service, "g/p");
  await service.refreshGitlab({ sessionId: review.id });
  const threads = () =>
    reads.filter((path) => /discussions|draft_notes/.test(path)).length;
  expect(threads()).toBe(2);
  await service.refreshGitlab({ sessionId: review.id, poll: true });
  expect(threads()).toBe(2);
  // A new note moves updated_at: its threads are read again.
  updatedAt = "2026-11-02T10:05:00Z";
  await service.refreshGitlab({ sessionId: review.id, poll: true });
  expect(threads()).toBe(4);
  // Not a poll (a reload, or after a write here): read again.
  await service.refreshGitlab({ sessionId: review.id });
  expect(threads()).toBe(6);
});
