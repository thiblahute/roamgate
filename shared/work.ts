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
  /**
   * Added as free text by the user and not sorted yet: its title is the
   * text's first line until its owner (the coordinator) gives it a clear
   * one, tags and a state, splits it when it holds several tasks, and
   * clears this.
   */
  needsTriage?: true;
  /**
   * For you and Verify: what the user has to do, in one or two sentences
   * ("Choose: media to the car with the phone mic, or no music on car
   * links", "Dictate once after 10 idle minutes; text should appear").
   * Cleared when the item leaves those states.
   */
  ask?: string;
  /** For a decision: a few short answers, one tap each (a comment). */
  answers?: string[];
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
  askChars: 400,
  answers: 6,
  answerChars: 80,
} as const;

/** The states whose items say what the user has to do (`ask`). */
export const WORK_ASK_STATES: readonly WorkState[] = ["you", "verify"];

export function workStateAsks(state: WorkState): boolean {
  return WORK_ASK_STATES.includes(state);
}

/**
 * What a card shows as the user's to do: the ask of a For you or Verify
 * item, with its answers; null in the other states or without an ask.
 */
export function workAskOf(
  item: Pick<WorkItem, "state" | "ask" | "answers">,
): { ask: string; answers: string[] } | null {
  if (!workStateAsks(item.state) || !item.ask?.trim()) return null;
  return { ask: item.ask.trim(), answers: item.answers ?? [] };
}

/**
 * Answers as stored: one line each, trimmed to 80 characters, empty and
 * repeated ones (whatever their case) dropped, 6 at most.
 */
export function normalizeWorkAnswers(answers: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of answers) {
    const answer = raw.replace(/\s+/g, " ").trim();
    const short =
      answer.length > WORK_LIMITS.answerChars
        ? `${answer.slice(0, WORK_LIMITS.answerChars - 1).trimEnd()}\u2026`
        : answer;
    const key = short.toLowerCase();
    if (!short || seen.has(key)) continue;
    seen.add(key);
    out.push(short);
  }
  return out.slice(0, WORK_LIMITS.answers);
}

/** An item's or project's id: 8 to 16 hex characters, as review ids are. */
export const WORK_ID = /^[0-9a-f]{8,16}$/;

/** How long an item's provisional title (its text's first line) is. */
export const WORK_PROVISIONAL_TITLE_CHARS = 80;

/**
 * The title an item added as free text has until it is sorted: the
 * text's first line with words (no image, heading or list mark), trimmed
 * to 80 characters with an ellipsis.
 */
export function provisionalWorkTitle(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/^\s*#+\s*/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    return line.length > WORK_PROVISIONAL_TITLE_CHARS
      ? `${line.slice(0, WORK_PROVISIONAL_TITLE_CHARS - 1).trimEnd()}\u2026`
      : line;
  }
  return "New item";
}

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

/**
 * A search of the board: `#voice` or `tag:voice` keeps the items with
 * that tag (each one named, all of them), the other words are searched
 * for in titles, tags and owners. The tag still being typed (the last
 * word, no space after it) is `partial`: the tags it begins.
 */
