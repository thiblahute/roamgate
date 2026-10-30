import { sshCommandArgv, sshReadCommandArgv } from "../bridge/ssh-command";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { gitShellCommandArgv } from "../workspace/git-shell";
import { enterCheckout, reviewScriptError } from "../workspace/review-patch";
import type {
  ReviewAnchor,
  ReviewComment,
  ReviewCommit,
  ReviewDiff,
  ReviewThread,
} from "../../../shared/review";
import { parseUnifiedDiff } from "./patch";

/**
 * GitLab through `glab api` on the checkout's host, as the PR/MR card does:
 * the user's own glab login, over the connection's SSH master remotely.
 * Draft notes are the one state shared with maildesk: they are read and
 * written straight on the merge request, never kept here.
 */

export type GlabContext = {
  root: string;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: (
    argv: string[],
    timeoutMs: number,
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
};

export type MergeRequestRef = { host: string; project: string; iid: number };

export type MergeRequestInfo = MergeRequestRef & {
  url: string;
  title: string;
  state: string;
  baseSha: string;
  startSha: string;
  headSha: string;
};

export type GitLabDraft = {
  id: number;
  note: string;
  /** Set on a reply to a discussion. */
  discussion_id?: string | null;
  position: {
    old_path?: string | null;
    new_path?: string | null;
    old_line?: number | null;
    new_line?: number | null;
  } | null;
};

const TIMEOUT_MS = 30_000;

export function parseMergeRequestUrl(url: string): MergeRequestRef | null {
  const match =
    /^https:\/\/([^/\s]+)\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/.exec(
      url,
    );
  if (!match) return null;
  return { host: match[1]!, project: match[2]!, iid: Number(match[3]) };
}

/** maildesk's rule: confidential security work never leaves GitLab. */
export function isSecurityProject(project: string): boolean {
  return /security/i.test(project);
}

function mrPath(ref: MergeRequestRef): string {
  return `projects/${encodeURIComponent(ref.project)}/merge_requests/${ref.iid}`;
}

/** Variables that make glab use one token for every host. */
const TOKEN_VARIABLES = ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"];

async function glab(
  context: GlabContext,
  /** ownLogin: a host other than glab's default, asked with its own login. */
  ref: { host: string; ownLogin?: boolean },
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  fields: [string, string, "raw" | "typed"][] = [],
  paginate = method === "GET",
): Promise<unknown> {
  const argv = [
    "glab",
    "api",
    "--hostname",
    ref.host,
    "--method",
    method,
    ...(paginate ? ["--paginate"] : []),
    path,
    ...fields.flatMap(([key, value, kind]) => [
      kind === "raw" ? "-f" : "-F",
      `${key}=${value}`,
    ]),
  ];
  const env = { GLAB_NO_PROMPT: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" };
  let result: { code: number; stdout: string; stderr: string };
  if (context.host) {
    const unset = ref.ownLogin
      ? `env ${TOKEN_VARIABLES.map((name) => `-u ${name}`).join(" ")} `
      : "";
    // `glab api` names its project: a removed checkout runs it from home.
    const command = `{ cd ${context.shQuote(context.root)} 2>/dev/null || cd; } && ${unset}${Object.entries(
      env,
    )
      .map(([key, value]) => `${key}=${value}`)
      .join(" ")} ${argv.map(context.shQuote).join(" ")}`;
    result = await context.runProcessWithCodeTimeout(
      method === "GET"
        ? sshReadCommandArgv(context.host, command, [], "review.gitlab")
        : sshCommandArgv(context.host, command, [], "review.gitlab"),
      TIMEOUT_MS,
    );
  } else {
    // A missing cwd fails the spawn with ENOENT too, as a missing glab
    // would: a removed checkout runs it from home instead.
    const cwd = existsSync(context.root) ? context.root : homedir();
    try {
      result = await context.runProcessWithCodeTimeout(argv, TIMEOUT_MS, {
        cwd,
        env: ref.ownLogin
          ? {
              ...Object.fromEntries(
                Object.entries(process.env).filter(
                  ([name]) => !TOKEN_VARIABLES.includes(name),
                ),
              ),
              ...env,
            }
          : { ...process.env, ...env },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("glab is not installed on this host", {
          cause: error,
        });
      throw error;
    }
  }
  if (result.code === 127)
    throw new Error("glab is not installed on this host");
  if (result.code !== 0) {
    const message = (result.stderr || result.stdout || "GitLab request failed")
      .trim()
      .split("\n")
      .slice(-3)
      .join(" ")
      .slice(0, 300);
    throw new Error(`GitLab: ${message}`);
  }
  const text = result.stdout.trim();
  if (!text) return null;
  // --paginate prints one JSON array per page back to back.
  if (paginate && text.startsWith("[")) {
    const pages = text.replace(/\]\s*\[/g, "],[");
    return (JSON.parse(`[${pages}]`) as unknown[][]).flat();
  }
  return JSON.parse(text);
}

export async function readMergeRequest(
  context: GlabContext,
  url: string,
): Promise<MergeRequestInfo> {
  const ref = parseMergeRequestUrl(url);
  if (!ref) throw new Error("not a GitLab merge request URL");
  const mr = (await glab(context, ref, "GET", mrPath(ref))) as Record<
    string,
    unknown
  >;
  const refs = (mr.diff_refs ?? {}) as Record<string, string | null>;
  if (!refs.head_sha || !refs.base_sha)
    throw new Error("GitLab has no diff for this merge request yet");
  return {
    ...ref,
    url: String(mr.web_url ?? url),
    title: String(mr.title ?? ""),
    state: String(mr.state ?? ""),
    baseSha: refs.base_sha,
    startSha: refs.start_sha ?? refs.base_sha,
    headSha: refs.head_sha,
  };
}

/** The MR's diff from the API, for when its commits are not in the checkout. */
export async function readMergeRequestDiff(
  context: GlabContext,
  mr: MergeRequestInfo,
): Promise<ReviewDiff> {
  const files = (await glab(
    context,
    mr,
    "GET",
    `${mrPath(mr)}/diffs?per_page=100`,
  )) as Record<string, unknown>[];
  const text = files
    .map((file) => {
      const oldPath = String(file.old_path ?? "");
      const newPath = String(file.new_path ?? "");
      const header = [
        `diff --git a/${oldPath} b/${newPath}`,
        `--- ${file.new_file ? "/dev/null" : `a/${oldPath}`}`,
        `+++ ${file.deleted_file ? "/dev/null" : `b/${newPath}`}`,
      ];
      if (file.too_large || file.collapsed)
        return [...header.slice(0, 1), "Binary files differ"].join("\n");
      return [...header, String(file.diff ?? "").replace(/\n$/, "")].join("\n");
    })
    .join("\n");
  return {
    files: parseUnifiedDiff(text),
    baseSha: mr.baseSha,
    headSha: mr.headSha,
    truncated: false,
  };
}

function anchorOf(
  position: Record<string, unknown> | null | undefined,
  mr?: MergeRequestInfo,
): ReviewAnchor {
  if (!position) return {};
  // A note written on one commit of the MR: its base is that commit's parent
  // (start and base agree), not the MR's base.
  const head = position.head_sha as string | undefined;
  const base = position.base_sha as string | undefined;
  const onCommit =
    mr && head && base && base === position.start_sha && base !== mr.baseSha
      ? { commit: head, commitParent: base }
      : {};
  return { ...anchorOfLine(position), ...onCommit };
}

function anchorOfLine(position: Record<string, unknown>): ReviewAnchor {
  const newLine = position.new_line as number | null | undefined;
  const oldLine = position.old_line as number | null | undefined;
  const newPath = position.new_path as string | undefined;
  const oldPath = position.old_path as string | undefined;
  if (newLine)
    return {
      path: newPath ?? oldPath,
      line: newLine,
      side: "new",
      ...(oldLine ? { contextOld: oldLine } : {}),
      ...(oldPath && oldPath !== newPath ? { oldPath } : {}),
    };
  if (oldLine) return { path: oldPath ?? newPath, line: oldLine, side: "old" };
  return { path: newPath ?? oldPath };
}

/**
 * The MR's discussions (system notes dropped) as read-only threads, and every
 * page of the user's draft notes as review comments: whichever app wrote
 * them, the user sees all of their pending review.
 */
export async function readMergeRequestThreads(
  context: GlabContext,
  mr: MergeRequestInfo,
  sessionId: string,
): Promise<ReviewThread[]> {
  const [discussions, drafts] = await Promise.all([
    glab(context, mr, "GET", `${mrPath(mr)}/discussions?per_page=100`),
    glab(context, mr, "GET", `${mrPath(mr)}/draft_notes?per_page=100`),
  ]);
  const threads: ReviewThread[] = [];
  const byDiscussion = new Map<string, ReviewThread>();
  for (const raw of (discussions as Record<string, unknown>[]) ?? []) {
    const notes = ((raw.notes as Record<string, unknown>[]) ?? []).filter(
      (note) => !note.system,
    );
    if (!notes.length) continue;
    const first = notes[0]!;
    const position = first.position as Record<string, unknown> | undefined;
    const at = String(first.created_at ?? "");
    threads.push({
      id: `gl:${raw.id}`,
      sessionId,
      kind: "merge-request",
      anchor: anchorOf(position, mr),
      resolved: notes.some((note) => note.resolvable)
        ? notes.every((note) => !note.resolvable || note.resolved)
        : false,
      comments: notes.map((note) => ({
        id: `gl:${raw.id}:${note.id}`,
        author: `@${(note.author as Record<string, unknown> | undefined)?.username ?? "someone"}`,
        body: String(note.body ?? ""),
        createdAt: String(note.created_at ?? at),
        updatedAt: String(note.updated_at ?? note.created_at ?? at),
      })),
      createdAt: at,
      updatedAt: at,
      gitlab: {
        discussionId: String(raw.id),
        headSha: position?.head_sha ? String(position.head_sha) : undefined,
      },
    });
    byDiscussion.set(String(raw.id), threads[threads.length - 1]!);
  }
  for (const draft of (drafts as GitLabDraft[]) ?? []) {
    // A draft reply goes under its discussion, after what it answers.
    const discussion = draft.discussion_id
      ? byDiscussion.get(draft.discussion_id)
      : undefined;
    if (discussion) discussion.comments.push(draftReply(draft));
    else threads.push(draftThread(draft, sessionId, mr));
  }
  return threads;
}

/** A draft reply in a discussion: the user's, until they submit it. */
export function draftReply(draft: GitLabDraft): ReviewComment {
  const at = new Date(0).toISOString();
  return {
    id: `gldraft:${draft.id}`,
    author: "you",
    body: draft.note,
    createdAt: at,
    updatedAt: at,
    gitlabDraftId: draft.id,
  };
}

export function draftThread(
  draft: GitLabDraft,
  sessionId: string,
  mr?: MergeRequestInfo,
): ReviewThread {
  const at = new Date(0).toISOString();
  return {
    id: `gldraft:${draft.id}`,
    sessionId,
    kind: "draft",
    anchor: anchorOf(draft.position as Record<string, unknown> | null, mr),
    resolved: false,
    comments: [
      {
        id: `gldraft:${draft.id}`,
        author: "you",
        body: draft.note,
        createdAt: at,
        updatedAt: at,
      },
    ],
    createdAt: at,
    updatedAt: at,
    gitlab: { draftId: draft.id },
  };
}

function positionFields(
  mr: MergeRequestInfo,
  anchor: ReviewAnchor,
): [string, string, "raw" | "typed"][] {
  if (!anchor.path || !anchor.line) return [];
  // On one commit's view the position is that commit against its parent,
  // as maildesk posts it; otherwise the MR's whole diff.
  const onCommit = anchor.commit && anchor.commitParent;
  const fields: [string, string, "raw" | "typed"][] = [
    ["position[position_type]", "text", "raw"],
    ["position[base_sha]", onCommit ? anchor.commitParent! : mr.baseSha, "raw"],
    [
      "position[start_sha]",
      onCommit ? anchor.commitParent! : mr.startSha,
      "raw",
    ],
    ["position[head_sha]", onCommit ? anchor.commit! : mr.headSha, "raw"],
    ["position[old_path]", anchor.oldPath ?? anchor.path, "raw"],
    ["position[new_path]", anchor.path, "raw"],
  ];
  const line = anchor.endLine ?? anchor.line;
  if (anchor.side === "old")
    fields.push(["position[old_line]", String(line), "typed"]);
  else {
    fields.push(["position[new_line]", String(line), "typed"]);
    // Unchanged lines need both numbers, or GitLab refuses the position.
    if (anchor.contextOld !== undefined)
      fields.push([
        "position[old_line]",
        String(anchor.contextOld + (line - anchor.line)),
        "typed",
      ]);
  }
  return fields;
}

export async function createDraftNote(
  context: GlabContext,
  mr: MergeRequestInfo,
  anchor: ReviewAnchor,
  note: string,
): Promise<GitLabDraft> {
  return (await glab(context, mr, "POST", `${mrPath(mr)}/draft_notes`, [
    ["note", note, "raw"],
    ...positionFields(mr, anchor),
  ])) as GitLabDraft;
}

/** A draft reply to a discussion: nobody else sees it until submitted. */
export async function createDraftReply(
  context: GlabContext,
  mr: MergeRequestInfo,
  discussionId: string,
  note: string,
): Promise<GitLabDraft> {
  if (!/^[0-9a-f]+$/.test(discussionId))
    throw new Error("invalid discussion id");
  return (await glab(context, mr, "POST", `${mrPath(mr)}/draft_notes`, [
    ["note", note, "raw"],
    ["in_reply_to_discussion_id", discussionId, "raw"],
  ])) as GitLabDraft;
}

export async function updateDraftNote(
  context: GlabContext,
  mr: MergeRequestInfo,
  id: number,
  note: string,
): Promise<GitLabDraft> {
  return (await glab(context, mr, "PUT", `${mrPath(mr)}/draft_notes/${id}`, [
    ["note", note, "raw"],
  ])) as GitLabDraft;
}

export async function deleteDraftNote(
  context: GlabContext,
  mr: MergeRequestInfo,
  id: number,
): Promise<void> {
  await glab(context, mr, "DELETE", `${mrPath(mr)}/draft_notes/${id}`);
}

/** A public reply on an MR discussion: only ever on the user's click. */
export async function replyToDiscussion(
  context: GlabContext,
  mr: MergeRequestInfo,
  discussionId: string,
  body: string,
): Promise<void> {
  if (!/^[0-9a-f]+$/.test(discussionId))
    throw new Error("invalid discussion id");
  await glab(
    context,
    mr,
    "POST",
    `${mrPath(mr)}/discussions/${discussionId}/notes`,
    [["body", body, "raw"]],
  );
}

/** A file at a commit, from GitLab when the checkout does not have it. */
export async function readRawFile(
  context: GlabContext,
  mr: MergeRequestInfo,
  path: string,
  sha: string,
): Promise<string> {
  const result = await glab(
    context,
    mr,
    "GET",
    `projects/${encodeURIComponent(mr.project)}/repository/files/${encodeURIComponent(path)}?ref=${sha}`,
  );
  const content = (result as Record<string, unknown> | null)?.content;
  if (typeof content !== "string") throw new Error("GitLab returned no file");
  return Buffer.from(content, "base64").toString("utf8");
}

/** The MR's commits, oldest first. */
export async function readMergeRequestCommits(
  context: GlabContext,
  mr: MergeRequestInfo,
): Promise<ReviewCommit[]> {
  const commits = (await glab(
    context,
    mr,
    "GET",
    `${mrPath(mr)}/commits?per_page=100`,
  )) as Record<string, unknown>[];
  return commits
    .map((commit) => {
      const message = String(commit.message ?? commit.title ?? "");
      const [subject = "", ...rest] = message.split("\n");
      const parents = commit.parent_ids as string[] | undefined;
      return {
        sha: String(commit.id ?? ""),
        parent: parents?.[0] ?? null,
        author: String(commit.author_name ?? ""),
        date: String(commit.authored_date ?? commit.created_at ?? ""),
        subject,
        body: rest.join("\n").trim(),
      };
    })
    .reverse();
}

/** One commit's diff from GitLab, when the checkout does not have it. */
export async function readCommitDiff(
  context: GlabContext,
  mr: MergeRequestInfo,
  sha: string,
  parent: string | null,
): Promise<ReviewDiff> {
  if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new Error("invalid commit");
  const files = (await glab(
    context,
    mr,
    "GET",
    `projects/${encodeURIComponent(mr.project)}/repository/commits/${sha}/diff?per_page=100`,
  )) as Record<string, unknown>[];
  const text = files
    .map((file) => {
      const oldPath = String(file.old_path ?? "");
      const newPath = String(file.new_path ?? "");
      return [
        `diff --git a/${oldPath} b/${newPath}`,
        `--- ${file.new_file ? "/dev/null" : `a/${oldPath}`}`,
        `+++ ${file.deleted_file ? "/dev/null" : `b/${newPath}`}`,
        String(file.diff ?? "").replace(/\n$/, ""),
      ].join("\n");
    })
    .join("\n");
  return {
    files: parseUnifiedDiff(text),
    baseSha: parent ?? undefined,
    headSha: sha,
    truncated: false,
  };
}

/** What finding the checkout's merge request needs, read in one command. */
export type ReviewCheckout = {
  /** The local branch, null when HEAD is detached. */
  branch: string | null;
  head: string | null;
  /** origin's default branch (origin/HEAD), such as main. */
  defaultBranch: string | null;
  /** Each remote's default branch (<remote>/HEAD), when it is known. */
  remoteHeads: Record<string, string>;
  /** branch.<b>.remote and branch.<b>.merge. */
  upstream: { remote: string; branch: string } | null;
  /** branch.<b>.pushRemote, else remote.pushDefault. */
  pushRemote: string | null;
  /**
   * The URL of the remote a merge request would come from (see
   * mergeRequestSource), with url.<base>.insteadOf applied.
   */
  remotes: Record<string, string>;
  /** The GitLab host glab uses on the checkout's host. */
  gitlabHost: string | null;
  /** That remote's host (without a leading "ssh."), if glab is logged in to it. */
  gitlabLogins: string[];
};

export type BranchMergeRequest = {
  url: string;
  title: string;
  number: number;
  state: string;
  /** The checkout's local branch. */
  branch: string;
};

export function readCheckoutScript(
  root: string,
  shQuote: (value: string) => string,
): string {
  return [
    enterCheckout(root, shQuote),
    `b=$(git symbolic-ref -q --short HEAD)`,
    `printf 'branch %s\\n' "$b"`,
    `printf 'head %s\\n' "$(git rev-parse -q --verify HEAD)"`,
    `printf 'default %s\\n' "$(git symbolic-ref -q --short refs/remotes/origin/HEAD)"`,
    `pd=$(git config --get remote.pushDefault)`,
    `printf 'pushdefault %s\\n' "$pd"`,
    `git for-each-ref --format='rhead %(refname) %(symref)' 'refs/remotes/*/HEAD'`,
    `g=$(GLAB_NO_PROMPT=1 glab config get host 2>/dev/null)`,
    `printf 'glab %s\\n' "$g"`,
    `[ -n "$b" ] || exit 0`,
    `r=$(git config --get "branch.$b.remote")`,
    `m=$(git config --get "branch.$b.merge")`,
    `pr=$(git config --get "branch.$b.pushRemote")`,
    `printf 'remote %s\\nmerge %s\\npushremote %s\\n' "$r" "$m" "$pr"`,
    // The source remote, as mergeRequestSource picks it: only its URL and
    // host are read, which keeps a checkout with many remotes quick.
    `case "$m" in refs/heads/*) ;; *) r= ;; esac`,
    `[ "$r" = . ] && r=`,
    `r=\${r:-\${pr:-\${pd:-origin}}}`,
    // get-url applies url.<base>.insteadOf.
    `u=$(git remote get-url "$r" 2>/dev/null) || exit 0`,
    `printf 'url %s %s\\n' "$r" "$u"`,
    `h=$(printf '%s\\n' "$u" | sed -n -E -e 's#^[A-Za-z+]+://([^@/]*@)?([^/:]+).*#\\2#p' -e t -e 's#^([^@/:]*@)?([^/:]+):.*#\\2#p' | tr 'A-Z' 'a-z')`,
    `h=\${h#ssh.}`,
    `g=$(printf '%s\\n' "$g" | sed -e 's#^[A-Za-z]*://##' -e 's#/.*##' | tr 'A-Z' 'a-z')`,
    `{ [ -z "$h" ] || [ "$h" = "$g" ]; } && exit 0`,
    // Another host is a login when glab's config has a token of its own
    // for it: GITLAB_TOKEN and the like answer for any host, as does a
    // token for no host in particular, which a made-up host gets. Only
    // whether there is one is printed, never the token.
    `token() { (unset GITLAB_TOKEN GITLAB_ACCESS_TOKEN OAUTH_TOKEN; GLAB_NO_PROMPT=1 glab config get token --host "$1" 2>/dev/null); }`,
    `t=$(token "$h")`,
    `[ -n "$t" ] && [ "$t" != "$(token roamgate.invalid)" ] && printf 'login %s\\n' "$h"`,
    `exit 0`,
  ].join("\n");
}

export function parseCheckout(stdout: string): ReviewCheckout {
  const lines = new Map<string, string>();
  const remotes: Record<string, string> = {};
  const remoteHeads: Record<string, string> = {};
  const logins: string[] = [];
  for (const line of stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space < 0) continue;
    const kind = line.slice(0, space);
    const value = line.slice(space + 1).trim();
    if (kind === "url") {
      const match = /^(\S+)\s+(.+)$/.exec(value);
      if (match) remotes[match[1]!] = match[2]!;
    } else if (kind === "rhead") {
      const match = /^refs\/remotes\/(.+)\/HEAD\s+refs\/remotes\/(.+)$/.exec(
        value,
      );
      const [remote, target] = [match?.[1], match?.[2]];
      if (remote && target?.startsWith(`${remote}/`))
        remoteHeads[remote] = target.slice(remote.length + 1);
    } else if (kind === "login") {
      if (value) logins.push(value.toLowerCase());
    } else lines.set(kind, value);
  }
  const get = (kind: string) => lines.get(kind) || null;
  const remote = get("remote");
  const merge = get("merge");
  const glabHost = get("glab")
    ?.replace(/^[a-z]+:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  return {
    branch: get("branch"),
    head: get("head"),
    defaultBranch: get("default")?.replace(/^origin\//, "") ?? null,
    remoteHeads,
    // "." tracks a local branch, which no merge request comes from.
    upstream:
      remote && remote !== "." && merge?.startsWith("refs/heads/")
        ? { remote, branch: merge.slice("refs/heads/".length) }
        : null,
    pushRemote: get("pushremote") ?? get("pushdefault"),
    remotes,
    gitlabHost: glabHost || null,
    gitlabLogins: logins,
  };
}

/**
 * The remote and branch a merge request of the checkout's branch comes
 * from: its upstream when it has one, else the branch's own name on its
 * push remote (or origin). None for a detached HEAD, or when the branch
 * or its source is a default branch: a branch made from origin/main tracks
 * main, whose name an unrelated merge request may come from.
 */
export function mergeRequestSource(
  checkout: ReviewCheckout,
): { remote: string; branch: string; byName?: true } | null {
  const { branch, upstream } = checkout;
  const isDefault = (name: string, remote?: string) =>
    name === "main" ||
    name === "master" ||
    name === checkout.defaultBranch ||
    (remote !== undefined && name === checkout.remoteHeads[remote]);
  if (!branch || isDefault(branch)) return null;
  if (upstream && !isDefault(upstream.branch, upstream.remote)) return upstream;
  // No upstream, or one that only says where it started (git checkout -b
  // fix origin/main): the merge request is the branch's name, pushed to
  // its push remote or a fork of it.
  return { remote: checkout.pushRemote ?? "origin", branch, byName: true };
}

/**
 * The host and project path of a remote URL: ssh://, scp-like
 * (user@host:path) and http(s); null for local paths. An SSH port is not
 * part of the host.
 */
export function remoteProject(
  url: string,
): { host: string; project: string } | null {
  const full =
    /^(?:ssh|git\+ssh|https?):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(
      url,
    );
  const scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(url);
  // C:\path is a Windows path, not host C.
  const match = full ?? (scp && !/^[a-z]:[\\/]/i.test(url) ? scp : null);
  if (!match) return null;
  const project = match[2]!
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  if (!project.includes("/") || project.startsWith("~")) return null;
  return { host: match[1]!.toLowerCase(), project };
}

/** Whether a remote is on glab's host; GitLab often serves SSH on ssh.<host>. */
export function onGitlabHost(remoteHost: string, gitlabHost: string): boolean {
  return remoteHost === gitlabHost || remoteHost === `ssh.${gitlabHost}`;
}

/**
 * The GitLab host to ask about a remote's host: glab's default host, or
 * another one glab is logged in to; null when glab knows none.
 */
export function gitlabHostFor(
  remoteHost: string,
  checkout: Pick<ReviewCheckout, "gitlabHost" | "gitlabLogins">,
): string | null {
  if (checkout.gitlabHost && onGitlabHost(remoteHost, checkout.gitlabHost))
    return checkout.gitlabHost;
  const host = remoteHost.replace(/^ssh\./, "");
  return checkout.gitlabLogins.includes(host) ? host : null;
}

/** The merge request list is read a page at a time, up to this many. */
const MR_PAGE_SIZE = 100;
const MR_MAX_PAGES = 5;

/** The first open merge request from that source project in the list. */
export function pickMergeRequest(
  list: unknown,
  sourceProjectId: number,
  /** Also one into that project, from another (a fork's). */
  orTarget = false,
): Omit<BranchMergeRequest, "branch"> | null {
  if (!Array.isArray(list)) return null;
  for (const item of list as Record<string, unknown>[]) {
    if (
      item?.state === "opened" &&
      (item.source_project_id === sourceProjectId ||
        (orTarget && item.project_id === sourceProjectId)) &&
      typeof item.web_url === "string" &&
      typeof item.iid === "number"
    )
      return {
        url: item.web_url,
        title: String(item.title ?? ""),
        number: item.iid,
        state: "opened",
      };
  }
  return null;
}

/** The checkout's branch, its source remote and glab's host; it only reads. */
export async function readCheckout(
  context: GlabContext,
): Promise<ReviewCheckout> {
  const script = readCheckoutScript(context.root, context.shQuote);
  const result = await context.runProcessWithCodeTimeout(
    context.host
      ? sshReadCommandArgv(context.host, script, [], "review.checkout")
      : gitShellCommandArgv(script),
    TIMEOUT_MS,
  );
  if (result.code !== 0)
    throw reviewScriptError(
      result.stderr,
      "cannot read the checkout",
      context.root,
      undefined,
      300,
    );
  return parseCheckout(result.stdout);
}

/**
 * The open merge request whose source is the checkout's branch, matched by
 * its name only, null when there is none; it only reads. It lists the open
 * merge requests from branches of that name across the host (they live in
 * their target project) a page at a time, stopping at the first from the
 * source project, whose id, asked once, is remembered in `projectIds`.
 */
export async function findBranchMergeRequest(
  context: GlabContext,
  checkout: ReviewCheckout,
  projectIds: Map<string, number>,
): Promise<BranchMergeRequest | null> {
  const source = mergeRequestSource(checkout);
  const url = source ? checkout.remotes[source.remote] : undefined;
  const remote = url ? remoteProject(url) : null;
  const host = remote ? gitlabHostFor(remote.host, checkout) : null;
  if (!source || !remote || !host) return null;
  // Not glab's default host: a token from the environment is for that one.
  const ref = { host, ownLogin: host !== checkout.gitlabHost };
  const key = `${host}\n${remote.project}`;
  let id = projectIds.get(key);
  if (id === undefined) {
    const project = (await glab(
      context,
      ref,
      "GET",
      `projects/${encodeURIComponent(remote.project)}`,
    )) as { id?: unknown } | null;
    if (typeof project?.id !== "number")
      throw new Error(`GitLab: no project ${remote.project}`);
    id = project.id;
    projectIds.set(key, id);
  }
  const find = async (scope: string, orTarget: boolean) => {
    for (let page = 1; page <= MR_MAX_PAGES; page++) {
      const list = await glab(
        context,
        ref,
        "GET",
        `merge_requests?scope=${scope}&state=opened&source_branch=${encodeURIComponent(source.branch)}&per_page=${MR_PAGE_SIZE}&page=${page}`,
        [],
        false,
      );
      const match = pickMergeRequest(list, id, orTarget);
      if (match) return { ...match, branch: checkout.branch ?? "" };
      if (!Array.isArray(list) || list.length < MR_PAGE_SIZE) break;
    }
    return null;
  };
  // Known only by its name: the user's own, pushed to that project or to a
  // fork of it with the same branch name.
  return (
    (await find("all", false)) ??
    (source.byName ? await find("created_by_me", true) : null)
  );
}
