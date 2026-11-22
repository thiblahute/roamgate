import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ReviewComment,
  ReviewSession,
  ReviewThread,
} from "../../../shared/review";
import { type HistoryArea, type ReviewSource, count } from "./area";
import { fileNameOf, parseDoc, renderDoc, stableJson } from "./format";
import { withoutSecrets } from "./secrets";

/**
 * Reviews in the history: `reviews/<yyyy>/<review>/review.json` (the
 * session, and the images its comments show), one Markdown file per
 * thread, `<thread>.md` (the thread's header, a title line, then each
 * comment's header and text), and the screenshots, content-addressed, in
 * `reviews/images/<sha256>.<ext>` (one stored once however often used;
 * one over 5 MB stays out and review.json says so). A review is placed by
 * the year it was made.
 */

/** A screenshot larger than this stays out of git (the backup target keeps it). */
export const HISTORY_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const IMAGE_REF =
  /images[\\/]([0-9a-f]{16})[\\/]([0-9a-f]{16}\.(?:png|jpg|gif|webp))/g;

export function reviewDir(session: Pick<ReviewSession, "id" | "createdAt">) {
  const year = /^\d{4}/.exec(session.createdAt ?? "")?.[0] ?? "undated";
  return `reviews/${year}/${fileNameOf(session.id)}/`;
}

/** A thread's file: its header and title, then each comment. */
export function renderThread(thread: ReviewThread, title: string): string {
  const { comments, ...rest } = thread;
  return renderDoc([
    {
      tag: "thread",
      meta: withoutSecrets(rest) as Record<string, unknown>,
      body: `# ${title.replace(/\s*\n\s*/g, " ").trim() || "Review"}`,
    },
    ...comments.map(({ body, ...meta }: ReviewComment) => ({
      tag: "comment",
      meta: withoutSecrets(meta) as Record<string, unknown>,
      body,
    })),
  ]);
}

/** A thread's file read back (its title line is not part of the thread). */
export function parseThread(text: string): ReviewThread {
  const [head, ...comments] = parseDoc(text);
  if (!head || head.tag !== "thread") throw new Error("not a thread file");
  if (comments.some((block) => block.tag !== "comment"))
    throw new Error("a thread file holds comments only");
  return {
    ...(head.meta as Omit<ReviewThread, "comments">),
    comments: comments.map(
      (block) => ({ ...block.meta, body: block.body }) as ReviewComment,
    ),
  };
}

/** The session as kept: without what only says what an agent is doing now. */
function keptSession(session: ReviewSession): ReviewSession {
  if (!session.agent?.working) return session;
  const agent = { ...session.agent };
  delete agent.working;
  return { ...session, agent };
}

type ImageEntry = string | { omitted: string; bytes: number };

const extensionOf = (name: string) => name.slice(name.lastIndexOf(".") + 1);

export function reviewsArea(
  paths: { reviews: string },
  source: () => ReviewSource | null,
): HistoryArea {
  return {
    name: "reviews",
    async render(ids) {
      const files = new Map<string, string | Uint8Array>();
      const store = source();
      if (!store) throw new Error("the review store is not open");
      const all = store.loadSessions();
      const sessions = ids ? all.filter((each) => ids.has(each.id)) : all;
      const owns = ids
        ? [...ids].map((id) => `reviews/*/${fileNameOf(id)}/`)
        : ["reviews/"];
      const images = new Map<string, Uint8Array>();
      for (const session of sessions) {
        const dir = reviewDir(session);
        const threads = store.loadThreads(session.id);
        const used: Record<string, ImageEntry> = {};
        const texts = [
          session.summary ?? "",
          ...threads.flatMap((thread) =>
            thread.comments.map((comment) => comment.body),
          ),
        ];
        for (const text of texts)
          for (const match of text.matchAll(IMAGE_REF)) {
            const key = `${match[1]}/${match[2]}`;
            if (used[key]) continue;
            const full = join(paths.reviews, "images", match[1]!, match[2]!);
            try {
              const size = (await stat(full)).size;
              if (size > HISTORY_IMAGE_MAX_BYTES) {
                used[key] = { omitted: "larger than 5 MB", bytes: size };
                continue;
              }
              const data = await readFile(full);
              const name = `${createHash("sha256").update(data).digest("hex")}.${extensionOf(match[2]!)}`;
              used[key] = name;
              images.set(`reviews/images/${name}`, data);
            } catch {
              // Gone: the comment links to nothing either way.
            }
          }
        files.set(
          `${dir}review.json`,
          stableJson({
            session: withoutSecrets(keptSession(session)),
            ...(Object.keys(used).length ? { images: used } : {}),
          }),
        );
        for (const thread of threads)
          files.set(
            `${dir}${fileNameOf(thread.id)}.md`,
            renderThread(thread, session.title),
          );
      }
      for (const [path, data] of images) files.set(path, data);
      return { files, owns };
    },
    describe: (changed) => {
      const reviews = new Set<string>();
      let threads = 0;
      let images = 0;
      for (const path of changed) {
        const match = /^reviews\/[^/]+\/([^/]+)\/(.+)$/.exec(path);
        if (path.startsWith("reviews/images/")) images++;
        else if (match) {
          reviews.add(match[1]!);
          if (match[2]!.endsWith(".md")) threads++;
        }
      }
      return [
        threads
          ? `${count(threads, "thread")} in ${count(reviews.size, "review")}`
          : reviews.size
            ? count(reviews.size, "review")
            : "",
        images ? count(images, "image") : "",
      ]
        .filter(Boolean)
        .join(", ");
    },
  };
}

/**
 * The review store telling the history what it wrote: each review changed
 * (and the Work item a thread is on, whose file shows its description).
 */
export function withHistoryHooks<
  T extends {
    loadThreads(sessionId: string): ReviewThread[];
    saveSession(session: ReviewSession): void;
    saveThread(thread: ReviewThread): void;
    deleteThread(id: string): void;
    deleteSession(id: string): void;
  },
>(storage: T, changed: (area: string, id?: string) => void): T {
  const sessionOf = new Map<string, string>();
  const workOf = new Map<string, string>();
  const seen = (thread: ReviewThread) => {
    sessionOf.set(thread.id, thread.sessionId);
    const item = thread.anchor?.work?.item;
    if (item) workOf.set(thread.id, item);
  };
  const wrapped = Object.create(storage) as T;
  wrapped.loadThreads = (sessionId) => {
    const threads = storage.loadThreads(sessionId);
    for (const thread of threads) seen(thread);
    return threads;
  };
  wrapped.saveSession = (session) => {
    storage.saveSession(session);
    changed("reviews", session.id);
  };
  wrapped.saveThread = (thread) => {
    storage.saveThread(thread);
    seen(thread);
    changed("reviews", thread.sessionId);
    const item = workOf.get(thread.id);
    if (item) changed("work", item);
  };
  wrapped.deleteThread = (id) => {
    storage.deleteThread(id);
    const session = sessionOf.get(id);
    if (session) changed("reviews", session);
    else changed("reviews");
    const item = workOf.get(id);
    if (item) changed("work", item);
    sessionOf.delete(id);
    workOf.delete(id);
  };
  wrapped.deleteSession = (id) => {
    storage.deleteSession(id);
    changed("reviews", id);
  };
  return wrapped;
}
