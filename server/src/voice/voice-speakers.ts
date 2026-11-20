import {
  MAYBE,
  matchPrint,
  parsePrint,
  profileScore,
  roundPrint,
  unit,
  type VoiceProfiles,
  type VoiceProfile,
  type VoiceRole,
} from "./voice-profiles";

/**
 * Who speaks on a call. The helper tells the voices it hears apart (A, B,
 * C...: voice/helper/src/voices.rs) and says, with each final, the voice
 * most heard in it, its share, whether two voices were in it (`mixed`),
 * how close it is to each voice of the call (`similarity`), and the prints
 * of the utterance and of its voices (`print`, `prints`).
 *
 * The people known from earlier calls (voice-profiles.ts) name the voices:
 * each voice of the call is matched against them, its print against
 * theirs, and named when it is surely one of them (MATCH, with a MARGIN
 * over the next), "maybe" one when close. The user's own profile makes
 * their voice "you" from their first utterance. Without one (or on a
 * microphone it does not know yet) the user's voice is learnt from the
 * conversation, as before: a voice whose words the companion takes up
 * (answers, passes on, looks up) is likely the user's; one whose words it
 * leaves to nobody likely not; the companion can also say so itself (its
 * `voice`: "user" or "other"). Once sure, that voice is kept as the user's
 * profile. The companion names voices too ("c'est Simon qui parle",
 * "that was my daughter"), and corrects a wrong name: name().
 *
 * A profile learns only from confident utterances: one voice, unmixed,
 * most of the utterance, close to its voice of the call. Each call gives
 * each person one print (the mean of those), replaced as the call goes,
 * undone when the name was wrong. A voice heard long on a call that no
 * one is is kept unnamed; once heard on a few calls, the companion is told
 * once that it may ask who it is.
 *
 * Each utterance then gets a label for the companion, the cleaner and the
 * router: `Thibault (you) 0.91` or `you 0.58` (the user's voice, and how
 * close), `Simon 0.84`, `voice C, maybe Simon 0.52`, `voice C, unknown,
 * 0.07 like you`, `mixed: you + Simon`, or `voice A` while nothing is
 * known; and, for the companion, every score behind it (detail()). The
 * helper is told the user's voice with each listen_start (its name on the
 * call and their kept prints), so another voice does not cut a reply.
 */

/** What the helper says of an utterance's voices (a final's `voice`). */
export type VoiceTag = {
  /** The set of voices its names belong to: a new one each call. */
  voices: number;
  /** The voice most heard, null when too little was heard to tell. */
  id: string | null;
  /** That voice's share of the utterance's voice, 0 to 1. */
  share: number;
  mixed: boolean;
  /** Each voice heard and its share, the most heard first. */
  mix: { id: string; share: number }[];
  /** How close the utterance is to each voice known, -1 to 1. */
  similarity: Record<string, number>;
  /** Voices found to be one: gone name to kept name. */
  merged?: Record<string, string>;
  /** The utterance's print (the helper's; not sent on to the page). */
  print?: number[];
  /** The print of each voice in it (likewise). */
  prints?: Record<string, number[]>;
  /** Which utterance it is, for its print kept here (observe()). */
  utterance?: number;
  /** Seconds of voice in it. */
  seconds?: number;
};

/**
 * The user's voice, as told to the helper (listen_start's `user_voice`):
 * its name on the call once known, and the prints kept of them.
 */
export type UserVoice = { voices?: number; id?: string; prints?: number[][] };

/** A name the companion gives a voice of the call (name()). */
export type VoiceNaming = {
  /** The voice of the call; the utterance's own when left out. */
  voice?: string;
  name: string;
  role?: VoiceRole;
};

/** What the companion's route says of who spoke. */
export type VoiceVerdict = "user" | "other";

/** How much a route counts towards a voice being the user's. */
const TAKEN_UP = 1;
const LEFT = -1;
/** The companion saying it outright counts more. */
const SAID = 3;
/** Under this share, an utterance says little of who spoke. */
const CLEAR_SHARE = 0.6;
/**
 * Under this closeness to the user's voice, an utterance of another voice
 * is surely not theirs (a person's own utterances score 0.45 or more).
 */
const OTHER = 0.2;

const name = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z]{1,2}$/.test(value);

const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** A voice of the call's name, checked. */
export const isVoiceName = name;

