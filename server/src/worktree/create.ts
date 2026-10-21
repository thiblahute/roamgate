import { sshCommandArgv } from "../bridge/ssh-command";
import { fetchOriginDefaultBranch } from "../workspace/default-branch";
import { GIT_PULL_TIMEOUT_MS } from "../workspace/file-constants";
import type { RunProcessWithCodeTimeout } from "../workspace/file-types";
import type { LegacyConnectionRuntime } from "../connections/runtime";
import { assertUnixHost } from "../connections/unix-only";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import {
  readGuiSettings,
  workspaceRepoSettingsKey,
  worktreeCommandFor,
} from "../config/gui-settings";
import type { WorktreeHookExpectation } from "./worktree-hooks";

type GitRootResolver = (workspaceId: string) => Promise<{ root: string }>;

/** Refresh origin's default branch without changing the source checkout. */
export async function syncWorktreeBase({
  workspaceId,
  resolveGitRoot,
  host,
  shQuote,
  runProcessWithCodeTimeout,
}: {
  workspaceId: string;
  resolveGitRoot: GitRootResolver;
  host?: string;
  shQuote: (value: string) => string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
}) {
  if (!workspaceId) throw new Error("worktree.create requires workspace_id");
  const { root } = await resolveGitRoot(workspaceId);
  const runGit = (args: string) => {
    const command = `GIT_TERMINAL_PROMPT=0 git -C ${shQuote(root)} ${args}`;
    return runProcessWithCodeTimeout(
      host ? sshCommandArgv(host, command) : ["sh", "-lc", command],
      GIT_PULL_TIMEOUT_MS,
    );
  };
  try {
    return {
      workspace_id: workspaceId,
      root,
      ...(await fetchOriginDefaultBranch(runGit, shQuote)),
    };
  } catch (error) {
    // A repository without an origin has nothing to refresh: branch from the
    // commit that is checked out instead of failing.
    if (!/'origin' does not appear to be a git repository/.test(String(error)))
      throw error;
    const probe = async () => {
      if ((await runGit("remote get-url origin")).code === 0) return null;
      const head = await runGit("rev-parse --verify 'HEAD^{commit}'");
      return head.code === 0 ? head.stdout.trim() : null;
    };
    const commit = await probe().catch(() => null);
    if (!commit) throw error;
    return {
      workspace_id: workspaceId,
      root,
      base: "HEAD",
      commit,
      command: "",
      stdout: "",
      stderr: "",
    };
  }
}

/** Checkout path for `branch` inside the repository's configured directory. */
export function worktreeCheckoutPath(directory: string, branch: string) {
  const name = branch
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "");
  if (!name) throw new Error("Worktree branch name is empty.");
  return `${directory.replace(/\/+$/, "")}/${name}`;
}

/** A worktree command may check out a large tree and its nested repositories. */
export const WORKTREE_COMMAND_TIMEOUT_MS = 300_000;

