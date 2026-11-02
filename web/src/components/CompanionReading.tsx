import {
  type KeyboardEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type CompanionReading,
  companionReading,
  subscribeCompanionReading,
} from "../companionReading";
import "./CompanionReading.css";

export function useCompanionReading(): CompanionReading | null {
  return useSyncExternalStore(subscribeCompanionReading, companionReading);
}

/**
 * Where the strip's line says what is read (CompanionStrip): how far it is,
 * the sentence itself being shown in full below.
 */
export function readingStatus(reading: CompanionReading): string {
  const whose = reading.answer ? `${reading.answer.agent}'s answer` : null;
  if (reading.done) return whose ? `Read ${whose}.` : "Said.";
  const count = reading.sentences.length;
  const place = count > 1 ? `, ${reading.index + 1} of ${count}` : "";
  return whose ? `Reading ${whose}${place}` : `Speaking${place}`;
}

/**
 * What the companion reads on a call, so the user can follow it: the
 * sentence being said in full, the one before and the one after dimmed.
 * A tap opens the whole text, which keeps the sentence being said in view;
 * another closes it. It sits in the call's strip, in the page's flow: it
 * pushes the content down and covers nothing. Once said, it stays as it
 * ended until something else is said.
 */
export function CompanionReadingView({
  reading,
}: {
  reading: CompanionReading;
}) {
  const [open, setOpen] = useState(false);
  const wholeRef = useRef<HTMLDivElement | null>(null);
  const { sentences, index, done } = reading;
  // The whole text follows the reading: the sentence said stays in view,
  // scrolled in its own box, never the page.
  useLayoutEffect(() => {
    const box = wholeRef.current;
    if (!open || !box) return;
    const now = box.querySelector<HTMLElement>(".is-now");
    if (!now) return;
    const top = now.offsetTop - box.offsetTop;
    const target = top - (box.clientHeight - now.offsetHeight) / 2;
    box.scrollTop = Math.max(0, target);
  }, [open, index, reading.id]);
  const toggle = () => setOpen((shown) => !shown);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  };
  const current = sentences[index] ?? "";
  const before = index > 0 ? sentences[index - 1]! : null;
  const after = !done ? (sentences[index + 1] ?? null) : null;
  return (
    // A div, not a button: it holds paragraphs.
    <div
      className={`companion-reading${open ? " is-open" : ""}${done ? " is-done" : ""}`}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      title={
        open ? "Show only the sentence being read" : "Show the whole text read"
      }
      onClick={toggle}
      onKeyDown={onKeyDown}
    >
      {open ? (
        <div ref={wholeRef} className="companion-reading-whole">
          {sentences.map((sentence, at) => (
            <span
              // Sentences repeat ("Ok."): their place is their key.
              key={at}
              className={
                at === index && !done
                  ? "is-now"
                  : at < index || done
                    ? "is-said"
                    : "is-ahead"
              }
              aria-current={at === index && !done ? "true" : undefined}
            >
              {sentence}{" "}
            </span>
          ))}
        </div>
      ) : (
        <>
          {before ? <p className="companion-reading-before">{before}</p> : null}
          <p className="companion-reading-now" aria-current={!done}>
            {current}
          </p>
          {after ? <p className="companion-reading-after">{after}</p> : null}
        </>
      )}
    </div>
  );
}
