import {
  type AgentProfile,
  isPlainProfile,
  MODEL_SLOTS,
} from "../../../shared/agentProfiles";
import { profileCommand } from "./profiles";

/** The aliases a Claude subscription takes; never asked of a server. */
export const CLAUDE_ALIASES = ["opus", "sonnet", "haiku", "opusplan"];

const CACHE_MS = 60 * 60_000;

export type ProfileModels = {
  models: string[];
  /** Where they came from: the profile's server, or the known aliases. */
  source: "server" | "aliases";
  fetched_at: number;
  /** The models the profile names that the list does not have. */
  missing: { slot: string; model: string }[];
  error?: string;
};

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Embedding and rerank models answer no chat. */
function chatModel(id: string): boolean {
  return !/embed|rerank/i.test(id);
}

function missingOf(profile: AgentProfile, models: string[]) {
  if (!models.length) return [];
  const known = new Set(models.map((each) => each.toLowerCase()));
  return MODEL_SLOTS.flatMap((slot) => {
    const value = profile.env?.[slot.env];
    return typeof value === "string" &&
      value.trim() &&
      !known.has(value.trim().toLowerCase())
      ? [{ slot: slot.env, model: value.trim() }]
      : [];
  });
}

/**
 * The models a profile's server offers (`GET <ANTHROPIC_BASE_URL>/v1/models`,
 * Anthropic's list, with the profile's token as both Bearer and
 * x-api-key), kept an hour. A profile without a base URL (Claude itself)
 * gets the subscription's aliases.
 */
export function createModelDiscovery(
  options: { fetch?: Fetch; now?: () => number; timeoutMs?: number } = {},
) {
  const fetcher: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const cache = new Map<string, Omit<ProfileModels, "missing">>();

  return async function models(
    profile: AgentProfile,
    refresh = false,
  ): Promise<ProfileModels> {
    const base = profile.env?.ANTHROPIC_BASE_URL;
    if (isPlainProfile(profile) || typeof base !== "string" || !base.trim())
      return {
        models: [...CLAUDE_ALIASES],
        source: "aliases",
        fetched_at: now(),
        missing: [],
      };
    const key = `${profile.name}\n${base}`;
    const cached = cache.get(key);
    if (cached && !refresh && now() - cached.fetched_at < CACHE_MS)
      return { ...cached, missing: missingOf(profile, cached.models) };
    let entry: Omit<ProfileModels, "missing">;
    try {
      const env = profileCommand(profile).env;
      const token = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? "";
      const url = `${base.trim().replace(/\/+$/, "")}/v1/models?limit=1000`;
      const response = await fetcher(url, {
        headers: {
          ...(token
            ? { authorization: `Bearer ${token}`, "x-api-key": token }
            : {}),
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok)
        throw new Error(`the server answered ${response.status}`);
      const body = (await response.json()) as { data?: unknown };
      const ids = (Array.isArray(body.data) ? body.data : [])
        .map((each) =>
          each && typeof each === "object"
            ? (each as { id?: unknown }).id
            : null,
        )
        .filter(
          (id): id is string => typeof id === "string" && !!id && chatModel(id),
        );
      entry = {
        models: [...new Set(ids)].sort(),
        source: "server",
        fetched_at: now(),
      };
      cache.set(key, entry);
    } catch (error) {
      // The token never reaches the message: only what failed.
      const message =
        error instanceof Error ? error.message : "the request failed";
      return {
        models: cached?.models ?? [],
        source: "server",
        fetched_at: cached?.fetched_at ?? now(),
        missing: cached ? missingOf(profile, cached.models) : [],
        error: `Could not list the models: ${message.replace(/Bearer \S+/g, "Bearer ...")}`,
      };
    }
    return { ...entry, missing: missingOf(profile, entry.models) };
  };
}

let shared: ReturnType<typeof createModelDiscovery> | null = null;
export function profileModels(profile: AgentProfile, refresh = false) {
  shared ??= createModelDiscovery();
  return shared(profile, refresh);
}
