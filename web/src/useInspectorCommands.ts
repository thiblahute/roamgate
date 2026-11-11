import { createContext, useContext, useId, useLayoutEffect } from "react";
import type { InspectorCommand } from "./inspectorCommands";
import type { InspectorView } from "./workspaceResource";

/** A view part's `:` commands, and `:N` where it has lines. */
export type InspectorCommandSet = {
  commands: readonly InspectorCommand[];
  line?: (line: number) => void;
};

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
