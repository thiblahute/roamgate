import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceDataFile } from "../config/data-paths";
import { emptyLedger, type LedgerFile } from "../mr-reviews/efforts";
import { type HistoryArea, count } from "./area";
import { fileNameOf, jsonl, parseJsonl, stableJson } from "./format";
import { withoutSecrets } from "../utils/secrets";

/**
 * What the Reviews author (section 11, D21, D22): the `mr_reviews` keys the
 * user and their agents write (order, pins, removals, overrides, views,
 * requests not proposed yet, groups and workspaces headed upstream,
 * efforts, merge rules; since version 2 also the hosts, followed projects
 * and hints, D30) and each effort's authored ledger with its history, as
 * stable key-sorted JSON (version 3 adds the workspaces headed upstream by
 * themselves). Never secrets, never derived data (forge state, inference,
 * caches, derived.json, what the user last saw), never the Undo journal.
 * The same code is `roamgate reviews export|import` and the history's
 * mr-reviews area (mrReviewsArea).
 */

export const REVIEWS_EXPORT_FORMAT = "roamgate-reviews";
export const REVIEWS_EXPORT_VERSION = 3;

/** The authored keys of `mr_reviews` in settings.json. */
export const EXPORTED_KEYS = [
  "order",
  "pinned",
  "hidden",
  "overrides",
  "views",
  "unsent",
  "upstream_groups",
  "upstream_skip",
  "upstream_workspaces",
  "efforts",
  "merge",
  "hosts",
  "followed",
  "hints",
] as const;

type ExportedKey = (typeof EXPORTED_KEYS)[number];

/**
 * The export version each key arrived in: an older export says nothing
 * of a newer key, so importing it keeps the local value (never removes it).
 */
const KEY_SINCE: Partial<Record<ExportedKey, number>> = {
  hosts: 2,
  followed: 2,
  hints: 2,
  upstream_workspaces: 3,
};

/** The keys an export of that version carries. */
function keysOf(version: number): ExportedKey[] {
  return EXPORTED_KEYS.filter((key) => (KEY_SINCE[key] ?? 1) <= version);
}

export type ExportedLedger = Omit<LedgerFile, "journal">;

export type ReviewsExport = {
  format: typeof REVIEWS_EXPORT_FORMAT;
  version: number;
  exported_at: string;
  mr_reviews: Record<string, unknown>;
  efforts: Record<
    string,
    { ledger: ExportedLedger; history: Record<string, unknown>[] }
  >;
};

function readJson(path: string): unknown {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

function readHistory(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line) return [];
      try {
        const value = JSON.parse(line);
        return value && typeof value === "object" ? [value] : [];
      } catch {
        return [];
      }
    });
}

/** What the Reviews authored, from settings.json's `mr_reviews` and the efforts' files. */
export function exportReviews(input: {
  /** settings.json's `mr_reviews` as stored. */
  stored: Record<string, unknown> | undefined;
  /** `<data>/mr-reviews/efforts`. */
  effortsRoot: string;
  now?: () => number;
}): ReviewsExport {
  const stored = input.stored ?? {};
  const mrReviews: Record<string, unknown> = {};
  for (const key of EXPORTED_KEYS)
    if (stored[key] !== undefined) mrReviews[key] = stored[key];
  const efforts: ReviewsExport["efforts"] = {};
  const ids = new Set<string>(
    (Array.isArray(stored.efforts) ? stored.efforts : []).flatMap(
      (effort: any) => (typeof effort?.id === "string" ? [effort.id] : []),
    ),
  );
  // Ledgers of efforts no longer declared are kept too: declaring it again finds it.
  if (existsSync(input.effortsRoot))
    for (const name of readdirSync(input.effortsRoot))
      if (!name.startsWith(".") && /^[\w-]+$/.test(name)) ids.add(name);
  for (const id of [...ids].sort()) {
    const dir = join(input.effortsRoot, id);
    const raw = readJson(
      join(dir, "ledger.json"),
    ) as Partial<LedgerFile> | null;
    const history = readHistory(join(dir, "history.jsonl"));
    if (!raw && !history.length) continue;
    const ledger: Partial<LedgerFile> = { ...emptyLedger(), ...raw };
    delete ledger.journal;
    efforts[id] = { ledger: ledger as ExportedLedger, history };
  }
  return withoutSecrets({
    format: REVIEWS_EXPORT_FORMAT,
    version: REVIEWS_EXPORT_VERSION,
    exported_at: new Date((input.now ?? Date.now)()).toISOString(),
    mr_reviews: mrReviews,
    efforts,
  }) as ReviewsExport;
}

