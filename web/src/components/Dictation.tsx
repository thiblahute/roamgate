import { Mic } from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type Dictating,
  type DictationKind,
  insertDictation,
  startDictation,
} from "../dictation";
import "./Dictation.css";

/**
 * A box dictated into (dictation.ts): its text and cursor when asked, and
 * how text goes in at the cursor.
 */
export type DictationField = {
  /** The text and the cursor now; null when the box is gone. */
  read: () => { value: string; start: number; end: number } | null;
  /** Puts `text` in place of `start`..`end`, the caret at `caret`. */
  replace: (start: number, end: number, text: string, caret: number) => void;
  kind: DictationKind;
  /** The box's label or placeholder, for the cleaner. */
  hint?: string;
  multiLine?: boolean;
};

/** A dictation under way, or its error shown a moment. */
export type DictationStatusState = {
  state: "starting" | "listening" | "cleaning";
  /** The words as heard so far. */
  heard: string;
  /** The server's listening models load: what is said is heard after. */
  loading?: boolean;
  error?: string;
};

export type Dictation = {
  status: DictationStatusState | null;
  /** Starts listening, or stops and puts the cleaned text at the cursor. */
  toggle: () => Promise<void>;
  /** Drops it: nothing is typed. */
  cancel: () => void;
};

/** How long an error stays. */
const ERROR_MS = 3000;
export const NOTHING_HEARD = "Nothing was heard";

/**
 * Dictation into a box: the words as heard while they are said, the
 * cleaned text put at the cursor when the user stops. The one behind every
 * Dictate button (DictationButton), the message box's among them.
 */
export function useDictation(field: DictationField): Dictation {
  const fieldRef = useRef(field);
  fieldRef.current = field;
  const [status, setStatus] = useState<DictationStatusState | null>(null);
  // Read by toggle at once, whatever was drawn last.
  const statusRef = useRef<DictationStatusState | null>(null);
  const dictatingRef = useRef<Dictating | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gone = useRef(false);
  const update = (
    next: (now: DictationStatusState | null) => DictationStatusState | null,
  ) => {
    statusRef.current = next(statusRef.current);
    setStatus(statusRef.current);
  };
  const fail = (error: string) => {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    update(() => ({ state: "starting", heard: "", error }));
    errorTimer.current = setTimeout(() => {
      errorTimer.current = null;
      update(() => null);
    }, ERROR_MS);
  };
  const cancel = () => {
    dictatingRef.current?.cancel();
    dictatingRef.current = null;
    if (statusRef.current && !statusRef.current.error) update(() => null);
  };
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      dictatingRef.current?.cancel();
      dictatingRef.current = null;
      if (errorTimer.current) clearTimeout(errorTimer.current);
    };
  }, []);
  const toggle = async () => {
    const now = statusRef.current;
    if (now?.state === "listening" && dictatingRef.current) {
      const dictating = dictatingRef.current;
      dictatingRef.current = null;
      update((now) =>
        now ? { ...now, state: "cleaning", loading: false } : now,
      );
      const result = await dictating.finish();
      if (result.nothingHeard) return fail(NOTHING_HEARD);
      // The box as it is now: the user may have typed meanwhile.
      const at = fieldRef.current.read();
      if (at && result.text) {
        const next = insertDictation(at.value, at.start, at.end, result.text);
        fieldRef.current.replace(
          at.start,
          at.end,
          next.value.slice(
            at.start,
            next.value.length - (at.value.length - at.end),
          ),
          next.caret,
        );
      }
      update(() => null);
      return;
    }
    if (now && !now.error) return;
    const at = fieldRef.current.read();
    const value = at?.value ?? "";
    const { kind, hint, multiLine } = fieldRef.current;
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = null;
    update(() => ({ state: "starting", heard: "" }));
    try {
      const dictating = await startDictation(
        {
          kind,
          ...(hint ? { hint } : {}),
          ...(multiLine === undefined ? {} : { multiLine }),
          before: value.slice(0, at?.start ?? value.length),
          after: value.slice(at?.end ?? value.length),
        },
        (heard) => update((now) => (now ? { ...now, heard } : now)),
        (loading) => update((now) => (now ? { ...now, loading } : now)),
      );
      // Its box went away meanwhile: nothing to type into.
      if (gone.current) return dictating.cancel();
      dictatingRef.current = dictating;
      update((now) => (now ? { ...now, state: "listening" } : now));
    } catch (error) {
      fail((error as Error).message || "Dictation failed");
    }
  };
  return { status, toggle, cancel };
}

