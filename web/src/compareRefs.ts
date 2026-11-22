import type { CompareRef, CompareRefs } from "../../shared/compareRefs";
import {
  compareSearchMatches,
  matchSearch,
  type SearchMatch,
  searchTokens,
} from "./fuzzyMatch";

export type { CompareRef, CompareRefs };

/*
 * The refs Changes' scope picker offers on either side of a comparison,
 * ranked for what is usually meant: with no search, Automatic's base, the
 * branch's upstream, its stack's neighbours, then branches by their last
 * commit, remote ones, tags, and backups last; a search ranks them as the
 * workspace search does (fzf-style, fuzzyMatch), those first on ties.
 */

/** A ref as the picker names it: `android-rust`, `origin/main`, `v1.0`. */
export function refLabel(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes|tags)\//, "");
}

export type CompareRefKind = "branch" | "remote" | "tag";

export function refKind(ref: string): CompareRefKind {
  return ref.startsWith("refs/tags/")
    ? "tag"
    : ref.startsWith("refs/remotes/")
      ? "remote"
      : "branch";
}

/** Copies kept aside: `backup/...`, `x/backups/...`, `backup-old`. */
export function isBackupRef(ref: string): boolean {
  const label = refLabel(ref);
  return /(^|\/)backups?(\/|$)/i.test(label) || /^backups?[-_]/i.test(label);
}

/** Why a ref is offered first: said beside it. */
export type CompareRefReason =
  | "checked out"
  | "automatic base"
  | "upstream"
  | "stack";

export type RankedRef = {
  name: string;
  label: string;
  kind: CompareRefKind;
  date?: number;
  reason?: CompareRefReason;
  /** The label's characters the search matched. */
  highlights?: number[];
};

/** At most this many shown: a search finds the others. */
export const COMPARE_REFS_SHOWN = 120;

/** The picker's refs when only the summary's branch names are known. */
export function compareRefsFromNames(
  names: readonly string[],
  current?: string,
): CompareRefs {
  return {
    ...(current ? { current: `refs/heads/${current}` } : {}),
    near: [],
    refs: names.map((name) => ({ name })),
  };
}

/**
 * The refs for one side, ranked for `search`: `exclude` (the other side)
 * left out; the checked-out branch offered first when `withCurrent` (the
 * head's side), else left out.
 */
export function rankCompareRefs(
  listed: CompareRefs,
  search: string,
  {
    exclude,
    withCurrent = false,
    limit = COMPARE_REFS_SHOWN,
  }: {
    exclude?: string | undefined;
    withCurrent?: boolean;
    limit?: number;
  } = {},
): RankedRef[] {
  const near = new Map((listed.near ?? []).map((name, index) => [name, index]));
  const reason = (name: string): CompareRefReason | undefined =>
    name === listed.current
      ? "checked out"
      : name === listed.base
        ? "automatic base"
        : name === listed.upstream
          ? "upstream"
          : near.has(name)
            ? "stack"
            : undefined;
  /** Lower first: why it is offered, then its kind, backups last. */
  const priority = (ref: CompareRef) => {
    switch (reason(ref.name)) {
      case "checked out":
        return 0;
      case "automatic base":
        return 1;
      case "upstream":
        return 2;
      case "stack":
        return 3 + near.get(ref.name)! / 100;
    }
    if (isBackupRef(ref.name)) return 9;
    return { branch: 4, remote: 5, tag: 6 }[refKind(ref.name)];
  };
  const seen = new Set<string>();
  const candidates = (listed.refs ?? []).filter((ref) => {
    if (seen.has(ref.name) || ref.name === exclude) return false;
    if (ref.name === listed.current && !withCurrent) return false;
    seen.add(ref.name);
    return true;
  });
  if (withCurrent && listed.current && !seen.has(listed.current))
    candidates.unshift({ name: listed.current });
  const tokens = searchTokens(search);
  const matches = new Map<string, SearchMatch>();
  const shown = tokens.length
    ? candidates.filter((ref) => {
        const match = matchSearch(tokens, [refLabel(ref.name)]);
        if (match) matches.set(ref.name, match);
        return !!match;
      })
    : candidates;
  return shown
    .map((ref) => ({ ref, priority: priority(ref) }))
    .sort(
      (a, b) =>
        compareSearchMatches(
          matches.get(a.ref.name),
          matches.get(b.ref.name),
        ) ||
        a.priority - b.priority ||
        (b.ref.date ?? 0) - (a.ref.date ?? 0) ||
        refLabel(a.ref.name).localeCompare(refLabel(b.ref.name)),
    )
    .slice(0, limit)
    .map(({ ref }) => {
      const why = reason(ref.name);
      const highlights = matches.get(ref.name)?.highlights[0];
      return {
        name: ref.name,
        label: refLabel(ref.name),
        kind: refKind(ref.name),
        ...(ref.date ? { date: ref.date } : {}),
        ...(why ? { reason: why } : {}),
        ...(highlights?.length ? { highlights } : {}),
      };
    });
}
