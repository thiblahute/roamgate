import { createContext, useContext, useId, useLayoutEffect } from "react";
import type { InspectorCommand } from "./inspectorCommands";
import type { ShortcutGroup, ShortcutRow } from "./components/ShortcutHelp";
import type { InspectorView } from "./workspaceResource";

/** A view part's `:` commands, and `:N` where it has lines. */
export type InspectorCommandSet = {
  commands: readonly InspectorCommand[];
  line?: (line: number) => void;
  /**
   * Where the part is drawn: with the focus in it, its commands come before
   * the other parts' (`:refresh` is the preview's there, the tree's in it).
   */
  root?: () => Element | null;
  /**
   * The part's own shortcut list, shown by `?` and `:help` in place of the
   * inspector's (the review in Changes: the review's list).
   */
  shortcuts?: { title: string; rows: readonly ShortcutRow[] };
  /** What the prompt says of a word that is no command (the review's). */
  unknown?: (text: string) => string;
};

/** The inspector's own keys, in its shortcut list (`?`, `:help`). */
export const INSPECTOR_KEYS: readonly ShortcutRow[] = [
  ["gt", "next view"],
  ["gT", "previous view"],
  [":", "command line, in every view; Tab / Shift+Tab complete"],
  ["?", "this list (:help WORD opens it filtered)", false],
  ["← → Home End", "on the tabs: previous / next view, the first / last"],
  [
    "Tab",
    "from the tabs, the shown view's controls, in the same header row",
    false,
  ],
];

/**
 * The shortcut list `?` shows over a view: its part's own list when it has
 * one (the review in Changes), else the inspector's keys, then every
 * command the prompt has there, each run by its name.
 */
export function inspectorShortcutList(set: InspectorCommandSet): {
  title: string;
  groups: ShortcutGroup[];
} {
  if (set.shortcuts)
    return {
      title: set.shortcuts.title,
      groups: [{ heading: "", rows: set.shortcuts.rows }],
    };
  const seen = new Set<string>();
  return {
    title: "Inspector shortcuts",
    groups: [
      { heading: "Keys", rows: INSPECTOR_KEYS },
      {
        heading: "Commands",
        rows: set.commands
          .filter((command) => {
            if (command.listed === false || seen.has(command.name))
              return false;
            seen.add(command.name);
            return true;
          })
          .map(
            (command): ShortcutRow => [
              [command.name, ...(command.aliases ?? [])]
                .map((word) => `:${word}`)
                .join(" "),
              command.description,
              `:${command.name}`,
            ],
          ),
      },
    ],
  };
}

/** The inspector's one prompt: what each part of its views can do there. */
export type InspectorCommandRegistry = {
  /** A part's commands, in `view`; null when it has none (or is gone). */
  set: (
    id: string,
    view: InspectorView,
    commands: InspectorCommandSet | null,
  ) => void;
  /** Runs what is typed, as the prompt does (the source view's Vim `:`). */
  run: (input: string) => void;
};

export const InspectorCommandsContext =
  createContext<InspectorCommandRegistry | null>(null);

/** The view a part of the inspector is in. */
export const InspectorViewContext = createContext<InspectorView | null>(null);

/**
 * Gives the inspector's prompt this part's commands while it is mounted,
 * for its view. Returns the inspector's runner when the inspector owns the
 * prompt, else null (the part is shown on its own, outside the inspector).
 */
export function useInspectorCommands(
  commands: InspectorCommandSet | null,
): ((input: string) => void) | null {
  const registry = useContext(InspectorCommandsContext);
  const view = useContext(InspectorViewContext);
  const id = useId();
  // Every render: the commands close over the part's current state.
  useLayoutEffect(() => {
    if (registry && view) registry.set(id, view, commands);
  });
  useLayoutEffect(() => {
    if (!registry || !view) return;
    return () => registry.set(id, view, null);
  }, [registry, view, id]);
  return registry && view ? registry.run : null;
}
