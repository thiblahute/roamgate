/**
 * Agent profiles: how Roamgate starts an agent. A profile is mostly the
 * environment its agent starts with (another API endpoint, its token,
 * which models fill Claude Code's model slots), for one agent driver, with
 * an optional program for drivers that need one. The built-in "Claude"
 * profile is plain `claude`, so nothing changes until the user adds one.
 *
 * An environment value is either text or a reference to a secret file
 * (`{"file": "~/.config/roamgate/secrets/token"}`) that the server reads
 * when it starts the agent. Secret values never reach a browser: they see
 * the reference only.
 */

import { sameModel, shortModelName } from "./agentModels";

export const PROFILE_AGENTS = ["claude"] as const;
export type ProfileAgent = (typeof PROFILE_AGENTS)[number];

export const BUILTIN_PROFILE_NAME = "Claude";

export type ProfileEnvValue = string | { file: string };

export type AgentProfile = {
  name: string;
  /** The agent driver (claude; more once their drivers exist). */
  agent: ProfileAgent;
  /** The program; absent: the driver's own (`claude`). */
  command?: string;
  /** Set for the agent; `{file}` values are read at start, never shown. */
  env?: Record<string, ProfileEnvValue>;
  /** Removed from the agent's environment (besides the implied ones). */
  unset?: string[];
};

export type ProfilesSettings = {
  /** The user's profiles; the built-in Claude is added unless redefined. */
  list: AgentProfile[];
  /** Used for new sessions, headless runs and Roamgate's helpers. */
  default: string;
  /**
   * After a usage limit sent a session to another profile, go back to
   * the default once the limit resets.
   */
  return_after_reset: boolean;
};

export const MAX_PROFILES = 16;
export const MAX_PROFILE_ENV = 48;

const NAME_RE = /^[^\x00-\x1f\x7f]{1,40}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const PROGRAM_BY_AGENT: Record<ProfileAgent, string> = {
  claude: "claude",
};

export function builtinProfile(): AgentProfile {
  return { name: BUILTIN_PROFILE_NAME, agent: "claude" };
}

