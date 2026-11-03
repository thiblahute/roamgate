import { Mic, MicOff, PhoneOff } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type CompanionPresence,
  companionCallState,
  companionName,
  endCompanionCall,
  subscribeCompanionCall,
  tapCompanionCall,
  toggleCompanionMute,
} from "../companionCall";
import { openCompanionPanel } from "../companionCallOpen";
import { subscribeVoiceFronting, voiceFronting } from "../voiceFrontFlag";
import { formatCallDuration } from "./voiceChatControl";
import {
  CompanionReadingView,
  readingStatus,
  useCompanionReading,
} from "./CompanionReading";
import "./CompanionChip.css";

const PRESENCE: Record<CompanionPresence, string> = {
  off: "idle",
  listening: "listening",
  hearing: "hearing you",
  thinking: "thinking",
  speaking: "speaking",
  waiting: "on a call",
};

/** The chip's words for what the companion does, and the jobs it waits on. */
export function companionChipText(
  presence: CompanionPresence,
  running: number,
): string {
  const doing = PRESENCE[presence];
  return running
    ? `${doing} · ${running} job${running === 1 ? "" : "s"} running`
    : doing;
}

function useCallTimer(since: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? "" : formatCallDuration(now - since);
}

/**
 * The voice companion in the top bar, as a pane shows its teammates: what
 * it does (idle, or in a call: listening, thinking, speaking) and the work
 * it waits on; it opens the companion's own conversation. During a call it
 * is the call's control too (timer, microphone, hang up), so the call
 * covers nothing of the app.
 */
export function CompanionChip() {
  const call = useSyncExternalStore(subscribeCompanionCall, companionCallState);
  const fronting = useSyncExternalStore(subscribeVoiceFronting, voiceFronting);
  const timer = useCallTimer(call.open ? call.since : null);
  if (!fronting && !call.open) return null;
  const running = call.log.filter(
    (entry) =>
      (entry.kind === "job" && entry.status === "running") ||
      (entry.kind === "web" && entry.status === "searching"),
  ).length;
  const text = companionChipText(call.presence, running);
  const name = companionName();
  return (
    <div
      className={`companion-chip is-${call.presence}${call.open ? " is-call" : ""}`}
      role="group"
      aria-label={call.open ? `Call with ${name}` : name}
    >
      <button
        type="button"
        className="companion-chip-main"
        aria-label={`${name}: ${text}. Open its conversation`}
        title={`${name}: ${text}`}
        onClick={() => openCompanionPanel()}
      >
        <span className="companion-chip-dot" aria-hidden="true" />
        <span className="companion-chip-name">{name}</span>
        <span className="companion-chip-state">{text}</span>
        {call.open && timer ? (
          <span className="companion-chip-timer" role="timer">
            {timer}
          </span>
        ) : null}
      </button>
      {call.open ? (
        <>
          {call.presence === "speaking" ? (
            <button
              type="button"
              className="companion-chip-call"
              aria-label="Stop it and listen"
              title="Stop it and listen"
              onClick={tapCompanionCall}
            >
              <Mic size={14} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className={`companion-chip-call${call.muted ? " is-muted" : ""}`}
              aria-pressed={call.muted}
              aria-label={
                call.muted ? "Unmute the microphone" : "Mute the microphone"
              }
              title={
                call.muted
                  ? "Unmute: listen again"
                  : "Mute: it still speaks, nothing is listened to"
              }
              onClick={toggleCompanionMute}
            >
              {call.muted ? (
                <MicOff size={14} aria-hidden="true" />
              ) : (
                <Mic size={14} aria-hidden="true" />
              )}
            </button>
          )}
          <button
            type="button"
            className="companion-chip-call companion-chip-hang-up"
            aria-label="Hang up"
            title="Hang up"
            onClick={() => endCompanionCall()}
          >
            <PhoneOff size={14} aria-hidden="true" />
          </button>
        </>
      ) : null}
    </div>
  );
}

/** Whether a companion call is on: it changes only when a call starts or ends. */
export function useCompanionCallOpen(): boolean {
  return useSyncExternalStore(
    subscribeCompanionCall,
    () => companionCallState().open,
  );
}

const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * What the user says now, as the transcriber hears it so far: none while
 * muted, while the companion speaks, or when it is only its own words
 * heard back through the speaker.
 */
export function hearingNow(call: {
  heard: string;
  line: string | null;
  presence: CompanionPresence;
  muted: boolean;
}): string | null {
  const heard = call.heard.trim();
  if (!heard || call.muted || call.presence === "speaking") return null;
  const line = call.line?.trim() ?? "";
  // Its own words, heard back through the speaker.
  if (line && plain(line).includes(plain(heard).slice(0, 40))) return null;
  return heard;
}

/**
 * Who says what the strip shows: the companion while it speaks (what the
 * microphone picks up of its own voice then is not the user's), the user
 * while they speak, else the companion's last line.
 */
export function stripLine(
  call: {
    heard: string;
    line: string | null;
    presence: CompanionPresence;
    muted: boolean;
  },
  name: string,
): [string, string] {
  const heard = hearingNow(call);
  if (heard) return ["You", heard];
  const line = call.line?.trim() ?? "";
  if (line) return [name, line];
  return [name, call.muted ? "Muted: it still speaks." : "Listening."];
}

// Strips shown on a view that covers the app (the review): while one is,
// the app's own strip under its top bar stays empty, so the call's line
// shows once (else one shows beside the workspace list, one over the review).
let coveringStrips = 0;
const coveringListeners = new Set<() => void>();

function subscribeCovering(listener: () => void): () => void {
  coveringListeners.add(listener);
  return () => {
    coveringListeners.delete(listener);
  };
}

function setCovering(change: 1 | -1) {
  coveringStrips += change;
  for (const listener of [...coveringListeners]) listener();
}

/**
 * During a call, what is said now (what it hears of the user, or its own
 * line) in one thin line under the top bar: it takes its own room in the
 * page, so it pushes the content down and covers nothing. Once the
 * companion says something, what it reads shows below that line, a sentence
 * at a time (CompanionReading.tsx): the line then says how far it is.
 *
 * Where the top bar is hidden or covered (Zen mode, the review), `control`
 * puts the call's chip at its end, so the call and its buttons stay on
 * screen; `children` go before it (Zen's way out). A strip on a view that
 * covers the app says so (`covering`): the app's own strip then shows
 * nothing, so there is only ever one.
 */
export function CompanionStrip({
  control = false,
  covering = false,
  children,
}: {
  control?: boolean;
  covering?: boolean;
  children?: ReactNode;
} = {}) {
  const call = useSyncExternalStore(subscribeCompanionCall, companionCallState);
  const reading = useCompanionReading();
  const covered = useSyncExternalStore(
    subscribeCovering,
    () => coveringStrips > 0,
  );
  useEffect(() => {
    if (!covering) return;
    setCovering(1);
    return () => setCovering(-1);
  }, [covering]);
  if (!call.open || (covered && !covering)) return null;
  const name = companionName();
  const [who, said] = stripLine(call, name);
  // Its own words are shown whole below: the line says where it is.
  const text = reading && who === name ? readingStatus(reading) : said;
  return (
    <div
      className={`companion-strip${control ? " has-control" : ""}${reading ? " has-reading" : ""}`}
    >
      <div className="companion-strip-line" aria-live="polite" title={text}>
        <strong>{who}</strong>
        <span>{text}</span>
      </div>
      {children}
      {control ? <CompanionChip /> : null}
      {reading ? <CompanionReadingView reading={reading} /> : null}
    </div>
  );
}