/** A final's `voice` (or a page's copy of it), checked; null when not one. */
export function parseVoiceTag(value: unknown): VoiceTag | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!number(raw.voices)) return null;
  const similarity: Record<string, number> = {};
  if (raw.similarity && typeof raw.similarity === "object")
    for (const [key, score] of Object.entries(raw.similarity))
      if (name(key) && number(score)) similarity[key] = score;
  const mix = Array.isArray(raw.mix)
    ? raw.mix.flatMap((each) =>
        each &&
        typeof each === "object" &&
        name((each as { id?: unknown }).id) &&
        number((each as { share?: unknown }).share)
          ? [each as { id: string; share: number }]
          : [],
      )
    : [];
  const merged: Record<string, string> = {};
  if (raw.merged && typeof raw.merged === "object")
    for (const [gone, kept] of Object.entries(raw.merged))
      if (name(gone) && name(kept)) merged[gone] = kept;
  const print = parsePrint(raw.print);
  const prints: Record<string, number[]> = {};
  if (raw.prints && typeof raw.prints === "object")
    for (const [id, each] of Object.entries(raw.prints)) {
      const parsed = name(id) ? parsePrint(each) : null;
      if (parsed) prints[id] = parsed;
    }
  return {
    voices: raw.voices,
    id: name(raw.id) ? raw.id : null,
    share: number(raw.share) ? raw.share : 0,
    mixed: raw.mixed === true,
    mix: mix.map(({ id, share }) => ({ id, share })),
    similarity,
    ...(Object.keys(merged).length ? { merged } : {}),
    ...(print ? { print } : {}),
    ...(Object.keys(prints).length ? { prints } : {}),
    ...(number(raw.utterance) ? { utterance: raw.utterance } : {}),
    ...(number(raw.seconds) ? { seconds: raw.seconds } : {}),
  };
}

/** A tag without its prints: what the page gets and sends back. */
export function withoutPrints(tag: VoiceTag): VoiceTag {
  const rest = { ...tag };
  delete rest.print;
  delete rest.prints;
  return rest;
}

const score = (value: number | undefined) => (value ?? 0).toFixed(2);

/** An utterance teaches a profile only this sure of its voice. */
const LEARN_SHARE = 0.8;
/** ...this close to its voice of the call (a person's own: 0.45 or more)... */
const LEARN_CLOSE = 0.45;
/** ...and this long. */
const LEARN_SECONDS = 1;
/** A call's print is kept once it has this many confident seconds. */
const KEEP_SECONDS = 3;
/** A voice no one is, heard this long on a call, is kept unnamed. */
const UNNAMED_SECONDS = 20;
/** An unnamed voice heard on this many calls may be asked about, once. */
const OFFER_CALLS = 3;
/** The user's voice is kept as theirs once this sure (SAID, or 3 routes). */
const USER_SURE = 3;
/** Utterance prints kept for the companion's scores (detail()). */
const KEPT_UTTERANCES = 64;

/** How a voice of the call came to be a person. */
type LinkHow = "match" | "named" | "user" | "kept";

/** What is known of a voice of the call. */
type Cluster = {
  /** The helper's print of it, as it last said. */
  print: number[] | null;
  /** Its confident utterances: their prints' sum, by seconds, and seconds. */
  sum: number[] | null;
  seconds: number;
  link: { profile: string; how: LinkHow } | null;
  /** The person it is close to, not surely. */
  maybe: { profile: string; score: number } | null;
  /** The people it is closest to, best first (detail()). */
  closest: { profile: string; score: number }[];
  /** People it was said not to be, on this call. */
  rejected: Set<string>;
};

const newCluster = (): Cluster => ({
  print: null,
  sum: null,
  seconds: 0,
  link: null,
  maybe: null,
  closest: [],
  rejected: new Set(),
});

/**
 * Learns which voice is the user's on the call, names the voices with the
 * people known (a VoiceProfiles, when given), and labels utterances.
 */
export class SpeakerTracker {
  private voices: number | null = null;
  /** How much each voice was taken up (positive) or left (negative). */
  private scores = new Map<string, number>();
  private userId: string | null = null;
  private clusters = new Map<string, Cluster>();
  /** Utterance prints, by `utterance`, for detail(). */
  private utterances = new Map<number, number[]>();
  private nextUtterance = 1;