export function defaultProfilesSettings(): ProfilesSettings {
  return {
    list: [],
    default: BUILTIN_PROFILE_NAME,
    return_after_reset: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Why a profile is not valid, or null. */
export function profileError(raw: unknown): string | null {
  if (!isRecord(raw)) return "A profile must be an object";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!NAME_RE.test(name))
    return "A profile name is 1 to 40 characters on one line";
  if (!PROFILE_AGENTS.includes(raw.agent as ProfileAgent))
    return `${name}: the agent must be one of ${PROFILE_AGENTS.join(", ")}`;
  if (raw.command !== undefined) {
    if (
      typeof raw.command !== "string" ||
      !raw.command.trim() ||
      raw.command.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(raw.command)
    )
      return `${name}: the command must be one line`;
  }
  if (raw.env !== undefined) {
    if (!isRecord(raw.env)) return `${name}: env must be an object`;
    const entries = Object.entries(raw.env);
    if (entries.length > MAX_PROFILE_ENV)
      return `${name}: at most ${MAX_PROFILE_ENV} variables`;
    for (const [key, value] of entries) {
      if (!ENV_NAME_RE.test(key))
        return `${name}: ${key} is not a variable name`;
      if (typeof value === "string") {
        if (value.includes("\0") || value.length > 16_384)
          return `${name}: ${key} is too long or has a NUL byte`;
      } else if (
        !isRecord(value) ||
        typeof value.file !== "string" ||
        !value.file.trim() ||
        /[\x00-\x1f]/.test(value.file) ||
        Object.keys(value).length !== 1
      )
        return `${name}: ${key} must be text or {"file": "<path>"}`;
    }
  }
  if (raw.unset !== undefined) {
    if (
      !Array.isArray(raw.unset) ||
      raw.unset.length > MAX_PROFILE_ENV ||
      raw.unset.some(
        (each) => typeof each !== "string" || !ENV_NAME_RE.test(each),
      )
    )
      return `${name}: unset must be a list of variable names`;
  }
  return null;
}

/** A valid profile, normalized, or null. */
export function normalizeProfile(raw: unknown): AgentProfile | null {
  if (profileError(raw) !== null) return null;
  const value = raw as Record<string, unknown>;
  const env = isRecord(value.env)
    ? Object.fromEntries(
        Object.entries(value.env).map(([key, each]) => [
          key,
          typeof each === "string"
            ? each
            : { file: (each as { file: string }).file.trim() },
        ]),
      )
    : undefined;
  const unset = Array.isArray(value.unset)
    ? [...new Set(value.unset as string[])]
    : undefined;
  return {
    name: (value.name as string).trim(),
    agent: value.agent as ProfileAgent,
    ...(typeof value.command === "string"
      ? { command: value.command.trim() }
      : {}),
    ...(env && Object.keys(env).length ? { env } : {}),
    ...(unset?.length ? { unset } : {}),
  };
}

/** Why a whole settings value is not valid, or null. */
export function profilesSettingsError(raw: unknown): string | null {
  if (!isRecord(raw)) return "profiles must be an object";
  if (!Array.isArray(raw.list)) return "profiles.list must be a list";
  if (raw.list.length > MAX_PROFILES) return `At most ${MAX_PROFILES} profiles`;
  const names = new Set<string>();
  for (const each of raw.list) {
    const error = profileError(each);
    if (error) return error;
    const name = (each as { name: string }).name.trim().toLowerCase();
    if (names.has(name))
      return `Two profiles are named ${(each as { name: string }).name.trim()}`;
    names.add(name);
  }
  if (raw.default !== undefined && typeof raw.default !== "string")
    return "profiles.default must be a profile name";
  if (
    typeof raw.default === "string" &&
    !profileNamed(
      raw.list.map((each) => normalizeProfile(each)!),
      raw.default,
    )
  )
    return `No profile is named ${raw.default}`;
  if (
    raw.return_after_reset !== undefined &&
    typeof raw.return_after_reset !== "boolean"
  )
    return "profiles.return_after_reset must be true or false";
  return null;
}

/** Keeps what is valid: invalid profiles drop, an unknown default resets. */
export function normalizeProfilesSettings(raw: unknown): ProfilesSettings {
  const fallback = defaultProfilesSettings();
  if (!isRecord(raw)) return fallback;
  const seen = new Set<string>();
  const list: AgentProfile[] = [];
  for (const each of Array.isArray(raw.list) ? raw.list : []) {
    const profile = normalizeProfile(each);
    if (!profile || seen.has(profile.name.toLowerCase())) continue;
    seen.add(profile.name.toLowerCase());
    list.push(profile);
    if (list.length >= MAX_PROFILES) break;
  }
  const wanted =
    typeof raw.default === "string" ? raw.default.trim() : fallback.default;
  return {
    list,
    default: profileNamed(list, wanted)?.name ?? BUILTIN_PROFILE_NAME,
    return_after_reset: raw.return_after_reset === true,
  };
}

/** Every profile offered: the built-in Claude first unless redefined. */
export function allProfiles(list: readonly AgentProfile[]): AgentProfile[] {
  const own = list.some(
    (each) => each.name.toLowerCase() === BUILTIN_PROFILE_NAME.toLowerCase(),
  );
  return own ? [...list] : [builtinProfile(), ...list];
}

/** The profile of that name (case-insensitive), the built-in included. */
export function profileNamed(
  list: readonly AgentProfile[],
  name: string | null | undefined,
): AgentProfile | null {
  if (!name) return null;
  const wanted = name.trim().toLowerCase();
  return (
    allProfiles(list).find((each) => each.name.toLowerCase() === wanted) ?? null
  );
}

/** The program a profile runs. */
export function profileProgram(profile: AgentProfile): string {
  return profile.command || PROGRAM_BY_AGENT[profile.agent];
}

/**
 * A profile that changes nothing: the driver's own program, no
 * environment. Roamgate starts it exactly as it did before profiles.
 */
export function isPlainProfile(profile: AgentProfile): boolean {
  return (
    profileProgram(profile) === PROGRAM_BY_AGENT[profile.agent] &&
    !Object.keys(profile.env ?? {}).length &&
    !(profile.unset ?? []).length
  );
}

/**
 * What a profile's environment implies is removed: a profile that names
 * its own endpoint or token must not also send the pane's Anthropic key,
 * or go to Bedrock/Vertex because the pane says so.
 */
const IMPLIED_UNSET: Record<string, string[]> = {
  ANTHROPIC_AUTH_TOKEN: [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ],
  ANTHROPIC_API_KEY: [
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ],
  ANTHROPIC_BASE_URL: ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"],
};

/** The variables a profile removes: its own list and the implied ones. */
export function profileUnset(profile: AgentProfile): string[] {
  const env = profile.env ?? {};
  const names = new Set(profile.unset ?? []);
  for (const key of Object.keys(env))
    for (const implied of IMPLIED_UNSET[key] ?? []) names.add(implied);
  for (const key of Object.keys(env)) names.delete(key);
  return [...names].sort();
}

/** What a browser is shown of a profile: secret files by path only. */
export type ProfileView = {
  name: string;
  agent: ProfileAgent;
  command?: string;
  builtin: boolean;
  env: { name: string; value?: string; file?: string }[];
  unset: string[];
};

export function profileView(
  profile: AgentProfile,
  builtin = false,
): ProfileView {
  return {
    name: profile.name,
    agent: profile.agent,
    ...(profile.command ? { command: profile.command } : {}),
    builtin,
    env: Object.entries(profile.env ?? {}).map(([name, value]) =>
      typeof value === "string" ? { name, value } : { name, file: value.file },
    ),
    unset: profile.unset ?? [],
  };
}

/** A usage limit an agent hit, from its message. */
export type UsageLimit = {
  /** "5-hour", "weekly", "session", "Opus"...; "usage" when not said. */
  kind: string;
  /** The message's own reset words ("5:20pm (America/Santiago)"). */
  resets: string | null;
  /** When it resets, if the message says (epoch ms). */
  resets_at: number | null;
  /** The time zone the message gave its reset in, if any. */
  zone?: string;
  /** When the agent reported it (the transcript record's time, epoch ms). */
  at?: number;
  message: string;
};

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/** The UTC offset (ms) of a time zone at an instant; null when unknown. */
function zoneOffsetMs(timeZone: string, at: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(at));
    const get = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value);
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    return asUtc - Math.floor(at / 1000) * 1000;
  } catch {
    return null;
  }
}

