import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dataRoot } from "../config/data-paths";
import { serverLogger } from "../utils/logger";

/**
 * The voices known across calls: one file per person in `voice-profiles/` under
 * Roamgate's data directory (~/.config/roamgate/voice-profiles/<id>.json), with a
 * name (null until the conversation gives one), a role (the user, family,
 * other, or a voice heard often and not named yet: unknown), a few voice
 * prints and how much was heard. A print is a WeSpeaker embedding (256
 * numbers) averaged over many seconds of the voice: biometric data, kept on
 * this machine only, never sent anywhere, and no audio is ever kept.
 * Deleting a file forgets that person; deleting the directory forgets
 * every voice. A file deleted while the server runs stays deleted: what
 * was loaded of it is dropped, not written back (docs/DEPLOYMENT.md).
 *
 * Each call adds at most one print to each person heard on it (the mean of
 * their confident utterances on that call, replaced as the call goes): a
 * person heard on the phone, a headset and the desktop gets one of each.
 * Past MAX_PRINTS, the two closest prints become one, so the prints stay
 * few and spread over the microphones and rooms they were heard in.
 */

export const VOICE_PROFILES_DIR = "voice-profiles";

export type VoiceRole = "user" | "family" | "other" | "unknown";

export const VOICE_ROLES: readonly VoiceRole[] = [
  "user",
  "family",
  "other",
  "unknown",
];

/** The print one call left of a person. */
export type KeptPrint = {
  print: number[];
  /** Seconds of confident utterances it is the mean of. */
  seconds: number;
  /** The call (the helper's set of voices) it came from. */
  call: number;
  /** When it was last updated (ms since the epoch). */
  at: number;
};

export type VoiceProfile = {
  id: string;
  name: string | null;
  role: VoiceRole;
  prints: KeptPrint[];
  /** Seconds of confident utterances learnt from, in all. */
  seconds: number;
  /** Calls it was heard on. */
  calls: number;
  first: number;
  last: number;
  /** An unnamed voice the companion was told it may ask about. */
  offered?: boolean;
};

/** A cluster of a call matched against the library. */
export type VoiceMatch = {
  /** The best profile and its score, when there is one. */
  best: { profile: VoiceProfile; score: number } | null;
  /** The next best score, -1 without one. */
  second: number;
  /** Confident: best >= MATCH and best - second >= MARGIN. */
  sure: boolean;
  /** Close, not sure: best >= MAYBE (said as "maybe <name>"). */
  maybe: boolean;
};

/**
 * Calibrated on recordings of four people, each print from 2.4 s on one
 * call against the same person's on another (voices.rs,
 * real_voices_are_known_again_on_another_call): the same person scored
 * 0.59 to 0.84 as recorded, 0.55 to 0.82 through a phone's band; other
 * people -0.05 to 0.23, but two siblings 0.56 to 0.63 against each other.
 * Sure is at 0.60, with a margin of 0.15 over the next person, so a
 * sibling not known yet is "maybe" the other, never taken for them; prints
 * kept from longer calls and more microphones score higher.
 */
export const MATCH = 0.6;
export const MAYBE = 0.45;
export const MARGIN = 0.15;
/** Prints kept per person at most. */
export const MAX_PRINTS = 6;
/** A merged print counts at most this many seconds. */
const MAX_PRINT_SECONDS = 600;
/** Unnamed voices kept at most: past it, the least heard goes. */
export const MAX_UNNAMED = 12;

const log = serverLogger.child("voice");

export function voiceProfilesDir(root = dataRoot()): string {
  return join(root, VOICE_PROFILES_DIR);
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** A unit vector, or null for nothing to scale. */
export function unit(vector: readonly number[]): number[] | null {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (!vector.length || !(norm > 1e-9)) return null;
  return vector.map((value) => value / norm);
}

/** Cosine of two unit prints; -1 when they cannot be compared. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (!a.length || a.length !== b.length) return -1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** A print as sent: unit, rounded to four decimals (cosines to 1e-3). */
export function roundPrint(print: readonly number[]): number[] {
  return print.map((value) => Math.round(value * 10_000) / 10_000);
}

/** A print from JSON, checked: numbers only, 16 to 4096 of them. */
export function parsePrint(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 16 || value.length > 4096)
    return null;
  if (!value.every(finite)) return null;
  return unit(value as number[]);
}

/** A person's closeness to `print`: their closest kept print's. */
export function profileScore(
  profile: VoiceProfile,
  print: readonly number[],
  exceptCall?: number,
): number | null {
  let best: number | null = null;
  for (const kept of profile.prints) {
    if (kept.call === exceptCall) continue;
    const score = cosine(kept.print, print);
    if (best === null || score > best) best = score;
  }
  return best;
}

/**
 * The person `print` is, among `profiles`: their prints from other calls
 * than `call` only (this call's own would vouch for itself), those in
 * `rejected` (corrected on this call) left out.
 */
