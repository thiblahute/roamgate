import { parseAgentAddress } from "../../../shared/agentMessage";
import {
  REVIEW_USER,
  type ReviewSession,
  type ReviewSnapshot,
  type ReviewThread,
} from "../../../shared/review";
import {
  describeWorkLink,
  filterWorkItems,
  parseWorkTitle as parseTitleLine,
  provisionalWorkTitle,
  WORK_OPEN_STATES,
  type WorkBoard,
  type WorkItem,
  type WorkLink,
  type WorkOwner,
  type WorkProject,
  type WorkPush,
} from "../../../shared/work";
import {
  mergeWorkLinks,
  newWorkId,
  oneLine,
  parseDoneRule,
  parseWorkCoordinator,
  parseWorkLinks,
  parseWorkOwner,
  parseWorkSource,
  parseWorkState,
  parseWorkTags,
  parseWorkTime,
  parseWorkTitle,
  WorkError,
  type WorkStore,
} from "./store";
import { autoWorkTags } from "./tags";

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
export const WORK_TEXT_CHARS = 20_000;

export type WorkGit = (
  root: string,
  args: string[],
  connectionId?: string,
) => Promise<{ code: number | null; stdout: string }>;

export type WorkReviews = {
  /** The item's review, wherever it was opened; null when it has none. */
  find(itemId: string): ReviewSnapshot | null;
  /** Makes the item's review (target `work`), or answers the existing one. */
  open(input: {
    item: string;
    connectionId: string;
    root: string;
    title: string;
  }): ReviewSnapshot;
  /** A review and its threads, by id (a prefix is enough). */
  get(reviewId: string): ReviewSnapshot | null;
  /** The review a thread or comment id belongs to. */
  sessionOfComment(id: string): ReviewSession | null;
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
  }): ReviewThread;
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
  panes?: (
    connectionId: string,
  ) => Promise<{ pane_id: string; workspace_id?: string }[]>;
  /** A connection's runtime generation (its notification targets). */
  generation?: (connectionId: string) => number | null;
  log?: (message: string, fields?: Record<string, unknown>) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

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
    store.saveItem(item, change);
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

  function list(params: Record<string, unknown>): WorkItem[] {
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
    return filterWorkItems(store.items(), {
      ...(project ? { project } : {}),
      ...(states ? { states } : {}),
      tags: parseWorkTags(params.tags),
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
    const project: WorkProject = {
      id: existing?.id ?? name.replace(/[^a-z0-9._-]+/g, "-"),
      name,
      roots,
      done,
      ...(params.tags !== undefined
        ? { tags: parseWorkTags(params.tags) }
        : existing?.tags
          ? { tags: existing.tags }
          : {}),
      ...(coordinator ? { coordinator } : {}),
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
    return autoWorkTags(words, [...(project.tags ?? []), ...used]);
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
    const snapshot = threads({ item: item.id, open: true });
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
    if (item.state === "done")
      item.doneAt = parseWorkTime(params.done_at, "done_at") ?? at;
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
      },
      `added "${oneLine(item.title, 60)}"`,
    );
    let adopted: string | undefined;
    if (given(params.adopt_thread))
      adopted = adopt(made, String(params.adopt_thread), meta).thread;
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
      adopted = adopt(written, String(params.adopt_thread), meta).thread;
    return {
      item: store.item(written.id) ?? written,
      changed: change,
      ...(adopted ? { adopted } : {}),
    };
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
    const next: WorkItem = {
      ...before,
      state: "done",
      doneAt: parseWorkTime(params.done_at, "done_at") ?? at,
      updatedAt: at,
      by: meta.by,
      links: mergeWorkLinks(before.links, links),
    };
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
    const made = commit(
      before,
      next,
      meta,
      {
        state,
        ...(owner && !before.owner ? { owner } : {}),
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
    store.removeItem(item.id);
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
  function threads(params: Record<string, unknown>): ReviewSnapshot | null {
    const item = itemOf(params.item);
    if (!deps.reviews)
      throw new WorkError("reviews are unavailable", "unavailable");
    const found = deps.reviews.find(item.id);
    if (found || params.open !== true) return found;
    const home = reviewHome(item);
    const snapshot = deps.reviews.open({
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
    const snapshot = threads({ item: item.id, open: true });
    if (!snapshot) throw new WorkError("the item's review could not be opened");
    return deps.reviews.addThread({
      sessionId: snapshot.session.id,
      author,
      text,
      anchor: { work: { item: item.id } },
    });
  }

  /** A thread by its id (or a comment's), with the review it is in. */
  function threadRef(ref: string): {
    session: ReviewSession;
    thread: ReviewThread;
  } {
    if (!deps.reviews)
      throw new WorkError("reviews are unavailable", "unavailable");
    const key = ref.trim();
    if (!key) throw new WorkError("thread is required");
    const session = deps.reviews.sessionOfComment(key);
    if (!session) throw new WorkError("no such thread", "not_found");
    const snapshot = deps.reviews.get(session.id);
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
    const { session, thread } = threadRef(ref);
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
  function adopt(
    item: WorkItem,
    ref: string,
    meta: WorkMeta,
  ): { item: WorkItem; thread: string } {
    const { session: from, thread } = threadRef(ref);
    const own = threads({ item: item.id, open: true });
    if (!own) throw new WorkError("the item's review could not be opened");
    if (thread.sessionId === own.session.id)
      return { item: store.item(item.id) ?? item, thread: thread.id };
    const quote = thread.anchor.work?.quote ?? thread.anchor.render?.quote;
    deps.reviews!.moveThread({
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

  /** Where the owner is, for the page to open its chat or its task. */
  async function ownerTarget(params: Record<string, unknown>): Promise<{
    connectionId: string;
    runtimeGeneration: number;
    workspaceId: string;
    paneId: string;
    task?: string;
  } | null> {
    const item = itemOf(params.item);
    const owner = item.owner ? parseAgentAddress(item.owner.session) : null;
    if (!owner) return null;
    const generation = deps.generation?.(owner.connectionId);
    if (generation === null || generation === undefined) return null;
    const panes = await deps.panes?.(owner.connectionId).catch(() => []);
    const workspaceId =
      panes?.find((pane) => pane.pane_id === owner.paneId)?.workspace_id ?? "";
    if (!workspaceId) return null;
    return {
      connectionId: owner.connectionId,
      runtimeGeneration: generation,
      workspaceId,
      paneId: owner.paneId,
      ...(item.owner?.task ? { task: item.owner.task } : {}),
    };
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
    const { session, thread } = threadRef(
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
    const found = store
      .projects()
      .find((project) =>
        project.roots.some(
          (each) =>
            each.connectionId === connectionId &&
            (root === each.path || root.startsWith(`${each.path}/`)),
        ),
      );
    return found?.id ?? projectOf(undefined).id;
  }

  /**
   * The done rules: every live item with a commit (or decision) link whose
   * project says it landed becomes done, with a `deploy` link saying where.
   */
  async function check(): Promise<{ landed: string[]; checked: number }> {
    seed();
    const landed: string[] = [];
    let checked = 0;
    const deployed = deps.deployed?.() ?? null;
    for (const item of store.items()) {
      if (!WORK_OPEN_STATES.includes(item.state)) continue;
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
      const next: WorkItem = {
        ...current,
        state: "done",
        doneAt: at,
        updatedAt: at,
        by: "agent",
        links: mergeWorkLinks(current.links, [where]),
      };
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
    return { landed, checked };
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
    /** An agent rewrites one of its comments on an item. */
    commentEdit: (params: Record<string, unknown>, meta: WorkMeta) =>
      commentEdit(params, meta, "edit"),
    /** An agent deletes one of its comments on an item. */
    commentDelete: (params: Record<string, unknown>, meta: WorkMeta) =>
      commentEdit(params, meta, "delete"),
    /** An item takes an existing review thread as its own. */
    adopt: (params: Record<string, unknown>, meta: WorkMeta) =>
      adopt(itemOf(params.item), String(params.thread ?? ""), meta).item,
    ownerPane,
    ownerTarget,
    promote,
    check,
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
