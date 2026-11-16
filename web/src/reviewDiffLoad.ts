import type { ReviewDiff, ReviewDiffFile } from "../../shared/review";
import { BoundedCache } from "./boundedCache";
import { LARGE_DIFF_CHANGED_LINES } from "./components/diffAutoCollapse";

/** A request for one view's diff, made with ReviewDiffs.begin. */
export type ReviewDiffRequest<D> = {
  /** The view's diff already loaded, unless the request asked it fresh. */
  readonly cached: D | undefined;
  /**
   * Whether the answer still counts: no reload came since, and for the shown
   * view no other view was asked for since.
   */
  current(): boolean;
  /** Keeps the answer while it counts; says whether it did. */
  done(diff: D): boolean;
};

/**
 * The diffs of a review's views, by commit (`""` for all changes). The shown
 * view's latest request wins: an answer for a view the user already left,
 * or one asked before a reload, neither shows nor fills the cache.
 */
export class ReviewDiffs<D> {
  private readonly cache: BoundedCache<string, D>;
  /** Bumped by each request for the shown view, and by a reload. */
  private latest = 0;
  /** Bumped by a reload. */
  private generation = 0;

  constructor(max = 16) {
    this.cache = new BoundedCache({ max });
  }

  /** The view's diff as loaded, if it still is. */
  get(sha: string): D | undefined {
    return this.cache.get(sha);
  }

  /** Forgets every diff: answers to requests made before are dropped. */
  clear() {
    this.generation++;
    this.latest++;
    this.cache.clear();
  }

  /**
   * Starts loading a view's diff. `shown` is the view put on screen (the
   * latest such request wins); otherwise one only looked at, such as by a
   * search through the other views, which only a reload makes stale.
   */
  begin(
    sha: string,
    { fresh = false, shown = true } = {},
  ): ReviewDiffRequest<D> {
    const token = shown ? ++this.latest : this.latest;
    const generation = this.generation;
    const current = () =>
      generation === this.generation && (!shown || token === this.latest);
    return {
      cached: fresh ? undefined : this.cache.get(sha),
      current,
      done: (diff) => {
        if (!current()) return false;
        this.cache.set(sha, diff);
        return true;
      },
    };
  }
}

/** Files one read asks for (as Changes' own reads ahead: one request each). */
export const VIEW_FILES_PER_READ = 16;
/** Reads of a view's files in flight at once. */
export const VIEW_READS_AT_ONCE = 2;

/**
 * One view's diff as Changes reads it (plan phase 5s): the summary, every
 * file listed with its counts, then the patches of the files the reader
 * gets near, a few files per request (as Changes reads its own files),
 * whatever the whole change weighs. A whole diff (a merge request GitLab
 * answers, an older bridge) is there at once. Large and generated files
 * wait to be asked for by name, as Changes folds them.
 */
export class ViewLoad {
  /** Patches read, by path. */
  readonly files = new Map<string, ReviewDiffFile>();
  readonly errors = new Map<string, string>();
  readonly loading = new Set<string>();
  /** Files wanted, the ones to read first first. */
  private wanted: string[] = [];
  /** Bumped by each change: what reads it draws again. */
  version = 0;
  private reads = 0;
  private readonly byPath: Map<string, ReviewDiffFile>;
  private readonly index: Map<string, number>;

  constructor(readonly diff: ReviewDiff) {
    this.byPath = new Map(diff.files.map((file) => [file.path, file]));
    this.index = new Map(diff.files.map((file, at) => [file.path, at]));
    for (const file of diff.files)
      if (!diff.summary || file.binary) this.files.set(file.path, file);
    // The first files, read before the reader scrolls.
    this.near(diff.files.slice(0, VIEW_FILES_PER_READ).map((f) => f.path));
  }

  /** Waits to be asked for by name: a file Changes folds (large, generated). */
  static held(file: ReviewDiffFile): boolean {
    return (
      !!file.generated ||
      (file.additions ?? 0) + (file.deletions ?? 0) >= LARGE_DIFF_CHANGED_LINES
    );
  }

  private waiting(path: string) {
    return (
      this.byPath.has(path) &&
      !this.files.has(path) &&
      !this.loading.has(path) &&
      !this.errors.has(path)
    );
  }

  /**
   * The files near the reader, and the block after them: wanted, unless
   * Changes folds them (asked by name with `ask`).
   */
  near(paths: readonly string[]) {
    const listed = this.diff.files;
    const last = Math.max(
      -1,
      ...paths.map((path) => this.index.get(path) ?? -1),
    );
    const ahead = listed
      .slice(last + 1, last + 1 + VIEW_FILES_PER_READ)
      .map((file) => file.path)
      .filter((path) => this.waiting(path));
    // Read ahead by blocks, not a file at a time as the reader moves: the
    // files near are read now, those after once half a block waits.
    const now = paths.filter((path) => this.waiting(path));
    const next = [
      ...now,
      ...(now.length || ahead.length >= VIEW_FILES_PER_READ / 2 ? ahead : []),
    ];
    const added = next.filter((path) => !ViewLoad.held(this.byPath.get(path)!));
    this.want(added);
    return added.length > 0;
  }

  /** A file wanted now (picked, Load diff, Retry), held or not. */
  ask(path: string) {
    if (!this.byPath.has(path)) return false;
    if (this.files.has(path) || this.loading.has(path)) return false;
    this.errors.delete(path);
    this.want([path]);
    return true;
  }

  /** These files read before the others wanted, in this order. */
  private want(paths: readonly string[]) {
    const first = new Set(paths);
    this.wanted = [...paths, ...this.wanted.filter((p) => !first.has(p))];
  }

  /** The files to read next. */
  private next(max: number): ReviewDiffFile[] {
    this.wanted = this.wanted.filter((path) => this.waiting(path));
    return this.wanted.slice(0, max).map((path) => this.byPath.get(path)!);
  }

  /**
   * Reads the files wanted with `read`, a few requests at a time, while
   * `alive` holds; `changed` after each answer.
   */
  pump(
    read: (files: ReviewDiffFile[]) => Promise<ReviewDiffFile[]>,
    alive: () => boolean,
    changed: () => void,
  ) {
    while (this.reads < VIEW_READS_AT_ONCE && alive()) {
      const batch = this.next(VIEW_FILES_PER_READ);
      if (!batch.length) return;
      this.reads++;
      for (const file of batch) this.loading.add(file.path);
      this.version++;
      void read(batch)
        .then(
          (files) => {
            batch.forEach((asked, index) => {
              const file =
                files.find((each) => each.path === asked.path) ?? files[index];
              if (file)
                this.files.set(asked.path, {
                  ...asked,
                  ...file,
                  path: asked.path,
                });
              else this.errors.set(asked.path, "the bridge answered no file");
            });
          },
          (error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            for (const file of batch) this.errors.set(file.path, message);
          },
        )
        .finally(() => {
          this.reads--;
          for (const file of batch) this.loading.delete(file.path);
          this.version++;
          changed();
          this.pump(read, alive, changed);
        });
    }
  }
}