export function matchPrint(
  print: readonly number[],
  profiles: readonly VoiceProfile[],
  call?: number,
  rejected: ReadonlySet<string> = new Set(),
): VoiceMatch {
  const scored = profiles
    .filter((profile) => !rejected.has(profile.id))
    .flatMap((profile) => {
      const score = profileScore(profile, print, call);
      return score === null ? [] : [{ profile, score }];
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0] ?? null;
  const second = scored[1]?.score ?? -1;
  const sure =
    best !== null && best.score >= MATCH && best.score - second >= MARGIN;
  return {
    best,
    second,
    sure,
    maybe: !sure && best !== null && best.score >= MAYBE,
  };
}

function parseProfile(id: string, value: unknown): VoiceProfile | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const role = VOICE_ROLES.includes(raw.role as VoiceRole)
    ? (raw.role as VoiceRole)
    : "other";
  const prints = Array.isArray(raw.prints)
    ? raw.prints.flatMap((each) => {
        const kept = (each ?? {}) as Record<string, unknown>;
        const print = parsePrint(kept.print);
        return print && finite(kept.seconds) && finite(kept.call)
          ? [
              {
                print,
                seconds: kept.seconds,
                call: kept.call,
                at: finite(kept.at) ? kept.at : 0,
              },
            ]
          : [];
      })
    : [];
  const name =
    typeof raw.name === "string" && raw.name.trim()
      ? cleanName(raw.name)
      : null;
  return {
    id,
    name,
    role,
    prints,
    seconds: finite(raw.seconds) ? raw.seconds : 0,
    calls: finite(raw.calls) ? raw.calls : 0,
    first: finite(raw.first) ? raw.first : 0,
    last: finite(raw.last) ? raw.last : 0,
    ...(raw.offered === true ? { offered: true } : {}),
  };
}

