import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  type AgentProfile,
  allProfiles,
  BUILTIN_PROFILE_NAME,
  isPlainProfile,
  normalizeProfilesSettings,
  profileNamed,
  profileProgram,
  type ProfilesSettings,
  profileUnset,
} from "../../../shared/agentProfiles";
import { dataRoot, replaceDataFile } from "../config/data-paths";
import { type GuiSettings, peekGuiSettings } from "../config/gui-settings";

/**
 * A profile ready to start an agent with: its program, the environment it
 * sets (secret files read) and what it removes. `plain` is the built-in
 * Claude unchanged: started exactly as before profiles.
 */
export type AgentCommand = {
  profile: string;
  agent: AgentProfile["agent"];
  program: string;
  env: Record<string, string>;
  unset: string[];
  plain: boolean;
  /**
   * The model to start the session with this once: it moved to this
   * profile from a model the profile's endpoint does not have.
   */
  model?: string;
};

export const PLAIN_CLAUDE: AgentCommand = Object.freeze({
  profile: BUILTIN_PROFILE_NAME,
  agent: "claude",
  program: "claude",
  env: {},
  unset: [],
  plain: true,
}) as AgentCommand;

export function profilesOf(settings: GuiSettings | null): ProfilesSettings {
  return settings?.profiles ?? normalizeProfilesSettings(undefined);
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/**
 * A secret file's value, its final newline dropped. Refused when others
 * may read it: a token belongs in a file only its owner reads (0600).
 */
export function readSecretFile(path: string, home = homedir()): string {
  const full = expandHome(path, home);
  if (!isAbsolute(full))
    throw new Error(`The secret file ${path} must be an absolute path`);
  let mode: number;
  try {
    mode = statSync(full).mode;
  } catch {
    throw new Error(`The secret file ${path} cannot be read`);
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0)
    throw new Error(
      `The secret file ${path} is readable by others; chmod 600 it`,
    );
  try {
    return readFileSync(full, "utf8").replace(/\r?\n$/, "");
  } catch {
    throw new Error(`The secret file ${path} cannot be read`);
  }
}

/** The command a profile starts; throws when a secret cannot be read. */
export function profileCommand(
  profile: AgentProfile,
  options: { home?: string } = {},
): AgentCommand {
  if (isPlainProfile(profile))
    return { ...PLAIN_CLAUDE, profile: profile.name, agent: profile.agent };
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(profile.env ?? {}))
    env[name] =
      typeof value === "string"
        ? value
        : readSecretFile(value.file, options.home);
  return {
    profile: profile.name,
    agent: profile.agent,
    program: profileProgram(profile),
    env,
    unset: profileUnset(profile),
    plain: false,
  };
}

/** Applies a command's environment to a base environment. */
export function commandEnv<T extends string | undefined>(
  command: AgentCommand,
  base: Record<string, T>,
): Record<string, T | string> {
  const env: Record<string, T | string> = { ...base };
  for (const name of command.unset) delete env[name];
  Object.assign(env, command.env);
  return env;
}

/** What a log may say of a command: names, never values. */
export function describeCommand(command: AgentCommand) {
  return {
    profile: command.profile,
    program: command.program,
    env: Object.keys(command.env).sort(),
    unset: command.unset,
  };
}

type SessionChoice = {
  /** null: the default profile (kept for `model`). */
  profile: string | null;
  at: string;
  /** Switched because a limit was hit: back to `return_to` at this time. */
  return_at?: number;
  return_to?: string;
  /**
   * Started with this model until it answered with it: a profile switch's
   * (switchModel), or the user's /model.
   */
  model?: string;
  /** When /model chose it (else `at`), and the model the agent said it is. */
  model_at?: string;
  model_resolved?: string;
};

const MAX_SESSIONS = 2000;

/**
 * Which profile each session runs with, when the user chose one (by
 * session id, every connection). No entry: the default profile.
 */