/** The wall time in a zone (or the local zone) as an instant. */
function zonedTime(
  fields: { year: number; month: number; day: number; minutes: number },
  timeZone: string | null,
): number | null {
  const wall =
    Date.UTC(fields.year, fields.month, fields.day) + fields.minutes * 60_000;
  if (!timeZone) {
    const local = new Date(fields.year, fields.month, fields.day);
    return local.getTime() + fields.minutes * 60_000;
  }
  // Two passes settle a DST change between the guess and the answer.
  let guess = wall;
  for (let pass = 0; pass < 2; pass++) {
    const offset = zoneOffsetMs(timeZone, guess);
    if (offset === null) return null;
    guess = wall - offset;
  }
  return guess;
}

/** Today's date in a zone (or the local one). */
function zoneDate(at: number, timeZone: string | null) {
  if (!timeZone) {
    const date = new Date(at);
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
    };
  }
  const offset = zoneOffsetMs(timeZone, at) ?? 0;
  const date = new Date(at + offset);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
  };
}

/**
 * When "5:20pm (America/Santiago)" or "Oct 5 at 8am (America/Santiago)"
 * comes next after `now`; null when the words are not a time.
 */
export function parseResetTime(words: string, now: number): number | null {
  const match =
    /^(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\s*(?:\(([^)]+)\))?\s*$/i.exec(
      words.trim(),
    );
  if (!match) return null;
  const [, monthWord, dayWord, yearWord, hourWord, minuteWord, ampm, zone] =
    match;
  let hour = Number(hourWord);
  const minute = minuteWord ? Number(minuteWord) : 0;
  if (hour > 23 || minute > 59) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  } else if (!minuteWord) return null;
  const timeZone = zone?.trim() || null;
  if (timeZone && zoneOffsetMs(timeZone, now) === null) return null;
  const minutes = hour * 60 + minute;
  const today = zoneDate(now, timeZone);
  if (monthWord) {
    const month = MONTHS.indexOf(monthWord.toLowerCase());
    if (month < 0) return null;
    const day = Number(dayWord);
    let year = yearWord ? Number(yearWord) : today.year;
    let at = zonedTime({ year, month, day, minutes }, timeZone);
    // "Jan 2" read in December is next year's.
    if (at !== null && !yearWord && at < now - 86_400_000) {
      year += 1;
      at = zonedTime({ year, month, day, minutes }, timeZone);
    }
    return at;
  }
  let at = zonedTime({ ...today, minutes }, timeZone);
  if (at !== null && at <= now) {
    const tomorrow = zoneDate(at + 86_400_000 + 3_600_000, timeZone);
    at = zonedTime({ ...tomorrow, minutes }, timeZone);
  }
  return at;
}

