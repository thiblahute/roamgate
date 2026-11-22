import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useState,
} from "react";
import { SHORTCUT_NUMBERS, type ShortcutNumber } from "../shortcutBindings";
import {
  getShortcutSnapshot,
  shortcutLabel,
  shortcutMatches,
  useShortcutPreferences,
} from "../shortcutPreferences";
import { normalizeSearchText } from "../searchText";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command";

/*
 * The searchable list of actions that runs the one picked: the command
 * menu's (Cmd+K), and every view's shortcut help (`?`, ShortcutHelp). The
 * search ranks the actions, Up / Down (Ctrl-n / Ctrl-p, Ctrl-j / Ctrl-k)
 * move, Enter or a click (a tap) runs.
 */

export type ActionDefinition = {
  key: string;
  icon?: ReactNode;
  title: string;
  detail?: string;
  /** Its shortcut as one label (Cmd+K). */
  shortcut?: string;
  /** Its keys, alternatives apart by spaces ("j ↓"), each drawn as a key. */
  keys?: string;
  keywords?: string[];
  danger?: boolean;
  disabledReason?: string | null;
  /** Runs it; none: it is listed only (a key one holds, a count). */
  run?: () => void;
};

export type ActionGroupDefinition = {
  heading: string;
  actions: ActionDefinition[];
};

export { normalizeSearchText };

export function commandFilter(
  value: string,
  search: string,
  keywords?: string[],
) {
  const query = normalizeSearchText(search);
  if (!query) return 1;

  const haystack = normalizeSearchText(value);
  const keywordText = normalizeSearchText((keywords ?? []).join(" "));
  const combined = [haystack, keywordText].filter(Boolean).join(" ");

  if (haystack === query) return 1;
  if (haystack.includes(query)) return 0.95;
  if (keywordText.includes(query)) return 0.9;

  const tokens = query.split(" ").filter(Boolean);
  if (tokens.length === 0) return 1;
  if (tokens.every((token) => combined.includes(token))) return 0.75;
  if (tokens.some((token) => combined.includes(token))) return 0.35;

  return 0;
}

function actionSearchValue(action: ActionDefinition) {
  return [action.title, action.detail, action.shortcut, action.keys]
    .filter(Boolean)
    .join(" ");
}