/** An export read back, checked; throws on anything else. */
export function parseReviewsExport(text: string): ReviewsExport {
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("not JSON");
  }
  if (value?.format !== REVIEWS_EXPORT_FORMAT)
    throw new Error("not a Reviews export");
  if (
    typeof value.version !== "number" ||
    value.version > REVIEWS_EXPORT_VERSION
  )
    throw new Error(
      `export version ${value.version} is newer than this Roamgate`,
    );
  if (!value.mr_reviews || typeof value.mr_reviews !== "object")
    throw new Error("no mr_reviews in the export");
  const efforts: ReviewsExport["efforts"] = {};
  for (const [id, effort] of Object.entries(value.efforts ?? {})) {
    if (!/^[\w-]+$/.test(id)) throw new Error(`bad effort id ${id}`);
    const each = effort as any;
    efforts[id] = {
      ledger: { ...emptyLedger(), ...(each?.ledger ?? {}) },
      history: Array.isArray(each?.history) ? each.history : [],
    };
    delete (efforts[id]!.ledger as any).journal;
  }
  const mrReviews: Record<string, unknown> = {};
  for (const key of EXPORTED_KEYS)
    if (value.mr_reviews[key] !== undefined)
      mrReviews[key] = value.mr_reviews[key];
  return withoutSecrets({
    format: REVIEWS_EXPORT_FORMAT,
    version: value.version,
    exported_at: String(value.exported_at ?? ""),
    mr_reviews: mrReviews,
    efforts,
  }) as ReviewsExport;
}

export type ImportChange = {
  path: string;
  kind: "added" | "removed" | "changed";
  /** The local value was set after the imported one. */
  newerLocal?: boolean;
};

/** The items of a value, by a stable name, for a diff by item. */
function itemsOf(path: string, value: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (Array.isArray(value)) {
    value.forEach((each: any, index) => {
      const name =
        typeof each === "string"
          ? each
          : (each?.id ??
            each?.key ??
            each?.name ??
            (each?.provider && each?.project && each?.number !== undefined
              ? `${each.provider}:${each.host}/${each.project}#${each.number}`
              : each?.provider && each?.project
                ? `${each.provider}:${each.host}/${each.project}`
                : each?.provider && each?.host
                  ? `${each.provider}:${each.host}`
                  : each?.connection_id
                    ? `${each.connection_id}:${each.path ?? each.label ?? ""}`
                    : `#${index}`));
      out.set(`${path}[${String(name)}]`, each);
    });
  } else if (value && typeof value === "object")
    for (const [key, each] of Object.entries(value))
      out.set(`${path}.${key}`, each);
  else if (value !== undefined) out.set(path, value);
  return out;
}

const atOf = (value: unknown): string =>
  value && typeof value === "object" && typeof (value as any).at === "string"
    ? (value as any).at
    : "";

/**
 * What importing would change, item by item: added, removed and changed
 * keys, each changed one flagged when the local value is the newer. The
 * order is one item (its arrangement as a whole).
 */
export function importChanges(
  local: ReviewsExport,
  incoming: ReviewsExport,
): ImportChange[] {
  const keys = keysOf(Math.min(local.version, incoming.version));
  const flat = (state: ReviewsExport) => {
    const out = new Map<string, unknown>();
    for (const key of keys) {
      const value = state.mr_reviews[key];
      if (key === "order") {
        if (value !== undefined) out.set("mr_reviews.order", value);
        continue;
      }
      for (const [path, each] of itemsOf(`mr_reviews.${key}`, value))
        out.set(path, each);
    }
    for (const [id, effort] of Object.entries(state.efforts)) {
      const base = `efforts.${id}`;
      for (const [path, each] of itemsOf(
        `${base}.entries`,
        effort.ledger.entries,
      ))
        out.set(path, each);
      for (const [path, each] of itemsOf(
        `${base}.matches`,
        effort.ledger.matches,
      ))
        out.set(path, each);
      for (const [path, each] of itemsOf(`${base}.plans`, effort.ledger.plans))
        out.set(path, each);
      for (const [path, each] of itemsOf(
        `${base}.aliases`,
        effort.ledger.aliases,
      ))
        out.set(path, each);
      if (effort.history.length)
        out.set(`${base}.history`, effort.history.length);
    }
    return out;
  };
  const mine = flat(local);
  const theirs = flat(incoming);
  const changes: ImportChange[] = [];
  for (const [path, value] of theirs) {
    if (!mine.has(path)) changes.push({ path, kind: "added" });
    else if (path.endsWith(".history")) {
      // History is merged, never replaced: only new lines count.
      if ((value as number) > (mine.get(path) as number))
        changes.push({ path, kind: "changed" });
    } else if (stableJson(mine.get(path)) !== stableJson(value)) {
      const newer = atOf(mine.get(path)) > atOf(value);
      changes.push({
        path,
        kind: "changed",
        ...(newer ? { newerLocal: true } : {}),
      });
    }
  }
  for (const path of mine.keys())
    if (!theirs.has(path) && !path.endsWith(".history"))
      changes.push({ path, kind: "removed" });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Applies an import to the efforts' files: each ledger replaced (its Undo
 * journal emptied, its version moved past the local one), each history
 * merged (lines not there yet appended). The settings part is the caller's.
 */
