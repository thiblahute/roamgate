import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import type {
  HistoryBlocked,
  HistoryCommitInfo,
  HistoryError,
} from "../../../shared/history";
import type { HistoryArea } from "./area";
import { type GitRunner, gitOk, gitRunner } from "./git";
import { scanDiff } from "../utils/secrets";

/**
 * The history repo: a git repository of plain files (`<data>/history/` by
 * default), written by passes. A pass writes the areas it is given (only
 * the files whose content changed), removes the files they no longer
 * have, scans what is staged for secrets (a hit keeps that file out of the
 * commit, named in the status) and commits as Roamgate. Work changes come
 * first, one commit each, authored by whoever made them at the time they
 * made them. One pass at a time, across processes too (a lock directory in
 * `.git`): the server and `roamgate history commit` never write together.
 */

export const HISTORY_FORMAT = 1;
/** A lock older than this was left by a process that died. */
const STALE_LOCK_MS = 10 * 60_000;
const STATUS_FILE = "roamgate-status.json";
const LOCK_DIR = "roamgate-pass.lock";

const README = `# Roamgate history

This repository is written by Roamgate: what you and your agents authored in
it (the Work board, reviews and their comments, settings without secrets,
connections, the Reviews' state, companion memories, voice settings), as
plain files, committed as it changes. Roamgate keeps it up to date; do not
edit it by hand, your changes would be overwritten by the next pass.

- \`work/\`: the Work board, one Markdown file per item (\`git log -p --
  work/items/<id>.md\` is its history, each change authored by who made it).
- \`reviews/<year>/<review>/\`: a review's \`review.json\` and one Markdown
  file per thread; \`reviews/images/\` the pasted screenshots.
- \`settings/\`: one file per top-level key of settings.json.
- \`mr-reviews/\`, \`companion/\`, \`voice/\` and the top-level JSON files:
  the other areas.

Prose files carry what is not text in one-line JSON headers inside HTML
comments (\`<!-- roamgate:... {...} -->\`), invisible when rendered.
\`FORMAT\` is the layout's version. See Roamgate's docs/ARCHITECTURE.md,
"History".
`;

export type WorkCommit = {
  /** The item's file in the repo. */
  path: string;
  /** Its content after the change; null: the item was removed. */
  content: string | null;
  author: { name: string; email: string };
  /** When the change was made (ISO 8601). */
  date: string;
  subject: string;
  body?: string;
};

export type PassInput = {
  areas: { area: HistoryArea; ids: ReadonlySet<string> | null }[];
  work?: WorkCommit[];
  /** Skip `git gc --auto` (a game runs). */
  light?: boolean;
};

export type PassResult = {
  /** Another process holds the lock: nothing was done. */
  locked?: true;
  commits: number;
  blocked: HistoryBlocked[];
  errors: HistoryError[];
  ms: number;
};

export type RepoStatus = {
  exists: boolean;
  lastCommit: HistoryCommitInfo | null;
  commits: number;
  sizeBytes: number;
  files: Record<string, number>;
  lastPass: { at: string; ms: number; commits: number } | null;
  blocked: HistoryBlocked[];
  errors: HistoryError[];
};

type StatusFile = {
  lastPass?: { at: string; ms: number; commits: number };
  blocked?: HistoryBlocked[];
  errors?: HistoryError[];
};

function bytesOf(content: string | Uint8Array): Buffer {
  return typeof content === "string"
    ? Buffer.from(content, "utf8")
    : Buffer.from(content);
}

/** A repo path made safe: forward slashes, no `..`, nothing under `.git`. */
function checkedPath(path: string): string {
  const parts = path.split("/");
  if (
    !path ||
    path.startsWith("/") ||
    parts.some((part) => !part || part === "." || part === "..") ||
    parts[0] === ".git"
  )
    throw new Error(`bad history path ${path}`);
  return path;
}

export class HistoryRepo {
  readonly dir: string;
  readonly host: string;
  private readonly git: GitRunner;
  private readonly identity: { name: string; email: string };
  private readonly now: () => number;

