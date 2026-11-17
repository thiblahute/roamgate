import type { InspectorCommand } from "./inspectorCommands";
import { store } from "./store";
import { setVimKeys, vimKeys } from "./vimKeys";

/*
 * The inspector's own settings at its `:` prompt: `:vim`, `:novim`,
 * `:set vim|novim` (the one Vim keys setting) and `:help`, the shortcut list.
 */

/** What `:vim` (a toggle), `:novim` and `:set vim|novim` set Vim keys to. */
const VIM_WORDS = new Map<string, boolean | null>([
  ["vim", null],
  ["novim", false],
  ["set vim", true],
  ["set novim", false],
]);

/**
 * `:vim`, `:novim`, `:set ...`: the one Vim keys setting, said as set.
 * False when the words are not a setting.
 */
export function runReviewSetting(words: string): boolean {
  const setting = VIM_WORDS.get(
    words.trim().replace(/^:/, "").split(/\s+/).join(" "),
  );
  if (setting === undefined) return false;
  const on = setting ?? !vimKeys();
  setVimKeys(on);
  store.notify({
    kind: "info",
    message: on ? "Vim keys on" : "Vim keys off",
    autoDismissMs: 1800,
  });
  return true;
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
