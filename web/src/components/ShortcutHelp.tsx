import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { pressShortcut, shortcutPresses } from "../shortcutPress";
import { type ActionDefinition, ActionList } from "./ActionList";
import { CloseButton } from "./CloseButton";
import "./ShortcutHelp.css";

/*
 * A view's shortcut help (`?`, `:help`): the command menu's list
 * (ActionList) over the view's own shortcuts, declared as data. The search
 * filters by keys and words; Enter, a click or a tap runs the shortcut in
 * the view, as if its keys were typed there.
 */

/**
 * How a shortcut runs: the keys to press in the view ("gg", "Ctrl-d"), a
 * `:command` (the view's `command`), a callback, or false when nothing can
 * run it (a count, a key held with a click). Not given: its keys, when they
 * are one shortcut; a row of several ("j k") is listed only.
 */
export type ShortcutRun = string | false | (() => void);

/** A view's shortcut: [keys apart by spaces, what it does, how it runs]. */
export type ShortcutRow = readonly [
  keys: string,
  label: string,
  run?: ShortcutRun,
];

export type ShortcutGroup = {
  heading: string;
  rows: readonly ShortcutRow[];
};

/**
 * Whether a row matches what is typed in the filter: one key that is a key
 * of the list lists the rows holding it; else every word typed must be in
 * the row's keys or label, accents ignored.
 */
