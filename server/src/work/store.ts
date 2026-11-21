import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isWorkState,
  normalizeWorkTags,
  WORK_ID,
  WORK_LIMITS,
  WORK_LINK_KINDS,
  type WorkItem,
  type WorkLink,
  type WorkOwner,
  type WorkProject,
  type WorkState,
} from "../../../shared/work";
import { parseAgentAddress } from "../../../shared/agentMessage";
import { dataRoot, replaceDataFile } from "../config/data-paths";
import { roamgateEnv } from "../config/environment";

/**
 * The Work board's store: one JSON file with the projects and the items,
 * written whole on every change (D9), and `history.jsonl`, append-only,
 * one line per change of an item's state or owner (who, when, from what to
 * what), never capped. The threads of an item live in the review store.
 */

export class WorkError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid"
      | "not_found"
      | "unavailable"
      | "conflict"
      | "forbidden" = "invalid",
  ) {
    super(message);
  }
}

type StoreFile = {
  version: 1;
  projects: WorkProject[];
  items: WorkItem[];
};

export type WorkHistoryLine = {
  at: string;
  item: string;
  by: "user" | "agent";
  /** What changed: the fields and their new values. */
  change: Record<string, unknown>;
};

export function workDirectory(
  environment: Record<string, string | undefined> = process.env,
  root = dataRoot(),
): string {
  return roamgateEnv("WORK_DIR", environment) ?? join(root, "work");
}

export function newWorkId(): string {
  return randomBytes(8).toString("hex");
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new WorkError(`${field} is required`);
  const out = value.replace(/\r\n?/g, "\n").trim();
  if (!out) throw new WorkError(`${field} is empty`);
  if (out.length > max) throw new WorkError(`${field} is too long`);
  return out;
}

