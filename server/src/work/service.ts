import { parseAgentAddress } from "../../../shared/agentMessage";
import {
  REVIEW_LIMITS,
  REVIEW_USER,
  type ReviewSession,
  type ReviewSnapshot,
  type ReviewThread,
} from "../../../shared/review";
import {
  describeWorkLink,
  filterWorkItems,
  isWorkWorkspaceTag,
  normalizeWorkTag,
  parseWorkTitle as parseTitleLine,
  provisionalWorkTitle,
  WORK_LIMITS,
  WORK_OPEN_STATES,
  type WorkBoard,
  workStateAsks,
  workDescriptionThread,
  workOpenQuestions,
  type WorkItem,
  isAbsoluteWorkPath,
  type WorkLink,
  type WorkLinkRoot,
  type WorkOwner,
  type WorkProject,
  type WorkPlace,
  type WorkPush,
  workPlaceTagFor,
  workProjectFamily,
  workProjectForPaths,
  workLandingMakesDone,
  workLinkRoots,
  workWorkspaceTag,
} from "../../../shared/work";
import {
  mergeWorkLinks,
  newWorkId,
  oneLine,
  parseDoneRule,
  parseWorkAnswers,
  parseWorkAsk,
  parseWorkCoordinator,
  parseWorkLink,
  parseWorkLinks,
  parseWorkOwner,
  parseWorkSource,
  parseWorkState,
  parseWorkTags,
  parseWorkTime,
  parseWorkTitle,
  WorkError,
  type WorkStore,
  workLinkKey,
} from "./store";
import { autoWorkTags } from "./tags";
import type { WorkActor } from "../history/hooks";

/**
 * The Work board's service: the items and projects of the store, their
 * threads (one review per item, target `work`, delivered to the owner as
 * an effort's are to its leader), the For you notification, and the done
 * rule (a commit landed where the project says). Every change is pushed
 * to the pages as `work`. Import-friendly (D14): an item keeps the dates
 * and the source it was given, one item per source, and adopts an
 * existing review thread as its own.
 */

export const WORK_ROAMGATE_PROJECT = "roamgate";
/** The done rules are checked this often. */
export const WORK_CHECK_MS = 10 * 60_000;
/** The deployed build is read this often. */
export const WORK_DEPLOYED_MS = 60_000;

export type WorkMeta = {
  by: "user" | "agent";
  /** The agent's name, in what the user is told. */
  caller?: string;
  /** The agent's session address, when known: its own items need no telling. */
  address?: string;
  summary?: string;
};

/** The most images an item is added with, and their tokens in its text. */
export const WORK_ADD_IMAGES = 8;
/** The longest description an item is added with or given: a design doc. */
export const WORK_TEXT_CHARS = REVIEW_LIMITS.descriptionChars;
export const WORK_DESCRIPTION_CHARS = WORK_TEXT_CHARS;

export type WorkGit = (
  root: string,
  args: string[],
  connectionId?: string,
) => Promise<{ code: number | null; stdout: string }>;

/** Bun's review service answers at once; the Rust core's, later. */
type MaybePromise<T> = T | Promise<T>;

export type WorkReviews = {
  /** The item's review, wherever it was opened; null when it has none. */
  find(itemId: string): MaybePromise<ReviewSnapshot | null>;
  /** Makes the item's review (target `work`), or answers the existing one. */
  open(input: {
    item: string;
    connectionId: string;
    root: string;
    title: string;
  }): MaybePromise<ReviewSnapshot>;
  /** A review and its threads, by id (a prefix is enough). */
  get(reviewId: string): MaybePromise<ReviewSnapshot | null>;
  /** The review a thread or comment id belongs to. */
  sessionOfComment(id: string): MaybePromise<ReviewSession | null>;
  /** A new thread on a review, by an author (an agent's name, or the user). */
  addThread(input: {
    sessionId: string;
    author: string;
    text: string;
    anchor: Record<string, unknown>;
  }): Promise<ReviewThread>;
  /**
   * A thread of any review becomes this review's, its id, comments and
   * timestamps kept, its anchor replaced.
   */
  moveThread(input: {
    sessionId: string;
    threadId: string;
    anchor: Record<string, unknown>;
  }): MaybePromise<ReviewThread>;
  /**
   * A thread's anchor replaced in its own review: the item's old
   * description, unmarked when another thread becomes its description.
   */
  setAnchor?(input: {
    sessionId: string;
    threadId: string;
    anchor: Record<string, unknown>;
  }): MaybePromise<ReviewThread>;
  /** Stores an image of the review (as a pasted one is); its path. */
  addImage?(sessionId: string, type: string, data: Uint8Array): string;
  /** Rewrites a comment, as its author (the review service checks). */
  editComment?(input: {
    sessionId: string;
    commentId: string;
    author: string;
    text: string;
  }): Promise<ReviewThread>;
  /** Deletes a comment (its thread, when the first), as its author. */
  deleteComment?(input: {
    sessionId: string;
    commentId: string;
    author: string;
  }): Promise<{ deleted: string; thread: ReviewThread | null }>;
};

export type WorkNotifications = {
  publish(item: WorkItem): void;
  clear(item: WorkItem): void;
};