export function applyLedgers(
  incoming: ReviewsExport,
  effortsRoot: string,
): number {
  let written = 0;
  for (const [id, effort] of Object.entries(incoming.efforts)) {
    const dir = join(effortsRoot, id);
    const local = readJson(
      join(dir, "ledger.json"),
    ) as Partial<LedgerFile> | null;
    const ledger: LedgerFile = {
      ...emptyLedger(),
      ...effort.ledger,
      version: Math.max(local?.version ?? 0, effort.ledger.version ?? 0) + 1,
      journal: [],
    };
    replaceDataFile(join(dir, "ledger.json"), `${JSON.stringify(ledger)}\n`);
    const path = join(dir, "history.jsonl");
    const have = new Set(readHistory(path).map((line) => stableJson(line)));
    const add = effort.history.filter((line) => !have.has(stableJson(line)));
    if (add.length) {
      const before = existsSync(path) ? readFileSync(path, "utf8") : "";
      replaceDataFile(
        path,
        `${before}${add.map((line) => JSON.stringify(line)).join("\n")}\n`,
      );
    }
    written++;
  }
  return written;
}

/** settings.json's `mr_reviews` with the imported authored keys (others kept). */
export function importedMrReviews(
  stored: Record<string, unknown> | undefined,
  incoming: ReviewsExport,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(stored ?? {}) };
  for (const key of keysOf(incoming.version)) {
    if (incoming.mr_reviews[key] === undefined) delete next[key];
    else next[key] = incoming.mr_reviews[key];
  }
  // Pages see a new version and read the inbox again.
  next.order_version =
    (typeof stored?.order_version === "number" ? stored.order_version : 0) + 1;
  return next;
}

/**
 * The history's mr-reviews area: the export above, split so each effort's
 * ledger and history are their own files (a ledger change does not rewrite
 * the others): `mr-reviews/export.json` holds the authored `mr_reviews`
 * keys (no `exported_at`: the same state, the same file),
 * `mr-reviews/efforts/<id>/ledger.json` and `history.jsonl` each effort's.
 */
export function mrReviewsArea(paths: {
  settings: string;
  data: string;
}): HistoryArea {
  const effortsRoot = join(paths.data, "mr-reviews", "efforts");
  return {
    name: "mr-reviews",
    watch: () => [
      paths.settings,
      ...effortDirs(effortsRoot).flatMap((dir) => [
        join(dir, "ledger.json"),
        join(dir, "history.jsonl"),
      ]),
    ],
    render() {
      const settings = readJson(paths.settings) as Record<string, any> | null;
      const exported = exportReviews({
        stored: settings?.mr_reviews,
        effortsRoot,
      });
      const files = new Map<string, string>();
      const { efforts } = exported;
      const head: Partial<ReviewsExport> = { ...exported, efforts: {} };
      delete head.exported_at;
      files.set("mr-reviews/export.json", stableJson(head));
      for (const [id, effort] of Object.entries(efforts)) {
        const base = `mr-reviews/efforts/${fileNameOf(id)}`;
        files.set(`${base}/ledger.json`, stableJson(effort.ledger));
        if (effort.history.length)
          files.set(`${base}/history.jsonl`, jsonl(effort.history));
      }
      return { files, owns: ["mr-reviews/"] };
    },
    describe: (changed) => {
      const efforts = new Set(
        changed.flatMap(
          (path) => /^mr-reviews\/efforts\/([^/]+)\//.exec(path)?.[1] ?? [],
        ),
      );
      return [
        changed.includes("mr-reviews/export.json")
          ? "the Reviews' settings"
          : "",
        efforts.size ? count(efforts.size, "effort") : "",
      ]
        .filter(Boolean)
        .join(", ");
    },
  };
}

/** The history's files read back as an export (format 3), for an import. */
export function mrReviewsFromHistory(
  files: ReadonlyMap<string, string>,
): ReviewsExport {
  const head = JSON.parse(files.get("mr-reviews/export.json") ?? "{}");
  const efforts: ReviewsExport["efforts"] = {};
  for (const [path, text] of files) {
    const match = /^mr-reviews\/efforts\/([^/]+)\/ledger\.json$/.exec(path);
    if (!match) continue;
    const id = match[1]!;
    efforts[id] = {
      ledger: JSON.parse(text),
      history: parseJsonl(
        files.get(`mr-reviews/efforts/${id}/history.jsonl`) ?? "",
      ) as Record<string, unknown>[],
    };
  }
  return parseReviewsExport(
    JSON.stringify({ ...head, exported_at: "", efforts }),
  );
}

function effortDirs(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((name) => !name.startsWith(".") && /^[\w-]+$/.test(name))
      .map((name) => join(root, name));
  } catch {
    return [];
  }
}