function optionalText(
  value: unknown,
  field: string,
  max: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, field, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** One line: no control characters, at most `max`. */
export function oneLine(value: string, max: number): string {
  const line = value
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}...` : line;
}

export function parseWorkState(value: unknown): WorkState {
  const state =
    value === "for_you" || value === "for-you" || value === "for you"
      ? "you"
      : value;
  if (!isWorkState(state))
    throw new WorkError(
      `state must be one of you, doing, verify, open, done (got ${String(value).slice(0, 20)})`,
    );
  return state;
}

export function parseWorkOwner(value: unknown): WorkOwner | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = typeof value === "string" ? { session: value } : value;
  if (!isRecord(raw)) throw new WorkError("owner must be {session, task?}");
  const session = text(raw.session, "owner.session", 200);
  if (!parseAgentAddress(session))
    throw new WorkError("owner.session must be an address, CONNECTION/PANE");
  const task = optionalText(raw.task, "owner.task", 120);
  return { session, ...(task ? { task } : {}) };
}

/** A project's coordinator: a session's address, or nothing. */
export function parseWorkCoordinator(
  value: unknown,
): { session: string } | undefined {
  const owner = parseWorkOwner(value);
  return owner ? { session: owner.session } : undefined;
}

const SHA = /^[0-9a-f]{7,64}$/i;

export function parseWorkLink(value: unknown): WorkLink {
  if (!isRecord(value)) throw new WorkError("a link is an object with a kind");
  const kind = value.kind;
  if (!(WORK_LINK_KINDS as readonly string[]).includes(kind as string))
    throw new WorkError(
      `link kind must be one of ${WORK_LINK_KINDS.join(", ")}`,
    );
  switch (kind as WorkLink["kind"]) {
    case "review": {
      const id = text(value.id, "link.id", 64);
      const thread = optionalText(value.thread, "link.thread", 64);
      return { kind: "review", id, ...(thread ? { thread } : {}) };
    }
    case "effort": {
      const id = text(value.id, "link.id", 200);
      const part = optionalText(value.part, "link.part", 200);
      return { kind: "effort", id, ...(part ? { part } : {}) };
    }
    case "pr": {
      const url = text(value.url, "link.url", 2048);
      if (!/^https?:\/\//.test(url))
        throw new WorkError("link.url must be an http(s) URL");
      return { kind: "pr", url };
    }
    case "commit": {
      const sha = text(value.sha, "link.sha", 64).toLowerCase();
      if (!SHA.test(sha)) throw new WorkError("link.sha must be a commit sha");
      const subject = optionalText(value.subject, "link.subject", 300);
      const root = optionalText(value.root, "link.root", 4096);
      return {
        kind: "commit",
        sha,
        ...(subject ? { subject: oneLine(subject, 300) } : {}),
        ...(root ? { root } : {}),
      };
    }
    case "branch": {
      const name = text(value.name, "link.name", 300);
      const root = optionalText(value.root, "link.root", 4096);
      return { kind: "branch", name, ...(root ? { root } : {}) };
    }
    case "decision": {
      const path = text(value.path, "link.path", 4096);
      const id = text(value.id, "link.id", 40);
      return { kind: "decision", path, id };
    }
    case "item": {
      const id = text(value.id, "link.id", 64);
      if (!WORK_ID.test(id)) throw new WorkError("link.id must be an item id");
      return { kind: "item", id };
    }
    case "deploy": {
      const sha = text(value.sha, "link.sha", 64).toLowerCase();
      if (!SHA.test(sha)) throw new WorkError("link.sha must be a commit sha");
      const branch = optionalText(value.branch, "link.branch", 300);
      return { kind: "deploy", sha, ...(branch ? { branch } : {}) };
    }
  }
}

export function parseWorkLinks(value: unknown): WorkLink[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new WorkError("links must be a list");
  if (value.length > WORK_LIMITS.linksPerItem)
    throw new WorkError(`at most ${WORK_LIMITS.linksPerItem} links`);
  return value.map(parseWorkLink);
}

/** The same place, whatever else differs: one link of each per item. */
export function workLinkKey(link: WorkLink): string {
  switch (link.kind) {
    case "review":
      return `review:${link.id}:${link.thread ?? ""}`;
    case "effort":
      return `effort:${link.id}:${link.part ?? ""}`;
    case "pr":
      return `pr:${link.url}`;
    case "commit":
      return `commit:${link.sha}`;
    case "branch":
      return `branch:${link.root ?? ""}:${link.name}`;
    case "decision":
      return `decision:${link.path}:${link.id}`;
    case "item":
      return `item:${link.id}`;
    case "deploy":
      return `deploy:${link.sha}`;
  }
}

export function mergeWorkLinks(
  current: readonly WorkLink[],
  added: readonly WorkLink[],
): WorkLink[] {
  const out = [...current];
  const keys = new Set(out.map(workLinkKey));
  for (const link of added) {
    const key = workLinkKey(link);
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(link);
  }
  return out.slice(0, WORK_LIMITS.linksPerItem);
}

/** Where an item came from, one line; the same words name the same item. */
export function parseWorkSource(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new WorkError("source must be words");
  return oneLine(text(value, "source", 400), 300);
}

/** A time as given (ISO 8601, or anything Date reads), as ISO. */
export function parseWorkTime(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const at =
    typeof value === "number"
      ? new Date(value)
      : typeof value === "string"
        ? new Date(value)
        : null;
  if (!at || Number.isNaN(at.getTime()))
    throw new WorkError(`${field} must be a date (ISO 8601)`);
  return at.toISOString();
}

export function parseWorkTitle(value: unknown): string {
  return oneLine(
    text(value, "title", WORK_LIMITS.titleChars * 2),
    WORK_LIMITS.titleChars,
  );
}

export function parseWorkTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list =
    typeof value === "string"
      ? value.split(/[\s,]+/)
      : Array.isArray(value)
        ? value
        : null;
  if (!list) throw new WorkError("tags must be a list of words");
  for (const tag of list)
    if (typeof tag !== "string") throw new WorkError("tags must be words");
  return normalizeWorkTags(list as string[]);
}

function normalItem(raw: unknown): WorkItem | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || !WORK_ID.test(raw.id)) return null;
  if (typeof raw.title !== "string" || typeof raw.project !== "string")
    return null;
  if (!isWorkState(raw.state)) return null;
  let links: WorkLink[];
  try {
    links = parseWorkLinks(raw.links);
  } catch {
    links = [];
  }
  let owner: WorkOwner | undefined;
  try {
    owner = parseWorkOwner(raw.owner);
  } catch {
    owner = undefined;
  }
  const source = typeof raw.source === "string" ? raw.source : undefined;
  const at = typeof raw.createdAt === "string" ? raw.createdAt : "";
  return {
    id: raw.id,
    project: raw.project,
    title: oneLine(raw.title, WORK_LIMITS.titleChars),
    state: raw.state,
    tags: normalizeWorkTags(
      Array.isArray(raw.tags)
        ? raw.tags.filter((t): t is string => typeof t === "string")
        : [],
    ),
    ...(owner ? { owner } : {}),
    ...(source ? { source } : {}),
    links,
    createdAt: at,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : at,
    ...(typeof raw.doneAt === "string" ? { doneAt: raw.doneAt } : {}),
    by: raw.by === "agent" ? "agent" : "user",
    ...(typeof raw.review === "string" ? { review: raw.review } : {}),
    ...(raw.needsTriage === true ? { needsTriage: true as const } : {}),
  };
}

export function parseDoneRule(value: unknown): WorkProject["done"] {
  if (!isRecord(value)) throw new WorkError("done must be a rule");
  if (value.kind === "deployed") return { kind: "deployed" };
  if (value.kind === "branch") {
    const root = text(value.root, "done.root", 4096);
    const branch = text(value.branch, "done.branch", 300);
    const connectionId = optionalText(
      value.connectionId,
      "done.connection",
      200,
    );
    return {
      kind: "branch",
      root,
      branch,
      ...(connectionId ? { connectionId } : {}),
    };
  }
  throw new WorkError("done.kind must be deployed or branch");
}

function normalProject(raw: unknown): WorkProject | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id || typeof raw.name !== "string")
    return null;
  let done: WorkProject["done"];
  try {
    done = parseDoneRule(raw.done);
  } catch {
    done = { kind: "deployed" };
  }
  const roots = Array.isArray(raw.roots)
    ? raw.roots.flatMap((root) =>
        isRecord(root) &&
        typeof root.connectionId === "string" &&
        typeof root.path === "string"
          ? [{ connectionId: root.connectionId, path: root.path }]
          : [],
      )
    : [];
  let coordinator: { session: string } | undefined;
  try {
    coordinator = parseWorkCoordinator(raw.coordinator);
  } catch {
    coordinator = undefined;
  }
  return {
    id: raw.id.slice(0, 64),
    name: oneLine(raw.name, 80),
    roots,
    done,
    ...(Array.isArray(raw.tags)
      ? {
          tags: normalizeWorkTags(
            raw.tags.filter((t): t is string => typeof t === "string"),
          ),
        }
      : {}),
    ...(coordinator ? { coordinator } : {}),
  };
}

export type WorkStore = ReturnType<typeof openWorkStore>;

/**
 * The store at a directory: read once, kept in memory, written whole on
 * each change. A file that does not parse is treated as empty (never
 * overwritten until something is saved).
 */
export function openWorkStore(directory: string) {
  const path = join(directory, "work.json");
  const historyPath = join(directory, "history.jsonl");
  let projects: WorkProject[] = [];
  let items: WorkItem[] = [];
  try {
    if (existsSync(path)) {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(raw)) {
        projects = (Array.isArray(raw.projects) ? raw.projects : [])
          .map(normalProject)
          .filter((p): p is WorkProject => !!p);
        items = (Array.isArray(raw.items) ? raw.items : [])
          .map(normalItem)
          .filter((i): i is WorkItem => !!i);
      }
    }
  } catch {
    projects = [];
    items = [];
  }

  function save() {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file: StoreFile = { version: 1, projects, items };
    replaceDataFile(path, `${JSON.stringify(file, null, 1)}\n`);
  }

  function history(line: WorkHistoryLine) {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      appendFileSync(historyPath, `${JSON.stringify(line)}\n`, {
        mode: 0o600,
      });
    } catch {
      // The store is the truth; the history is a convenience.
    }
  }

  return {
    path,
    projects: () => projects,
    items: () => items,
    project(id: string): WorkProject | undefined {
      return projects.find((p) => p.id === id || p.name === id);
    },
    item(id: string): WorkItem | undefined {
      return items.find((i) => i.id === id);
    },
    /** An item by its id or a prefix of it (8 characters at least). */
    find(ref: string): WorkItem | undefined {
      const key = ref.trim().toLowerCase();
      if (!key) return undefined;
      const exact = items.find((i) => i.id === key);
      if (exact) return exact;
      if (key.length < 8) return undefined;
      const matches = items.filter((i) => i.id.startsWith(key));
      return matches.length === 1 ? matches[0] : undefined;
    },
    saveProject(project: WorkProject) {
      if (
        !projects.some((p) => p.id === project.id) &&
        projects.length >= WORK_LIMITS.projects
      )
        throw new WorkError(`at most ${WORK_LIMITS.projects} projects`);
      projects = [...projects.filter((p) => p.id !== project.id), project].sort(
        (a, b) => a.name.localeCompare(b.name),
      );
      save();
    },
    removeProject(id: string) {
      projects = projects.filter((p) => p.id !== id);
      items = items.filter((i) => i.project !== id);
      save();
    },
    saveItem(item: WorkItem, change?: Record<string, unknown>) {
      const at = items.findIndex((i) => i.id === item.id);
      if (at < 0) {
        if (items.length >= WORK_LIMITS.items)
          throw new WorkError(`at most ${WORK_LIMITS.items} items`);
        items = [...items, item];
      } else items = items.map((i) => (i.id === item.id ? item : i));
      save();
      if (change && Object.keys(change).length)
        history({ at: item.updatedAt, item: item.id, by: item.by, change });
    },
    removeItem(id: string) {
      items = items.filter((i) => i.id !== id);
      save();
    },
    /** For tests and exports: the file as it is. */
    snapshot(): StoreFile {
      return { version: 1, projects, items };
    },
  };
}