/**
 * The usage limit a message reports, or null. Claude Code says "You've
 * hit your 5-hour limit · resets 5:20pm (America/Santiago)" (older:
 * "Claude AI usage limit reached|<epoch seconds>"); an API 429 says
 * rate_limit_error.
 */
export function parseUsageLimit(
  text: string,
  now: number = Date.now(),
): UsageLimit | null {
  if (!text) return null;
  const message = text.trim().slice(0, 400);
  const hit =
    /(?:you(?:'|’)ve|you have) (?:hit|reached) your (?:(.{1,40}?) )?limit(?:\s*[·•|-]\s*resets\s+([^\n]{1,80}))?/i.exec(
      message,
    );
  if (hit) {
    const resets = hit[2]?.trim().replace(/[.\s]+$/, "") || null;
    const zone = resets
      ? /\(([^)]+)\)\s*$/.exec(resets)?.[1]?.trim()
      : undefined;
    return {
      kind: hit[1]?.trim() || "usage",
      resets,
      resets_at: resets ? parseResetTime(resets, now) : null,
      ...(zone ? { zone } : {}),
      message,
    };
  }
  const legacy = /Claude AI usage limit reached\|(\d{9,11})/i.exec(message);
  if (legacy)
    return {
      kind: "usage",
      resets: null,
      resets_at: Number(legacy[1]) * 1000,
      message: "Claude AI usage limit reached",
    };
  if (
    /\b429\b/.test(message) &&
    /rate[_ ]limit/i.test(message) &&
    /error/i.test(message)
  )
    return { kind: "rate", resets: null, resets_at: null, message };
  return null;
}

/**
 * The model a profile runs, for a chip ("GLM 5p3" from glm-5p3, "Kimi
 * k3p1 pro" from kimi-k3p1-pro: shortModelName); its name when it sets no
 * model.
 */
export function profileModelLabel(profile: AgentProfile): string {
  const model = profile.env?.ANTHROPIC_MODEL;
  if (typeof model !== "string" || !model.trim()) return profile.name;
  return shortModelName(model);
}

/**
 * The usage limit a session stopped on, from the end of its transcript
 * (Claude Code's JSONL): the newest assistant record decides. An API
 * error record reporting a limit means limited; any other assistant
 * record, not (a later turn went through).
 */
export function latestUsageLimit(
  transcriptTail: string,
  now: number = Date.now(),
): UsageLimit | null {
  const lines = transcriptTail.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line.startsWith("{") || !line.includes('"assistant"')) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type !== "assistant") continue;
    if (record.isApiErrorMessage !== true) return null;
    const message = isRecord(record.message) ? record.message : {};
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part) =>
                isRecord(part) && typeof part.text === "string"
                  ? part.text
                  : "",
              )
              .join(" ")
          : "";
    const at =
      typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    const limit =
      parseUsageLimit(text, Number.isFinite(at) ? at : now) ??
      (record.error === "rate_limit"
        ? {
            kind: "usage",
            resets: null,
            resets_at: null,
            message: text.trim().slice(0, 400),
          }
        : null);
    if (!limit) return null;
    // Over once its reset time has passed.
    if (limit.resets_at !== null && limit.resets_at <= now) return null;
    return Number.isFinite(at) ? { ...limit, at } : limit;
  }
  return null;
}

/**
 * The model a session's transcript (Claude Code's JSONL, its end) last
 * answered with, among those `wanted` accepts, and when (epoch ms; null
 * when the record does not say); null when none is there. API errors and
 * Claude Code's own notices (<synthetic>) are not answers.
 */
export function latestSessionAnswer(
  transcriptTail: string,
  wanted: (model: string) => boolean = () => true,
): { model: string; at: number | null } | null {
  const lines = transcriptTail.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line.startsWith("{") || !line.includes('"assistant"')) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type !== "assistant" || record.isApiErrorMessage === true)
      continue;
    const message = isRecord(record.message) ? record.message : {};
    const model = message.model;
    if (typeof model !== "string" || !model || model === "<synthetic>")
      continue;
    if (!wanted(model)) continue;
    const at =
      typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    return { model, at: Number.isFinite(at) ? at : null };
  }
  return null;
}