  constructor(private library: VoiceProfiles | null = null) {}

  /** The people known across calls (index.ts: ~/.config/roamgate/voice-profiles). */
  useLibrary(library: VoiceProfiles | null) {
    this.library = library;
  }

  private cluster(id: string): Cluster {
    let cluster = this.clusters.get(id);
    if (!cluster) {
      cluster = newCluster();
      this.clusters.set(id, cluster);
    }
    return cluster;
  }

  private profileOf(id: string | null | undefined): VoiceProfile | null {
    const link = id ? this.clusters.get(id)?.link : null;
    return (link && this.library?.get(link.profile)) ?? null;
  }

  /**
   * A final's voices: a new set forgets the old; merged names carry. With
   * its prints: the voices are matched with the people known, and those
   * known learn from it. Gives the tag its `utterance`.
   */
  observe(tag: VoiceTag | null) {
    if (!tag) return;
    if (tag.voices !== this.voices) {
      this.voices = tag.voices;
      this.scores.clear();
      this.userId = null;
      this.clusters.clear();
      // A new call: files deleted since are forgotten.
      this.library?.reload();
    }
    for (const [gone, kept] of Object.entries(tag.merged ?? {})) {
      const moved = this.scores.get(gone);
      if (moved !== undefined) {
        this.scores.set(kept, (this.scores.get(kept) ?? 0) + moved);
        this.scores.delete(gone);
      }
      if (this.userId === gone) this.userId = kept;
      this.mergeCluster(gone, kept);
    }
    if (tag.print && tag.utterance === undefined) {
      tag.utterance = this.nextUtterance++;
      this.utterances.set(tag.utterance, tag.print);
      if (this.utterances.size > KEPT_UTTERANCES)
        this.utterances.delete(this.utterances.keys().next().value!);
    }
    if (!this.library || !tag.prints) return;
    for (const [id, print] of Object.entries(tag.prints))
      this.cluster(id).print = print;
    // Only a confident utterance teaches its voice's print.
    if (
      tag.id &&
      tag.print &&
      !tag.mixed &&
      tag.share >= LEARN_SHARE &&
      (tag.similarity[tag.id] ?? 0) >= LEARN_CLOSE
    ) {
      const seconds = tag.seconds ?? 0;
      if (seconds >= LEARN_SECONDS) {
        const cluster = this.cluster(tag.id);
        const weight = seconds * tag.share;
        cluster.sum = tag.print.map(
          (value, i) => (cluster.sum?.[i] ?? 0) + value * weight,
        );
        cluster.seconds += weight;
      }
    }
    for (const id of Object.keys(tag.prints)) this.match(id);
    this.seedUser();
    for (const id of Object.keys(tag.prints)) {
      this.keepUnnamed(id);
      this.teach(id);
    }
  }

  private mergeCluster(gone: string, kept: string) {
    const from = this.clusters.get(gone);
    if (!from) return;
    this.clusters.delete(gone);
    const into = this.cluster(kept);
    if (from.sum)
      into.sum = from.sum.map((value, i) => value + (into.sum?.[i] ?? 0));
    into.seconds += from.seconds;
    for (const profile of from.rejected) into.rejected.add(profile);
    const strong = (how?: LinkHow) => how === "named" || how === "user";
    if (
      from.link &&
      (!into.link || (strong(from.link.how) && !strong(into.link.how)))
    )
      into.link = from.link;
  }