export function parseWorkQuery(query: string): {
  words: string[];
  tags: string[];
  partial?: string;
} {
  const words: string[] = [];
  const tags: string[] = [];
  let partial: string | undefined;
  const all = query.toLowerCase().split(/\s+/).filter(Boolean);
  const typing = !/\s$/.test(query);
  all.forEach((word, at) => {
    const tag = /^(?:#|tag:)(.+)$/.exec(word)?.[1];
    if (tag) {
      const normal = normalizeWorkTag(tag);
      if (!normal) return;
      if (typing && at === all.length - 1) partial = normal;
      else if (!tags.includes(normal)) tags.push(normal);
    } else if (word !== "#" && word !== "tag:") words.push(word);
  });
  return { words, tags, ...(partial ? { partial } : {}) };
}

/**
 * The tags the search's last word can be completed to, when it starts
 * one (`#vo`, `tag:vo`): those beginning with what is typed first, then
 * those holding it; each with the search it makes (the word replaced by
 * `#tag` and a space).
 */
export function workTagCompletions(
  query: string,
  tags: readonly string[],
): { tag: string; insert: string }[] {
  const last = /(?:^|\s)((?:#|tag:)\S*)$/i.exec(query);
  if (!last) return [];
  const typed = normalizeWorkTag(last[1]!.replace(/^(?:#|tag:)/i, ""));
  const head = query.slice(0, query.length - last[1]!.length);
  const taken = new Set(parseWorkQuery(`${head} `).tags);
  const open = tags.filter((tag) => !taken.has(tag) && tag !== typed);
  const first = open.filter((tag) => tag.startsWith(typed));
  const inside = typed
    ? open.filter((tag) => !tag.startsWith(typed) && tag.includes(typed))
    : [];
  return [...first, ...inside].map((tag) => ({
    tag,
    insert: `${head}#${tag} `,
  }));
}

/** The search with `#tag` added, unless it names that tag already. */
export function workQueryWithTag(query: string, tag: string): string {
  if (parseWorkQuery(`${query} `).tags.includes(tag)) return query;
  const base = query.trimEnd();
  return `${base ? `${base} ` : ""}#${tag} `;
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
  const { words, tags: named, partial } = parseWorkQuery(filter.query ?? "");
  const tags = [...(filter.tags ?? []), ...named];
  return items.filter((item) => {
    if (filter.project && item.project !== filter.project) return false;
    if (tags.length && !tags.every((t) => item.tags.includes(t))) return false;
    if (partial && !item.tags.some((t) => t.startsWith(partial))) return false;
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
      // The decisions' rule: no commit, the branch says how they were found.
      if (link.sha === "decision")
        return `decisions ${link.branch ?? "ticked"}`;
      return `landed ${link.sha.slice(0, 10)}${link.branch ? ` on ${link.branch}` : ""}`;
  }
}

/** A request's number as its forge writes it: `!123` (GitLab), `#123`. */
export function workPrRef(url: string): string | null {
  const gitlab = /\/-\/merge_requests\/(\d+)/.exec(url);
  if (gitlab) return `!${gitlab[1]}`;
  const github = /\/pulls?\/(\d+)/.exec(url);
  return github ? `#${github[1]}` : null;
}

/** The kinds of links a card's chips group, in the chips' order. */
export const WORK_LINK_GROUPS = [
  "effort",
  "pr",
  "thread",
  "review",
  "branch",
  "commit",
  "decision",
  "item",
  "deploy",
] as const;
export type WorkLinkGroupKind = (typeof WORK_LINK_GROUPS)[number];

/** A card's chip: the links of a kind, as a word and a count. */
export type WorkLinkGroup = {
  kind: WorkLinkGroupKind;
  label: string;
  count: number;
  /** Its links in words (the chip's tooltip), no ids. */
  title: string;
};

/** A chip's words for one link of a kind, and for several. */
const WORK_LINK_WORDS: Record<WorkLinkGroupKind, [string, string]> = {
  effort: ["effort", "efforts"],
  pr: ["PR", "PRs"],
  thread: ["thread", "threads"],
  review: ["review", "reviews"],
  branch: ["branch", "branches"],
  commit: ["commit", "commits"],
  decision: ["decision", "decisions"],
  item: ["after an item", "items before"],
  deploy: ["landed", "landings"],
};

/** The group a link's chip counts it in. */
export function workLinkGroupOf(link: WorkLink): WorkLinkGroupKind {
  if (link.kind === "review") return link.thread ? "thread" : "review";
  return link.kind;
}

/** A link in the words of a card's tooltip: what it is, never an id. */
function workLinkHint(link: WorkLink): string {
  switch (link.kind) {
    case "review":
      return link.thread ? "a review thread" : "a review";
    case "effort":
      return link.part ? `an effort's part ${link.part}` : "an effort";
    case "pr":
      return workPrRef(link.url) ?? link.url.replace(/^https?:\/\//, "");
    case "commit":
      return link.subject ?? link.sha.slice(0, 10);
    case "branch":
      return link.name;
    case "decision":
      return `${link.id} in ${link.path.split("/").pop() ?? link.path}`;
    case "item":
      return "another item";
    case "deploy":
      return link.sha === "decision"
        ? "its decisions ticked"
        : `landed${link.branch ? ` on ${link.branch}` : ""}`;
  }
}

/**
 * A card's links on one line: a chip per kind with its count ("effort",
 * "2 branches", "PR !123", "thread"), never the raw ids; the item's detail
 * lists each.
 */
export function summarizeWorkLinks(
  links: readonly WorkLink[],
): WorkLinkGroup[] {
  const byGroup = new Map<WorkLinkGroupKind, WorkLink[]>();
  for (const link of links) {
    const group = workLinkGroupOf(link);
    byGroup.set(group, [...(byGroup.get(group) ?? []), link]);
  }
  return WORK_LINK_GROUPS.flatMap((kind) => {
    const found = byGroup.get(kind);
    if (!found) return [];
    const count = found.length;
    const first = found[0]!;
    const ref = first.kind === "pr" ? workPrRef(first.url) : null;
    const [one, several] = WORK_LINK_WORDS[kind];
    const label =
      count > 1
        ? `${count} ${several}`
        : kind === "pr" && ref
          ? `PR ${ref}`
          : one;
    return [{ kind, label, count, title: found.map(workLinkHint).join("\n") }];
  });
}

/** What the page knows that names a link better than its id. */
export type WorkLinkNames = {
  effort?: (id: string) => string | undefined;
  /** A request's title, by its URL. */
  pr?: (url: string) => string | undefined;
  /** A review's title, and the first words of the thread named. */
  review?: (
    id: string,
    thread?: string,
  ) => { title?: string; thread?: string } | undefined;
  /** Another item's title. */
  item?: (id: string) => string | undefined;
};

/**
 * A link as the item's detail lists it: a label one reads (a commit's
 * subject, a branch, an effort's name, a request's title or number, the
 * thread's first words) and a smaller line saying what and where it is.
 */
export function readableWorkLink(
  link: WorkLink,
  names: WorkLinkNames = {},
): { label: string; detail: string } {
  const base = (path: string) =>
    path.replace(/\/+$/, "").split("/").pop() ?? path;
  switch (link.kind) {
    case "review": {
      const known = names.review?.(link.id, link.thread);
      const where = known?.title ? `in ${known.title}` : "in a review";
      if (link.thread)
        return {
          label: known?.thread ? `"${known.thread}"` : "The review thread",
          detail: `Thread ${where}`,
        };
      return { label: known?.title ?? "A review", detail: "Review" };
    }
    case "effort":
      return {
        label: names.effort?.(link.id) ?? "An upstreaming effort",
        detail: `Upstreaming effort${link.part ? `, part ${link.part}` : ""}`,
      };
    case "pr": {
      const ref = workPrRef(link.url);
      const host = /^https?:\/\/([^/]+)/.exec(link.url)?.[1];
      const title = names.pr?.(link.url);
      return {
        label: title ?? (ref ? `Request ${ref}` : link.url),
        detail: [
          ref?.startsWith("!") ? "Merge request" : "Pull request",
          ref && title ? ref : null,
          host ? `on ${host}` : null,
        ]
          .filter(Boolean)
          .join(" "),
      };
    }
    case "commit":
      return {
        label: link.subject ?? `Commit ${link.sha.slice(0, 10)}`,
        detail: `Commit ${link.sha.slice(0, 10)}${link.root ? ` in ${base(link.root)}` : ""}`,
      };
    case "branch":
      return {
        label: link.name,
        // A worktree is often named as its branch: no need to say it twice.
        detail: `Branch${link.root && base(link.root) !== link.name ? ` in ${base(link.root)}` : ""}`,
      };
    case "decision":
      return {
        label: `Decision ${link.id}`,
        detail: `In ${base(link.path)}`,
      };
    case "item":
      return {
        label: names.item?.(link.id) ?? "Another item",
        detail: "This item comes after it",
      };
    case "deploy":
      return link.sha === "decision"
        ? { label: "Its decisions are ticked", detail: link.branch ?? "" }
        : {
            label: `Landed${link.branch ? ` on ${link.branch}` : ""}`,
            detail: `Commit ${link.sha.slice(0, 10)}`,
          };
  }
}

/**
 * When a live item becomes done by itself ("Done when: ..."), for the
 * item's detail and the tools' answers; null when nothing watches it (no
 * commit nor decision link, or already done). Decisions count only when
 * they are the item's only links: a commit link rules.
 */
export function workDoneWhen(
  item: Pick<WorkItem, "state" | "links">,
  project: Pick<WorkProject, "done"> | null | undefined,
): string | null {
  if (item.state === "done") return null;
  const commits = item.links.filter((link) => link.kind === "commit");
  const decisions = item.links.filter((link) => link.kind === "decision");
  if (!commits.length && !decisions.length) return null;
  const where = !project
    ? "where its project says"
    : project.done.kind === "deployed"
      ? "this Roamgate's deployed build"
      : `${project.done.branch} in ${project.done.root}`;
  if (commits.length)
    return `${commits.length === 1 ? "its commit reaches" : "one of its commits reaches"} ${where}${decisions.length ? " (its decisions do not count: they rule only an item whose links are all decisions)" : ""}`;
  return `every decision is ticked (\`- [x] **Dn**\`, or its \`### Dn\` heading answered or decided) in the file${project?.done.kind === "branch" ? ` on ${project.done.branch}` : " as committed"}, or in the checkout's working tree (said uncommitted then)`;
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
