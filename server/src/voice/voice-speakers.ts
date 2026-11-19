/**
 * Who speaks on a call. The helper tells the voices it hears apart (A, B,
 * C...: voice/helper/src/voices.rs) and says, with each final, the voice
 * most heard in it, its share, whether two voices were in it (`mixed`),
 * and how close it is to each voice known (`similarity`). It does not know
 * which voice is the user's: that is learnt here, from the conversation,
 * never from the first sound heard. A voice whose words the companion
 * takes up (answers, passes on, looks up) is likely the user's; one whose
 * words it leaves to nobody likely not; the companion can also say so
 * itself (its `voice`: "user" or "other"), as when it asked "is that you?".
 * The voice with the most of it is the user's.
 *
 * Each utterance then gets a label for the companion, the cleaner and the
 * router: `you 0.58` (the user's voice, and how close), `voice B, 0.07 like
 * you`, `mixed: you + B`, or `voice A` while the user's is not known yet.
 * The helper is told the user's voice with each listen_start, so another
 * voice does not cut a reply. Nothing is kept across calls: a new call is a
 * new set of voices (`voices`), and what was learnt goes with the old one.
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
};

/** The user's voice, as told to the helper (listen_start's `user_voice`). */
export type UserVoice = { voices: number; id: string };

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
  return {
    voices: raw.voices,
    id: name(raw.id) ? raw.id : null,
    share: number(raw.share) ? raw.share : 0,
    mixed: raw.mixed === true,
    mix: mix.map(({ id, share }) => ({ id, share })),
    similarity,
    ...(Object.keys(merged).length ? { merged } : {}),
  };
}

const score = (value: number | undefined) => (value ?? 0).toFixed(2);

/**
 * Learns which voice is the user's on the call, and labels utterances
 * with it.
 */
export class SpeakerTracker {
  private voices: number | null = null;
  /** How much each voice was taken up (positive) or left (negative). */
  private scores = new Map<string, number>();
  private userId: string | null = null;

  /** A final's voices: a new set forgets the old; merged names carry. */
  observe(tag: VoiceTag | null) {
    if (!tag) return;
    if (tag.voices !== this.voices) {
      this.voices = tag.voices;
      this.scores.clear();
      this.userId = null;
    }
    for (const [gone, kept] of Object.entries(tag.merged ?? {})) {
      const moved = this.scores.get(gone);
      if (moved !== undefined) {
        this.scores.set(kept, (this.scores.get(kept) ?? 0) + moved);
        this.scores.delete(gone);
      }
      if (this.userId === gone) this.userId = kept;
    }
  }

  /**
   * What the companion (or the router) did with an utterance: its route
   * (`nobody` leaves it), and what it said of the voice, if anything.
   */
  learn(tag: VoiceTag | null, to: string, verdict?: VoiceVerdict) {
    if (!tag?.id) return;
    this.observe(tag);
    let change = 0;
    if (verdict) change = verdict === "user" ? SAID : -SAID;
    // Only a clear utterance of one voice tells by its route.
    else if (!tag.mixed && tag.share >= CLEAR_SHARE)
      change = to === "nobody" ? LEFT : TAKEN_UP;
    if (!change) return;
    this.scores.set(tag.id, (this.scores.get(tag.id) ?? 0) + change);
    this.choose();
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

  /** The user's voice, when known. */
  user(): UserVoice | null {
    return this.userId !== null && this.voices !== null
      ? { voices: this.voices, id: this.userId }
      : null;
  }

  /**
   * Whether an utterance is clearly another voice than the user's: theirs
   * is known, not in it, and it is far from it.
   */
  isOther(tag: VoiceTag | null): boolean {
    const user = tag && tag.voices === this.voices ? this.userId : null;
    if (!tag || !user || tag.id === user) return false;
    if (tag.mix.some((each) => each.id === user)) return false;
    return (tag.similarity[user] ?? 0) < OTHER;
  }

  /** The label of an utterance, for the companion; "" without a tag. */
  label(tag: VoiceTag | null): string {
    if (!tag) return "";
    const user = tag.voices === this.voices ? this.userId : null;
    const known = (id: string) => (id === user ? "you" : id);
    const like = user ? `, ${score(tag.similarity[user])} like you` : "";
    if (tag.mixed && tag.mix.length > 1) {
      const names = tag.mix.map((each) => each.id);
      // The user first: what they say is what counts.
      if (user && names.includes(user))
        return `mixed: ${["you", ...names.filter((id) => id !== user)].join(" + ")}`;
      return `mixed: ${names.map(known).join(" + ")}${like}`;
    }
    if (!tag.id) return `voice unclear${like}`;
    if (tag.id === user) return `you ${score(tag.similarity[user])}`;
    return `voice ${tag.id}${like}`;
  }
}
