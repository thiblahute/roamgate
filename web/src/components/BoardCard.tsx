import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

/**
 * A card of the board view, the frame both modes draw their cards in: a
 * list item holding the card (a button-like row: focus selects it, a
 * click opens it, Enter being the panel's key) and its actions over the
 * card's top right corner, never beside it, so a card keeps the width of
 * its column selected or not.
 */
export function BoardCard({
  selected,
  unread,
  className,
  rowClassName,
  style,
  data,
  item,
  onSelect,
  onOpen,
  actions,
  extra,
  children,
}: {
  selected: boolean;
  /** Something new since the user looked: its title stands out. */
  unread?: boolean;
  /** More classes of the list item (is-child, has-action...). */
  className?: string;
  /** More classes of the card itself. */
  rowClassName?: string;
  style?: CSSProperties;
  /** The card's data attributes: what names it for the keys and tests. */
  data?: Record<`data-${string}`, string | undefined>;
  /** The list item's own attributes: dragging, its id. */
  item?: HTMLAttributes<HTMLLIElement> & { draggable?: boolean };
  onSelect: () => void;
  onOpen: () => void;
  /** Its actions (icon buttons), over its top right corner. */
  actions?: ReactNode;
  /** Drawn between the card and its actions (a fold button in the gutter). */
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li
      {...item}
      className={`mr-reviews-item${selected ? " is-selected" : ""}${className ? ` ${className}` : ""}`}
      style={style}
    >
      <div
        role="button"
        tabIndex={0}
        className={`assistant-task-row mr-reviews-row${selected ? " is-selected" : ""}${unread ? " is-unread" : ""}${rowClassName ? ` ${rowClassName}` : ""}`}
        aria-current={selected ? "true" : undefined}
        {...data}
        onFocus={onSelect}
        onClick={onOpen}
      >
        {children}
      </div>
      {extra}
      <span className="mr-reviews-actions">{actions}</span>
    </li>
  );
}
