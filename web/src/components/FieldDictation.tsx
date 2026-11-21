import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DictationKind } from "../dictation";
import { useSpeechEngine } from "../speechEngine";
import { activeCall } from "../webrtcCall";
import {
  DictationButton,
  DictationStatus,
  textFieldDictation,
  useDictation,
} from "./Dictation";

type TextBox = HTMLInputElement | HTMLTextAreaElement;

/** Inputs whose text a person writes, or may say. */
const INPUT_TYPES = new Set(["text", "search", "url", "email"]);

/**
 * Whether a box gets Dictate when focused: a textarea or text input one can
 * type in, but not one with its own Dictate or that wants none
 * (`data-dictation` on it or around it: the message box, a filter on
 * names), a terminal's keys, or CodeMirror's Vim bar.
 */
export function dictatesInto(target: EventTarget | null): target is TextBox {
  // By tag, not class: a frame's boxes, or a test DOM's, are of others.
  const box = target as TextBox | null;
  if (
    box?.tagName !== "TEXTAREA" &&
    !(box?.tagName === "INPUT" && INPUT_TYPES.has(box.type))
  )
    return false;
  if (!box || box.readOnly || box.disabled) return false;
  return !box.closest("[data-dictation], .xterm, .cm-editor");
}

/** What the server's cleaner is told the box takes. */
export function dictationKind(box: TextBox): DictationKind {
  if (box.tagName === "TEXTAREA") return "text";
  if (box.type === "search") return "search";
  if (box.type === "url") return "url";
  if (box.type === "email") return "email_address";
  return "text";
}

/** The button's place and size, and the status line's, on the page. */
type Place = {
  top: number;
  left: number;
  size: number;
  status: { left: number; width: number; top?: number; bottom?: number };
  hidden: boolean;
};

const GAP = 4;
const BUTTON = 28;

function placeFor(box: TextBox): Place {
  const rect = box.getBoundingClientRect();
  const size = Math.max(20, Math.min(BUTTON, rect.height - GAP));
  // A box of several lines: at its bottom right, as on the message box.
  const tall = box.tagName === "TEXTAREA" && rect.height > 2 * BUTTON;
  const top = tall
    ? rect.bottom - size - GAP
    : rect.top + (rect.height - size) / 2;
  const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 8);
  const left = Math.max(4, Math.min(rect.left, window.innerWidth - width - 4));
  const below = window.innerHeight - rect.bottom > 72;
  return {
    top,
    left: rect.right - size - GAP,
    size,
    status: below
      ? { left, width, top: rect.bottom + GAP }
      : { left, width, bottom: window.innerHeight - rect.top + GAP },
    hidden: rect.bottom < 0 || rect.top > window.innerHeight,
  };
}

/**
 * Dictate on every other box (Dictation.tsx): the message box's
 * microphone, shown at the right edge of the textarea or text input that
 * has the focus, while the server has its voice engine and no call runs.
 * Mounted once for the page.
 */
export default function FieldDictation() {
  const listen = useSpeechEngine().listen;
  const [box, setBox] = useState<TextBox | null>(null);
  const boxRef = useRef<TextBox | null>(null);
  boxRef.current = box;
  const dictation = useDictation(
    textFieldDictation(() => boxRef.current, box ? dictationKind(box) : "text"),
  );
  // Dictating: the box stays the one, wherever the focus goes.
  const busy = !!dictation.status && !dictation.status.error;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const [place, setPlace] = useState<Place | null>(null);
  const cancel = useRef(dictation.cancel);
  cancel.current = dictation.cancel;

  useEffect(() => {
    const follow = (target: EventTarget | null) => {
      if (busyRef.current) return;
      setBox(dictatesInto(target) && !activeCall() ? target : null);
    };
    const onFocusIn = (event: FocusEvent) => follow(event.target);
    const onFocusOut = (event: FocusEvent) => {
      if (event.target === boxRef.current) follow(event.relatedTarget);
    };
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    follow(document.activeElement);
    return () => {
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
    };
  }, []);

  // Done, its box no longer focused: it goes.
  useEffect(() => {
    if (!busy && box && document.activeElement !== box) setBox(null);
  }, [busy, box]);

  // On the box wherever it moves; gone with it.
  useLayoutEffect(() => {
    if (!box) {
      setPlace(null);
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      if (!box.isConnected) {
        cancel.current();
        setBox(null);
        return;
      }
      const next = placeFor(box);
      // Most page changes move nothing: drawn again only when it moved.
      setPlace((now) =>
        now && JSON.stringify(now) === JSON.stringify(next) ? now : next,
      );
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", later, { capture: true, passive: true });
    window.addEventListener("resize", later);
    window.visualViewport?.addEventListener("resize", later);
    window.visualViewport?.addEventListener("scroll", later);
    const resized =
      typeof ResizeObserver === "function" ? new ResizeObserver(later) : null;
    resized?.observe(box);
    // A box removed or moved by a re-render: checked as the page changes.
    const changed =
      typeof MutationObserver === "function"
        ? new MutationObserver(later)
        : null;
    changed?.observe(document.body, { childList: true, subtree: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", later, { capture: true });
      window.removeEventListener("resize", later);
      window.visualViewport?.removeEventListener("resize", later);
      window.visualViewport?.removeEventListener("scroll", later);
      resized?.disconnect();
      changed?.disconnect();
    };
  }, [box]);

  const shown = !!box && !!place && (listen || !!dictation.status);
  // The text keeps clear of the button.
  useEffect(() => {
    if (!box || !shown || !listen) return;
    box.classList.add("has-field-dictation");
    return () => box.classList.remove("has-field-dictation");
  }, [box, shown, listen]);

  if (!shown || !box || !place) return null;
  return createPortal(
    <div className="field-dictation">
      {listen && !place.hidden ? (
        <div
          className="field-dictation-button"
          style={{
            top: place.top,
            left: place.left,
            width: place.size,
            height: place.size,
          }}
        >
          <DictationButton
            dictation={dictation}
            size={place.size < 24 ? 14 : 17}
          />
        </div>
      ) : null}
      {dictation.status ? (
        <div
          className="field-dictation-status"
          style={{
            left: place.status.left,
            width: place.status.width,
            ...(place.status.top === undefined
              ? { bottom: place.status.bottom }
              : { top: place.status.top }),
          }}
        >
          <DictationStatus dictation={dictation} />
        </div>
      ) : null}
    </div>,
    box.closest("dialog") ?? document.body,
  );
}