  constructor(options: {
    dir: string;
    host: string;
    git?: GitRunner;
    lowPriority?: boolean;
    now?: () => number;
  }) {
    this.dir = options.dir;
    this.git =
      options.git ??
      gitRunner(options.dir, { lowPriority: options.lowPriority ?? false });
    this.host = options.host;
    this.identity = {
      name: "Roamgate",
      email: `roamgate@${options.host.replace(/[^A-Za-z0-9.-]+/g, "-") || "host"}`,
    };
    this.now = options.now ?? Date.now;
  }

  private get gitDir() {
    return join(this.dir, ".git");
  }

  private trailer() {
    return `Roamgate-Host: ${this.host}`;
  }

  private roamgateEnv(): Record<string, string> {
    return {
      GIT_AUTHOR_NAME: this.identity.name,
      GIT_AUTHOR_EMAIL: this.identity.email,
      GIT_COMMITTER_NAME: this.identity.name,
      GIT_COMMITTER_EMAIL: this.identity.email,
    };
  }

  async exists(): Promise<boolean> {
    try {
      return (await stat(join(this.gitDir, "HEAD"))).isFile();
    } catch {
      return false;
    }
  }

  /**
   * The repo there, made when missing (FORMAT and README.md committed).
   * Throws on a layout newer than this Roamgate.
   */
  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (!(await this.exists())) {
      await gitOk(this.git, ["init", "-q"]);
    }
    let format: number | null = null;
    try {
      format = Number.parseInt(
        await readFile(join(this.dir, "FORMAT"), "utf8"),
        10,
      );
    } catch {}
    if (format !== null && Number.isFinite(format) && format > HISTORY_FORMAT)
      throw new Error(
        `the history at ${this.dir} has format ${format}, newer than this Roamgate (${HISTORY_FORMAT})`,
      );
    let wrote = false;
    if (format === null) {
      await this.write("FORMAT", `${HISTORY_FORMAT}\n`);
      wrote = true;
    }
    try {
      await stat(join(this.dir, "README.md"));
    } catch {
      await this.write("README.md", README);
      wrote = true;
    }
    if (wrote) {
      await gitOk(this.git, ["add", "--", "FORMAT", "README.md"]);
      if (await this.staged())
        await this.commit("Start the Roamgate history", this.roamgateEnv());
    }
  }

  /** Writes a file when its content differs; true when it did. */
  private async write(path: string, content: string | Uint8Array) {
    const full = join(this.dir, ...checkedPath(path).split("/"));
    const bytes = bytesOf(content);
    try {
      const current = await readFile(full);
      if (current.equals(bytes)) return false;
    } catch {}
    await mkdir(dirname(full), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(full), `.roamgate-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, full);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return true;
  }

  private async remove(path: string) {
    const full = join(this.dir, ...checkedPath(path).split("/"));
    await rm(full, { force: true });
    // Empty directories left behind go too, up to the repo.
    let parent = dirname(full);
    while (parent !== this.dir && parent.startsWith(this.dir + sep)) {
      try {
        await rmdir(parent);
      } catch {
        break;
      }
      parent = dirname(parent);
    }
  }

  /**
   * The files under an owned path, repo-relative; a `*` segment stands for
   * any directory there.
   */
  private async filesUnder(owned: string): Promise<string[]> {
    const star = owned.split("/").indexOf("*");
    if (star >= 0) {
      const parts = owned.split("/");
      const base = parts.slice(0, star).join("/");
      let names: string[] = [];
      try {
        names = (
          await readdir(join(this.dir, ...base.split("/").filter(Boolean)), {
            withFileTypes: true,
          })
        )
          .filter((entry) => entry.isDirectory() && entry.name !== ".git")
          .map((entry) => entry.name);
      } catch {}
      const out: string[] = [];
      for (const name of names)
        out.push(
          ...(await this.filesUnder(
            [...parts.slice(0, star), name, ...parts.slice(star + 1)].join("/"),
          )),
        );
      return out;
    }
    const full = join(this.dir, ...owned.replace(/\/$/, "").split("/"));
    if (!owned.endsWith("/")) {
      try {
        return (await stat(full)).isFile() ? [owned] : [];
      } catch {
        return [];
      }
    }
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== ".git") await walk(path);
        } else if (!entry.name.startsWith(".roamgate-"))
          out.push(relative(this.dir, path).split(sep).join("/"));
      }
    };
    await walk(full);
    return out;
  }

  private async staged(paths: string[] = []): Promise<string[]> {
    const out = await gitOk(this.git, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--no-renames",
      "--",
      ...paths,
    ]);
    return out.split("\0").filter(Boolean);
  }

  /** Secret hits in what is staged; their files unstaged. */
  private async blockSecrets(): Promise<HistoryBlocked[]> {
    const diff = await gitOk(this.git, [
      "diff",
      "--cached",
      "-U0",
      "--no-color",
      "--no-ext-diff",
      "--no-renames",
      "--text",
    ]);
    const hits = scanDiff(diff);
    if (!hits.length) return [];
    const files = [...new Set(hits.map((hit) => hit.file))];
    await this.unstage(files);
    return hits.map((hit) => ({ ...hit }));
  }

  private async unstage(files: string[]) {
    if (!files.length) return;
    const head = await this.git(["rev-parse", "-q", "--verify", "HEAD"]);
    if (head.code === 0)
      await gitOk(this.git, ["reset", "-q", "HEAD", "--", ...files]);
    else await gitOk(this.git, ["rm", "-q", "--cached", "--", ...files]);
  }

  private async commit(message: string, env: Record<string, string>) {
    await gitOk(
      this.git,
      ["commit", "-q", "--no-verify", "--no-gpg-sign", "-F", "-"],
      { env, input: `${message.trim()}\n\n${this.trailer()}\n` },
    );
  }

  private async lock(): Promise<boolean> {
    const path = join(this.gitDir, LOCK_DIR);
    try {
      await mkdir(path);
      return true;
    } catch {
      try {
        const age = this.now() - (await stat(path)).mtimeMs;
        if (age > STALE_LOCK_MS) {
          await rm(path, { recursive: true, force: true });
          await mkdir(path);
          return true;
        }
      } catch {}
      return false;
    }
  }

  private async unlock() {
    await rm(join(this.gitDir, LOCK_DIR), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }

  /** One pass: the Work changes one commit each, then the areas in one. */
  async pass(input: PassInput): Promise<PassResult> {
    const started = this.now();
    await this.ensure();
    if (!(await this.lock()))
      return { locked: true, commits: 0, blocked: [], errors: [], ms: 0 };
    const errors: HistoryError[] = [];
    const blocked: HistoryBlocked[] = [];
    let commits = 0;
    const at = () => new Date(this.now()).toISOString();
    try {
      for (const change of input.work ?? []) {
        try {
          if (change.content === null) await this.remove(change.path);
          else await this.write(change.path, change.content);
          const tracked =
            (await this.git(["ls-files", "--error-unmatch", "--", change.path]))
              .code === 0;
          if (change.content === null && !tracked) continue;
          await gitOk(this.git, ["add", "-A", "--", change.path]);
          if (!(await this.staged([change.path])).length) continue;
          const hits = await this.blockSecrets();
          blocked.push(...hits);
          if (!(await this.staged()).length) continue;
          await this.commit(
            `${change.subject}${change.body ? `\n\n${change.body}` : ""}`,
            {
              ...this.roamgateEnv(),
              GIT_AUTHOR_NAME: change.author.name,
              GIT_AUTHOR_EMAIL: change.author.email,
              GIT_AUTHOR_DATE: change.date,
            },
          );
          commits++;
        } catch (error) {
          errors.push({
            area: "work",
            message: error instanceof Error ? error.message : String(error),
            at: at(),
          });
        }
      }
      const owners: { prefix: string; area: HistoryArea }[] = [];
      for (const { area, ids } of input.areas) {
        try {
          const render = await area.render(ids);
          for (const owned of render.owns) owners.push({ prefix: owned, area });
          for (const [path, content] of render.files)
            await this.write(path, content);
          for (const owned of render.owns)
            for (const path of await this.filesUnder(owned))
              if (!render.files.has(path)) await this.remove(path);
        } catch (error) {
          errors.push({
            area: area.name,
            message: error instanceof Error ? error.message : String(error),
            at: at(),
          });
        }
      }
      await gitOk(this.git, ["add", "-A"]);
      if ((await this.staged()).length) {
        blocked.push(...(await this.blockSecrets()));
        const paths = await this.staged();
        if (paths.length) {
          await this.commit(this.message(paths, owners), this.roamgateEnv());
          commits++;
        }
      }
      if (commits && !input.light)
        await this.git(["gc", "--auto", "--quiet"]).catch(() => undefined);
    } catch (error) {
      errors.push({
        message: error instanceof Error ? error.message : String(error),
        at: at(),
      });
    } finally {
      const ms = this.now() - started;
      await this.writeStatus({
        lastPass: { at: at(), ms, commits },
        blocked: dedupe(blocked),
        errors,
      }).catch(() => undefined);
      await this.unlock();
    }
    return {
      commits,
      blocked: dedupe(blocked),
      errors,
      ms: this.now() - started,
    };
  }

  /** "work: 2 items; reviews: 3 threads in 2 reviews". */
  private message(
    paths: readonly string[],
    owners: readonly { prefix: string; area: HistoryArea }[],
  ): string {
    const byArea = new Map<HistoryArea | null, string[]>();
    for (const path of paths) {
      const owner =
        owners.find(({ prefix }) => ownedBy(prefix, path))?.area ?? null;
      byArea.set(owner, [...(byArea.get(owner) ?? []), path]);
    }
    const parts = [...byArea].map(([area, changed]) => {
      const name = area?.name ?? "history";
      const what =
        area?.describe?.(changed) ||
        `${changed.length} file${changed.length === 1 ? "" : "s"}`;
      return `${name}: ${what}`;
    });
    const subject = parts.join("; ");
    const listed = paths.slice(0, 40).map((path) => `- ${path}`);
    if (paths.length > 40) listed.push(`- and ${paths.length - 40} more`);
    return `${subject.length > 200 ? `${subject.slice(0, 197)}...` : subject}\n\n${listed.join("\n")}`;
  }

  private async writeStatus(file: StatusFile) {
    const path = join(this.gitDir, STATUS_FILE);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  }

  private async readStatus(): Promise<StatusFile> {
    try {
      return JSON.parse(
        await readFile(join(this.gitDir, STATUS_FILE), "utf8"),
      ) as StatusFile;
    } catch {
      return {};
    }
  }

  async status(): Promise<RepoStatus> {
    const empty: RepoStatus = {
      exists: false,
      lastCommit: null,
      commits: 0,
      sizeBytes: 0,
      files: {},
      lastPass: null,
      blocked: [],
      errors: [],
    };
    if (!(await this.exists())) return empty;
    const file = await this.readStatus();
    const log = await this.git([
      "log",
      "-1",
      "--format=%H%x00%s%x00%aI%x00%an",
    ]);
    const [sha, subject, date, author] = log.stdout.trim().split("\0");
    const count = await this.git(["rev-list", "--count", "HEAD"]);
    const listed = await this.git(["ls-files", "-z"]);
    const files: Record<string, number> = {};
    for (const path of listed.stdout.split("\0").filter(Boolean)) {
      const top = path.includes("/")
        ? path.slice(0, path.indexOf("/"))
        : path.replace(/\.json$/, "");
      files[top] = (files[top] ?? 0) + 1;
    }
    return {
      exists: true,
      lastCommit:
        log.code === 0 && sha
          ? {
              sha,
              subject: subject ?? "",
              at: date ?? "",
              author: author ?? "",
            }
          : null,
      commits: count.code === 0 ? Number(count.stdout.trim()) || 0 : 0,
      sizeBytes: await sizeOf(this.dir),
      files,
      lastPass: file.lastPass ?? null,
      blocked: file.blocked ?? [],
      errors: file.errors ?? [],
    };
  }

  /** The git runner, for tests and the CLI's log. */
  run(args: string[]) {
    return this.git(args);
  }
}

/** Whether a path is under an owned path (`*`: any one directory). */
export function ownedBy(owned: string, path: string): boolean {
  const pattern = new RegExp(
    `^${owned
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]+")}${owned.endsWith("/") ? "" : "$"}`,
  );
  return pattern.test(path);
}

function dedupe(hits: HistoryBlocked[]): HistoryBlocked[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.file}:${hit.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Bytes used by a directory tree (the repo with its .git). */
export async function sizeOf(dir: string): Promise<number> {
  let total = 0;
  const walk = async (path: string) => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile())
        try {
          total += (await stat(full)).size;
        } catch {}
    }
  };
  await walk(dir);
  return total;
}
