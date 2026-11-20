/**
 * The Work board: work items on a kanban by state, one project at a time,
 * each item a thread for the session (or subagent) that owns it, linked to
 * what it is about (a review thread, an effort part, a request, a commit,
 * a decision in an RFC or plan), done by itself once what it links to
 * landed where its project says. Built on the effort model: a project is
 * an effort with no git source, its items its parts (plans/work-view.md).
 */

export const WORK_STATES = ["you", "doing", "verify", "open", "done"] as const;
export type WorkState = (typeof WORK_STATES)[number];

export const WORK_STATE_TITLE: Record<WorkState, string> = {
  you: "For you",
  doing: "Doing",
  verify: "Verify",
  open: "Open",
  done: "Done",
};

/** The states an item is live in: everything but done. */
export const WORK_OPEN_STATES: readonly WorkState[] = [
  "you",
  "doing",
  "verify",
  "open",
];

export function isWorkState(value: unknown): value is WorkState {
  return (WORK_STATES as readonly string[]).includes(value as string);
}

/**
 * When an item's commit counts as landed. `deployed`: the running build of
 * this Roamgate holds it (server/public/.built-from). `branch`: it is
 * reachable from that branch in that checkout (`gstreamer2/main`).
 */
export type WorkDoneRule =
  | { kind: "deployed" }
  | { kind: "branch"; root: string; branch: string; connectionId?: string };

export type WorkProject = {
  id: string;
  name: string;
  /** The checkouts it spans, on their connections. */
  roots: { connectionId: string; path: string }[];
  done: WorkDoneRule;
  /** Tags it suggests (the ones its items used are suggested too). */
  tags?: string[];
  /**
   * The session that takes the project's items nobody owns: an item added
   * or reopened with no owner is its, and told to it as a review comment
   * is; so is a comment on an item whose owner is gone.
   */
  coordinator?: { session: string };
};

/** Who works on an item: a session, or one of its background subagents. */
export type WorkOwner = {
  /** The session's address, `connection/pane`, as agent_sessions lists it. */
  session: string;
  /** A background task (subagent) of that session: its id. */
  task?: string;
};

export type WorkLink =
  | { kind: "review"; id: string; thread?: string }
  | { kind: "effort"; id: string; part?: string }
  | { kind: "pr"; url: string }
  | { kind: "commit"; sha: string; subject?: string; root?: string }
  | { kind: "branch"; name: string; root?: string }
  /** A decision of an RFC or plan file: the file and its id (D13). */
  | { kind: "decision"; path: string; id: string }
  /** Another item this one waits for. */
  | { kind: "item"; id: string }
  /** Set when the done rule found the commit: where it landed. */
  | { kind: "deploy"; sha: string; branch?: string };

export const WORK_LINK_KINDS = [
  "review",
  "effort",
  "pr",
  "commit",
  "branch",
  "decision",
  "item",
  "deploy",
] as const;

export type WorkItem = {
  id: string;
  project: string;
  title: string;
  state: WorkState;
  tags: string[];
  owner?: WorkOwner;
  /**
   * Where it came from, in a few words: a review thread id, "imported from
   * STATUS.md line 12", a voice job. One item per source: adding the same
   * source again changes the item instead.
   */
  source?: string;
  links: WorkLink[];
  createdAt: string;
  updatedAt: string;
  /** When it entered done (cleared when reopened). */
  doneAt?: string;
  /** Who last changed it. */
  by: "user" | "agent";
  /** The item's review (its thread), once one was made. */
  review?: string;
};

export type WorkPushKind = "items" | "projects" | "item";

/** What the server pushes to every page when the board changes. */
export type WorkPush = {
  changed: WorkPushKind[];
  /** The item changed, when one was. */
  item?: string;
  by: "user" | "agent";
  /** What the agent did, in a few words. */
  summary?: string;
};

export type WorkBoard = {
  projects: WorkProject[];
  items: WorkItem[];
  /** The deployed build, when known (the Roamgate project's rule). */
  deployed?: string;
};

export const WORK_LIMITS = {
  items: 2000,
  projects: 50,
  titleChars: 300,
  tagChars: 40,
  tagsPerItem: 12,
  linksPerItem: 30,
} as const;

/** An item's or project's id: 8 to 16 hex characters, as review ids are. */
export const WORK_ID = /^[0-9a-f]{8,16}$/;

