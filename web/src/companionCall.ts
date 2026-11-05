import { roamgateLocalStorage } from "./browserStorage";
import { clearCompanionReading } from "./companionReading";

/**
 * A call with the voice companion itself (server voice-front.ts): the one
 * agent the user talks to, which answers and starts work on the sessions.
 * It belongs to no pane. Started from a pane, that pane's session is only
 * where work goes by default (`target`); naming another session sends the
 * work there, and the call stays with the companion. Started from the app
 * menu, a shortcut or the phone's menu, the session shown is the default.
 */

/** The companion call's voice chat key (voiceFollow.ts claims). */
export const COMPANION_VOICE_KEY = {
  connectionId: "@companion",
  paneId: "@companion",
} as const;

export function isCompanionVoice(
  key: { connectionId: string; paneId: string } | null | undefined,
): boolean {
  return (
    key?.connectionId === COMPANION_VOICE_KEY.connectionId &&
    key.paneId === COMPANION_VOICE_KEY.paneId
  );
}

const NAME_KEY = "voice.companionName";
export const DEFAULT_COMPANION_NAME = "Companion";

/** What the companion does now, as its chip shows it. */
export type CompanionPresence =
  | "off"
  | "listening"
  | "hearing"
  | "thinking"
  | "speaking"
  | "waiting";

/**
 * What happened on the companion's calls, for its own conversation view:
 * what it heard and said, the questions it relayed, and the work it
 * started on which session, with how it went.
 */
export type CompanionLogEntry =
  | { id: number; at: number; kind: "heard" | "said"; text: string }
  | {
      id: number;
      at: number;
      kind: "job";
      /** `<connection>/<pane>`, and how it is named aloud. */
      session: string;
      label: string;
      /** What was given to the session. */
      words: string;
      /** What was said, when the addressing was dropped from it. */
      said?: string;
      status: "running" | "answered" | "no answer" | "not started";
      answer?: string;
    }
  | {
      id: number;
      at: number;
      /**
       * A web search it started (voiceRoute.ts ResearchJob), or with
       * `tool`, a request done with its MCP tools (server voice-tools.ts).
       */
      kind: "web";
      job: string;
      tool?: boolean;
      question: string;
      status: "searching" | "done" | "failed" | "cancelled";
      steps: readonly string[];
      /** What it said of it, the whole answer and where it comes from. */
      spoken?: string;
      answer?: string;
      sources?: readonly { title: string; url: string }[];
      error?: string;
    };

/** A web search's entry, as logCompanion takes it. */
export type CompanionWebEntry = Omit<
  Extract<CompanionLogEntry, { kind: "web" }>,
  "id" | "at"
>;

type CompanionCallState = {
  open: boolean;
  presence: CompanionPresence;
  log: readonly CompanionLogEntry[];
  /** What it says now, shown in its call card. */
  line: string | null;
  /** `<connection>/<pane>`: where work goes unless another is named. */
  target: string | null;
  /** Bumped by each start, so a host starts listening again. */
  started: number;
  /** What the user is saying, as heard so far. */
  heard: string;
  muted: boolean;
  /** When the call started listening (Date.now()); null before. */
  since: number | null;
};

const EMPTY: CompanionCallState = {
  open: false,
  presence: "off",
  log: [],
  line: null,
  target: null,
  started: 0,
  heard: "",
  muted: false,
  since: null,
};
/** Entries kept in the conversation view, at most. */
const LOG_KEPT = 200;
let state: CompanionCallState = EMPTY;
let nextLogId = 1;
const listeners = new Set<() => void>();

function publish(next: Partial<CompanionCallState>) {
  state = { ...state, ...next };
  for (const listener of [...listeners]) listener();
}

export function companionCallState(): CompanionCallState {
  return state;
}

