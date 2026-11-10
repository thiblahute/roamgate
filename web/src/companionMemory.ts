import { clearCompanionLog } from "./companionCall";
import { forgetAgentAnswers } from "./voiceCompanion";

/**
 * The companion's memory across calls lives on the server (voice-memory.ts,
 * in Roamgate's data directory). What a page keeps of a call (its
 * conversation and the agents' answers) goes when the memory is reset, by
 * voice, by the button, or on another device (`companion_epoch`).
 */

const VOICE_HEADERS = { "x-roamgate-voice": "1" };

let seenEpoch: number | null = null;

/** Forgets what this page holds of the conversation. */
export function forgetCompanionLocally() {
  clearCompanionLog();
  forgetAgentAnswers();
}

/** The server's reset counter, from GET /api/voice: a change means a reset. */
export function noteCompanionEpoch(epoch: unknown) {
  if (typeof epoch !== "number") return;
  if (seenEpoch !== null && seenEpoch !== epoch) forgetCompanionLocally();
  seenEpoch = epoch;
}

/**
 * Starts the companion over: saved memory and running sessions on the
 * server, then what this page holds. False when the server refused.
 */
export async function resetCompanion(): Promise<boolean> {
  try {
    const response = await fetch("/api/voice/companion/reset", {
      method: "POST",
      headers: VOICE_HEADERS,
    });
    if (!response.ok) return false;
    const { epoch } = (await response.json()) as { epoch?: unknown };
    forgetCompanionLocally();
    if (typeof epoch === "number") seenEpoch = epoch;
    return true;
  } catch {
    return false;
  }
}

export function __resetCompanionEpochForTests() {
  seenEpoch = null;
}

export type CompanionMemoryFile = {
  file: string;
  name: string;
  description: string;
  type: string;
  body: string;
  updated: number;
};

/** The long-term memories, or null when the server cannot tell. */
export async function listCompanionMemories(): Promise<
  CompanionMemoryFile[] | null
> {
  try {
    const response = await fetch("/api/voice/companion/memories", {
      headers: VOICE_HEADERS,
    });
    if (!response.ok) return null;
    const { memories } = (await response.json()) as {
      memories?: CompanionMemoryFile[];
    };
    return Array.isArray(memories) ? memories : null;
  } catch {
    return null;
  }
}

/** Deletes one memory; false when the server refused. */
export async function deleteCompanionMemory(file: string): Promise<boolean> {
  try {
    const response = await fetch(
      `/api/voice/companion/memories/${encodeURIComponent(file)}`,
      { method: "DELETE", headers: VOICE_HEADERS },
    );
    return response.ok;
  } catch {
    return false;
  }
}