export function matchesShortcutFilter(
  rows: readonly ShortcutRow[],
  keys: string,
  label: string,
  filter: string,
): boolean {
  const plain = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const normal = (value: string) => plain(value).toLowerCase();
  const query = normal(filter).trim();
  if (!query) return true;
  // One key: the rows holding it, when it is a key of the list.
  const key = plain(filter).trim();
  const holds = (row: string) =>
    row.split(" ").some((each) => plain(each) === key);
  if (key.length === 1 && rows.some(([row]) => holds(row))) return holds(keys);
  const haystack = normal(`${keys} ${label}`);
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

/** What runs a row, or null when it is listed only. */
export function shortcutRunOf(
  row: ShortcutRow,
  command: ((text: string) => void) | undefined,
): (() => void) | string | null {
  const [keys, , run] = row;
  if (run === false) return null;
  if (typeof run === "function") return run;
  const shortcut = run ?? keys;
  if (shortcut.startsWith(":") && shortcut.length > 1 && !/\s/.test(shortcut))
    return command ? shortcut : null;
  if (run === undefined && /\s/.test(keys.trim())) return null;
  return shortcutPresses(shortcut) ? shortcut : null;
}

export function ShortcutHelp({
  title,
  rows,
  groups,
  filter: initialFilter = "",
  onClose,
  command,
  target,
  placeholder = "Search shortcuts",
  className = "",
}: {
  title: string;
  /** The view's shortcuts, in one list. */
  rows?: readonly ShortcutRow[];
  /** Or in groups, each under its heading. */
  groups?: readonly ShortcutGroup[];
  /** What the search starts with (`:help WORD`). */
  filter?: string;
  /** Esc, the close button, a click beside the panel. */
  onClose: () => void;
  /** Runs a `:command` row (the text after the colon) in the view. */
  command?: (text: string) => void;
  /**
   * Where the keys of a row are pressed (and the focus goes back) when
   * what had the focus as the help opened was nothing, or a button.
   */
  target?: () => HTMLElement | null | undefined;
  placeholder?: string;
  className?: string;
}) {
  const [search, setSearch] = useState(initialFilter);
  /** Moved through the list: j / k move too, any other key searches. */
  const [browsing, setBrowsing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousRef = useRef<Element | null>(null);
  const ranRef = useRef(false);
  const commandRef = useRef(command);
  commandRef.current = command;
  const targetRef = useRef(target);
  targetRef.current = target;

  const sections = useMemo<readonly ShortcutGroup[]>(
    () => groups ?? [{ heading: "", rows: rows ?? [] }],
    [groups, rows],
  );
  const allRows = useMemo(
    () => sections.flatMap((section) => section.rows),
    [sections],
  );
  const actionGroups = sections.map((section, at) => ({
    heading: section.heading,
    actions: section.rows.map((row, index): ActionDefinition => {
      const run = shortcutRunOf(row, command);
      return {
        key: `${at}:${index}:${row[0]}`,
        title: row[1],
        keys: row[0],
        ...(run === null ? {} : { run: () => runRow(run) }),
      };
    }),
  }));

  /**
   * Where the view's keys go: what had the focus when the help opened,
   * unless it was a button (the one that opened it); else the target.
   */
  const viewElement = (): HTMLElement | null => {
    const previous = previousRef.current;
    if (
      previous instanceof HTMLElement &&
      previous.isConnected &&
      previous !== document.body &&
      !previous.closest("button, a")
    )
      return previous;
    const given = targetRef.current?.();
    return given?.isConnected ? given : null;
  };
  /** Closes, gives the focus back, then runs the row in the view. */
  const runRow = (run: (() => void) | string) => {
    ranRef.current = true;
    onClose();
    // The view sees the help closed (its state, its listeners) first.
    window.setTimeout(() => {
      const element = viewElement();
      element?.focus({ preventScroll: true });
      if (typeof run === "function") run();
      else if (run.startsWith(":")) commandRef.current?.(run.slice(1));
      else {
        const presses = shortcutPresses(run);
        if (presses)
          pressShortcut(
            element ?? document.activeElement ?? document.body,
            presses,
          );
      }
    }, 0);
  };

  useEffect(() => {
    previousRef.current = document.activeElement;
    inputRef.current?.focus({ preventScroll: true });
    const panel = panelRef.current;
    return () => {
      if (ranRef.current) return;
      // Closed: the focus goes back to the view, unless it moved on.
      const active = document.activeElement;
      if (
        active === null ||
        active === document.body ||
        !active.isConnected ||
        panel?.contains(active)
      )
        viewElement()?.focus({ preventScroll: true });
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: on open and close only
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      (event.ctrlKey && /^[jknp]$/.test(event.key))
    ) {
      setBrowsing(true);
      return;
    }
    if (event.key === "Tab" && plain) {
      // Tab moves into the list: j / k then move.
      event.preventDefault();
      setBrowsing(true);
      event.currentTarget.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: event.shiftKey ? "ArrowUp" : "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
      return;
    }
    if (!browsing || !plain) return;
    if (event.key === "j" || event.key === "k") {
      event.preventDefault();
      (event.target as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: event.key === "j" ? "ArrowDown" : "ArrowUp",
          bubbles: true,
          cancelable: true,
        }),
      );
    } else if (event.key === "/") {
      // Back to the search.
      event.preventDefault();
      setBrowsing(false);
      inputRef.current?.select();
    } else if (event.key.length === 1 || event.key === "Backspace") {
      setBrowsing(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click beside the panel closes it
    <div
      className={`shortcut-help ${className}`.trim()}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          onClose();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        // The help's keys are its own: the view under it waits. App
        // shortcuts (Cmd, Alt) go on.
        if (!event.metaKey && !event.altKey) event.stopPropagation();
      }}
    >
      <div
        ref={panelRef}
        className="shortcut-help-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="shortcut-help-head">
          <h2>{title}</h2>
          <CloseButton label="Close (Esc)" onClick={onClose} />
        </div>
        <ActionList
          className="shortcut-help-list"
          label={title}
          groups={actionGroups}
          search={search}
          onSearch={(next) => {
            setSearch(next);
            setBrowsing(false);
          }}
          onRun={(action) => action.run?.()}
          placeholder={placeholder}
          emptyText="Nothing matches."
          topResults={false}
          rank={(action, typed) =>
            matchesShortcutFilter(
              allRows,
              action.keys ?? "",
              action.title,
              typed,
            )
              ? 1
              : 0
          }
          inputRef={inputRef}
          onKeyDown={onKeyDown}
        />
        <p className="shortcut-help-foot">
          <kbd>Enter</kbd> or a tap runs it · <kbd>↑</kbd> <kbd>↓</kbd> move
          (then <kbd>j</kbd> <kbd>k</kbd> too, <kbd>/</kbd> searches again) ·{" "}
          <kbd>Esc</kbd> closes
        </p>
      </div>
    </div>
  );
}
