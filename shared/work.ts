/**
 * The Work board: work items on a kanban by state, one project at a time,
 * each item a thread for the session (or subagent) that owns it, linked to
 * what it is about (a review thread, an effort part, a request, a commit,
 * a decision in an RFC or plan), done by itself once what it links to
 * landed where its project says. Built on the effort model: a project is
 * an effort with no git source, its items its parts (plans/work-view.md).
 */

import { parseAgentAddress } from "./agentMessage";

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
  /**
   * The project it is a part of (its id): a subproject's items show on
   * its parent's board too, each card naming its subproject.
   */
  parent?: string;
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
  /**
   * A file to read: a plan, a doc, an RFC. Its path in its checkout
   * (`root`, filled from the project's roots when the path is relative),
   * or absolute; at a line when given; `label` names it better than its
   * file name. Opened in Files, rendered when it renders.
   */
  | {
      kind: "file";
      path: string;
      root?: string;
      line?: number;
      label?: string;
    }
  /** Another item this one waits for. */
  | { kind: "item"; id: string }
  /** Set when the done rule found the commit: where it landed. */
  | { kind: "deploy"; sha: string; branch?: string }
  /**
   * A message of an agent's chat it came from: the session's address
   * (`connection/pane`), its chat (the session id) and the message's
   * entry, when known.
   */
  | { kind: "chat"; session: string; chat?: string; entry?: string };

