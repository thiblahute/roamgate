/**
 * The archive settings (`archive` in settings.json): where the archive lives,
 * which agents and hosts it covers, what is indexed and what is left out.
 */

export type IndexLevel = "full" | "words" | "none";

/** A match on any of host, agent and project (substring); empty fields match all. */
export type ArchiveRule = {
  host?: string;
  agent?: string;
  project?: string;
};

export type ArchiveIndexRule = ArchiveRule & { level: IndexLevel };

export type ArchiveHostSpec = {
  /** An ssh destination; absent: this machine. */
  ssh?: string;
  /** The user's home there, for project path mapping; found when absent. */
  home?: string;
  path_style?: "posix" | "windows";
  /** Per-agent root overrides. */
  roots?: Record<string, string>;
  /** Left out of pulls while false. */
  enabled?: boolean;
};

export type GuiArchiveSettings = {
  /** Archive directory; default `<data root>/claude-archive`. */
  dir?: string;
  /** This machine's name in the archive; default from connections, else hostname. */
  host?: string;
  /** Agents archived; others are never guessed. */
  agents: string[];
  hosts: Record<string, ArchiveHostSpec>;
  /** Hours without a successful sync after which health warns. */
  stale_hours: number;
  /** Index thinking blocks too. */
  thinking: boolean;
  index: { default: IndexLevel; rules: ArchiveIndexRule[] };
  /** Never archived. */
  exclude: ArchiveRule[];
  /** Archived but left out of search and the Ranger tools. */
  hide: ArchiveRule[];
  /** Health warns below this much free disk, in GB. */
  min_free_gb: number;
  /** Where a push goes: the archive home, reached over ssh. */
  push?: { target: string; archive_dir?: string; binary?: string };
  /** An archive on another machine, reached over ssh (resume, search). */
  remote?: string;
};

export const DEFAULT_ARCHIVE_SETTINGS: GuiArchiveSettings = {
  agents: ["claude", "codex", "pi"],
  hosts: {},
  stale_hours: 48,
  thinking: false,
  index: { default: "full", rules: [] },
  exclude: [],
  hide: [],
  min_free_gb: 20,
};

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function level(value: unknown): IndexLevel | undefined {
  return value === "full" || value === "words" || value === "none"
    ? value
    : undefined;
}

function rules(value: unknown): ArchiveRule[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObj).map((rule) => ({
    ...(str(rule.host) ? { host: str(rule.host) } : {}),
    ...(str(rule.agent) ? { agent: str(rule.agent) } : {}),
    ...(str(rule.project) ? { project: str(rule.project) } : {}),
  }));
}

function hostSpec(value: unknown): ArchiveHostSpec {
  if (!isObj(value)) return {};
  const roots = isObj(value.roots)
    ? Object.fromEntries(
        Object.entries(value.roots).flatMap(([agent, root]) =>
          str(root) ? [[agent, str(root) as string]] : [],
        ),
      )
    : undefined;
  return {
    ...(str(value.ssh) ? { ssh: str(value.ssh) } : {}),
    ...(str(value.home) ? { home: str(value.home) } : {}),
    ...(value.path_style === "windows" || value.path_style === "posix"
      ? { path_style: value.path_style }
      : {}),
    ...(roots && Object.keys(roots).length ? { roots } : {}),
    ...(value.enabled === false ? { enabled: false } : {}),
  };
}

/** Fills defaults in and drops invalid values, field by field. */
export function normalizeArchiveSettings(raw: unknown): GuiArchiveSettings {
  const obj = isObj(raw) ? raw : {};
  const defaults = DEFAULT_ARCHIVE_SETTINGS;
  const agents = Array.isArray(obj.agents)
    ? obj.agents.filter((a): a is string => typeof a === "string" && !!a.trim())
    : defaults.agents;
  const index = isObj(obj.index) ? obj.index : {};
  const push = isObj(obj.push) ? obj.push : undefined;
  const staleHours =
    typeof obj.stale_hours === "number" && obj.stale_hours > 0
      ? obj.stale_hours
      : defaults.stale_hours;
  const minFree =
    typeof obj.min_free_gb === "number" && obj.min_free_gb >= 0
      ? obj.min_free_gb
      : defaults.min_free_gb;
  return {
    ...(str(obj.dir) ? { dir: str(obj.dir) } : {}),
    ...(str(obj.host) ? { host: str(obj.host) } : {}),
    agents,
    hosts: isObj(obj.hosts)
      ? Object.fromEntries(
          Object.entries(obj.hosts).map(([id, spec]) => [id, hostSpec(spec)]),
        )
      : {},
    stale_hours: staleHours,
    thinking: obj.thinking === true,
    index: {
      default: level(index.default) ?? "full",
      rules: Array.isArray(index.rules)
        ? index.rules.filter(isObj).flatMap((rule) => {
            const lv = level(rule.level);
            return lv ? [{ ...rules([rule])[0], level: lv }] : [];
          })
        : [],
    },
    exclude: rules(obj.exclude),
    hide: rules(obj.hide),
    min_free_gb: minFree,
    ...(push && str(push.target)
      ? {
          push: {
            target: str(push.target) as string,
            ...(str(push.archive_dir)
              ? { archive_dir: str(push.archive_dir) }
              : {}),
            ...(str(push.binary) ? { binary: str(push.binary) } : {}),
          },
        }
      : {}),
    ...(str(obj.remote) ? { remote: str(obj.remote) } : {}),
  };
}

export type RuleSubject = { host: string; agent: string; project: string };

export function ruleMatches(rule: ArchiveRule, subject: RuleSubject): boolean {
  return (
    (!rule.host || rule.host === subject.host) &&
    (!rule.agent || rule.agent === subject.agent) &&
    (!rule.project || subject.project.includes(rule.project))
  );
}

export function anyRuleMatches(
  list: readonly ArchiveRule[],
  subject: RuleSubject,
): boolean {
  return list.some((rule) => ruleMatches(rule, subject));
}

export function indexLevelFor(
  settings: GuiArchiveSettings,
  subject: RuleSubject,
): IndexLevel {
  const rule = settings.index.rules.find((entry) =>
    ruleMatches(entry, subject),
  );
  return rule?.level ?? settings.index.default;
}