export function createSessionProfiles(
  options: { file?: string | null; now?: () => number } = {},
) {
  const file =
    options.file === undefined
      ? join(dataRoot(), "session-profiles.json")
      : options.file;
  const now = options.now ?? Date.now;
  let sessions: Map<string, SessionChoice> | null = null;

  function load(): Map<string, SessionChoice> {
    if (sessions) return sessions;
    sessions = new Map();
    if (!file) return sessions;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        sessions?: Record<string, SessionChoice>;
      };
      for (const [id, choice] of Object.entries(parsed.sessions ?? {}))
        if (
          choice &&
          (typeof choice.profile === "string" ||
            (choice.profile === null && typeof choice.model === "string"))
        )
          sessions.set(id, choice);
    } catch {
      // None yet.
    }
    return sessions;
  }

  function save() {
    if (!file) return;
    const all = load();
    while (all.size > MAX_SESSIONS) all.delete(all.keys().next().value!);
    replaceDataFile(
      file,
      `${JSON.stringify({ version: 1, sessions: Object.fromEntries(all) }, null, 2)}\n`,
    );
  }

  return {
    get(sessionId: string | null | undefined): SessionChoice | null {
      return sessionId ? (load().get(sessionId) ?? null) : null;
    },
    /**
     * Remembers a choice; null (the default profile) with no model clears
     * it. `model`: what the session starts with until it answered there.
     */
    set(
      sessionId: string,
      profile: string | null,
      back?: { at: number; to: string },
      model?: string | null,
    ) {
      const all = load();
      all.delete(sessionId);
      if (profile || model)
        all.set(sessionId, {
          profile: profile || null,
          at: new Date(now()).toISOString(),
          ...(back ? { return_at: back.at, return_to: back.to } : {}),
          ...(model ? { model } : {}),
        });
      save();
    },
    /**
     * The user's /model: the session starts with `model` until it answered
     * with it (`resolved`: the model id the agent said it is). Its profile
     * and return stay. Null drops the choice.
     */
    chooseModel(
      sessionId: string,
      model: string | null,
      resolved?: string | null,
    ) {
      const all = load();
      const choice = all.get(sessionId);
      const rest: SessionChoice = choice
        ? { ...choice }
        : { profile: null, at: new Date(now()).toISOString() };
      delete rest.model;
      delete rest.model_at;
      delete rest.model_resolved;
      if (model) {
        rest.model = model;
        rest.model_at = new Date(now()).toISOString();
        if (resolved) rest.model_resolved = resolved;
      }
      all.delete(sessionId);
      if (rest.profile !== null || rest.model) all.set(sessionId, rest);
      save();
    },
    /** The session answered on its profile: its own model choice holds now. */
    settleModel(sessionId: string) {
      const all = load();
      const choice = all.get(sessionId);
      if (!choice?.model) return;
      if (choice.profile === null) all.delete(sessionId);
      else {
        const rest = { ...choice };
        delete rest.model;
        delete rest.model_at;
        delete rest.model_resolved;
        all.set(sessionId, rest);
      }
      save();
    },
    /** Sessions due back on their default profile. */
    due(): { sessionId: string; to: string }[] {
      const at = now();
      return [...load()].flatMap(([sessionId, choice]) =>
        choice.return_at !== undefined &&
        choice.return_to &&
        choice.return_at <= at
          ? [{ sessionId, to: choice.return_to }]
          : [],
      );
    },
  };
}

export type SessionProfiles = ReturnType<typeof createSessionProfiles>;

let sharedSessions: SessionProfiles | null = null;
/** The server's session choices (tests make their own). */
export function sessionProfiles(): SessionProfiles {
  sharedSessions ??= createSessionProfiles();
  return sharedSessions;
}

/** The profile a session runs with: its choice, else the default. */
export function profileForSession(
  settings: GuiSettings | null,
  sessionId: string | null | undefined,
  store: SessionProfiles | null = sessionProfiles(),
): AgentProfile {
  const profiles = profilesOf(settings);
  const chosen = store?.get(sessionId)?.profile;
  return (
    profileNamed(profiles.list, chosen) ??
    profileNamed(profiles.list, profiles.default) ??
    allProfiles(profiles.list)[0]!
  );
}

/**
 * The command a session's agent starts with (its profile, else the
 * default), from the settings read last. A profile whose secret cannot be
 * read throws: starting on the default instead would bill the wrong
 * account without saying so.
 */
