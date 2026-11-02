import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useState,
} from "react";
import { createPortal } from "react-dom";

/**
 * Where the agent chats turn merge and pull request references into chips.
 * Markdown is rendered as sanitized HTML: its references are found in the
 * rendered text (never in code) and each is replaced by an empty slot the
 * chat draws a chip into; plain text is split as it renders. Only chats
 * provide this: other Markdown (file previews) is left as is.
 */
export type ForgeSlots = {
  /** Marks the references under `root`; `restore` puts the text back. */
  mark(root: HTMLElement): {
    targets: { element: HTMLElement; node: ReactNode }[];
    restore(): void;
  };
  /** Plain text with its references as chips, or null when it has none. */
  renderText(text: string): ReactNode | null;
};

export const ForgeSlotsContext = createContext<ForgeSlots | null>(null);

export function useForgeSlotsContext(): ForgeSlots | null {
  return useContext(ForgeSlotsContext);
}

/** The chips of the sanitized HTML under `root`, redrawn when `html` changes. */
export function useForgeSlots(
  rootRef: RefObject<HTMLElement | null>,
  html: string,
): ReactNode {
  const slots = useContext(ForgeSlotsContext);
  const [targets, setTargets] = useState<
    { element: HTMLElement; node: ReactNode }[]
  >([]);
  useEffect(() => {
    const root = rootRef.current;
    if (!slots || !root) {
      setTargets((previous) => (previous.length ? [] : previous));
      return;
    }
    const marked = slots.mark(root);
    setTargets(marked.targets);
    return () => marked.restore();
    // Redrawn when the HTML changes; the ref is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, slots]);
  return targets.map(({ element, node }, index) =>
    createPortal(node, element, String(index)),
  );
}