/** Herdr's worktree.create default, `~/.herdr/worktrees/<repo>/<branch slug>`. */
export function herdrDefaultCheckoutPath(repoName: string, branch: string) {
  const slug = branch
    .replace(/[^A-Za-z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
  return `~/.herdr/worktrees/${repoName}/${slug || "worktree"}`;
}

/** Quotes a path for the shell, leaving a leading `~/` to the host's $HOME. */
export function shQuotePath(path: string) {
  return path.startsWith("~/")
    ? `"$HOME"/${shQuote(path.slice(2))}`
    : shQuote(path);
}

/** Substitutes `{path}`, `{branch}`, `{base}` and `{repo}`, each shell-quoted. */
export function renderWorktreeCommand(
  template: string,
  values: { path: string; branch: string; base: string; repo: string },
) {
  return template.replace(/\{(path|branch|base|repo)\}/g, (_, name) =>
    name === "path"
      ? shQuotePath(values.path)
      : shQuote(values[name as "branch" | "base" | "repo"]),
  );
}

/** Shared by the workspace UI and Ranger's confirmed operations. */
export async function createWorkspaceWorktree(
  runtime: LegacyConnectionRuntime,
  params: Record<string, unknown>,
  isCurrent: () => boolean,
  parentWarning: (error: unknown) => void = () => {},
  syncBase = syncWorktreeBase,
  beforeDispatch?: () => void,
  {
    readSettings = readGuiSettings,
    runProcess = runProcessWithCodeTimeout,
  }: {
    readSettings?: typeof readGuiSettings;
    runProcess?: RunProcessWithCodeTimeout;
  } = {},
) {
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error("The worktree target changed.");
  };
  const beforeSend = () => {
    assertCurrent();
    beforeDispatch?.();
  };
  assertCurrent();
  assertUnixHost(runtime, "Worktree creation");
  const {
    expected_setup_hook: expectedCommand,
    expected_hooks_enabled: expectedEnabled,
    expected_source_root: expectedRoot,
    ...createParams
  } = params;
  const guardedRoot = Object.hasOwn(params, "expected_source_root");
  if (guardedRoot && (typeof expectedRoot !== "string" || !expectedRoot.trim()))
    throw new Error("Confirmed source repository is invalid.");
  let expected: WorktreeHookExpectation | undefined;
  if (
    Object.hasOwn(params, "expected_setup_hook") ||
    Object.hasOwn(params, "expected_hooks_enabled")
  ) {
    if (
      (typeof expectedCommand !== "string" && expectedCommand !== null) ||
      typeof expectedEnabled !== "boolean"
    )
      throw new Error("Confirmed setup hook configuration is invalid.");
    expected = { command: expectedCommand, enabled: expectedEnabled };
  }
  const sourceWorkspace =
    await runtime.worktreeHooks.sourceWorkspaceForWorktreeCreate(createParams);
  assertCurrent();
  const workspaceId = String(createParams.workspace_id ?? "");
  const resolveGitRoot: GitRootResolver = async (id) => {
    assertCurrent();
    const result = await runtime.files.resolveWorkspaceGitRoot({
      workspace_id: id,
    });
    assertCurrent();
    if (guardedRoot && result.root !== expectedRoot)
      throw new Error("The worktree source repository changed.");
    return result;
  };
  const baseSync = await syncBase({
    workspaceId,
    resolveGitRoot,
    host: runtime.sshHost(),
    shQuote,
    runProcessWithCodeTimeout: async (argv, timeout) => {
      beforeSend();
      const result = await runProcess(argv, timeout);
      assertCurrent();
      return result;
    },
  });
  assertCurrent();
  const rpcParams: Record<string, unknown> = {
    ...createParams,
    base: baseSync.commit,
  };
  const key = workspaceRepoSettingsKey(
    sourceWorkspace,
    runtime.sshHost(),
    runtime.identity?.id,
  );
  const settings = await readSettings();
  assertCurrent();
  const command = worktreeCommandFor(settings, key);
  if (!rpcParams.path && typeof rpcParams.branch === "string") {
    const directory = key
      ? settings.repositories[key]?.worktree_directory
      : undefined;
    if (directory)
      rpcParams.path = worktreeCheckoutPath(directory, rpcParams.branch);
  }
  if (guardedRoot) {
    if (baseSync.root !== expectedRoot)
      throw new Error("The worktree source repository changed.");
    await resolveGitRoot(workspaceId);
    delete rpcParams.workspace_id;
    rpcParams.cwd = expectedRoot;
  }
  assertCurrent();
  // A command missing on this host (git recworktree not installed there)
  // falls back to Herdr's own worktree.
  const result =
    (command
      ? await runWorktreeCommand(runtime, command, rpcParams, baseSync, {
          runProcess,
          repoName:
            sourceWorkspace?.worktree?.repo_name ||
            baseSync.root.replace(/\/+$/, "").split("/").pop() ||
            "",
          assertCurrent,
          beforeSend,
        })
      : null) ??
    (await runtime.herdr.call(
      "worktree.create",
      rpcParams,
      undefined,
      beforeSend,
    ));
  assertCurrent();
  let parentTrackingFailed = false;
  await runtime.worktreeParents
    .rememberWorktreeParent(result, workspaceId, isCurrent)
    .catch((error) => {
      parentTrackingFailed = true;
      parentWarning(error);
    });
  assertCurrent();
  const hookSourceWorkspace = sourceWorkspace
    ? {
        ...sourceWorkspace,
        cwd:
          sourceWorkspace.worktree?.checkout_path ||
          sourceWorkspace.cwd ||
          baseSync.root,
      }
    : { cwd: baseSync.root };
  const setupHook = await runtime.worktreeHooks.runWorktreeSetupHook(
    result,
    hookSourceWorkspace,
    expected,
    isCurrent,
  );
  assertCurrent();
  return {
    ...result,
    base_sync: baseSync,
    setup_hook: setupHook,
    ...(parentTrackingFailed ? { parent_tracking_failed: true } : {}),
  };
}

/** The shell's or git's answer for a command that is not installed. */
const COMMAND_MISSING = /command not found|is not a git command/;

/** Whether a worktree command failed only because it is not installed. */
export function worktreeCommandMissing(run: {
  code: number;
  stdout: string;
  stderr: string;
}) {
  return (
    run.code === 127 ||
    (run.code !== 0 &&
      !run.stdout.trim() &&
      COMMAND_MISSING.test(run.stderr.split("\n")[0] ?? ""))
  );
}

/**
 * Creates the checkout with the configured command on the connection's host,
 * then registers it with Herdr through worktree.open. The reply has the shape
 * of Herdr's worktree.create result; null when the command is not installed
 * on that host.
 */
async function runWorktreeCommand(
  runtime: LegacyConnectionRuntime,
  template: string,
  rpcParams: Record<string, unknown>,
  baseSync: { root: string; commit: string },
  {
    runProcess,
    repoName,
    assertCurrent,
    beforeSend,
  }: {
    runProcess: RunProcessWithCodeTimeout;
    repoName: string;
    assertCurrent: () => void;
    beforeSend: () => void;
  },
) {
  const branch = typeof rpcParams.branch === "string" ? rpcParams.branch : "";
  if (!branch.trim()) throw new Error("worktree.create requires branch");
  const path =
    typeof rpcParams.path === "string" && rpcParams.path.trim()
      ? rpcParams.path.trim()
      : herdrDefaultCheckoutPath(repoName, branch);
  if (!path.startsWith("/") && !path.startsWith("~/"))
    throw new Error("Worktree path must be absolute.");
  // Then the checkout's absolute path, `~` resolved on its host: what
  // Herdr opens.
  const shellCommand = `cd ${shQuote(baseSync.root)} && ${renderWorktreeCommand(
    template,
    { path, branch, base: baseSync.commit, repo: baseSync.root },
  )} && cd ${shQuotePath(path)} && printf '\\n%s\\n' "$PWD"`;
  const host = runtime.sshHost();
  beforeSend();
  const run = await runProcess(
    host
      ? sshCommandArgv(host, shellCommand, [], "worktree-command")
      : ["sh", "-lc", shellCommand],
    WORKTREE_COMMAND_TIMEOUT_MS,
  );
  assertCurrent();
  if (worktreeCommandMissing(run)) return null;
  if (run.code !== 0) {
    const output = (run.stderr.trim() || run.stdout.trim()).slice(-2000);
    throw new Error(
      `Worktree command failed (exit ${run.code})${output ? `: ${output}` : "."}`,
    );
  }
  const created = run.stdout.trim().split("\n").pop()?.trim() ?? "";
  if (!created.startsWith("/"))
    throw new Error("The worktree command left no checkout at its path.");
  const openParams: Record<string, unknown> = { path: created };
  for (const name of [
    "workspace_id",
    "cwd",
    "focus",
    "label",
    "trust_repository",
  ])
    if (rpcParams[name] !== undefined) openParams[name] = rpcParams[name];
  const opened = await runtime.herdr.call(
    "worktree.open",
    openParams,
    undefined,
    beforeSend,
  );
  delete opened?.already_open;
  return opened;
}
