import {
  type ReactNode,
  type RefObject,
  Suspense,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { type DiagramLanguage, diagramLanguage } from "../diagramSource";
import { lazyWithReload } from "../lazyWithReload";

/**
 * Where messages draw their diagrams. DiagramBlock and its renderers load
 * when the first diagram shows, not with the app.
 */
const DiagramBlock = lazyWithReload("diagram-block", () =>
  import("./DiagramBlock").then((module) => ({
    default: module.DiagramBlock,
  })),
);

export function Diagram({
  lang,
  code,
}: {
  lang: DiagramLanguage;
  code: string;
}) {
  return (
    <Suspense
      fallback={
        <div
          role="status"
          style={{ padding: "8px 0", color: "var(--muted)", fontSize: 12 }}
        >
          Drawing the diagram
        </div>
      }
    >
      <DiagramBlock lang={lang} code={code} />
    </Suspense>
  );
}

type DiagramSlot = {
  element: HTMLElement;
  lang: DiagramLanguage;
  code: string;
};

const slotIds = new WeakMap<HTMLElement, string>();
let nextSlotId = 0;

function slotId(element: HTMLElement): string {
  let id = slotIds.get(element);
  if (!id) {
    id = String(++nextSlotId);
    slotIds.set(element, id);
  }
  return id;
}

/**
 * The diagrams of the sanitized HTML under `root`: each ```mermaid or
 * ```svg block is replaced by a slot a diagram is drawn into. A streamed
 * message's HTML changes with every piece: the slots drawn for the same
 * diagrams are moved into the new HTML before it is painted, so a diagram
 * stays as it is (no flash, nothing drawn again). `openAtEnd`: the text ends
 * in a block not closed yet, its last code block, left as code until whole.
 */
export function useDiagramSlots(
  rootRef: RefObject<HTMLElement | null>,
  html: string,
  openAtEnd: boolean,
): ReactNode {
  const [slots, setSlots] = useState<DiagramSlot[]>([]);
  const drawn = useRef<readonly DiagramSlot[]>([]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // Not the source of a diagram drawn already.
    const codes = [...root.querySelectorAll("pre > code")].filter(
      (code) => !code.closest(".markdown-diagram-slot, .diagram-block"),
    );
    if (openAtEnd) codes.pop();
    const used = new Set<DiagramSlot>();
    const next: DiagramSlot[] = [];
    const replaced: Array<{ element: HTMLElement; pre: Element }> = [];
    for (const code of codes) {
      const language = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1];
      const lang = diagramLanguage(language);
      const pre = code.parentElement;
      if (!lang || !pre) continue;
      const source = code.textContent ?? "";
      const previous = drawn.current.find(
        (slot) => !used.has(slot) && slot.lang === lang && slot.code === source,
      );
      if (previous) used.add(previous);
      const element = previous?.element ?? document.createElement("div");
      element.className = "markdown-diagram-slot";
      pre.replaceWith(element);
      replaced.push({ element, pre });
      next.push({ element, lang, code: source });
    }
    drawn.current = next;
    setSlots((current) =>
      current.length === next.length &&
      current.every(
        (slot, index) =>
          slot.element === next[index]!.element &&
          slot.code === next[index]!.code,
      )
        ? current
        : next,
    );
    return () => {
      // Puts the code back (StrictMode's replay); new HTML has its own.
      for (const { element, pre } of replaced)
        if (root.contains(element)) element.replaceWith(pre);
    };
    // Redrawn when the HTML changes; the ref is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, openAtEnd]);
  return slots.map(({ element, lang, code }) =>
    createPortal(<Diagram lang={lang} code={code} />, element, slotId(element)),
  );
}