function actionDisplaySignature(action: ActionDefinition) {
  return normalizeSearchText(
    [
      action.title,
      action.detail,
      action.shortcut,
      action.keys,
      action.danger ? "danger" : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function actionCommandValue(action: ActionDefinition) {
  return [action.title, action.detail, action.shortcut, action.key]
    .filter(Boolean)
    .join(" ");
}

/** How well an action matches the search: 0 hides it. */
export function rankAction(action: ActionDefinition, search: string) {
  return commandFilter(actionSearchValue(action), search, action.keywords);
}

type CommandNumberShortcutModifiers = Pick<
  KeyboardEvent,
  "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

type CommandNumberShortcutEvent = CommandNumberShortcutModifiers &
  Pick<KeyboardEvent, "preventDefault" | "repeat" | "stopPropagation">;

export function commandNumberShortcutIndex(
  event: CommandNumberShortcutModifiers,
) {
  const number = SHORTCUT_NUMBERS.find((n) =>
    shortcutMatches(event, `command.${n}`),
  );
  return number === undefined ? null : number - 1;
}

export function commandNumberedActions<T>(
  groups: readonly { actions: readonly T[] }[],
) {
  return groups.flatMap((group) => group.actions).slice(0, 9);
}

export function commandNumberShortcutTarget<T>(
  event: CommandNumberShortcutModifiers,
  actions: readonly T[],
) {
  const index = commandNumberShortcutIndex(event);
  return index === null ? null : (actions[index] ?? null);
}

export function runCommandNumberShortcut<T>(
  event: CommandNumberShortcutEvent,
  actions: readonly T[],
  runAction: (action: T) => void,
) {
  if (event.repeat) return false;
  const action = commandNumberShortcutTarget(event, actions);
  if (action === null) return false;
  event.preventDefault();
  event.stopPropagation();
  runAction(action);
  return true;
}

/**
 * The groups as shown for a search: with `topResults`, the best three
 * first in their own group; the others in theirs, each shown once.
 */
export function displayedActionGroups(
  groups: readonly ActionGroupDefinition[],
  search: string,
  rank: (action: ActionDefinition, search: string) => number = rankAction,
  topResults = true,
): ActionGroupDefinition[] {
  const normalizedSearch = normalizeSearchText(search);
  const rankedActions =
    normalizedSearch && topResults
      ? (() => {
          const seen = new Set<string>();
          return groups
            .flatMap((group) =>
              group.actions.map((action) => ({
                action,
                group: group.heading,
                score: rank(action, search),
              })),
            )
            .filter((entry) => entry.score > 0)
            .sort(
              (a, b) =>
                b.score - a.score ||
                a.group.localeCompare(b.group) ||
                a.action.title.localeCompare(b.action.title),
            )
            .filter((entry) => {
              const signature = actionDisplaySignature(entry.action);
              if (seen.has(signature)) return false;
              seen.add(signature);
              return true;
            })
            .slice(0, 3);
        })()
      : [];
  const topActionKeys = new Set(rankedActions.map((entry) => entry.action.key));
  const displayedSignatures = new Set(
    rankedActions.map((entry) => actionDisplaySignature(entry.action)),
  );
  return [
    ...(rankedActions.length > 0
      ? [
          {
            heading: rankedActions.length === 1 ? "Top result" : "Top results",
            actions: rankedActions.map((entry) => entry.action),
          },
        ]
      : []),
    ...groups
      .map((group) => ({
        ...group,
        actions: group.actions.filter((action) => {
          if (topActionKeys.has(action.key)) return false;
          if (!search.trim()) return true;
          if (rank(action, search) <= 0) return false;
          const signature = actionDisplaySignature(action);
          if (displayedSignatures.has(signature)) return false;
          displayedSignatures.add(signature);
          return true;
        }),
      }))
      .filter((group) => group.actions.length > 0),
  ];
}

/**
 * The search and the actions it finds; the one picked runs (`onRun`). It
 * lives while it is shown: the selection starts on the first action.
 */
export function ActionList({
  groups,
  search,
  onSearch,
  onRun,
  placeholder,
  emptyText = "No actions found.",
  label,
  numbered = false,
  rank = rankAction,
  topResults = true,
  inputRef,
  onKeyDown,
  className,
}: {
  groups: readonly ActionGroupDefinition[];
  search: string;
  onSearch: (search: string) => void;
  onRun: (action: ActionDefinition) => void;
  placeholder: string;
  emptyText?: string;
  label?: string;
  /** The first nine shown run with their number shortcuts (command.1-9). */
  numbered?: boolean;
  rank?: (action: ActionDefinition, search: string) => number;
  /** The best three first, in their own group. */
  topResults?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** Keys in the list, before its own (Up, Down, Enter). */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  className?: string;
}) {
  const [selectedActionValue, setSelectedActionValue] = useState("");
  const [selectedActionSearch, setSelectedActionSearch] = useState("");
  const normalizedSearch = normalizeSearchText(search);
  const shown = displayedActionGroups(groups, search, rank, topResults);
  const numberedActions = numbered ? commandNumberedActions(shown) : [];
  const numberShortcutIndexByKey = new Map(
    numberedActions.map((action, index) => [action.key, index]),
  );
  const firstDisplayedActionValue = shown[0]?.actions[0]
    ? actionCommandValue(shown[0].actions[0])
    : "";
  const displayedActionValues = new Set(
    shown.flatMap((group) =>
      group.actions.map((action) => actionCommandValue(action)),
    ),
  );
  const commandSelectedValue =
    selectedActionSearch === normalizedSearch &&
    selectedActionValue &&
    displayedActionValues.has(selectedActionValue)
      ? selectedActionValue
      : firstDisplayedActionValue;

  useEffect(() => {
    setSelectedActionValue(firstDisplayedActionValue);
    setSelectedActionSearch(normalizedSearch);
  }, [firstDisplayedActionValue, normalizedSearch]);

  const runnable = (action: ActionDefinition) =>
    !action.disabledReason && !!action.run;
  return (
    <Command
      loop
      shouldFilter={false}
      label={label}
      className={className}
      value={commandSelectedValue}
      onValueChange={(value) => {
        setSelectedActionValue(value);
        setSelectedActionSearch(normalizedSearch);
      }}
      onKeyDownCapture={(event) => {
        if (numbered)
          runCommandNumberShortcut(
            event,
            numberedActions,
            (action) => runnable(action) && onRun(action),
          );
      }}
      onKeyDown={onKeyDown}
    >
      <CommandInput
        ref={inputRef}
        value={search}
        onValueChange={onSearch}
        placeholder={placeholder}
      />
      <CommandList>
        <CommandEmpty>{emptyText}</CommandEmpty>
        {shown.map((group) => (
          <CommandGroup
            key={group.heading}
            heading={group.heading || undefined}
          >
            {group.actions.map((action) => (
              <ActionItem
                key={action.key}
                value={actionCommandValue(action)}
                action={action}
                numberShortcutIndex={numberShortcutIndexByKey.get(action.key)}
                onSelect={() => {
                  if (runnable(action)) onRun(action);
                }}
              />
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );
}

function ActionItem({
  value,
  action,
  numberShortcutIndex,
  onSelect,
}: {
  value: string;
  action: ActionDefinition;
  numberShortcutIndex?: number;
  onSelect: () => void;
}) {
  useShortcutPreferences();
  const { icon, title, detail, shortcut, keys, keywords, danger } = action;
  const disabledReason = action.disabledReason;
  const id =
    numberShortcutIndex === undefined
      ? null
      : (`command.${numberShortcutIndex + 1}` as `command.${ShortcutNumber}`);
  const numberShortcut = id ? shortcutLabel(id) : null;
  // Listed only: shown as the others, but it does not run.
  const inert = !action.run && !disabledReason;
  return (
    <CommandItem
      value={value}
      disabled={!!disabledReason || inert}
      title={disabledReason ?? undefined}
      keywords={keywords}
      onSelect={onSelect}
      className={
        [danger ? "is-danger" : "", inert ? "is-inert" : ""]
          .filter(Boolean)
          .join(" ") || undefined
      }
      aria-keyshortcuts={
        id
          ? getShortcutSnapshot()
              .preset.bindings[id].map((key) => key.replace("Ctrl", "Control"))
              .join(" ") || undefined
          : undefined
      }
    >
      <span className="command-item-icon">{icon}</span>
      <span className="command-item-text">
        <span className="command-item-title">{title}</span>
        {disabledReason || detail ? (
          <span className="command-item-detail">
            {disabledReason ?? detail}
          </span>
        ) : null}
      </span>
      {numberShortcut || shortcut ? (
        <CommandShortcut>{numberShortcut ?? shortcut}</CommandShortcut>
      ) : keys ? (
        <CommandShortcut className="command-keys">
          {keys.split(" ").map((key, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a row may hold a key twice (Esc Esc)
            <kbd key={index}>{key}</kbd>
          ))}
        </CommandShortcut>
      ) : null}
    </CommandItem>
  );
}