export const WORK_LINK_KINDS = [
  "review",
  "effort",
  "pr",
  "commit",
  "branch",
  "decision",
  "file",
  "item",
  "deploy",
  "chat",
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
  /**
   * The decisions its description leaves open (`- [ ] **Dn**` lines), as
   * last written through the board; none when it has none.
   */
  decisions?: number;
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
 * An answer that only says the user will write their own ("Something
 * else (I will write it)", "Other"): the card's Reply box is that, so it
 * is not drawn as a tap.
 */
export function workAnswerWritesIn(answer: string): boolean {
  return /^(something else|other|none of (these|the above))\b/i.test(
    answer.trim(),
  );
}

/**
 * What a card shows as the user's to do: the ask of a For you or Verify
 * item, with its answers (but the ones that say "I will write it": the
 * card's Reply box is there for that); null in the other states or
 * without an ask.
 */
export function workAskOf(
  item: Pick<WorkItem, "state" | "ask" | "answers">,
): { ask: string; answers: string[] } | null {
  if (!workStateAsks(item.state) || !item.ask?.trim()) return null;
  return {
    ask: item.ask.trim(),
    answers: (item.answers ?? []).filter((each) => !workAnswerWritesIn(each)),
  };
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

/**
 * A project and its subprojects, at any depth, the project first: what
 * its board shows. An unknown id is itself alone; a cycle stops.
 */
export function workProjectFamily(
  projects: readonly Pick<WorkProject, "id" | "parent">[],
  id: string,
): string[] {
  const family = [id];
  for (let at = 0; at < family.length; at++)
    for (const project of projects)
      if (project.parent === family[at] && !family.includes(project.id))
        family.push(project.id);
  return family;
}

/** The project a project is part of at the top (itself when none). */
export function workTopProject(
  projects: readonly Pick<WorkProject, "id" | "parent">[],
  id: string,
): string {
  const seen = new Set<string>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const parent = projects.find((each) => each.id === current)?.parent;
    if (!parent || !projects.some((each) => each.id === parent)) break;
    current = parent;
  }
  return current;
}

/**
 * The projects as a tree, for a picker: each parent followed by its
 * subprojects (by name), with their depth.
 */
export function workProjectTree<T extends Pick<WorkProject, "id" | "parent">>(
  projects: readonly T[],
): { project: T; depth: number }[] {
  const known = new Set(projects.map((each) => each.id));
  const out: { project: T; depth: number }[] = [];
  const placed = new Set<string>();
  const walk = (project: T, depth: number) => {
    if (placed.has(project.id)) return;
    placed.add(project.id);
    out.push({ project, depth });
    for (const child of projects)
      if (child.parent === project.id) walk(child, depth + 1);
  };
  for (const project of projects)
    if (!project.parent || !known.has(project.parent)) walk(project, 0);
  // A cycle has no top: its projects stand at the top.
  for (const project of projects) walk(project, 0);
  return out;
}

/** What a workspace's tag starts with: `ws:gst2-video`. */
export const WORK_WORKSPACE_TAG_PREFIX = "ws:";

/**
 * A workspace's tag: `ws:` and its name as a slug (lower case, words
 * joined by dashes, 40 characters at most); null for a name with no
 * letter nor digit. Stable while the workspace keeps its name.
 */
export function workWorkspaceTag(label: string): string | null {
  const room = WORK_LIMITS.tagChars - WORK_WORKSPACE_TAG_PREFIX.length;
  const slug = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, room)
    .replace(/-+$/, "");
  return slug ? `${WORK_WORKSPACE_TAG_PREFIX}${slug}` : null;
}

export function isWorkWorkspaceTag(tag: string): boolean {
  return (
    tag.startsWith(WORK_WORKSPACE_TAG_PREFIX) &&
    tag.length > WORK_WORKSPACE_TAG_PREFIX.length
  );
}

/** A tag as a chip shows it: a workspace's as its name's slug. */
export function workTagLabel(tag: string): string {
  return isWorkWorkspaceTag(tag)
    ? tag.slice(WORK_WORKSPACE_TAG_PREFIX.length)
    : tag;
}

/** A workspace, as the board places it: where it is, and its panes. */
export type WorkPlace = {
  connectionId: string;
  /** Its name, as Herdr shows it. */
  label: string;
  /** Its checkout and its panes' working directories, the checkout first. */
  paths: readonly string[];
  /** Its panes' ids (the coordinator's pane is one of them, or not). */
  paneIds: readonly string[];
};

function pathUnder(path: string, root: string): boolean {
  const base = root.replace(/\/+$/, "");
  return !!base && (path === base || path.startsWith(`${base}/`));
}

/**
 * The project whose root holds a path the most closely (the longest
 * root, so a subproject's checkout inside its parent's is the
 * subproject's), trying the paths in order; null when none does.
 */
export function workProjectForPaths<
  T extends Pick<WorkProject, "id" | "roots">,
>(
  projects: readonly T[],
  connectionId: string,
  paths: readonly (string | null | undefined)[],
): T | null {
  for (const path of paths) {
    if (!path) continue;
    let best: { project: T; length: number } | null = null;
    for (const project of projects)
      for (const root of project.roots)
        if (
          root.connectionId === connectionId &&
          pathUnder(path, root.path) &&
          (!best || root.path.length > best.length)
        )
          best = { project, length: root.path.length };
    if (best) return best.project;
  }
  return null;
}

/** A checkout a link's commit or branch may be in, on its connection. */
export type WorkLinkRoot = { connectionId?: string; path: string };

/**
 * Where a commit, branch or landing link is looked for, in order: the
 * link's own root (on the connection of the project's root that holds
 * it), then the project's roots, then the checkout of its branch rule.
 * Each place once; the caller tries them (git) until one has it.
 */
export function workLinkRoots(
  link: WorkLink,
  project: Pick<WorkProject, "roots" | "done"> | null | undefined,
): WorkLinkRoot[] {
  const roots = project?.roots ?? [];
  const out: WorkLinkRoot[] = [];
  const seen = new Set<string>();
  const put = (connectionId: string | undefined, raw: string) => {
    const path = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
    const key = `${connectionId ?? ""}\n${path}`;
    if (!path || seen.has(key)) return;
    seen.add(key);
    out.push(connectionId ? { connectionId, path } : { path });
  };
  const own =
    (link.kind === "commit" ||
      link.kind === "branch" ||
      link.kind === "file") &&
    link.root
      ? link.root
      : null;
  if (own) {
    let best: { connectionId: string; length: number } | null = null;
    for (const root of roots)
      if (
        pathUnder(own, root.path) &&
        (!best || root.path.length > best.length)
      )
        best = { connectionId: root.connectionId, length: root.path.length };
    put(best?.connectionId, own);
  }
  for (const root of roots) put(root.connectionId, root.path);
  if (project?.done.kind === "branch")
    put(project.done.connectionId, project.done.root);
  return out;
}

/**
 * Where a workspace stands on the board: its project (the one whose
 * coordinator is one of its panes, else the one whose root holds it),
 * its tag, and whether it is that project's coordinator's workspace (the
 * board is then the whole project's, and its items are nobody's
 * workspace's); null when no project holds it.
 */
export function workPlaceScope<T extends WorkProject>(
  place: WorkPlace,
  projects: readonly T[],
): { project: T; tag: string | null; coordinator: boolean } | null {
  const tag = workWorkspaceTag(place.label);
  const coordinating = projects.find((project) => {
    const address = project.coordinator
      ? parseAgentAddress(project.coordinator.session)
      : null;
    return (
      !!address &&
      address.connectionId === place.connectionId &&
      place.paneIds.includes(address.paneId)
    );
  });
  if (coordinating) return { project: coordinating, tag, coordinator: true };
  const project = workProjectForPaths(
    projects,
    place.connectionId,
    place.paths,
  );
  return project ? { project, tag, coordinator: false } : null;
}

/**
 * The tag an item added from a workspace gets: the workspace's, when the
 * workspace belongs to a project of the item's project's tree and is not
 * its project's coordinator's (whose board is the whole project).
 */
export function workPlaceTagFor(
  place: WorkPlace,
  projects: readonly WorkProject[],
  itemProject: string,
): string | null {
  const scope = workPlaceScope(place, projects);
  if (!scope?.tag || scope.coordinator) return null;
  return workTopProject(projects, scope.project.id) ===
    workTopProject(projects, itemProject)
    ? scope.tag
    : null;
}

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
 * that tag (each one named, all of them), `owner:ADDRESS` those that
 * session owns (its subagents' too), the other words are searched for in
 * titles, tags and owners. The tag still being typed (the last word, no
 * space after it) is `partial`: the tags it begins.
 */
export function parseWorkQuery(query: string): {
  words: string[];
  tags: string[];
  owners: string[];
  partial?: string;
} {
  const words: string[] = [];
  const tags: string[] = [];
  const owners: string[] = [];
  let partial: string | undefined;
  const all = query.toLowerCase().split(/\s+/).filter(Boolean);
  const typing = !/\s$/.test(query);
  all.forEach((word, at) => {
    const owner = /^owner:(.+)$/.exec(word)?.[1];
    if (owner) {
      if (!owners.includes(owner)) owners.push(owner);
      return;
    }
    const tag = /^(?:#|tag:)(.+)$/.exec(word)?.[1];
    if (tag) {
      const normal = normalizeWorkTag(tag);
      if (!normal) return;
      if (typing && at === all.length - 1) partial = normal;
      else if (!tags.includes(normal)) tags.push(normal);
    } else if (word !== "#" && word !== "tag:") words.push(word);
  });
  return { words, tags, owners, ...(partial ? { partial } : {}) };
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

/**
 * The items of a board that a filter keeps: project (or one of
 * `projects`: a project's tree), tags (all), states.
 */
export function filterWorkItems(
  items: readonly WorkItem[],
  filter: {
    project?: string;
    projects?: readonly string[];
    tags?: readonly string[];
    states?: readonly WorkState[];
    owner?: string;
    query?: string;
  },
): WorkItem[] {
  const {
    words,
    tags: named,
    owners,
    partial,
  } = parseWorkQuery(filter.query ?? "");
  const tags = [...(filter.tags ?? []), ...named];
  return items.filter((item) => {
    if (filter.project && item.project !== filter.project) return false;
    if (filter.projects && !filter.projects.includes(item.project))
      return false;
    if (tags.length && !tags.every((t) => item.tags.includes(t))) return false;
    if (partial && !item.tags.some((t) => t.startsWith(partial))) return false;
    if (filter.states?.length && !filter.states.includes(item.state))
      return false;
    if (filter.owner && item.owner?.session !== filter.owner) return false;
    if (
      owners.length &&
      !owners.includes(item.owner?.session.toLowerCase() ?? "")
    )
      return false;
    if (words.length) {
      const hay = [item.title, ...item.tags, item.owner?.session ?? ""]
        .join("\n")
        .toLowerCase();
      if (!words.every((word) => hay.includes(word))) return false;
    }
    return true;
  });
}

/** A file link's path: absolute when its root is known or it is absolute. */
export function workFileLinkPath(
  link: Extract<WorkLink, { kind: "file" }>,
): string {
  if (!link.root || isAbsoluteWorkPath(link.path)) return link.path;
  return `${link.root.replace(/[\\/]+$/, "")}/${link.path.replace(/^\.\//, "")}`;
}

/** A file link's name on a card: its label, else its file's name. */
export function workFileLinkName(
  link: Extract<WorkLink, { kind: "file" }>,
): string {
  return (
    link.label ??
    link.path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ??
    link.path
  );
}

/** An absolute path, POSIX or Windows (`C:\`, `C:/`). */
export function isAbsoluteWorkPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
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
    case "file":
      return `file ${workFileLinkPath(link)}${link.line ? `:${link.line}` : ""}`;
    case "item":
      return `after ${link.id.slice(0, 8)}`;
    case "deploy":
      // The decisions' rule: no commit, the branch says how they were found.
      if (link.sha === "decision")
        return `decisions ${link.branch ?? "ticked"}`;
      return `landed ${link.sha.slice(0, 10)}${link.branch ? ` on ${link.branch}` : ""}`;
    case "chat":
      return `message in ${link.session}${link.entry ? ` ${link.entry.slice(0, 12)}` : ""}`;
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
  "file",
  "decision",
  "item",
  "deploy",
  "chat",
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
  file: ["file", "files"],
  item: ["after an item", "items before"],
  deploy: ["landed", "landings"],
  chat: ["message", "messages"],
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
    case "file":
      return `${workFileLinkPath(link)}${link.line ? `:${link.line}` : ""}`;
    case "item":
      return "another item";
    case "deploy":
      return link.sha === "decision"
        ? "its decisions ticked"
        : `landed${link.branch ? ` on ${link.branch}` : ""}`;
    case "chat":
      return `a message in ${link.session}'s chat`;
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
          : first.kind === "file"
            ? workFileLinkName(first)
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
  /** A session's name (its title, or its workspace's), by its address. */
  session?: (address: string) => string | undefined;
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
    case "file":
      return {
        label: link.label ?? base(link.path),
        detail: `File ${workFileLinkPath(link)}${link.line ? `, line ${link.line}` : ""}`,
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
    case "chat": {
      const name = names.session?.(link.session);
      return {
        label: link.entry
          ? "The message it came from"
          : "The chat it came from",
        detail: `Agent chat${name ? ` of ${name}` : ""} (${link.session})`,
      };
    }
  }
}

/**
 * The states the done rule moves to done when the item's commit lands:
 * doing and open. An item waiting on the user (verify, for you) stays
 * where it is; the landing is only recorded (its `deploy` link).
 */
export const WORK_LANDING_DONE_STATES: readonly WorkState[] = ["doing", "open"];

/** Whether a landing makes an item in this state done by itself. */
export function workLandingMakesDone(state: WorkState): boolean {
  return WORK_LANDING_DONE_STATES.includes(state);
}

/**
 * When a live item becomes done by itself ("Done when: ..."), for the
 * item's detail and the tools' answers; null when nothing watches it (no
 * commit nor decision link, or already done). Decisions count only when
 * they are the item's only links: a commit link rules. An item in verify
 * or for you never does: its landing is recorded, the user says done.
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
  if (!workLandingMakesDone(item.state)) {
    const landed = item.links.some((link) => link.kind === "deploy");
    const waits =
      item.state === "verify" ? "the user verifies it" : "the user answers";
    return landed
      ? `when ${waits} and marks it done: it landed already, and stays ${item.state === "verify" ? "in Verify" : "For you"} until then`
      : `when ${waits} and marks it done: its landing (${commits.length ? `its commit reaching ${where}` : "its decisions ticked"}) is only recorded, the item stays ${item.state === "verify" ? "in Verify" : "For you"}`;
  }
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

/**
 * A decision line of a design doc: `- [ ] **Dn ...` while open, `- [x]`
 * once decided. Its id, whether it is open, and its line (0-based).
 */
const DECISION_LINE = /^\s*[-*+]\s+\[([ xX])\]\s+\*\*(D\d+)(?![0-9])/;

export type WorkDecision = { id: string; open: boolean; line: number };

/** The decisions of a description (a design doc), in order. */
export function workDecisions(text: string): WorkDecision[] {
  const out: WorkDecision[] = [];
  text.split("\n").forEach((line, at) => {
    const match = DECISION_LINE.exec(line);
    if (match) out.push({ id: match[2]!, open: match[1] === " ", line: at });
  });
  return out;
}

/** How many decisions a description leaves open. */
export function workOpenDecisions(text: string): number {
  return workDecisions(text).filter((each) => each.open).length;
}

/**
 * A decision ticked in a description: its box checked and, after its
 * bold words, the day and the user's words, `- [x] **D3 Title.** (2026-11-22,
 * user: "as recommended") ...`. Null when no open decision has that id.
 */
export function tickWorkDecision(
  text: string,
  id: string,
  answer: string,
  day: string,
): string | null {
  const lines = text.split("\n");
  const key = id.trim().toUpperCase();
  const at = lines.findIndex((line) => {
    const match = DECISION_LINE.exec(line);
    return !!match && match[1] === " " && match[2] === key;
  });
  if (at < 0) return null;
  const line = lines[at]!;
  const words = answer.replace(/\s+/g, " ").trim();
  const note = ` (${day}, user: "${words}")`;
  const open = line.indexOf("**");
  const close = line.indexOf("**", open + 2);
  const checked = line.replace(/\[ \]/, "[x]");
  lines[at] =
    close > open
      ? `${checked.slice(0, close + 2)}${note}${checked.slice(close + 2)}`
      : `${checked}${note}`;
  return lines.join("\n");
}

/**
 * Whether a description reads as a document (a design doc): it has a
 * Markdown heading. Its single line breaks are then the source's wrapping,
 * not breaks in the text.
 */
export function workDescriptionIsDocument(text: string): boolean {
  return /^#{1,6}\s+\S/m.test(text);
}
