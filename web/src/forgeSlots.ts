import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/**
 * Where the agent chats turn merge and pull request references into chips.
 * Markdown is rendered as sanitized HTML: its references are found in the
 * rendered text (never in code) and each is replaced by an empty slot the
 * chat draws a chip into; plain text is split as it renders. Only chats
 * provide this: other Markdown (file previews, reviews) is left as is.
 */
export type ForgeSlotTarget = {
  element: HTMLElement;
  node: ReactNode;
  /** The request and how it was written: what a redraw reuses it for. */
  key: string;
};

export type ForgeSlots = {
  /**
   * Marks the references under `root`; `restore` puts the text back.
   * The slots of `reuse` are drawn into again for the same references, in
   * order, so their chips stay as they are; a `streaming` message's last
   * reference waits until it is whole (`#5` of `#562`).
   */
  mark(
    root: HTMLElement,
    options?: { reuse?: readonly ForgeSlotTarget[]; streaming?: boolean },
  ): {
    targets: ForgeSlotTarget[];
    restore(): void;
  };
  /** Plain text with its references as chips, or null when it has none. */
  renderText(text: string): ReactNode | null;
};

export const ForgeSlotsContext = createContext<ForgeSlots | null>(null);

export function useForgeSlotsContext(): ForgeSlots | null {
  return useContext(ForgeSlotsContext);
}

/** A message still being written (a live turn's text). */
export const ForgeStreamingContext = createContext(false);

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
 * The chips of the sanitized HTML under `root`, redrawn when `html` changes.
 * A streamed message's HTML changes with every piece: its chips' slots are
 * moved into the new HTML before it is painted, each chip staying mounted
 * with what it shows (no flash of the plain text, no reload, no new hover).
 */
export function useForgeSlots(
  rootRef: RefObject<HTMLElement | null>,
  html: string,
): ReactNode {
  const slots = useContext(ForgeSlotsContext);
  const streaming = useContext(ForgeStreamingContext);
  const [targets, setTargets] = useState<ForgeSlotTarget[]>([]);
  const drawn = useRef<readonly ForgeSlotTarget[]>([]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!slots || !root) {
      drawn.current = [];
      setTargets((previous) => (previous.length ? [] : previous));
      return;
    }
    const marked = slots.mark(root, { reuse: drawn.current, streaming });
    drawn.current = marked.targets;
    setTargets(marked.targets);
    return () => marked.restore();
    // Redrawn when the HTML changes; the ref is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, slots, streaming]);
  return targets.map(({ element, node }) =>
    createPortal(node, element, slotId(element)),
  );
}
