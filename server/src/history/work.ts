import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  type WorkItem,
  type WorkProject,
  workDescriptionThread,
} from "../../../shared/work";
import { type HistoryArea, type ReviewSource, count } from "./area";
import {
  fileNameOf,
  jsonl,
  parseDoc,
  parseJsonl,
  renderDoc,
  stableJson,
} from "./format";
import type { WorkChange } from "./hooks";
import type { WorkCommit } from "./repo";
import { withoutSecrets } from "./secrets";

/**
 * The Work board in the history: `work/items/<id>.md` (the item as a
 * one-line JSON header, then its description, from the item's review),
 * `work/projects/<id>.json`, and the store's `work/history.jsonl` (kept
 * until restoring from git is proven). Each change of an item is its own
 * commit (workCommit), authored by whoever made it at the time it was
 * made: `git log -p -- work/items/<id>.md` is the item's history.
 */

export function workItemPath(id: string): string {
  return `work/items/${fileNameOf(id)}.md`;
}

/** An item's file: its header, then its description (Markdown). */
export function renderWorkItem(
  item: WorkItem,
  description: string | null,
): string {
  return renderDoc([
    {
      tag: "item",
      meta: withoutSecrets(item) as Record<string, unknown>,
      body: description ?? "",
    },
  ]);
}

/** An item's file read back. */
export function parseWorkItem(text: string): {
  item: WorkItem;
  description: string;
} {
  const [block] = parseDoc(text);
  if (!block || block.tag !== "item") throw new Error("not a Work item file");
  return { item: block.meta as unknown as WorkItem, description: block.body };
}

/** The item's description: the first comment of its description thread. */
export function workDescriptionOf(
  source: ReviewSource | null,
  item: WorkItem,
): string | null {
  if (!source || !item.review) return null;
  try {
    return (
      workDescriptionThread(source.loadThreads(item.review), item)?.comments[0]
        ?.body ?? null
    );
  } catch {
    return null;
  }
}

type WorkFile = { projects: WorkProject[]; items: WorkItem[] };

function readWork(dir: string): WorkFile {
  const raw = JSON.parse(readFileSync(join(dir, "work.json"), "utf8"));
  return {
    projects: Array.isArray(raw?.projects) ? raw.projects : [],
    items: Array.isArray(raw?.items) ? raw.items : [],
  };
}

export function workArea(
  paths: { work: string },
  reviews: () => ReviewSource | null,
): HistoryArea {
  return {
    name: "work",
    // Not watched: the store says each change (hooks.ts), and the server
    // writes work.json whole from memory, so a hand edit would not last.
    render(ids) {
      const files = new Map<string, string>();
      let work: WorkFile;
      try {
        work = readWork(paths.work);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { files, owns: ["work/"] };
        throw error;
      }
      const source = reviews();
      const items = ids
        ? work.items.filter((item) => ids.has(item.id))
        : work.items;
      for (const item of items)
        files.set(
          workItemPath(item.id),
          renderWorkItem(item, workDescriptionOf(source, item)),
        );
      if (ids) return { files, owns: [...ids].map(workItemPath) };
      for (const project of work.projects)
        files.set(
          `work/projects/${fileNameOf(project.id)}.json`,
          stableJson(withoutSecrets(project)),
        );
      try {
        const lines = parseJsonl(
          readFileSync(join(paths.work, "history.jsonl"), "utf8"),
        );
        if (lines.length)
          files.set("work/history.jsonl", jsonl(lines.map(withoutSecrets)));
      } catch {}
      return { files, owns: ["work/"] };
    },
    describe: (changed) => {
      const items = changed.filter((path) => path.startsWith("work/items/"));
      const projects = changed.filter((path) =>
        path.startsWith("work/projects/"),
      );
      return [
        items.length ? count(items.length, "item") : "",
        projects.length ? count(projects.length, "project") : "",
        changed.includes("work/history.jsonl") ? "its history" : "",
      ]
        .filter(Boolean)
        .join(", ");
    },
  };
}

function localUser(): string {
  try {
    return userInfo().username || "you";
  } catch {
    return "you";
  }
}

/** What a change did, in a few words: "state doing, tags". */
function changeWords(change: Record<string, unknown>): string {
  if (change.removed) return "removed";
  const words = Object.keys(change)
    .filter((key) => key !== "previous_description")
    .map((key) =>
      typeof change[key] === "string" &&
      (key === "state" || key === "project") &&
      (change[key] as string).length < 40
        ? `${key} ${change[key]}`
        : key,
    );
  return words.length ? words.join(", ") : "updated";
}

/**
 * The commit of one Work change: the item's file as the change left it,
 * authored by the user (their login on this machine) or the agent (its
 * name and session address), dated when it was made.
 */
export function workCommit(
  change: WorkChange,
  description: string | null,
  host: string,
): WorkCommit {
  const short = change.id.slice(0, 8);
  const title = change.item?.title
    ? ` "${change.item.title.length > 60 ? `${change.item.title.slice(0, 57)}...` : change.item.title}"`
    : "";
  const user = localUser();
  const author =
    change.actor.by === "agent"
      ? {
          name:
            [
              change.actor.caller?.split(" in ")[0],
              change.actor.address ? `(${change.actor.address})` : "",
            ]
              .filter(Boolean)
              .join(" ") || "agent",
          email: `agent@${host}`,
        }
      : { name: user, email: `${user}@${host}` };
  const body = [
    change.actor.by === "agent"
      ? `By ${change.actor.caller ?? "an agent"}${change.actor.address ? ` at ${change.actor.address}` : ""}.`
      : "By the user.",
  ];
  return {
    path: workItemPath(change.id),
    content: change.item ? renderWorkItem(change.item, description) : null,
    author,
    date: change.at,
    subject: `work ${short}: ${changeWords(change.change)}${title}`,
    body: body.join("\n"),
  };
}