/** What the status line says. */
export function dictationStatusText(status: DictationStatusState): string {
  if (status.error) return status.error;
  if (status.heard) return status.heard;
  if (status.state === "starting") return "Opening the microphone...";
  if (status.state === "cleaning") return "Cleaning...";
  if (status.loading)
    return "Loading the voice models: speak, you are heard once they are ready";
  return "Listening: speak, then press the button again";
}

/** The words as heard while they are said, or what went wrong. */
export function DictationStatus({
  dictation,
  className,
}: {
  dictation: Dictation;
  className?: string;
}) {
  const status = dictation.status;
  if (!status) return null;
  return (
    <div
      className={`dictation-status${className ? ` ${className}` : ""}${status.error ? " is-error" : ""}${status.loading ? " is-loading" : ""}`}
      role="status"
    >
      {dictationStatusText(status)}
      {status.heard && status.state === "cleaning" ? " ..." : null}
    </div>
  );
}

/** Pressing the button leaves the focus, and the cursor, in the box. */
const keepFocus = (event: ReactMouseEvent<HTMLButtonElement>) =>
  event.preventDefault();

/** Dictate, the microphone on a box. */
export function DictationButton({
  dictation,
  className = "is-on-field",
  onMouseDown = keepFocus,
  size = 17,
}: {
  dictation: Dictation;
  className?: string;
  onMouseDown?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  size?: number;
}) {
  const state = dictation.status?.error ? null : dictation.status?.state;
  const listening = state === "listening";
  return (
    <button
      type="button"
      className={`dictation-button ${className}${listening ? " is-listening" : ""}`}
      aria-label={
        listening ? "Stop dictating and put the text in the box" : "Dictate"
      }
      aria-pressed={listening}
      title={listening ? "Stop: the cleaned text goes in the box" : "Dictate"}
      disabled={state === "starting" || state === "cleaning"}
      onMouseDown={onMouseDown}
      onClick={() => void dictation.toggle()}
    >
      <Mic size={size} aria-hidden="true" />
    </button>
  );
}

/**
 * A textarea's or text input's DictationField: the text goes in as typed
 * text does, so React's onChange sees it.
 */
export function textFieldDictation(
  element: () => HTMLInputElement | HTMLTextAreaElement | null,
  kind: DictationKind,
): DictationField {
  const box = element();
  const hint =
    box?.getAttribute("aria-label") || box?.getAttribute("placeholder") || "";
  return {
    kind,
    ...(hint ? { hint } : {}),
    multiLine: box?.tagName === "TEXTAREA",
    read: () => {
      const box = element();
      if (!box?.isConnected) return null;
      const value = box.value;
      return {
        value,
        start: box.selectionStart ?? value.length,
        end: box.selectionEnd ?? value.length,
      };
    },
    replace: (start, end, text, caret) => {
      const box = element();
      if (!box?.isConnected) return;
      const value = `${box.value.slice(0, start)}${text}${box.value.slice(end)}`;
      // The prototype's setter: React tracks the element's own, and only
      // reports a change it did not make itself.
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(box),
        "value",
      )?.set?.call(box, value);
      box.dispatchEvent(new Event("input", { bubbles: true }));
      try {
        box.setSelectionRange(caret, caret);
      } catch {
        // Inputs without a selection (none here) keep theirs.
      }
    },
  };
}