export function commandForSession(
  sessionId?: string | null,
  settings: GuiSettings | null = peekGuiSettings(),
  store: SessionProfiles | null = sessionProfiles(),
): AgentCommand {
  const command = profileCommand(profileForSession(settings, sessionId, store));
  const model = store?.get(sessionId)?.model;
  return model ? { ...command, model } : command;
}

/** Agent arguments without any `--model`. */
export function withoutModel(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--model") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--model=")) continue;
    kept.push(arg);
  }
  return kept;
}

/**
 * Agent arguments with `--model` set to `model` (any earlier one dropped);
 * the same arguments when there is none.
 */
export function withModel(args: readonly string[], model?: string): string[] {
  if (!model) return [...args];
  return [...withoutModel(args), "--model", model];
}

/** The default profile's command, for Roamgate's own helpers. */
export function defaultCommand(
  settings: GuiSettings | null = peekGuiSettings(),
): AgentCommand {
  return commandForSession(null, settings);
}

/**
 * Agent starts typed into a pane carry only a token; the pane's
 * roamgate-hold fetches the program and environment with it (so a secret
 * is never typed, shown on screen or kept in a shell history) and becomes
 * the agent. One use each, for a short while, for that pane only.
 */
export type LaunchSpec = {
  argv: string[];
  env: Record<string, string>;
  unset: string[];
  agent: string;
  /** Set ROAMGATE_CLAUDE_START=terminal (the agent stays in the terminal). */
  terminal: boolean;
};

export function createLaunchRegistry(
  options: { now?: () => number; ttlMs?: number } = {},
) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 120_000;
  const launches = new Map<
    string,
    { connectionId: string; paneId: string; spec: LaunchSpec; until: number }
  >();
  function sweep() {
    const at = now();
    for (const [token, entry] of launches)
      if (entry.until <= at) launches.delete(token);
  }
  return {
    register(connectionId: string, paneId: string, spec: LaunchSpec): string {
      sweep();
      const token = randomBytes(16).toString("hex");
      launches.set(token, {
        connectionId,
        paneId,
        spec,
        until: now() + ttlMs,
      });
      return token;
    },
    take(connectionId: string, paneId: string, token: string) {
      sweep();
      const entry = launches.get(token);
      if (
        !entry ||
        entry.connectionId !== connectionId ||
        entry.paneId !== paneId
      )
        return null;
      launches.delete(token);
      return entry.spec;
    },
  };
}

export type LaunchRegistry = ReturnType<typeof createLaunchRegistry>;

let sharedLaunches: LaunchRegistry | null = null;
export function launchRegistry(): LaunchRegistry {
  sharedLaunches ??= createLaunchRegistry();
  return sharedLaunches;
}

/** A command given as a bare program (voice.json claude_command, tests). */
export function asCommand(command: string | AgentCommand | undefined) {
  if (command === undefined) return PLAIN_CLAUDE;
  return typeof command === "string"
    ? { ...PLAIN_CLAUDE, program: command, plain: command === "claude" }
    : command;
}

/** Tells two commands apart (a warm helper restarts when it changes). */
export function commandKey(command: string | AgentCommand | undefined) {
  if (command === undefined || typeof command === "string")
    return command ?? "";
  return createHash("sha256")
    .update(JSON.stringify([command.program, command.env, command.unset]))
    .digest("hex")
    .slice(0, 16);
}

let helperWarned = false;
/**
 * The command Roamgate's own helpers run (voice, curation): an explicit
 * program (voice.json claude_command) wins, else the default profile. A
 * default profile that cannot be used (its secret file) falls back to
 * plain claude, said once in the log, so the helpers keep working.
 */
export function helperCommand(
  explicit?: string,
  log?: (message: string, fields?: Record<string, unknown>) => void,
): string | AgentCommand {
  if (explicit) return explicit;
  try {
    const command = defaultCommand();
    // Plain claude stays a bare program, as before profiles.
    return command.plain ? command.program : command;
  } catch (error) {
    if (!helperWarned) {
      helperWarned = true;
      log?.("the default profile cannot be used; helpers run plain claude", {
        error: (error as Error).message,
      });
    }
    return PLAIN_CLAUDE.program;
  }
}