  /** A voice of the call against the people known. */
  private match(id: string) {
    const cluster = this.cluster(id);
    const library = this.library;
    if (!library || !cluster.print || this.voices === null) return;
    const call = this.voices;
    const profiles = library.profiles();
    cluster.closest = profiles
      .flatMap((profile) => {
        const score = profileScore(profile, cluster.print!, call);
        return score === null ? [] : [{ profile: profile.id, score }];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    // A name given or learnt on the call stays.
    if (cluster.link && cluster.link.how !== "match") return;
    const found = matchPrint(cluster.print, profiles, call, cluster.rejected);
    cluster.maybe =
      found.maybe && found.best
        ? { profile: found.best.profile.id, score: found.best.score }
        : null;
    const was = cluster.link?.profile;
    if (found.sure && found.best) {
      if (was === found.best.profile.id) return;
      this.unlink(cluster);
      cluster.link = { profile: found.best.profile.id, how: "match" };
      cluster.maybe = null;
    } else if (
      was &&
      !(found.best?.profile.id === was && found.best.score >= MAYBE)
    )
      // No longer close enough: what it taught is undone.
      this.unlink(cluster);
  }

  /** A voice of the call is no one known any more (on this call). */
  private unlink(cluster: Cluster, reject = false) {
    const profile = cluster.link && this.library?.get(cluster.link.profile);
    if (profile && this.voices !== null) {
      this.library!.forgetCall(profile, this.voices);
      if (reject) cluster.rejected.add(profile.id);
    }
    cluster.link = null;
  }

  /** A voice of the call matched to the user's profile is theirs. */
  private seedUser() {
    for (const [id, cluster] of this.clusters) {
      if (this.profileOf(id)?.role !== "user" || cluster.link?.how !== "match")
        continue;
      if ((this.scores.get(id) ?? 0) < USER_SURE) {
        this.scores.set(id, USER_SURE);
        this.choose();
      }
    }
  }

  /** A voice heard long that is no one known is kept, unnamed. */
  private keepUnnamed(id: string) {
    const cluster = this.cluster(id);
    if (
      !this.library ||
      this.voices === null ||
      cluster.link ||
      cluster.maybe ||
      cluster.seconds < UNNAMED_SECONDS ||
      this.userId === id ||
      (this.scores.get(id) ?? 0) > 0
    )
      return;
    const profile = this.library.create(null, "unknown");
    cluster.link = { profile: profile.id, how: "kept" };
  }

  /** A known voice's confident utterances so far, kept as this call's print. */
  private teach(id: string) {
    const cluster = this.clusters.get(id);
    const profile = this.profileOf(id);
    if (
      !cluster?.sum ||
      !profile ||
      this.voices === null ||
      cluster.seconds < KEEP_SECONDS
    )
      return;
    const print = unit(cluster.sum);
    if (print)
      this.library!.learn(profile, this.voices, print, cluster.seconds);
  }

  /**
   * What the companion (or the router) did with an utterance: its route
   * (`nobody` leaves it), and what it said of the voice, if anything.
   */
  learn(tag: VoiceTag | null, to: string, verdict?: VoiceVerdict) {
    if (!tag?.id) return;
    this.observe(tag);
    // A voice known as someone else is not the user's by its route.
    const known = this.profileOf(tag.id);
    if (known && known.role !== "user" && known.role !== "unknown") return;
    let change = 0;
    if (verdict) change = verdict === "user" ? SAID : -SAID;
    // Only a clear utterance of one voice tells by its route.
    else if (!tag.mixed && tag.share >= CLEAR_SHARE)
      change = to === "nobody" ? LEFT : TAKEN_UP;
    if (!change) return;
    this.scores.set(tag.id, (this.scores.get(tag.id) ?? 0) + change);
    this.choose();
    this.keepUser(tag.id);
  }

  /**
   * The user's profile follows what the call taught: a voice surely
   * theirs is kept as theirs (a new microphone, or their first call); one
   * matched to them that the conversation says is not, is not.
   */
  private keepUser(id: string) {
    const library = this.library;
    if (!library) return;
    const cluster = this.cluster(id);
    const profile = this.profileOf(id);
    const score = this.scores.get(id) ?? 0;
    if (profile?.role === "user" && score <= 0) {
      this.unlink(cluster, true);
      return;
    }
    if (this.userId !== id || score < USER_SURE) return;
    if (profile && profile.role !== "unknown") return;
    const user = library.user();
    if (user && cluster.rejected.has(user.id)) return;
    let kept: VoiceProfile;
    if (profile && user) {
      // Kept unnamed before the call knew it was theirs.
      library.absorb(user, profile);
      kept = user;
    } else if (profile) {
      library.update(profile, { role: "user" });
      kept = profile;
    } else kept = user ?? library.create(null, "user");
    cluster.link = { profile: kept.id, how: "user" };
    cluster.maybe = null;
    this.teach(id);
  }

  /**
   * The companion names a voice of the call (`naming.voice`, the
   * utterance's own by default): a person known by that name, or a new
   * one. A voice named before is renamed, what it taught the wrong person
   * undone. `role` "user" makes it the user's. Returns what was done, for
   * the log; null when there is nothing to name.
   */
  name(tag: VoiceTag | null, naming: VoiceNaming): string | null {
    const library = this.library;
    if (!library || !tag) return null;
    this.observe(tag);
    let id = naming.voice && name(naming.voice) ? naming.voice : tag.id;
    if (!id || tag.voices !== this.voices) return null;
    // Merged since: under its kept name.
    id = tag.merged?.[id] ?? id;
    const given = naming.name.trim();
    if (!given) return null;
    const cluster = this.cluster(id);
    const before = this.profileOf(id);
    let target: VoiceProfile;
    if (naming.role === "user") {
      target =
        library.user() ??
        library.byName(given) ??
        library.create(given, "user");
      library.update(target, { name: given, role: "user" });
    } else {
      target =
        library.byName(given) ?? library.create(given, naming.role ?? "other");
      if (naming.role && naming.role !== target.role)
        library.update(target, { role: naming.role });
      else library.update(target, {});
    }
    if (before && before.id !== target.id) {
      if (before.role === "unknown") library.absorb(target, before);
      else this.unlink(cluster, true);
    }
    cluster.link = { profile: target.id, how: "named" };
    cluster.maybe = null;
    cluster.rejected.delete(target.id);
    if (target.role === "user") {
      this.scores.set(id, Math.max(this.scores.get(id) ?? 0, SAID * 2));
      this.userId = id;
    } else if (this.userId === id || (this.scores.get(id) ?? 0) > 0) {
      this.scores.set(id, -SAID);
      this.choose();
    }
    this.teach(id);
    return `voice ${id} is ${target.name ?? "unnamed"} (${target.role})${before && before.id !== target.id ? `, was ${before.name ?? "unnamed"}` : ""}`;
  }

  private choose() {
    let best: string | null = null;
    for (const [id, value] of this.scores)
      if (value >= 1 && (best === null || value > this.scores.get(best)!))
        best = id;
    const current = this.userId ? (this.scores.get(this.userId) ?? 0) : 0;
    if (this.userId && current < 1) this.userId = null;
    // The voice taken for theirs stays until another has clearly more.
    if (best && (!this.userId || this.scores.get(best)! > current))
      this.userId = best;
  }

  /**
   * The user's voice, when known: its name on the call, and the prints
   * kept of them (which tell it before the call learnt it).
   */
  user(): UserVoice | null {
    const kept = this.keptUser();
    const named =
      this.userId !== null && this.voices !== null
        ? { voices: this.voices, id: this.userId }
        : null;
    if (!named) return kept;
    return kept ? { ...named, ...kept } : named;
  }

  /** The prints kept of the user, for a new call; null without. */
  keptUser(): UserVoice | null {
    const prints = this.library?.user()?.prints ?? [];
    return prints.length
      ? { prints: prints.map((kept) => roundPrint(kept.print)) }
      : null;
  }

  /**
   * Whether an utterance is clearly another voice than the user's: theirs
   * is known, not in it, and it is far from it; or it is someone else
   * known, without the user in it.
   */
  isOther(tag: VoiceTag | null): boolean {
    if (!tag || tag.voices !== this.voices) return false;
    const user = this.userId;
    if (user && tag.mix.some((each) => each.id === user)) return false;
    const known = this.profileOf(tag.id);
    if (known && known.role !== "user" && known.role !== "unknown") return true;
    if (!user || tag.id === user) return false;
    return (tag.similarity[user] ?? 0) < OTHER;
  }

  /** How a voice of the call is called: its person's name, or its own. */
  private who(id: string): string {
    const profile = this.profileOf(id);
    if (id === this.userId || profile?.role === "user") {
      const userName = (profile ?? this.library?.user())?.name;
      return userName ? `${userName} (you)` : "you";
    }
    return profile?.name ?? id;
  }

  /** The person's score for this utterance: its print against theirs. */
  private personScore(tag: VoiceTag, profile: VoiceProfile): number | null {
    const print =
      (tag.utterance !== undefined && this.utterances.get(tag.utterance)) ||
      tag.print ||
      (tag.id ? this.clusters.get(tag.id)?.print : null);
    if (!print) return null;
    return (
      profileScore(profile, print, this.voices ?? undefined) ??
      profileScore(profile, print)
    );
  }

  /** The label of an utterance, for the companion; "" without a tag. */
  label(tag: VoiceTag | null): string {
    if (!tag) return "";
    const current = tag.voices === this.voices;
    const user = current ? this.userId : null;
    const like = user ? `, ${score(tag.similarity[user])} like you` : "";
    const who = (id: string) => (current ? this.who(id) : id);
    if (tag.mixed && tag.mix.length > 1) {
      const names = tag.mix.map((each) => each.id);
      // The user first: what they say is what counts.
      if (user && names.includes(user))
        return `mixed: ${[user, ...names.filter((id) => id !== user)].map(who).join(" + ")}`;
      return `mixed: ${names.map(who).join(" + ")}${like}`;
    }
    if (!tag.id) return `voice unclear${like}`;
    if (tag.id === user) return `${who(tag.id)} ${score(tag.similarity[user])}`;
    const profile = current ? this.profileOf(tag.id) : null;
    if (profile?.name) {
      const close = this.personScore(tag, profile);
      return close === null ? profile.name : `${profile.name} ${score(close)}`;
    }
    if (profile)
      return `voice ${tag.id}, heard on ${profile.calls} call${profile.calls === 1 ? "" : "s"}${like}`;
    const maybe = current ? this.clusters.get(tag.id)?.maybe : null;
    const maybeOf = maybe && this.library?.get(maybe.profile);
    if (maybe && maybeOf)
      return `voice ${tag.id}, maybe ${this.profileName(maybeOf)} ${score(maybe.score)}${like}`;
    const named = this.library?.profiles().some((each) => each.name) ?? false;
    return `voice ${tag.id}${named ? ", unknown" : ""}${like}`;
  }

  private profileName(profile: VoiceProfile): string {
    if (profile.role === "user")
      return profile.name ? `${profile.name} (you)` : "you";
    return profile.name ?? `an unnamed voice (${profile.calls} calls)`;
  }

  /**
   * Every score behind the label, compact, for the companion to judge
   * with: each voice in the utterance, its share and the people it is
   * closest to; the utterance against each person and each voice of the
   * call. With `offer`, an unnamed voice heard on many calls is said to be
   * worth asking about, once ever. "" when there is nothing to tell.
   */
  detail(tag: VoiceTag | null, offer = false): string {
    if (!tag || tag.voices !== this.voices) return "";
    const library = this.library;
    const parts: string[] = [];
    const people = (list: { profile: string; score: number }[]) =>
      list
        .flatMap(({ profile, score: value }) => {
          const known = library?.get(profile);
          return known ? [`${this.profileName(known)} ${score(value)}`] : [];
        })
        .join(", ");
    const voices = tag.mix.map((each) => {
      const cluster = this.clusters.get(each.id);
      const close = cluster ? people(cluster.closest) : "";
      const is =
        this.profileOf(each.id) || each.id === this.userId
          ? ` is ${this.who(each.id)}`
          : "";
      return `${each.id} ${Math.round(each.share * 100)}%${is}${close ? ` (closest: ${close})` : ""}`;
    });
    if (voices.length) parts.push(`voices in it: ${voices.join("; ")}`);
    const print =
      tag.utterance !== undefined
        ? this.utterances.get(tag.utterance)
        : tag.print;
    if (library && print) {
      const scored = library
        .profiles()
        .flatMap((profile) => {
          // Not against what this call taught it: that would vouch for itself.
          const value =
            profileScore(profile, print, this.voices ?? undefined) ??
            profileScore(profile, print);
          return value === null ? [] : [{ profile: profile.id, score: value }];
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 4);
      const words = people(scored);
      if (words) parts.push(`the words against people known: ${words}`);
    }
    const call = Object.entries(tag.similarity)
      .sort((a, b) => b[1] - a[1])
      .map(([id, value]) => `${id} ${score(value)}`)
      .join(", ");
    if (call) parts.push(`against this call's voices: ${call}`);
    if (offer && library)
      for (const each of tag.mix) {
        const profile = this.profileOf(each.id);
        if (
          profile &&
          profile.role === "unknown" &&
          !profile.offered &&
          profile.calls >= OFFER_CALLS
        ) {
          library.markOffered(profile);
          parts.push(
            `voice ${each.id} was heard on ${profile.calls} calls and has no name: you may ask once, when it fits, who it is`,
          );
        }
      }
    return parts.join(" | ");
  }
}