export type WorkServiceDeps = {
  store: WorkStore;
  now?: () => string;
  publish?: (push: WorkPush) => void;
  reviews?: WorkReviews;
  notifications?: WorkNotifications;
  git?: WorkGit;
  /**
   * A file of a checkout's working tree, on its connection (the decisions'
   * rule reads uncommitted ticks there); null when unreadable.
   */
  readFile?: (
    root: string,
    path: string,
    connectionId?: string,
  ) => Promise<string | null>;
  /**
   * The addresses (`connection/pane`) of the agent sessions Roamgate
   * manages, as agent_sessions lists them: an owner must be one of them.
   */
  sessions?: () => Promise<readonly string[]>;
  /** The deployed build of this Roamgate (server/public/.built-from). */
  deployed?: () => string | null;
  /** This Roamgate's own checkout, for the deployed rule. */
  ownRoot?: () => string | null;
  /** The default connection's id, where no other is known. */
  defaultConnection?: () => string | null;
  /** The panes of a connection, for the owner's workspace. */
  panes?: (connectionId: string) => Promise<
    {
      pane_id: string;
      workspace_id?: string;
      cwd?: string;
      foreground_cwd?: string;
    }[]
  >;
  /**
   * The workspaces of a connection: their names and checkouts, to place
   * an item added from one (its tag).
   */
  workspaces?: (connectionId: string) => Promise<
    {
      workspace_id: string;
      label?: string;
      worktree?: { checkout_path?: string; repo_root?: string } | null;
    }[]
  >;
  /** A connection's runtime generation (its notification targets). */
  generation?: (connectionId: string) => number | null;
  log?: (message: string, fields?: Record<string, unknown>) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** How long placing a workspace may wait on its connection. */
export const WORK_PLACE_MS = 3_000;

function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/** An image an item is added with: its token in the text, its bytes. */
type AddImage = { token: string; type: string; data: Uint8Array };

/** The summary the user sees of an agent's change, when it gave none. */
function summaryOf(meta: WorkMeta, what: string): string {
  return meta.summary ?? `${meta.caller ?? "Claude"} ${what}`;
}

/** The agent's bare name from its caller line ("Claude in roamgate"). */
/** Who made a change, for the history's per-change commits. */
function actorOf(meta: WorkMeta): WorkActor {
  return {
    by: meta.by,
    ...(meta.by === "agent" && meta.address ? { address: meta.address } : {}),
    ...(meta.by === "agent" && meta.caller ? { caller: meta.caller } : {}),
  };
}

function agentNameOf(meta: WorkMeta): string {
  return (meta.caller ?? "Claude").split(" in ")[0] || "Claude";
}

/**
 * Whether a decision is decided in a file's text: its box ticked (`- [x]
 * **Dn**`), or its heading (`### Dn.`, `## Dn:`, `#### Dn`) followed, before
 * the next heading of its level or higher, by a line that says it was
 * answered or decided (RFC-0053's `> **Answered 2026-11-11:** ...`).
 */
export function decisionDecided(text: string, id: string): boolean {
  const lines = text.split("\n");
  const ticked = lines.find((line) => line.includes(`**${id}**`));
  if (ticked && /^\s*[-*]\s+\[[xX]\]/.test(ticked)) return true;
  const heading = new RegExp(`^(#{1,6})\\s+${id}(?![0-9])[.:)]?(\\s|$)`);
  for (let at = 0; at < lines.length; at++) {
    const open = heading.exec(lines[at]!);
    if (!open) continue;
    const level = open[1]!.length;
    for (let next = at + 1; next < lines.length; next++) {
      const line = lines[next]!;
      const other = /^(#{1,6})\s/.exec(line);
      if (other && other[1]!.length <= level) break;
      if (/^\s*>?\s*\*\*(Answered|Decided|Decision)\b/i.test(line)) return true;
    }
    return false;
  }
  return false;
}

/** What `add` did: the item, and whether it changed an existing one. */
export type WorkAdded = {
  item: WorkItem;
  /** The source named an existing item: changed instead of added. */
  updated: boolean;
  /** What the change touched, by field (the item's fields' names). */
  changed?: Record<string, unknown>;
  /** Parameters an update leaves aside (the text: its description stands). */
  ignored?: string[];
  /** The thread given as `adopt_thread`, now the item's own. */
  adopted?: string;
};

/** What an agent is told when it leaves the user nothing to do. */
export const WORK_ASK_REQUIRED =
  'an item in For you (you) or Verify (verify) says what the user has to do: give ask, one or two sentences from the item and its thread ("Choose: media to the car with the phone mic, or no music on car links", "Dictate once after 10 idle minutes; text should appear"), and for a decision answers, a few short one-tap choices';

/**
 * An item's ask and answers as a change leaves them, written on `next`
 * and said in `change`: given ones taken (null or "" clears), cleared
 * when the item leaves For you and Verify unless given then. An agent's
 * change that puts or keeps the item in those states with no ask (none
 * stored, none given, or cleared) is refused: the card says what the user
 * has to do. The user's own moves are never refused.
 */
export function settleWorkAsk(
  before: WorkItem | null,
  next: WorkItem,
  params: Record<string, unknown>,
  meta: Pick<WorkMeta, "by">,
  change: Record<string, unknown>,
): void {
  const askGiven = params.ask !== undefined;
  const answersGiven = params.answers !== undefined;
  if (askGiven) {
    const ask = parseWorkAsk(params.ask);
    if (ask) next.ask = ask;
    else delete next.ask;
  }
  if (answersGiven) {
    const answers = parseWorkAnswers(params.answers);
    if (answers.length) next.answers = answers;
    else delete next.answers;
  }
  const leaving = !workStateAsks(next.state);
  if (leaving && !askGiven) delete next.ask;
  if (leaving && !answersGiven) delete next.answers;
  if (
    meta.by === "agent" &&
    !leaving &&
    !next.ask &&
    (!before || before.state !== next.state || askGiven)
  )
    throw new WorkError(WORK_ASK_REQUIRED);
  if ((next.ask ?? null) !== (before?.ask ?? null))
    change.ask = next.ask ?? null;
  if (
    JSON.stringify(next.answers ?? []) !== JSON.stringify(before?.answers ?? [])
  )
    change.answers = next.answers ?? null;
}

/** An item leaving For you and Verify (done, landed): its ask goes. */
function withoutAsk(item: WorkItem): WorkItem {
  if (workStateAsks(item.state)) return item;
  const rest = { ...item };
  delete rest.ask;
  delete rest.answers;
  return rest;
}

export function createWorkService(deps: WorkServiceDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.log ?? (() => {});
  let timers: ReturnType<typeof setInterval>[] = [];
  let lastDeployed: string | null | undefined;

  function push(push: WorkPush) {
    deps.publish?.(push);
  }

  function projectOf(ref: string | undefined): WorkProject {
    const id = (ref ?? "").trim();
    const found = id
      ? store.project(id)
      : (store.project(WORK_ROAMGATE_PROJECT) ?? store.projects()[0]);
    if (!found)
      throw new WorkError(
        id
          ? `no project ${id.slice(0, 40)}: work_project declares one`
          : "no project yet: work_project declares one",
        "not_found",
      );
    return found;
  }

  function itemOf(ref: unknown): WorkItem {
    if (typeof ref !== "string" || !ref.trim())
      throw new WorkError("item is required");
    const found = store.find(ref);
    if (!found)
      throw new WorkError(`no work item ${ref.slice(0, 20)}`, "not_found");
    return found;
  }

  /**
   * An owner's session must be one Roamgate manages (agent_sessions); its
   * task (a subagent's id) is taken as given, subagents are not listed.
   */
  async function assertOwnerKnown(owner: WorkOwner | undefined) {
    if (!owner || !deps.sessions) return;
    const known = await deps.sessions();
    if (known.includes(owner.session)) return;
    throw new WorkError(
      `no agent session Roamgate manages is at ${owner.session}; agent_sessions (roamgate-review sessions) lists them as CONNECTION/PANE${known.length ? `, such as ${known.slice(0, 3).join(", ")}` : ""}`,
      "not_found",
    );
  }

  /** Writes an item, says so, and keeps the For you notification right. */
  function commit(
    before: WorkItem | null,
    item: WorkItem,
    meta: WorkMeta,
    change: Record<string, unknown>,
    what: string,
  ): WorkItem {
    store.saveItem(item, change, actorOf(meta));
    if (needsLinkRoots(item)) fillLinkRootsLater(item.id);
    if (item.state === "you" && before?.state !== "you")
      deps.notifications?.publish(item);
    else if (item.state !== "you" && before?.state === "you")
      deps.notifications?.clear(item);
    push({
      changed: before ? ["item"] : ["items"],
      item: item.id,
      by: meta.by,
      ...(meta.by === "agent" ? { summary: summaryOf(meta, what) } : {}),
    });
    return item;
  }

  /** The seeded projects: Roamgate itself, on the deployed rule. */
  function seed() {
    if (store.projects().length) return;
    const connectionId = deps.defaultConnection?.() ?? "local";
    const root = deps.ownRoot?.();
    store.saveProject({
      id: WORK_ROAMGATE_PROJECT,
      name: "roamgate",
      roots: root ? [{ connectionId, path: root }] : [],
      done: { kind: "deployed" },
      tags: ["reviews", "voice", "android", "housekeeping"],
    });
  }

  function board(): WorkBoard {
    seed();
    const deployed = deps.deployed?.() ?? undefined;
    return {
      projects: store.projects(),
      items: store.items(),
      ...(deployed ? { deployed } : {}),
    };
  }

  /**
   * The items a filter keeps. A project keeps its subprojects' items too;
   * `workspace` keeps a workspace's (its tag): a name, a tag, or `self`
   * (the caller's, from `address`).
   */
  async function list(
    params: Record<string, unknown>,
    address?: string,
  ): Promise<WorkItem[]> {
    seed();
    const states = given(params.state)
      ? [parseWorkState(params.state)]
      : params.open === true
        ? [...WORK_OPEN_STATES]
        : undefined;
    const project =
      typeof params.project === "string" && params.project.trim()
        ? projectOf(params.project).id
        : undefined;
    const tags = parseWorkTags(params.tags);
    if (typeof params.workspace === "string" && params.workspace.trim()) {
      const named = params.workspace.trim();
      let tag: string | null;
      if (named === "self") {
        const parsed = address ? parseAgentAddress(address) : null;
        const place = parsed
          ? await placeOf({
              connectionId: parsed.connectionId,
              paneId: parsed.paneId,
            })
          : null;
        if (!place)
          throw new WorkError(
            "workspace self: your session's workspace is not known",
            "not_found",
          );
        tag = workWorkspaceTag(place.label);
      } else
        tag = isWorkWorkspaceTag(named.toLowerCase())
          ? normalizeWorkTag(named)
          : workWorkspaceTag(named);
      if (!tag) throw new WorkError("workspace: a workspace's name or tag");
      if (!tags.includes(tag)) tags.push(tag);
    }
    return filterWorkItems(store.items(), {
      ...(project
        ? { projects: workProjectFamily(store.projects(), project) }
        : {}),
      ...(states ? { states } : {}),
      tags,
      ...(typeof params.owner === "string" && params.owner
        ? { owner: params.owner }
        : {}),
      ...(typeof params.query === "string" ? { query: params.query } : {}),
    });
  }

  function projectSet(
    params: Record<string, unknown>,
    meta: WorkMeta,
  ): WorkProject {
    seed();
    const name = oneLine(
      typeof params.name === "string" ? params.name : "",
      80,
    ).toLowerCase();
    if (!name) throw new WorkError("name is required");
    const existing =
      (typeof params.id === "string" ? store.project(params.id) : undefined) ??
      store.project(name);
    const roots = Array.isArray(params.roots)
      ? params.roots.map((root) => {
          const raw = typeof root === "string" ? { path: root } : root;
          if (!isRecord(raw) || typeof raw.path !== "string" || !raw.path)
            throw new WorkError("roots are paths, or {connectionId, path}");
          const connectionId =
            typeof raw.connectionId === "string" && raw.connectionId
              ? raw.connectionId
              : (deps.defaultConnection?.() ?? "local");
          return { connectionId, path: raw.path.slice(0, 4096) };
        })
      : (existing?.roots ?? []);
    if (roots.length > 20) throw new WorkError("at most 20 roots");
    const done =
      params.done !== undefined
        ? parseDoneRule(params.done)
        : (existing?.done ?? { kind: "deployed" as const });
    if (done.kind === "branch" && !done.connectionId)
      done.connectionId =
        roots.find((root) => root.path === done.root)?.connectionId ??
        deps.defaultConnection?.() ??
        undefined;
    const coordinator =
      params.coordinator !== undefined
        ? parseWorkCoordinator(params.coordinator)
        : existing?.coordinator;
    const id = existing?.id ?? name.replace(/[^a-z0-9._-]+/g, "-");
    let parent = existing?.parent;
    if (params.parent === null || params.parent === "") parent = undefined;
    else if (params.parent !== undefined) {
      if (typeof params.parent !== "string")
        throw new WorkError("parent is a project's name or id, or null");
      const found = store.project(params.parent.trim());
      if (!found)
        throw new WorkError(
          `no project ${params.parent.slice(0, 40)} to be part of`,
          "not_found",
        );
      // A project cannot be part of itself, nor of one of its own parts.
      if (workProjectFamily(store.projects(), id).includes(found.id))
        throw new WorkError(
          `${found.name} is ${found.id === id ? "this project" : "one of its subprojects"}: a project cannot be part of it`,
          "conflict",
        );
      parent = found.id;
    }
    const project: WorkProject = {
      id,
      name,
      roots,
      done,
      ...(params.tags !== undefined
        ? { tags: parseWorkTags(params.tags) }
        : existing?.tags
          ? { tags: existing.tags }
          : {}),
      ...(coordinator ? { coordinator } : {}),
      ...(parent ? { parent } : {}),
    };
    store.saveProject(project);
    push({
      changed: ["projects"],
      by: meta.by,
      ...(meta.by === "agent"
        ? {
            summary: summaryOf(
              meta,
              `${existing ? "changed" : "declared"} project ${project.name}`,
            ),
          }
        : {}),
    });
    return project;
  }

  /**
   * Adds an item; one with the same source in the project is changed
   * instead (an import run again), its id kept. `created_at` and
   * `done_at` keep an imported item's dates; `adopt_thread` makes an
   * existing review thread the item's own.
   */
  /**
   * The tags an item given none gets by itself, from its words: the
   * project's own (its list, and its items', most used first) when the
   * words name them, and the app's areas (tags.ts).
   */
  function autoTags(project: WorkProject, words: string): string[] {
    const counts = new Map<string, number>();
    for (const item of store.items())
      if (item.project === project.id)
        for (const tag of item.tags)
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const used = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => tag);
    // A workspace's tag says where an item was added, not what it is about.
    return autoWorkTags(
      words,
      [...(project.tags ?? []), ...used].filter(
        (tag) => !isWorkWorkspaceTag(tag),
      ),
    );
  }

  /**
   * A workspace as the board places it (its name, checkout, panes' working
   * directories and ids), by its id or one of its panes'; null when its
   * connection does not answer in time or does not know it.
   */
  async function placeOf(where: {
    connectionId: string;
    workspaceId?: string;
    paneId?: string;
  }): Promise<WorkPlace | null> {
    if (!deps.panes || !deps.workspaces) return null;
    const read = Promise.all([
      deps.panes(where.connectionId),
      deps.workspaces(where.connectionId),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), WORK_PLACE_MS);
    });
    try {
      const listed = await Promise.race([read, late]).catch(() => null);
      if (!listed) return null;
      const [panes, workspaces] = listed;
      const workspaceId =
        where.workspaceId ??
        panes.find((pane) => pane.pane_id === where.paneId)?.workspace_id;
      const workspace = workspaceId
        ? workspaces.find((each) => each.workspace_id === workspaceId)
        : undefined;
      if (!workspace?.label) return null;
      const own = panes.filter((pane) => pane.workspace_id === workspaceId);
      const paths = [
        workspace.worktree?.checkout_path,
        workspace.worktree?.repo_root,
        ...own.map((pane) => pane.cwd),
        ...own.map((pane) => pane.foreground_cwd),
      ].filter((path): path is string => !!path);
      return {
        connectionId: where.connectionId,
        label: workspace.label,
        paths: [...new Set(paths)],
        paneIds: own.map((pane) => pane.pane_id),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The workspace tag of an item added from a workspace: the board's add
   * form says which (`workspace: {connectionId, workspaceId}`, or a pane
   * of it: a conversation's), an agent is where its session is. None from
   * a coordinator's workspace, nor for a project of another tree.
   */
  async function addedFromTag(
    project: WorkProject,
    params: Record<string, unknown>,
    meta: WorkMeta,
  ): Promise<string | null> {
    if (params.workspace === false) return null;
    let where: { connectionId: string; workspaceId?: string; paneId?: string };
    if (isRecord(params.workspace)) {
      const { connectionId, workspaceId, paneId } = params.workspace;
      if (typeof connectionId !== "string" || !connectionId) return null;
      where = {
        connectionId,
        ...(typeof workspaceId === "string" && workspaceId
          ? { workspaceId }
          : {}),
        ...(typeof paneId === "string" && paneId ? { paneId } : {}),
      };
      if (!where.workspaceId && !where.paneId) return null;
    } else if (meta.by === "agent" && meta.address) {
      const parsed = parseAgentAddress(meta.address);
      if (!parsed) return null;
      where = parsed;
    } else return null;
    const place = await placeOf(where);
    return place ? workPlaceTagFor(place, store.projects(), project.id) : null;
  }

  /**
   * The owner an item gets when given none: the project's coordinator,
   * unless the item is For you (the user's own, nothing to deliver).
   */
  function ownerFor(
    project: WorkProject,
    state: WorkItem["state"],
    given: WorkOwner | undefined,
  ): WorkOwner | undefined {
    if (given) return given;
    // For you is the user's own; a done item is history, nobody's to do.
    if (state === "you" || state === "done" || !project.coordinator)
      return undefined;
    return { session: project.coordinator.session };
  }

  /** The text an item is added with, and the images it holds. */
  function parseAddText(params: Record<string, unknown>): {
    text: string | undefined;
    images: AddImage[];
  } {
    const raw = params.text;
    if (raw !== undefined && raw !== null && typeof raw !== "string")
      throw new WorkError("text must be words");
    const text = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n") : "";
    if (text.length > WORK_TEXT_CHARS) throw new WorkError("text is too long");
    const list = params.images;
    if (list === undefined || list === null)
      return { text: text.trim() ? text.trim() : undefined, images: [] };
    if (!Array.isArray(list)) throw new WorkError("images must be a list");
    if (list.length > WORK_ADD_IMAGES)
      throw new WorkError(`at most ${WORK_ADD_IMAGES} images`);
    const images = list.map((each) => {
      if (
        !isRecord(each) ||
        typeof each.token !== "string" ||
        !each.token ||
        typeof each.type !== "string" ||
        typeof each.data !== "string"
      )
        throw new WorkError("an image is {token, type, data (base64)}");
      return {
        token: each.token.slice(0, 80),
        type: each.type,
        data: new Uint8Array(Buffer.from(each.data, "base64")),
      };
    });
    return { text: text.trim() ? text.trim() : undefined, images };
  }

  /**
   * Tells the item's owner of it, as a review comment is told: the item's
   * review is opened and a thread added, by its author (the user, or the
   * agent that added it), holding the text it was added with (its
   * description; the title alone when it has none), with its images
   * stored as pasted ones are. An agent's own item (it owns what it added)
   * needs no telling: the thread is its own words.
   */
  async function announce(
    item: WorkItem,
    meta: WorkMeta,
    given: { text: string | undefined; images: AddImage[] },
    what: "added" | "reopened",
  ): Promise<ReviewThread | null> {
    if (!deps.reviews) return null;
    const own =
      meta.by === "agent" &&
      !!meta.address &&
      item.owner?.session === meta.address;
    // Nothing to tell: no text, and no owner but the agent that added it.
    if (!given.text && (!item.owner || own)) return null;
    const author =
      meta.by === "user"
        ? REVIEW_USER
        : own
          ? (meta.caller ?? "Claude").split(" in ")[0] || "Claude"
          : (meta.caller ?? "Claude");
    const snapshot = await threads({ item: item.id, open: true });
    if (!snapshot) throw new WorkError("the item's review could not be opened");
    let text = given.text ?? (what === "added" ? item.title : "Reopened.");
    for (const image of given.images) {
      if (!deps.reviews.addImage)
        throw new WorkError("images are unavailable", "unavailable");
      const path = deps.reviews.addImage(
        snapshot.session.id,
        image.type,
        image.data,
      );
      text = text.split(image.token).join(path);
    }
    return deps.reviews.addThread({
      sessionId: snapshot.session.id,
      author,
      text,
      anchor: {
        work: {
          item: item.id,
          ...(given.text ? { description: true } : {}),
          ...(item.needsTriage ? { triage: true } : {}),
        },
      },
    });
  }

  async function add(
    params: Record<string, unknown>,
    meta: WorkMeta,
  ): Promise<WorkItem> {
    return (await addOrUpdate(params, meta)).item;
  }

  /**
   * `add`, saying what it did: an item with the same source in the project
   * is changed instead of added (an import run again), its id kept, but
   * never silently retitled: a different title is refused unless `replace`
   * is true. Its text is left aside then (the description stands).
   */
  async function addOrUpdate(
    params: Record<string, unknown>,
    meta: WorkMeta,
  ): Promise<WorkAdded> {
    seed();
    const project = projectOf(
      typeof params.project === "string" ? params.project : undefined,
    );
    const source = parseWorkSource(params.source);
    const existing = source
      ? store
          .items()
          .find((item) => item.project === project.id && item.source === source)
      : undefined;
    if (existing) {
      const title =
        params.title !== undefined ? parseWorkTitle(params.title) : undefined;
      if (
        title !== undefined &&
        title !== existing.title &&
        params.replace !== true
      )
        throw new WorkError(
          `an item with source "${oneLine(source!, 80)}" exists in ${project.name}: ${existing.id} "${oneLine(existing.title, 80)}"; work_update changes it, or replace: true retitles it to "${oneLine(title, 80)}"`,
          "conflict",
        );
      const rest: Record<string, unknown> = { ...params, item: existing.id };
      delete rest.source;
      delete rest.project;
      delete rest.text;
      delete rest.images;
      delete rest.replace;
      const ignored = ["text", "images"].filter((key) => given(params[key]));
      const { item, changed, adopted } = await change(rest, meta);
      return {
        item,
        updated: true,
        changed,
        ...(ignored.length ? { ignored } : {}),
        ...(adopted ? { adopted } : {}),
      };
    }
    const at = now();
    const created = parseWorkTime(params.created_at, "created_at") ?? at;
    const state = given(params.state) ? parseWorkState(params.state) : "open";
    const givenOwner = parseWorkOwner(params.owner);
    await assertOwnerKnown(givenOwner);
    const owner = ownerFor(project, state, givenOwner);
    const text = parseAddText(params);
    // Free text and no title (the board's add form): the text's first
    // line stands for the title until its owner sorts the item.
    const untitled =
      (params.title === undefined ||
        params.title === null ||
        (typeof params.title === "string" && !params.title.trim())) &&
      !!text.text;
    const item: WorkItem = {
      id: newWorkId(),
      project: project.id,
      title: untitled
        ? provisionalWorkTitle(text.text!)
        : parseWorkTitle(params.title),
      state,
      tags: [],
      ...(owner ? { owner } : {}),
      ...(source ? { source } : {}),
      links: mergeWorkLinks([], parseWorkLinks(params.links)),
      createdAt: created,
      updatedAt: given(params.updated_at)
        ? parseWorkTime(params.updated_at, "updated_at")!
        : created > at
          ? created
          : at,
      by: meta.by,
      // Sorted by its owner: there is one to ask, and it is not the
      // agent that added it.
      ...(untitled &&
      owner &&
      !(meta.by === "agent" && meta.address === owner.session)
        ? { needsTriage: true as const }
        : {}),
    };
    // Given none: read from its words (its title and text, or what
    // promote hands as `tag_text`).
    item.tags = parseWorkTags(params.tags);
    if (!item.tags.length && params.tags === undefined)
      item.tags = autoTags(
        project,
        [
          untitled ? "" : item.title,
          text.text ?? "",
          typeof params.tag_text === "string" ? params.tag_text : "",
        ].join("\n"),
      );
    // Where it was added from: that workspace's tag, besides the others.
    const from = await addedFromTag(project, params, meta);
    if (from && !item.tags.includes(from))
      item.tags = [...item.tags.slice(0, WORK_LIMITS.tagsPerItem - 1), from];
    if (item.state === "done")
      item.doneAt = parseWorkTime(params.done_at, "done_at") ?? at;
    const asked: Record<string, unknown> = {};
    settleWorkAsk(null, item, params, meta, asked);
    const made = commit(
      null,
      item,
      meta,
      {
        state: item.state,
        title: item.title,
        ...(owner ? { owner } : {}),
        ...(item.tags.length ? { tags: item.tags } : {}),
        ...(item.needsTriage ? { needs_triage: true } : {}),
        ...asked,
      },
      `added "${oneLine(item.title, 60)}"`,
    );
    let adopted: string | undefined;
    if (given(params.adopt_thread))
      adopted = (await adopt(made, String(params.adopt_thread), meta)).thread;
    // An adopted thread is the item's words already; an imported done item
    // is history, nobody's to do.
    else if (item.state !== "done") await announce(made, meta, text, "added");
    return {
      item: store.item(made.id) ?? made,
      updated: false,
      ...(adopted ? { adopted } : {}),
    };
  }

  async function update(
    params: Record<string, unknown>,
    meta: WorkMeta,
  ): Promise<WorkItem> {
    return (await change(params, meta)).item;
  }

  /** `update`, saying what changed (the fields, by name). */
  async function change(
    params: Record<string, unknown>,
    meta: WorkMeta,
  ): Promise<{
    item: WorkItem;
    changed: Record<string, unknown>;
    adopted?: string;
  }> {
    const before = itemOf(params.item);
    const change: Record<string, unknown> = {};
    const next: WorkItem = { ...before, by: meta.by, updatedAt: now() };
    if (params.title !== undefined) {
      next.title = parseWorkTitle(params.title);
      if (next.title !== before.title) change.title = next.title;
    }
    if (given(params.state)) {
      next.state = parseWorkState(params.state);
      if (next.state !== before.state) {
        change.state = next.state;
        if (next.state === "done")
          next.doneAt =
            parseWorkTime(params.done_at, "done_at") ?? next.updatedAt;
        else delete next.doneAt;
      } else if (next.state === "done" && given(params.done_at))
        next.doneAt = parseWorkTime(params.done_at, "done_at")!;
    }
    if (given(params.created_at)) {
      const created = parseWorkTime(params.created_at, "created_at")!;
      if (created !== before.createdAt) {
        next.createdAt = created;
        change.created_at = created;
      }
    }
    if (given(params.project)) {
      next.project = projectOf(String(params.project)).id;
      if (next.project !== before.project) change.project = next.project;
    }
    if (params.source !== undefined) {
      const source = parseWorkSource(params.source);
      if (source) next.source = source;
      else delete next.source;
      if (source !== before.source) change.source = source ?? null;
    }
    if (params.tags !== undefined) next.tags = parseWorkTags(params.tags);
    if (params.add_tags !== undefined)
      next.tags = parseWorkTags([
        ...next.tags,
        ...parseWorkTags(params.add_tags),
      ]);
    if (params.remove_tags !== undefined) {
      const gone = new Set(parseWorkTags(params.remove_tags));
      next.tags = next.tags.filter((tag) => !gone.has(tag));
    }
    if (next.tags.join("\n") !== before.tags.join("\n"))
      change.tags = next.tags;
    if (params.owner !== undefined) {
      const owner = parseWorkOwner(params.owner);
      if (owner && owner.session !== before.owner?.session)
        await assertOwnerKnown(owner);
      if (owner) next.owner = owner;
      else delete next.owner;
      if (JSON.stringify(owner) !== JSON.stringify(before.owner))
        change.owner = owner ?? null;
    }
    if (params.links !== undefined)
      next.links = mergeWorkLinks([], parseWorkLinks(params.links));
    if (params.add_links !== undefined)
      next.links = mergeWorkLinks(next.links, parseWorkLinks(params.add_links));
    if (params.remove_links !== undefined) {
      const gone = new Set(
        parseWorkLinks(params.remove_links).map((link) => JSON.stringify(link)),
      );
      next.links = next.links.filter((link) => !gone.has(JSON.stringify(link)));
    }
    if (params.needs_triage !== undefined) {
      if (typeof params.needs_triage !== "boolean")
        throw new WorkError("needs_triage must be true or false");
      if (params.needs_triage) next.needsTriage = true;
      else delete next.needsTriage;
      if (!!next.needsTriage !== !!before.needsTriage)
        change.needs_triage = !!next.needsTriage;
    } else if (
      before.needsTriage &&
      change.title !== undefined &&
      meta.by === "agent" &&
      !!meta.address &&
      (meta.address === before.owner?.session ||
        meta.address === next.owner?.session)
    ) {
      // Its owner's first title for it is the triage the mark waits for.
      delete next.needsTriage;
      change.needs_triage = false;
    }
    settleWorkAsk(before, next, params, meta, change);
    if (params.text !== undefined) {
      const written = await writeDescription(before, params, meta);
      if (written) {
        change.description = { chars: written.text.length };
        // The text it replaced: every version stays in the history.
        change.previous_description = written.previous;
      }
    }
    const linksChanged =
      JSON.stringify(next.links) !== JSON.stringify(before.links);
    if (linksChanged) change.links = next.links;
    let written = before;
    if (Object.keys(change).length)
      written = commit(
        before,
        next,
        meta,
        change,
        change.state
          ? `moved "${oneLine(next.title, 60)}" to ${String(change.state)}`
          : `changed "${oneLine(next.title, 60)}"`,
      );
    let adopted: string | undefined;
    if (given(params.adopt_thread))
      adopted = (await adopt(written, String(params.adopt_thread), meta))
        .thread;
    return {
      item: store.item(written.id) ?? written,
      changed: change,
      ...(adopted ? { adopted } : {}),
    };
  }

  /**
   * The item's description set (`text`, Markdown: a whole design doc
   * fits). The description is the first
   * comment of the item's thread marked so: rewritten in place when it is
   * the caller's own, else a new description thread is made and the old
   * one stays as an ordinary thread (the user's words are never rewritten
   * under their name). Threads on parts of the description quote its
   * words and are found again by them. What it replaced is answered, for
   * the history. Null when nothing changed.
   */
  async function writeDescription(
    item: WorkItem,
    params: Record<string, unknown>,
    meta: WorkMeta,
  ): Promise<{ text: string; previous: string | null } | null> {
    if (!deps.reviews)
      throw new WorkError("reviews are unavailable", "unavailable");
    const snapshot = await threads({ item: item.id, open: true });
    if (!snapshot) throw new WorkError("the item's review could not be opened");
    const current = workDescriptionThread(snapshot.threads, item);
    const old = current?.comments[0] ?? null;
    let text = old?.body ?? "";
    if (params.text !== undefined) {
      if (typeof params.text !== "string" || !params.text.trim())
        throw new WorkError("text is empty: an item keeps a description");
      text = params.text.replace(/\r\n?/g, "\n").trim();
      if (text.length > WORK_DESCRIPTION_CHARS)
        throw new WorkError(
          `text is too long (${WORK_DESCRIPTION_CHARS} characters at most)`,
        );
    }
    if (!text) throw new WorkError("text is required");
    // Read now: the review service rewrites the comment in place.
    const previous = old?.body ?? null;
    if (old && text === previous) return null;
    const author = meta.by === "user" ? REVIEW_USER : agentNameOf(meta);
    const own =
      !!old &&
      (old.author === author ||
        (meta.by === "agent" && !!meta.caller && old.author === meta.caller));
    if (current && old && own && deps.reviews.editComment)
      await deps.reviews.editComment({
        sessionId: snapshot.session.id,
        commentId: old.id,
        author: old.author,
        text,
      });
    else {
      if (current?.anchor.work?.description) {
        if (!deps.reviews.setAnchor)
          throw new WorkError(
            "the description cannot be replaced here",
            "unavailable",
          );
        await deps.reviews.setAnchor({
          sessionId: snapshot.session.id,
          threadId: current.id,
          anchor: {
            work: {
              item: item.id,
              ...(current.anchor.work.triage ? { triage: true } : {}),
            },
          },
        });
      }
      await deps.reviews.addThread({
        sessionId: snapshot.session.id,
        author,
        text,
        anchor: { work: { item: item.id, description: true } },
      });
    }
    return { text, previous };
  }

  /**
   * The versions an item's description had before its current one, from
   * the history, newest first: when each was replaced, by whom, its text.
   */
  function descriptionVersions(
    item: WorkItem,
  ): { replaced: string; by: "user" | "agent"; text: string }[] {
    return store
      .historyOf(item.id)
      .filter((line) => typeof line.change.previous_description === "string")
      .map((line) => ({
        replaced: line.at,
        by: line.by,
        text: line.change.previous_description as string,
      }))
      .reverse();
  }

  /**
   * An item's review changed (`threads`, all of them): how many questions
   * its owner asks on parts of its description are still open, kept on the
   * item for its card, and the board told when that number moved.
   */
  function questionsSeen(itemId: string, threads: readonly ReviewThread[]) {
    const item = store.item(itemId);
    if (!item) return;
    const open = workOpenQuestions(threads, item);
    if ((item.questions ?? 0) === open) return;
    const next: WorkItem = { ...item };
    if (open) next.questions = open;
    else delete next.questions;
    store.saveItem(next);
    push({ changed: ["item"], item: item.id, by: "user" });
  }

  /** The item is done: what landed, when known, is linked. */
  function done(params: Record<string, unknown>, meta: WorkMeta): WorkItem {
    const before = itemOf(params.item);
    const landed = isRecord(params.landed) ? params.landed : null;
    const links: WorkLink[] = [];
    if (landed) {
      if (typeof landed.commit === "string")
        links.push(
          parseWorkLinks([
            {
              kind: "commit",
              sha: landed.commit,
              ...(typeof landed.subject === "string"
                ? { subject: landed.subject }
                : {}),
              ...(typeof landed.root === "string" ? { root: landed.root } : {}),
            },
          ])[0]!,
        );
      if (typeof landed.pr === "string")
        links.push(parseWorkLinks([{ kind: "pr", url: landed.pr }])[0]!);
      if (typeof landed.branch === "string")
        links.push(
          parseWorkLinks([{ kind: "branch", name: landed.branch }])[0]!,
        );
    }
    const at = now();
    const next: WorkItem = withoutAsk({
      ...before,
      state: "done",
      doneAt: parseWorkTime(params.done_at, "done_at") ?? at,
      updatedAt: at,
      by: meta.by,
      links: mergeWorkLinks(before.links, links),
    });
    return commit(
      before,
      next,
      meta,
      {
        state: "done",
        ...(links.length ? { landed: links.map(describeWorkLink) } : {}),
      },
      `done with "${oneLine(next.title, 60)}"`,
    );
  }

  async function reopen(
    params: Record<string, unknown>,
    meta: WorkMeta,
  ): Promise<WorkItem> {
    const before = itemOf(params.item);
    const state = given(params.state) ? parseWorkState(params.state) : "open";
    if (state === "done") throw new WorkError("reopen to a live state");
    const project = store.project(before.project);
    const owner = project
      ? ownerFor(project, state, before.owner)
      : before.owner;
    const next: WorkItem = {
      ...before,
      state,
      ...(owner ? { owner } : {}),
      updatedAt: now(),
      by: meta.by,
    };
    delete next.doneAt;
    const asked: Record<string, unknown> = {};
    settleWorkAsk(before, next, params, meta, asked);
    const made = commit(
      before,
      next,
      meta,
      {
        state,
        ...(owner && !before.owner ? { owner } : {}),
        ...asked,
      },
      `reopened "${oneLine(next.title, 60)}" as ${state}`,
    );
    // Given to the coordinator now: told of it, as of a new item.
    if (owner && !before.owner)
      await announce(made, meta, { text: undefined, images: [] }, "reopened");
    return store.item(made.id) ?? made;
  }

  function remove(params: Record<string, unknown>, meta: WorkMeta): WorkItem {
    const item = itemOf(params.item);
    store.removeItem(item.id, actorOf(meta));
    if (item.state === "you") deps.notifications?.clear(item);
    push({
      changed: ["items"],
      item: item.id,
      by: meta.by,
      ...(meta.by === "agent"
        ? { summary: summaryOf(meta, `removed "${oneLine(item.title, 60)}"`) }
        : {}),
    });
    return item;
  }

  /** Where an item's review lives: the owner's connection, else the project's. */
  function reviewHome(item: WorkItem): { connectionId: string; root: string } {
    const project = store.project(item.project);
    const owner = item.owner ? parseAgentAddress(item.owner.session) : null;
    const connectionId =
      owner?.connectionId ??
      project?.roots[0]?.connectionId ??
      deps.defaultConnection?.() ??
      "local";
    const root =
      project?.roots.find((each) => each.connectionId === connectionId)?.path ??
      project?.roots[0]?.path ??
      deps.ownRoot?.() ??
      "/";
    return { connectionId, root };
  }

  /** The item's review: its threads, for the board (made when `open`). */
  async function threads(
    params: Record<string, unknown>,
  ): Promise<ReviewSnapshot | null> {
    const item = itemOf(params.item);
    if (!deps.reviews)
      throw new WorkError("reviews are unavailable", "unavailable");
    const found = await deps.reviews.find(item.id);
    if (found || params.open !== true) return found;
    const home = reviewHome(item);
    const snapshot = await deps.reviews.open({
      item: item.id,
      connectionId: home.connectionId,
      root: home.root,
      title: `Work: ${item.title}`,
    });
    if (item.review !== snapshot.session.id) {
      store.saveItem({ ...item, review: snapshot.session.id });
      push({ changed: ["item"], item: item.id, by: "user" });
    }
    return snapshot;
  }

  /** A comment on an item, by an agent or the user: its review's thread. */
  async function comment(
    params: Record<string, unknown>,
    author: string,
  ): Promise<ReviewThread> {
    const item = itemOf(params.item);
    if (!deps.reviews)
      throw new WorkError("reviews are unavailable", "unavailable");
    const text = typeof params.text === "string" ? params.text.trim() : "";
    if (!text) throw new WorkError("text is empty");
    const snapshot = await threads({ item: item.id, open: true });
    if (!snapshot) throw new WorkError("the item's review could not be opened");
    return deps.reviews.addThread({
      sessionId: snapshot.session.id,
      author,
      text,
      anchor: { work: { item: item.id } },
    });
  }

  /** A thread by its id (or a comment's), with the review it is in. */
  async function threadRef(ref: string): Promise<{
    session: ReviewSession;
    thread: ReviewThread;
  }> {
    if (!deps.reviews)
      throw new WorkError("reviews are unavailable", "unavailable");
    const key = ref.trim();
    if (!key) throw new WorkError("thread is required");
    const session = await deps.reviews.sessionOfComment(key);
    if (!session) throw new WorkError("no such thread", "not_found");
    const snapshot = await deps.reviews.get(session.id);
    const thread = snapshot?.threads.find(
      (each) =>
        each.id === key ||
        each.id.startsWith(key) ||
        each.comments.some((c) => c.id === key || c.id.startsWith(key)),
    );
    if (!thread) throw new WorkError("no such thread", "not_found");
    return { session, thread };
  }

  /**
   * A comment of an item's thread, by an agent: rewritten (`text`) or
   * deleted, only one of its own (its name, or its caller line "NAME in
   * WORKSPACE", as the comment was signed); the user's and other agents'
   * are refused. The comment names its item: any item's review will do.
   */
  async function commentEdit(
    params: Record<string, unknown>,
    meta: WorkMeta,
    what: "edit" | "delete",
  ): Promise<{
    item: WorkItem;
    thread: ReviewThread | null;
    deleted?: string;
  }> {
    const ref = typeof params.comment === "string" ? params.comment.trim() : "";
    if (!ref) throw new WorkError("comment is required");
    const { session, thread } = await threadRef(ref);
    if (session.target.kind !== "work")
      throw new WorkError(
        "that comment is not on a work item: review_edit works on it",
      );
    const item = itemOf(session.target.item);
    const comment = thread.comments.find(
      (each) => each.id === ref || each.id.startsWith(ref),
    );
    if (!comment)
      throw new WorkError(
        "comment names a thread: give the comment's own id (work_list {item} lists them)",
        "not_found",
      );
    const mine = new Set([agentNameOf(meta), meta.caller ?? "Claude"]);
    if (meta.by === "agent" && !mine.has(comment.author))
      throw new WorkError(
        `an agent can only ${what} its own comments (this one is by ${oneLine(comment.author, 60)})`,
        "forbidden",
      );
    const author = meta.by === "user" ? REVIEW_USER : comment.author;
    if (what === "edit") {
      if (!deps.reviews?.editComment)
        throw new WorkError("comments cannot be edited here", "unavailable");
      const text = typeof params.text === "string" ? params.text.trim() : "";
      if (!text) throw new WorkError("text is empty");
      const edited = await deps.reviews.editComment({
        sessionId: session.id,
        commentId: comment.id,
        author,
        text,
      });
      return { item, thread: edited };
    }
    if (!deps.reviews?.deleteComment)
      throw new WorkError("comments cannot be deleted here", "unavailable");
    const gone = await deps.reviews.deleteComment({
      sessionId: session.id,
      commentId: comment.id,
      author,
    });
    return { item, thread: gone.thread, deleted: gone.deleted };
  }

  /**
   * An existing review thread becomes the item's own: moved into the
   * item's review with its comments and ids, anchored on the item (the
   * review and thread it came from remembered, with its quoted words), a
   * review link added. A thread the item already has changes nothing.
   * Answers the item and the thread's id (the same, moved or not).
   */
  async function adopt(
    item: WorkItem,
    ref: string,
    meta: WorkMeta,
  ): Promise<{ item: WorkItem; thread: string }> {
    const { session: from, thread } = await threadRef(ref);
    const own = await threads({ item: item.id, open: true });
    if (!own) throw new WorkError("the item's review could not be opened");
    if (thread.sessionId === own.session.id)
      return { item: store.item(item.id) ?? item, thread: thread.id };
    const quote = thread.anchor.work?.quote ?? thread.anchor.render?.quote;
    await deps.reviews!.moveThread({
      sessionId: own.session.id,
      threadId: thread.id,
      anchor: {
        work: {
          item: item.id,
          from: { review: from.id, thread: thread.id },
          ...(quote ? { quote } : {}),
        },
      },
    });
    const current = store.item(item.id) ?? item;
    const links = mergeWorkLinks(current.links, [
      { kind: "review", id: from.id, thread: thread.id },
      ...(from.target.kind === "effort"
        ? [{ kind: "effort" as const, id: from.target.effort }]
        : []),
    ]);
    if (JSON.stringify(links) !== JSON.stringify(current.links))
      commit(
        current,
        { ...current, links, updatedAt: now(), by: meta.by },
        meta,
        { adopted: thread.id },
        `took thread ${thread.id.slice(0, 8)} into "${oneLine(current.title, 60)}"`,
      );
    return { item: store.item(item.id) ?? current, thread: thread.id };
  }

  /**
   * The pane an item's comments go to: its owner's, when that owner is on
   * the connection asked (the review's) and its pane is still there; else
   * the project's coordinator's, on that connection; else none (they
   * wait).
   */
  async function ownerPane(
    itemId: string,
    connectionId: string,
  ): Promise<string | null> {
    const item = store.item(itemId);
    if (!item) return null;
    const panes = deps.panes
      ? await deps.panes(connectionId).catch(() => null)
      : null;
    const here = (session: string | undefined): string | null => {
      const address = session ? parseAgentAddress(session) : null;
      if (!address || address.connectionId !== connectionId) return null;
      if (panes && !panes.some((pane) => pane.pane_id === address.paneId))
        return null;
      return address.paneId;
    };
    const own = here(item.owner?.session);
    if (own) return own;
    // The user's own For you item (nobody's): its comments are notes.
    if (item.state === "you" && !item.owner) return null;
    const coordinator = store.project(item.project)?.coordinator;
    if (!coordinator || coordinator.session === item.owner?.session)
      return null;
    return here(coordinator.session);
  }

  /**
   * Where a session (its address) runs, for the page to open its chat;
   * null when no pane of its connection holds it now.
   */
  async function addressTarget(address: string): Promise<{
    connectionId: string;
    runtimeGeneration: number;
    workspaceId: string;
    paneId: string;
  } | null> {
    const at = parseAgentAddress(address);
    if (!at) return null;
    const generation = deps.generation?.(at.connectionId);
    if (generation === null || generation === undefined) return null;
    const panes = await deps.panes?.(at.connectionId).catch(() => []);
    const workspaceId =
      panes?.find((pane) => pane.pane_id === at.paneId)?.workspace_id ?? "";
    if (!workspaceId) return null;
    return {
      connectionId: at.connectionId,
      runtimeGeneration: generation,
      workspaceId,
      paneId: at.paneId,
    };
  }

  /** Where the owner is, for the page to open its chat or its task. */
  async function ownerTarget(params: Record<string, unknown>): Promise<{
    connectionId: string;
    runtimeGeneration: number;
    workspaceId: string;
    paneId: string;
    task?: string;
  } | null> {
    const item = itemOf(params.item);
    if (!item.owner) return null;
    const target = await addressTarget(item.owner.session);
    if (!target) return null;
    return { ...target, ...(item.owner.task ? { task: item.owner.task } : {}) };
  }

  /** Where a session runs (a chat link's), for the page to open its chat. */
  function sessionTarget(params: Record<string, unknown>) {
    if (typeof params.session !== "string" || !params.session)
      throw new WorkError("session must be a session's address");
    return addressTarget(params.session);
  }

  /**
   * A review thread becomes an item that adopts it: the title and state
   * from its first line (`**state** Title`, else the line), its source the
   * thread's id (so the same thread never makes two items), the project the
   * one whose root holds the review's checkout.
   */
  async function promote(
    params: Record<string, unknown>,
    meta: WorkMeta,
  ): Promise<WorkItem> {
    seed();
    const { session, thread } = await threadRef(
      typeof params.thread === "string" ? params.thread : "",
    );
    // Its own item already (the thread was adopted): that item.
    if (session.target.kind === "work") {
      const owner = store.item(session.target.item);
      if (owner) return owner;
    }
    const parsed = parseTitleLine(thread.comments[0]?.body ?? "");
    const title =
      typeof params.title === "string" && params.title.trim()
        ? params.title
        : parsed.title || thread.anchor.render?.quote || "Untitled";
    const project =
      typeof params.project === "string" && params.project.trim()
        ? params.project
        : projectForRoot(session.connectionId, session.root);
    return add(
      {
        project,
        title,
        state:
          params.state ?? (thread.resolved ? "done" : (parsed.state ?? "open")),
        tags: params.tags,
        owner: params.owner,
        ask: params.ask,
        answers: params.answers,
        // Tags read from the whole thread's first comment, not its title.
        tag_text: thread.comments[0]?.body ?? "",
        source: `thread ${thread.id}`,
        created_at: thread.createdAt,
        ...(thread.resolved ? { done_at: thread.updatedAt } : {}),
        adopt_thread: thread.id,
      },
      meta,
    );
  }

  /** The project whose root holds this checkout, else the first. */
  function projectForRoot(connectionId: string, root: string): string {
    // The closest root: a subproject's checkout inside its parent's root.
    const found = workProjectForPaths(store.projects(), connectionId, [root]);
    return found?.id ?? projectOf(undefined).id;
  }

  /**
   * The done rules: every live item with a commit (or decision) link whose
   * project says it landed becomes done, with a `deploy` link saying where.
   */
  async function check(): Promise<{
    landed: string[];
    recorded: string[];
    checked: number;
  }> {
    seed();
    const landed: string[] = [];
    let checked = 0;
    const deployed = deps.deployed?.() ?? null;
    const recorded: string[] = [];
    for (const item of store.items()) {
      if (!WORK_OPEN_STATES.includes(item.state)) continue;
      // Waiting on the user (verify, for you): a landing is recorded once.
      if (!workLandingMakesDone(item.state) && landedOnce(item)) continue;
      const project = store.project(item.project);
      if (!project) continue;
      const commits = item.links.filter(
        (link): link is Extract<WorkLink, { kind: "commit" }> =>
          link.kind === "commit",
      );
      const decisions = item.links.filter(
        (link): link is Extract<WorkLink, { kind: "decision" }> =>
          link.kind === "decision",
      );
      if (!commits.length && !decisions.length) continue;
      checked++;
      let where: Extract<WorkLink, { kind: "deploy" }> | null = null;
      try {
        for (const commit of commits) {
          where = await landedAt(project, commit, deployed);
          if (where) break;
        }
        if (!where && !commits.length && decisions.length) {
          const ticked = await Promise.all(
            decisions.map((decision) => decisionTicked(project, decision)),
          );
          if (ticked.every((each) => each.ticked))
            where = {
              kind: "deploy",
              sha: "decision",
              // Said on the item: a tick the file's branch has not yet.
              branch: ticked.some((each) => each.uncommitted)
                ? "ticked, uncommitted"
                : "ticked",
            };
        }
      } catch (error) {
        log("work done check failed", {
          item: item.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!where) continue;
      const at = now();
      const current = store.item(item.id);
      if (!current || !WORK_OPEN_STATES.includes(current.state)) continue;
      // The user still has to verify or answer: the item stays in its
      // state, its landing linked (shown on its card).
      if (!workLandingMakesDone(current.state)) {
        if (landedOnce(current)) continue;
        const kept: WorkItem = {
          ...current,
          updatedAt: at,
          by: "agent",
          links: mergeWorkLinks(current.links, [where]),
        };
        commit(
          current,
          kept,
          {
            by: "agent",
            summary: `${oneLine(kept.title, 60)} landed (${describeWorkLink(where)}), still ${kept.state === "verify" ? "to verify" : "for you"}`,
          },
          { landed: describeWorkLink(where) },
          "landed",
        );
        recorded.push(kept.id);
        continue;
      }
      const next: WorkItem = withoutAsk({
        ...current,
        state: "done",
        doneAt: at,
        updatedAt: at,
        by: "agent",
        links: mergeWorkLinks(current.links, [where]),
      });
      commit(
        current,
        next,
        {
          by: "agent",
          summary: `${oneLine(next.title, 60)} landed (${describeWorkLink(where)})`,
        },
        { state: "done", landed: describeWorkLink(where) },
        "landed",
      );
      landed.push(next.id);
    }
    return { landed, recorded, checked };
  }

  /** Whether an item's landing is linked already (a `deploy` link). */
  function landedOnce(item: WorkItem): boolean {
    return item.links.some((link) => link.kind === "deploy");
  }

  /**
   * The checkout that holds a link's commit (a commit or landing link) or
   * branch: the link's root, then the project's (workLinkRoots), then,
   * on the deployed rule, this Roamgate's own; null when none does.
   */
  async function linkRepository(
    link: WorkLink,
    project: WorkProject | undefined,
  ): Promise<WorkLinkRoot | null> {
    const git = deps.git;
    if (!git) return null;
    let ask: string[];
    if (link.kind === "branch") {
      if (link.name.startsWith("-")) return null;
      ask = ["rev-parse", "--verify", "--quiet", `${link.name}^{commit}`];
    } else if (link.kind === "commit" || link.kind === "deploy") {
      if (!/^[0-9a-f]{4,64}$/.test(link.sha)) return null;
      ask = ["cat-file", "-e", `${link.sha}^{commit}`];
    } else return null;
    const places = workLinkRoots(link, project);
    const own = project?.done.kind === "deployed" ? deps.ownRoot?.() : null;
    if (own && !places.some((each) => each.path === own))
      places.push({ path: own });
    for (const place of places) {
      const read = await git(place.path, ask, place.connectionId);
      if (read.code === 0) return place;
    }
    return null;
  }

  /**
   * The checkout that holds a file link's relative path: its root, then
   * the project's (workLinkRoots), the first that has the file; null when
   * none does.
   */
  async function fileRepository(
    link: Extract<WorkLink, { kind: "file" }>,
    project: WorkProject | undefined,
  ): Promise<WorkLinkRoot | null> {
    const read = deps.readFile;
    if (!read || isAbsoluteWorkPath(link.path)) return null;
    for (const place of workLinkRoots(link, project))
      if ((await read(place.path, link.path, place.connectionId)) !== null)
        return place;
    return null;
  }

  /**
   * Where a file link opens: its checkout (its root, the project's root
   * that has the file, else the project's first) on that root's
   * connection, and its path there; an absolute path on the connection of
   * the project's root that holds it.
   */
  async function fileTarget(
    link: Extract<WorkLink, { kind: "file" }>,
    project: WorkProject | undefined,
  ): Promise<{ connectionId: string | null; root: string; path: string }> {
    const fallback = deps.defaultConnection?.() ?? null;
    if (isAbsoluteWorkPath(link.path)) {
      // The project's root that holds it the most closely says where.
      const holder = (project?.roots ?? [])
        .filter((each) => pathHolds(each.path, link.path))
        .sort((a, b) => b.path.length - a.path.length)[0];
      return {
        connectionId: holder?.connectionId ?? fallback,
        root:
          link.root ??
          holder?.path ??
          (link.path.replace(/[\\/][^\\/]*$/, "") || "/"),
        path: link.path,
      };
    }
    const place =
      (link.root ? null : await fileRepository(link, project)) ??
      workLinkRoots(link, project)[0];
    if (!place)
      throw new WorkError(
        `The file ${oneLine(link.path, 80)} has no checkout: the project has no roots`,
        "not_found",
      );
    return {
      connectionId: place.connectionId ?? fallback,
      root: place.path,
      path: link.path,
    };
  }

  /**
   * `bridge.work.link_target`: where a commit, branch or landing link of
   * an item is to be opened (its checkout, on its connection), or a
   * plain error saying it is in none of the project's repositories; for a
   * file link, its checkout and its path there (fileTarget).
   */
  async function linkTarget(params: Record<string, unknown>): Promise<{
    connectionId: string | null;
    root: string;
    path?: string;
  }> {
    const item = itemOf(params.item);
    const link = parseWorkLink(params.link);
    if (link.kind === "file")
      return fileTarget(link, store.project(item.project));
    if (link.kind === "deploy" && link.sha === "decision")
      throw new WorkError("decisions ticked name no commit");
    if (
      link.kind !== "commit" &&
      link.kind !== "branch" &&
      link.kind !== "deploy"
    )
      throw new WorkError(
        "only commit, branch and landing links have a repository",
      );
    const project = store.project(item.project);
    const found = await linkRepository(link, project);
    if (!found)
      throw new WorkError(
        link.kind === "branch"
          ? `The branch ${oneLine(link.name, 80)} is not in any of the project's repositories`
          : link.kind === "deploy"
            ? "The landed commit is not in any of the project's repositories"
            : "This commit is not in any of the project's repositories",
        "not_found",
      );
    return {
      connectionId: found.connectionId ?? deps.defaultConnection?.() ?? null,
      root: found.path,
    };
  }

  /**
   * A commit or branch link without its checkout, or a file link with a
   * relative path and none: the server finds it.
   */
  function rootless(link: WorkLink): boolean {
    if (link.kind === "file")
      return !!deps.readFile && !link.root && !isAbsoluteWorkPath(link.path);
    return (
      !!deps.git &&
      (link.kind === "commit" || link.kind === "branch") &&
      !link.root
    );
  }

  function needsLinkRoots(item: WorkItem): boolean {
    return item.links.some(rootless);
  }

  /** Links looked for and found nowhere, not looked for again. */
  const notFound = new Set<string>();
  let fills: Promise<unknown> = Promise.resolve();

  function fillLinkRootsLater(id: string) {
    fills = fills.then(() => fillLinkRoots(id)).catch(() => {});
  }

  /**
   * Gives an item's commit and branch links the checkout that holds them
   * (agents add them without one): written quietly, no history line, the
   * item's time and author kept. True when a link changed.
   */
  async function fillLinkRoots(id: string): Promise<boolean> {
    const item = store.item(id);
    if (!item || !needsLinkRoots(item)) return false;
    const project = store.project(item.project);
    const found = new Map<string, WorkLink>();
    for (const link of item.links) {
      if (!rootless(link)) continue;
      const key = `${item.project}\n${workLinkKey(link)}`;
      if (notFound.has(key)) continue;
      const where =
        link.kind === "file"
          ? await fileRepository(link, project)
          : await linkRepository(link, project);
      if (!where) {
        notFound.add(key);
        continue;
      }
      found.set(workLinkKey(link), { ...link, root: where.path } as WorkLink);
    }
    if (!found.size) return false;
    // The item as it is now: written meanwhile, only the roots added.
    const current = store.item(id);
    if (!current) return false;
    const links = mergeWorkLinks(
      [],
      current.links.map((link) =>
        rootless(link) ? (found.get(workLinkKey(link)) ?? link) : link,
      ),
    );
    if (JSON.stringify(links) === JSON.stringify(current.links)) return false;
    store.saveItem({ ...current, links });
    push({ changed: ["item"], item: id, by: "agent" });
    return true;
  }

  function pathHolds(root: string, path: string): boolean {
    const base = root.replace(/[\\/]+$/, "");
    return !!base && (path === base || path.startsWith(`${base}/`));
  }

  /** Every item's links without a checkout, looked for (at start). */
  function backfillLinkRoots(): Promise<unknown> {
    for (const item of store.items())
      if (needsLinkRoots(item)) fillLinkRootsLater(item.id);
    return fills;
  }

  /** Where a commit landed under the project's rule, or null. */
  async function landedAt(
    project: WorkProject,
    commit: Extract<WorkLink, { kind: "commit" }>,
    deployed: string | null,
  ): Promise<Extract<WorkLink, { kind: "deploy" }> | null> {
    if (!deps.git) return null;
    const rule = project.done;
    if (rule.kind === "deployed") {
      if (!deployed) return null;
      const root = commit.root ?? deps.ownRoot?.();
      if (!root) return null;
      if (commit.sha === deployed || deployed.startsWith(commit.sha))
        return { kind: "deploy", sha: deployed };
      const sha = await reachable(root, commit, deployed, undefined);
      return sha ? { kind: "deploy", sha: deployed } : null;
    }
    const root = commit.root ?? rule.root;
    const sha = await reachable(root, commit, rule.branch, rule.connectionId);
    return sha ? { kind: "deploy", sha, branch: rule.branch } : null;
  }

  /**
   * The commit's sha when `target` holds it (its own, or, once a rebase
   * rewrote it, the one on the target with its subject), else null.
   */
  async function reachable(
    root: string,
    commit: Extract<WorkLink, { kind: "commit" }>,
    target: string,
    connectionId: string | undefined,
  ): Promise<string | null> {
    const git = deps.git!;
    const direct = await git(
      root,
      ["merge-base", "--is-ancestor", commit.sha, target],
      connectionId,
    );
    if (direct.code === 0) return commit.sha;
    if (direct.code !== 128 && direct.code !== 1) return null;
    if (!commit.subject) return null;
    // A rewritten commit: the one on the target with its subject.
    const found = await git(
      root,
      [
        "log",
        "-1",
        "--format=%H",
        "--fixed-strings",
        `--grep=${commit.subject}`,
        target,
      ],
      connectionId,
    );
    const sha = found.stdout.trim().split("\n")[0]?.trim() ?? "";
    return found.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  /**
   * Whether a decision is decided (`decisionDecided`) in the file on the
   * project's branch (HEAD, for the deployed rule), else in the working
   * tree of the rule's root when it is a checkout (`uncommitted` then).
   */
  async function decisionTicked(
    project: WorkProject,
    decision: Extract<WorkLink, { kind: "decision" }>,
  ): Promise<{ ticked: boolean; uncommitted?: boolean }> {
    const none = { ticked: false };
    if (!deps.git) return none;
    const root =
      project.roots.find((each) => decision.path.startsWith(`${each.path}/`)) ??
      project.roots[0];
    if (!root) return none;
    const path = decision.path.startsWith("/")
      ? decision.path.slice(root.path.length + 1)
      : decision.path;
    const ref = project.done.kind === "branch" ? project.done.branch : "HEAD";
    const shown = await deps.git(
      root.path,
      ["show", `${ref}:${path}`],
      root.connectionId,
    );
    if (shown.code === 0 && decisionDecided(shown.stdout, decision.id))
      return { ticked: true };
    // Not on the branch yet: the working tree of the root, when the
    // branch is checked out there (or the deployed rule's own checkout).
    if (!deps.readFile) return none;
    if (project.done.kind === "branch") {
      const head = await deps.git(
        root.path,
        ["rev-parse", "--abbrev-ref", "HEAD"],
        root.connectionId,
      );
      if (head.code !== 0 || head.stdout.trim() !== project.done.branch)
        return none;
    }
    const text = await deps.readFile(root.path, path, root.connectionId);
    return text !== null && decisionDecided(text, decision.id)
      ? { ticked: true, uncommitted: true }
      : none;
  }

  function start() {
    if (timers.length) return;
    seed();
    void backfillLinkRoots();
    lastDeployed = deps.deployed?.() ?? null;
    void check().catch(() => {});
    timers.push(
      setInterval(() => {
        void check().catch(() => {});
      }, WORK_CHECK_MS),
    );
    timers.push(
      setInterval(() => {
        const current = deps.deployed?.() ?? null;
        if (current !== lastDeployed) {
          lastDeployed = current;
          push({ changed: ["projects"], by: "user" });
          void check().catch(() => {});
        }
      }, WORK_DEPLOYED_MS),
    );
  }

  function stop() {
    for (const timer of timers) clearInterval(timer);
    timers = [];
  }

  return {
    board,
    list,
    projectSet,
    add,
    addOrUpdate,
    update,
    change,
    done,
    reopen,
    remove,
    threads,
    comment,
    descriptionVersions,
    questionsSeen,
    /** An agent rewrites one of its comments on an item. */
    commentEdit: (params: Record<string, unknown>, meta: WorkMeta) =>
      commentEdit(params, meta, "edit"),
    /** An agent deletes one of its comments on an item. */
    commentDelete: (params: Record<string, unknown>, meta: WorkMeta) =>
      commentEdit(params, meta, "delete"),
    /** An item takes an existing review thread as its own. */
    adopt: async (params: Record<string, unknown>, meta: WorkMeta) =>
      (await adopt(itemOf(params.item), String(params.thread ?? ""), meta))
        .item,
    ownerPane,
    ownerTarget,
    sessionTarget,
    promote,
    check,
    linkTarget,
    backfillLinkRoots,
    /** Settles once the links' checkouts being looked for are found. */
    linkRootsFilled: () => fills,
    start,
    stop,
    /** For tests and the tools. */
    store,
  };
}

export type WorkService = ReturnType<typeof createWorkService>;

/** The owner as `connection/pane`, from the parts. */
export function workOwnerAddress(owner: WorkOwner): string {
  return owner.session;
}