/**
 * The model a session's transcript (its end) last names, whichever agent
 * wrote it: a Claude Code answer's (as latestSessionAnswer reads it), a
 * Pi model_change's or answer's, a Codex turn_context's. Null when none.
 */
export function latestTranscriptModel(transcriptTail: string): string | null {
  const lines = transcriptTail.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line.startsWith("{") || !/"model(?:Id)?"/.test(line)) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = isRecord(record.message) ? record.message : {};
    const payload = isRecord(record.payload) ? record.payload : {};
    const model =
      record.type === "assistant" && record.isApiErrorMessage !== true
        ? message.model
        : record.type === "message" && message.role === "assistant"
          ? message.model
          : record.type === "model_change"
            ? record.modelId
            : record.type === "turn_context"
              ? payload.model
              : null;
    if (typeof model === "string" && model.trim() && model !== "<synthetic>")
      return model.trim();
  }
  return null;
}

/** The model of latestSessionAnswer, or null. */
export function latestSessionModel(
  transcriptTail: string,
  wanted: (model: string) => boolean = () => true,
): string | null {
  return latestSessionAnswer(transcriptTail, wanted)?.model ?? null;
}

/**
 * Whether a session started with a model of its own (a profile switch's
 * switchModel, or /model) has answered with it since: Claude Code then
 * resumes on it by itself, and the choice is no longer needed. An answer
 * after the choice, with another model the profile serves, counts too:
 * the session moved on (a /model in its terminal).
 */
export function chosenModelAnswered(
  answer: { model: string; at: number | null },
  choice: { model: string; resolved?: string; at: string },
  profile: AgentProfile,
): boolean {
  if (sameModel(answer.model, choice.model)) return true;
  if (choice.resolved && sameModel(answer.model, choice.resolved)) return true;
  const chosenAt = Date.parse(choice.at);
  return (
    answer.at !== null &&
    Number.isFinite(chosenAt) &&
    answer.at > chosenAt &&
    profileServesModel(profile, answer.model)
  );
}

/**
 * Whether a profile's endpoint has a model: behind a gateway
 * (ANTHROPIC_BASE_URL), the models its slots name; else Claude's own.
 */
export function profileServesModel(
  profile: AgentProfile,
  model: string,
): boolean {
  const env = profile.env ?? {};
  if (!env.ANTHROPIC_BASE_URL) return /^claude-/.test(model);
  return MODEL_SLOTS.some((slot) => env[slot.env] === model);
}

/**
 * The model a session must be started with on a profile it moves to, or
 * null. Claude Code resumes a session on the model it last answered with,
 * which the new endpoint may not have (kimi-k3p1-pro on Anthropic's): then
 * the last model the session had there, else the profile's own model,
 * else, on Anthropic's endpoint, Opus.
 */
export function switchModel(
  transcriptTail: string | null,
  profile: AgentProfile,
): string | null {
  if (!transcriptTail) return null;
  const last = latestSessionModel(transcriptTail);
  if (!last || profileServesModel(profile, last)) return null;
  const served = latestSessionModel(transcriptTail, (model) =>
    profileServesModel(profile, model),
  );
  if (served) return served;
  const own = profile.env?.ANTHROPIC_MODEL;
  if (typeof own === "string" && own) return own;
  return profile.env?.ANTHROPIC_BASE_URL ? null : "opus";
}

/** Claude Code's model slots a profile may fill. */
export const MODEL_SLOTS = [
  { env: "ANTHROPIC_MODEL", label: "Main model" },
  { env: "ANTHROPIC_DEFAULT_OPUS_MODEL", label: "Opus slot" },
  { env: "ANTHROPIC_DEFAULT_SONNET_MODEL", label: "Sonnet slot" },
  { env: "ANTHROPIC_DEFAULT_HAIKU_MODEL", label: "Haiku slot" },
  { env: "ANTHROPIC_SMALL_FAST_MODEL", label: "Small, fast model" },
  { env: "CLAUDE_CODE_SUBAGENT_MODEL", label: "Subagent model" },
] as const;