/** A name as said, kept short and printable. */
export function cleanName(name: string): string | null {
  const clean = name
    .replace(/[^\p{L}\p{N} '.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return clean || null;
}

const FILE = /^([a-z0-9]{6,32})\.json$/;

/** Two prints as one, by their seconds. */
function mergePrints(a: KeptPrint, b: KeptPrint): KeptPrint {
  const total = Math.max(a.seconds + b.seconds, 1e-6);
  const print =
    unit(
      a.print.map(
        (value, i) => (value * a.seconds + b.print[i]! * b.seconds) / total,
      ),
    ) ?? a.print;
  return {
    print,
    seconds: Math.min(total, MAX_PRINT_SECONDS),
    call: a.at >= b.at ? a.call : b.call,
    at: Math.max(a.at, b.at),
  };
}

export class VoiceProfiles {
  private loaded = false;
  private known = new Map<string, VoiceProfile>();
  /** Profiles read from or written to a file: gone from disk means deleted. */
  private stored = new Set<string>();

  constructor(
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reads the files again: deleted ones are forgotten (each new call). */
  reload() {
    this.loaded = true;
    this.known.clear();
    this.stored.clear();
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const file of files) {
      const id = FILE.exec(file)?.[1];
      if (!id) continue;
      try {
        const profile = parseProfile(
          id,
          JSON.parse(readFileSync(join(this.dir, file), "utf8")),
        );
        if (!profile) continue;
        this.known.set(id, profile);
        this.stored.add(id);
      } catch (error) {
        log.warn("voice profiles: unreadable file skipped", {
          file,
          error: (error as Error).message,
        });
      }
    }
  }

  private ensure() {
    if (!this.loaded) this.reload();
  }

  profiles(): VoiceProfile[] {
    this.ensure();
    return [...this.known.values()];
  }

  get(id: string): VoiceProfile | null {
    this.ensure();
    return this.known.get(id) ?? null;
  }

  /** The user's own profile, if one is kept. */
  user(): VoiceProfile | null {
    return this.profiles().find((profile) => profile.role === "user") ?? null;
  }

  byName(name: string): VoiceProfile | null {
    const wanted = name.trim().toLocaleLowerCase();
    return (
      this.profiles().find(
        (profile) => profile.name?.toLocaleLowerCase() === wanted,
      ) ?? null
    );
  }

  /** A new person, kept from now on (their file is written once learnt). */
  create(name: string | null, role: VoiceRole): VoiceProfile {
    this.ensure();
    const now = this.now();
    const profile: VoiceProfile = {
      id: randomBytes(8).toString("hex"),
      name: name ? cleanName(name) : null,
      role,
      prints: [],
      seconds: 0,
      calls: 0,
      first: now,
      last: now,
    };
    this.known.set(profile.id, profile);
    if (role === "unknown") this.boundUnnamed(profile.id);
    return profile;
  }

  /**
   * `profile`'s print from call `call`: the mean of its confident
   * utterances there so far, `seconds` of them (replacing what the call
   * gave before).
   */
  learn(profile: VoiceProfile, call: number, print: number[], seconds: number) {
    if (!this.known.has(profile.id)) return;
    const now = this.now();
    const index = profile.prints.findIndex((kept) => kept.call === call);
    const before = index >= 0 ? profile.prints[index]!.seconds : 0;
    const kept: KeptPrint = { print, seconds, call, at: now };
    if (index >= 0) profile.prints[index] = kept;
    else {
      profile.prints.push(kept);
      profile.calls += 1;
    }
    profile.seconds += Math.max(0, seconds - before);
    profile.last = now;
    this.bound(profile, call);
    this.save(profile);
  }

  /** What call `call` taught of `profile` is undone (a wrong name). */
  forgetCall(profile: VoiceProfile, call: number) {
    const index = profile.prints.findIndex((kept) => kept.call === call);
    if (index < 0) return;
    const [gone] = profile.prints.splice(index, 1);
    profile.seconds = Math.max(0, profile.seconds - gone!.seconds);
    profile.calls = Math.max(0, profile.calls - 1);
    // An unnamed voice made from a voice that was not one is dropped.
    if (!profile.prints.length && profile.role === "unknown") {
      this.remove(profile.id);
      return;
    }
    this.save(profile);
  }

  /** `from`'s prints move to `into` (an unnamed voice given a name). */
  absorb(into: VoiceProfile, from: VoiceProfile) {
    if (into.id === from.id) return;
    for (const kept of from.prints) {
      const index = into.prints.findIndex((each) => each.call === kept.call);
      if (index >= 0)
        into.prints[index] = mergePrints(into.prints[index]!, kept);
      else into.prints.push(kept);
    }
    into.seconds += from.seconds;
    into.calls += from.calls;
    into.first = Math.min(into.first, from.first);
    into.last = Math.max(into.last, from.last);
    this.bound(into);
    this.save(into);
    this.remove(from.id);
  }

  /** A name or role given. */
  update(profile: VoiceProfile, change: { name?: string; role?: VoiceRole }) {
    if (change.name !== undefined) profile.name = cleanName(change.name);
    if (change.role) {
      // One user: another taken for them before is not any more.
      if (change.role === "user")
        for (const other of this.profiles())
          if (other.id !== profile.id && other.role === "user") {
            other.role = "other";
            this.save(other);
          }
      profile.role = change.role;
    }
    this.save(profile);
  }

  markOffered(profile: VoiceProfile) {
    profile.offered = true;
    this.save(profile);
  }

  remove(id: string) {
    this.known.delete(id);
    if (this.stored.delete(id))
      rmSync(join(this.dir, `${id}.json`), { force: true });
  }

  /** Past MAX_PRINTS, the two closest prints are one (this call's kept). */
  private bound(profile: VoiceProfile, call?: number) {
    while (profile.prints.length > MAX_PRINTS) {
      let pair: [number, number] | null = null;
      let closest = -2;
      for (let i = 0; i < profile.prints.length; i++)
        for (let j = i + 1; j < profile.prints.length; j++) {
          // The call going on keeps its own print, to replace as it goes.
          if (
            profile.prints[i]!.call === call ||
            profile.prints[j]!.call === call
          )
            continue;
          const score = cosine(
            profile.prints[i]!.print,
            profile.prints[j]!.print,
          );
          if (score > closest) {
            closest = score;
            pair = [i, j];
          }
        }
      if (!pair) return;
      const [i, j] = pair;
      const merged = mergePrints(profile.prints[i]!, profile.prints[j]!);
      profile.prints.splice(j, 1);
      profile.prints[i] = merged;
    }
  }

  private boundUnnamed(keep: string) {
    const unnamed = this.profiles()
      .filter((profile) => profile.role === "unknown" && profile.id !== keep)
      .sort((a, b) => a.seconds - b.seconds || a.last - b.last);
    while (unnamed.length >= MAX_UNNAMED) this.remove(unnamed.shift()!.id);
  }

  /** Written whole, private to the user; a file deleted meanwhile stays so. */
  private save(profile: VoiceProfile) {
    if (!this.known.has(profile.id)) return;
    const file = join(this.dir, `${profile.id}.json`);
    if (this.stored.has(profile.id) && !existsSync(file)) {
      this.known.delete(profile.id);
      this.stored.delete(profile.id);
      log.info("voice profiles: a deleted voice stays forgotten", {
        id: profile.id,
      });
      return;
    }
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const kept: Partial<VoiceProfile> = { ...profile };
      delete kept.id;
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(
        temp,
        `${JSON.stringify({
          ...kept,
          prints: profile.prints.map((each) => ({
            ...each,
            print: roundPrint(each.print),
          })),
        })}\n`,
        { mode: 0o600 },
      );
      renameSync(temp, file);
      this.stored.add(profile.id);
    } catch (error) {
      log.warn("voice profiles: not written", {
        id: profile.id,
        error: (error as Error).message,
      });
    }
  }
}
