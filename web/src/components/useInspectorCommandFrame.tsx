import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type InspectorCommand,
  inspectorCompletions,
  isTypingTarget,
  opensCommandLine,
  runInspectorCommand,
} from "../inspectorCommands";
import { store } from "../store";
import {
  type InspectorCommandRegistry,
  type InspectorCommandSet,
  inspectorShortcutList,
} from "../useInspectorCommands";
import type { InspectorView } from "../workspaceResource";
import { CommandLine } from "./CommandLine";
import { ShortcutHelp } from "./ShortcutHelp";

/**
 * The inspector's `:` prompt and shortcut list (`?`, `:help`) around its
 * views: `:` anywhere in it but where it is typed text. Each part of the
 * shown view gives its commands (useInspectorCommands), then come the
 * frame's own, which `commands` makes (`openShortcuts` for `:help`).
 * `back`: where the focus goes when what had it is gone.
 */
export function useInspectorCommandFrame({
  view,
  commands,
  back,
}: {
  view: InspectorView;
  commands: (openShortcuts: (filter: string) => void) => InspectorCommand[];
  back: () => HTMLElement | null | undefined;
}): {
  registry: InspectorCommandRegistry;
  /** The prompt or the list is open: the view's keys wait. */
  busy: boolean;
  commandLineOpen: boolean;
  leaveCommandLine: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  overlays: ReactNode;
} {
  const [commandLine, setCommandLine] = useState<{
    from: HTMLElement | null;
  } | null>(null);
  /** The shortcut list, with what its filter starts with. */
  const [shortcuts, setShortcuts] = useState<{ filter: string } | null>(null);
  const partsRef = useRef(
    new Map<string, { view: InspectorView; commands: InspectorCommandSet }>(),
  );
  const own = commands((filter) => setShortcuts({ filter }));
  /**
   * The commands of the view shown, its parts' first, then the frame's;
   * of its parts, first the one where the focus is (or was, when `:` was
   * pressed): one word means that part's.
   */
  const shownCommands = (): InspectorCommandSet => {
    const focus = commandLine?.from ?? document.activeElement;
    const focused = (part: { commands: InspectorCommandSet }) =>
      !!focus && !!part.commands.root?.()?.contains(focus);
    const parts = [...partsRef.current.values()]
      .filter((part) => part.view === view)
      .sort((a, b) => Number(focused(b)) - Number(focused(a)));
    // A part with its own list and words (the review in Changes).
    const special = parts.find(
      (part) => part.commands.shortcuts || part.commands.unknown,
    );
    return {
      commands: [...parts.flatMap((part) => part.commands.commands), ...own],
      line: parts.find((part) => part.commands.line)?.commands.line,
      ...(special?.commands.shortcuts
        ? { shortcuts: special.commands.shortcuts }
        : {}),
      ...(special?.commands.unknown
        ? { unknown: special.commands.unknown }
        : {}),
    };
  };
  const run = (input: string) => {
    const { commands, line, unknown } = shownCommands();
    const problem = runInspectorCommand(
      commands,
      input,
      line,
      unknown ? (text) => unknown(text) : undefined,
    );
    if (problem)
      store.notify({ kind: "info", message: problem, autoDismissMs: 2500 });
  };
  const runRef = useRef(run);
  runRef.current = run;
  const registry = useMemo<InspectorCommandRegistry>(
    () => ({
      set: (id, view, commands) => {
        if (commands) partsRef.current.set(id, { view, commands });
        else partsRef.current.delete(id);
      },
      run: (input) => runRef.current(input),
    }),
    [],
  );
  /** Esc, Enter: the focus back where it was when `:` was pressed. */
  const leaveCommandLine = () => {
    const from = commandLine?.from;
    setCommandLine(null);
    (from?.isConnected ? from : back())?.focus({ preventScroll: true });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (
      event.key === "?" &&
      !event.defaultPrevented &&
      !commandLine &&
      !shortcuts &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !isTypingTarget(event.target)
    ) {
      event.preventDefault();
      event.stopPropagation();
      setShortcuts({ filter: "" });
      return;
    }
    if (event.defaultPrevented || commandLine || !opensCommandLine(event))
      return;
    event.preventDefault();
    event.stopPropagation();
    setCommandLine({
      from:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
    });
  };
  const overlays = (
    <>
      {shortcuts ? (
        <ShortcutHelp
          className="inspector-keys"
          {...inspectorShortcutList(shownCommands())}
          filter={shortcuts.filter}
          placeholder="Search shortcuts and commands"
          command={(text) => run(text)}
          onClose={() => {
            setShortcuts(null);
            back()?.focus({ preventScroll: true });
          }}
        />
      ) : null}
      {commandLine ? (
        <CommandLine
          kind=":"
          completions={(typed) =>
            inspectorCompletions(shownCommands().commands, typed)
          }
          onBlur={() => setCommandLine(null)}
          onSubmit={(text) => {
            leaveCommandLine();
            run(text);
          }}
          onCancel={leaveCommandLine}
        />
      ) : null}
    </>
  );
  return {
    registry,
    busy: !!commandLine || !!shortcuts,
    commandLineOpen: !!commandLine,
    leaveCommandLine,
    onKeyDown,
    overlays,
  };
}
