import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RENDERED_STORAGE_MAX_CHARS,
  RENDERED_STORAGE_MAX_KEYS,
  type RenderedStorageWrite,
  storageChars,
} from "../../../shared/renderedPage";
import { dataRoot, replaceDataFileAsync } from "../config/data-paths";
import { serverLogger } from "../utils/logger";

/**
 * What the pages of each listed site keep in `localStorage`, per site (the
 * listed entry): the pages' sandbox has no storage of its own, so the
 * server keeps it and writes it into each page it serves
 * (rendered-pages.ts), where the helper's shim reads it
 * (rendered-helper.ts). A small JSON file under Roamgate's data directory,
 * written whole and atomically after each change, bounded per site and in
 * the number of sites.
 */
export const RENDERED_STORAGE_MAX_SITES = 100;

export class StorageQuotaError extends Error {
  constructor() {
    super("the site's storage is full");
    this.name = "QuotaExceededError";
  }
}

export type SiteStorage = {
  /** The site's items: a copy. */
  get(site: string): Record<string, string>;
  /** Applies one write; throws StorageQuotaError over the bounds. */
  write(site: string, write: RenderedStorageWrite): void;
  /** Forgets everything the site stored. */
  clear(site: string): void;
  /** Resolves once what is changed is on disk. */
  flush(): Promise<void>;
};

const log = serverLogger.child("rendered");

export function renderedStoragePath(root = dataRoot()): string {
  return join(root, "rendered-storage.json");
}

function load(file: string): Map<string, Map<string, string>> {
  const sites = new Map<string, Map<string, string>>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      log.warn("rendered storage unreadable, starting empty", {
        error: String(error),
      });
    return sites;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return sites;
  for (const [site, raw] of Object.entries(parsed)) {
    if (sites.size >= RENDERED_STORAGE_MAX_SITES) break;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const items = new Map<string, string>();
    let chars = 0;
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== "string" || items.size >= RENDERED_STORAGE_MAX_KEYS)
        continue;
      chars += key.length + value.length;
      if (chars > RENDERED_STORAGE_MAX_CHARS) break;
      items.set(key, value);
    }
    if (items.size) sites.set(site, items);
  }
  return sites;
}

/** In memory only when no `file` is given (tests). */
export function createSiteStorage(file?: string): SiteStorage {
  const sites = file ? load(file) : new Map<string, Map<string, string>>();
  let dirty = false;
  let writing: Promise<void> | null = null;

  async function save() {
    if (!file) return;
    // One write at a time; a change made during it is written after it.
    while (dirty) {
      dirty = false;
      const body: Record<string, Record<string, string>> = {};
      for (const [site, items] of sites) body[site] = Object.fromEntries(items);
      try {
        await replaceDataFileAsync(file, `${JSON.stringify(body)}\n`);
      } catch (error) {
        log.warn("rendered storage not saved", { error: String(error) });
      }
    }
  }
  function changed() {
    dirty = true;
    writing ??= save().finally(() => {
      writing = null;
    });
  }

  return {
    get(site) {
      return Object.fromEntries(sites.get(site) ?? []);
    },
    write(site, write) {
      if (write.op === "clear") {
        if (sites.delete(site)) changed();
        return;
      }
      const items = sites.get(site);
      if (write.op === "remove") {
        if (items?.delete(write.key)) {
          if (!items.size) sites.delete(site);
          changed();
        }
        return;
      }
      if (items?.get(write.key) === write.value) return;
      if (write.key.length + write.value.length > RENDERED_STORAGE_MAX_CHARS)
        throw new StorageQuotaError();
      const next = new Map(items ?? []);
      next.set(write.key, write.value);
      if (
        next.size > RENDERED_STORAGE_MAX_KEYS ||
        storageChars(Object.fromEntries(next)) > RENDERED_STORAGE_MAX_CHARS ||
        (!items && sites.size >= RENDERED_STORAGE_MAX_SITES)
      )
        throw new StorageQuotaError();
      sites.set(site, next);
      changed();
    },
    clear(site) {
      if (sites.delete(site)) changed();
    },
    async flush() {
      while (writing) await writing;
    },
  };
}
