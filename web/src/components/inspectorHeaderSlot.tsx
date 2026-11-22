import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
} from "react";
import { createPortal } from "react-dom";
import { InspectorViewContext } from "../useInspectorCommands";
import type { InspectorView } from "../workspaceResource";
import type { ReviewMenuItem } from "./ReviewMenu";

/**
 * The workspace inspector's header row has one slot for the view shown:
 * the view's own controls (its status, its few actions) go there, beside
 * the view tabs, so no view has a toolbar row of its own under the header.
 */
export type InspectorHeaderSlot = {
  /** The slot's element in the header row, once mounted. */
  target: HTMLElement | null;
  /** The view the inspector shows: only its controls fill the slot. */
  view: InspectorView;
  /**
   * A view's entries for the inspector's More menu (null: none): a
   * phone's row has room for one menu, the inspector's.
   */
  setMoreItems?: (
    view: InspectorView,
    items: readonly ReviewMenuItem[] | null,
  ) => void;
};

export const InspectorHeaderSlotContext =
  createContext<InspectorHeaderSlot | null>(null);

/**
 * True when this part is in the inspector, whose header takes its
 * controls: the part then leaves its own toolbar row out.
 */
export function useInInspectorHeader(): boolean {
  return !!useContext(InspectorHeaderSlotContext);
}

/**
 * A view's controls: in the inspector's header row while its view is shown
 * (nothing while another view is), else, where the part is shown on its
 * own, in its own row (`fallback`). `inline` keeps them in that row in the
 * inspector too (a part that covers the screen, a nested part).
 */
export function InspectorHeaderControls({
  children,
  className,
  label,
  inline = false,
  fallback,
  data,
  headRef,
}: {
  children: ReactNode;
  /** The slot's wrapper: the part's own head class keeps its styles. */
  className: string;
  /** Read out for the controls' group. */
  label: string;
  inline?: boolean;
  /** The part's own row, outside the inspector or `inline`. */
  fallback: (children: ReactNode) => ReactNode;
  /** Attributes the part's styles read on its head (data-*). */
  data?: Record<`data-${string}`, string | undefined>;
  /**
   * The controls' element in the header: a part whose keys are read on
   * the window takes the keys there too, as in its own element.
   */
  headRef?: RefObject<HTMLElement | null>;
}) {
  const slot = useContext(InspectorHeaderSlotContext);
  const view = useContext(InspectorViewContext);
  if (!slot || !view || inline) return fallback(children);
  if (slot.view !== view || !slot.target) return null;
  return createPortal(
    <div
      ref={
        headRef
          ? (element) => {
              headRef.current = element;
            }
          : undefined
      }
      className={`inspector-view-head ${className}`}
      role="group"
      aria-label={label}
      data-view-head={view}
      {...data}
    >
      {children}
    </div>,
    slot.target,
  );
}

/**
 * A view's entries in the inspector's More menu, while `items` is given
 * and the part is in the inspector: true when they went there (the part
 * then leaves its own menu out). `items` should be memoized.
 */
export function useInspectorMoreItems(
  items: readonly ReviewMenuItem[] | null,
): boolean {
  const slot = useContext(InspectorHeaderSlotContext);
  const view = useContext(InspectorViewContext);
  const set = slot?.setMoreItems;
  useEffect(() => {
    if (!set || !view || !items) return;
    set(view, items);
    return () => set(view, null);
  }, [set, view, items]);
  return !!(set && view && items);
}
