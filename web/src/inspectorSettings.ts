import type { InspectorCommand } from "./inspectorCommands";
import { parseReviewCommand } from "./reviewNavigation";
import { store } from "./store";
import { setVimKeys, vimKeys } from "./vimKeys";

/*
 * The inspector's own settings at its `:` prompt: `:vim`, `:novim`,
 * `:set vim|novim` (the one Vim keys setting) and `:help`, the shortcut list.
 */

/**
 * `:vim`, `:novim`, `:set ...`: the one Vim keys setting, said as set.
 * False when the words are not a setting.
 */
export function runReviewSetting(words: string): boolean {
  const command = parseReviewCommand(words);
  if (command.type === "vim") {
    const on = command.on ?? !vimKeys();
    setVimKeys(on);
    store.notify({
      kind: "info",
      message: on ? "Vim keys on" : "Vim keys off",
      autoDismissMs: 1800,
    });
    return true;
  }
  return false;
}

/** The settings commands; `:help WORD` opens the list filtered. */
export function inspectorSettingCommands(
  openShortcuts: (filter: string) => void,
): InspectorCommand[] {
  return [
    {
      name: "vim",
      description: "Vim keys in the review, comments and previews on / off",
      run: () => runReviewSetting("vim"),
    },
    {
      name: "novim",
      description: "Vim keys off",
      listed: false,
      run: () => runReviewSetting("novim"),
    },
    {
      name: "set",
      description: "set vim, novim",
      complete: () => [
        ["vim", "Vim keys on"],
        ["novim", "Vim keys off"],
      ],
      run: (argument, how) => {
        if (!runReviewSetting(`set ${argument}`)) how.unknown();
      },
    },
    {
      name: "help",
      description: "the shortcuts and commands here (:help WORD, filtered)",
      run: (argument) => openShortcuts(argument),
    },
  ];
}