export function subscribeCompanionCall(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Starts the call (or keeps it), work going to `target` by default. */
export function startCompanionCall(target?: string | null) {
  publish({
    open: true,
    target: target ?? state.target,
    started: state.started + 1,
  });
}

/**
 * The running call's voice chat, as its host (CompanionCall.tsx) reports
 * it, for the controls in the top bar.
 */
export function setCompanionVoice(voice: {
  heard: string;
  muted: boolean;
  since: number | null;
}) {
  if (
    state.heard !== voice.heard ||
    state.muted !== voice.muted ||
    state.since !== voice.since
  )
    publish(voice);
}

type CompanionControls = {
  toggleMute: () => void;
  tap: () => void;
  sendNow?: () => void;
};
let controls: CompanionControls | null = null;

/** The host's controls: the top bar's mute and its tap on the call. */
export function setCompanionControls(next: CompanionControls | null) {
  controls = next;
}

/** Mutes or unmutes the call's microphone. */
export function toggleCompanionMute() {
  controls?.toggleMute();
}

/**
 * Sends what the user is saying now (the transcript so far), without
 * waiting for the pause that ends it.
 */
export function sendCompanionHeard() {
  controls?.sendNow?.();
}

/** A tap on the call: stops what it reads and listens, as speaking up does. */
export function tapCompanionCall() {
  controls?.tap();
}

export function endCompanionCall() {
  clearCompanionReading();
  if (state.open)
    publish({
      open: false,
      presence: "off",
      line: null,
      heard: "",
      muted: false,
      since: null,
    });
}

/** The call's voice chat state, shown by the companion's chip. */
export function setCompanionPresence(presence: CompanionPresence) {
  if (state.presence !== presence) publish({ presence });
}

/** What the companion says now, for its call card. */
export function setCompanionLine(line: string | null) {
  if (state.line !== line) publish({ line });
}

/** Notes what the companion heard or said; its id back. */
export function logCompanion(
  entry:
    | { kind: "heard" | "said"; text: string }
    | Omit<Extract<CompanionLogEntry, { kind: "job" }>, "id" | "at">
    | CompanionWebEntry,
  at = Date.now(),
): number {
  const id = nextLogId++;
  publish({
    log: [...state.log, { ...entry, id, at } as CompanionLogEntry].slice(
      -LOG_KEPT,
    ),
  });
  return id;
}

/** How a job it started went. */
export function updateCompanionJob(
  id: number,
  update: Pick<Extract<CompanionLogEntry, { kind: "job" }>, "status"> & {
    answer?: string;
  },
) {
  publish({
    log: state.log.map((entry) =>
      entry.id === id && entry.kind === "job" ? { ...entry, ...update } : entry,
    ),
  });
}

/** How a web search it started goes. */
export function updateCompanionWeb(
  id: number,
  update: Partial<Omit<CompanionWebEntry, "kind" | "job" | "question">>,
) {
  publish({
    log: state.log.map((entry) =>
      entry.id === id && entry.kind === "web" ? { ...entry, ...update } : entry,
    ),
  });
}

/**
 * Who says a web search's result aloud: the voice chat with a front that
 * runs now (useVoiceChat), once the user is not talking. Without one, the
 * result is only written in the conversation view.
 */
type CompanionTeller = (text: string) => void;
let teller: CompanionTeller | null = null;

/** Sets who tells results now; the function that unsets it, if still it. */
export function setCompanionTeller(next: CompanionTeller): () => void {
  teller = next;
  return () => {
    if (teller === next) teller = null;
  };
}

/** The voice that tells results now, if any. */
export function companionTeller(): CompanionTeller | null {
  return teller;
}

/** Where work goes by default; the session last given work. */
export function setCompanionTarget(target: string) {
  if (state.target !== target) publish({ target });
}

/** What the user calls the companion; "Companion" unless renamed. */
export function companionName(): string {
  return (
    roamgateLocalStorage.getItem(NAME_KEY)?.trim() || DEFAULT_COMPANION_NAME
  );
}

export function setCompanionName(name: string) {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed || trimmed === DEFAULT_COMPANION_NAME)
    roamgateLocalStorage.removeItem(NAME_KEY);
  else roamgateLocalStorage.setItem(NAME_KEY, trimmed);
  for (const listener of [...listeners]) listener();
}

export function __resetCompanionCallForTests() {
  state = EMPTY;
  nextLogId = 1;
  teller = null;
  listeners.clear();
}