export { WORK_NO_OWNER, WORK_SESSION_PREFIX } from "./review";

/** A tag as stored: lower case, spaces as dashes, 40 characters at most. */
export function normalizeWorkTag(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/\s+/g, "-")
    .slice(0, WORK_LIMITS.tagChars);
}

export function normalizeWorkTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = normalizeWorkTag(raw);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, WORK_LIMITS.tagsPerItem);
}

/**
 * A TODO thread's title line: `**state** Title` (the coordinator's
 * convention on plans/todo.md). Without the state word, the line is the
 * title and the state is null.
 */
export function parseWorkTitle(line: string): {
  state: WorkState | null;
  title: string;
} {
  const first = line.split("\n")[0]?.trim() ?? "";
  const match = /^\*\*([a-z-]+)\*\*\s*[:-]?\s*(.*)$/i.exec(first);
  if (match) {
    const word = match[1]!.toLowerCase();
    const state = word === "for-you" || word === "foryou" ? "you" : word;
    if (isWorkState(state)) return { state, title: match[2]!.trim() };
  }
  return {
    state: null,
    title: first.replace(/^#+\s*/, "").replace(/^[-*]\s+/, ""),
  };
}

/** The items of a board that a filter keeps: project, tags (all), states. */
export function filterWorkItems(
  items: readonly WorkItem[],
  filter: {
    project?: string;
    tags?: readonly string[];
    states?: readonly WorkState[];
    owner?: string;
    query?: string;
  },
): WorkItem[] {
  const words = (filter.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (filter.project && item.project !== filter.project) return false;
    if (filter.tags?.length && !filter.tags.every((t) => item.tags.includes(t)))
      return false;
    if (filter.states?.length && !filter.states.includes(item.state))
      return false;
    if (filter.owner && item.owner?.session !== filter.owner) return false;
    if (words.length) {
      const hay = [item.title, ...item.tags, item.owner?.session ?? ""]
        .join("\n")
        .toLowerCase();
      if (!words.every((word) => hay.includes(word))) return false;
    }
    return true;
  });
}

/** The tags the items of a project use, most used first. */
export function workTagsOf(items: readonly WorkItem[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items)
    for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

/** A link in a few words, for a card's chip or a tool's answer. */
export function describeWorkLink(link: WorkLink): string {
  switch (link.kind) {
    case "review":
      return `review ${link.id.slice(0, 8)}${link.thread ? ` thread ${link.thread.slice(0, 8)}` : ""}`;
    case "effort":
      return `effort ${link.id}${link.part ? ` part ${link.part}` : ""}`;
    case "pr":
      return link.url.replace(/^https?:\/\//, "");
    case "commit":
      return `${link.sha.slice(0, 10)}${link.subject ? ` ${link.subject}` : ""}`;
    case "branch":
      return `branch ${link.name}`;
    case "decision":
      return `${link.path.split("/").pop() ?? link.path} ${link.id}`;
    case "item":
      return `after ${link.id.slice(0, 8)}`;
    case "deploy":
      return `landed ${link.sha.slice(0, 10)}${link.branch ? ` on ${link.branch}` : ""}`;
  }
}

/** The owner as shown: `connection/pane`, with its task. */
export function describeWorkOwner(owner: WorkOwner): string {
  return owner.task
    ? `${owner.session} (task ${owner.task.slice(0, 8)})`
    : owner.session;
}

/**
 * The thread that holds an item's description: the one made with the item
 * (anchor `work.description`), whose first comment is the text it was
 * added with; for an item made before that mark, the earliest thread on
 * the item itself (no quote, not adopted) written within a minute of it.
 */
export function workDescriptionThread<
  T extends {
    anchor: { work?: { description?: true; quote?: string; from?: unknown } };
    createdAt: string;
  },
>(threads: readonly T[], item: Pick<WorkItem, "createdAt">): T | null {
  const marked = threads.find((thread) => thread.anchor.work?.description);
  if (marked) return marked;
  const made = new Date(item.createdAt).getTime();
  if (Number.isNaN(made)) return null;
  const early = threads
    .filter((thread) => {
      const work = thread.anchor.work;
      if (!work || work.quote || work.from) return false;
      const at = new Date(thread.createdAt).getTime();
      return at >= made - 1_000 && at <= made + 60_000;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return early[0] ?? null;
}
