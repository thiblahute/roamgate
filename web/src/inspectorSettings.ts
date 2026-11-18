import type { InspectorCommand } from "./inspectorCommands";
import { store } from "./store";
import { setVimKeys, vimKeys } from "./vimKeys";
import { setWideDiffs } from "./wideDiffs";

/*
 * The inspector's own settings at its `:` prompt: `:vim`, `:novim`,
 * `:set vim|novim` (the one Vim keys setting), `:set wide|nowide` (full
 * width diffs) and `:help`, the shortcut list.
 */

/** What `:set wide` and `:set nowide` set full width diffs to. */
const WIDE_WORDS = new Map<string, boolean>([
  ["set wide", true],
  ["set nowide", false],
]);

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
  const said = words.trim().replace(/^:/, "").split(/\s+/).join(" ");
  const wide = WIDE_WORDS.get(said);
  if (wide !== undefined) {
    setWideDiffs(wide);
    store.notify({
      kind: "info",
      message: wide ? "Full width diffs" : "Diffs centred",
      autoDismissMs: 1800,
    });
    return true;
  }
  const setting = VIM_WORDS.get(said);
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
      description: "set vim, novim, wide, nowide",
      complete: () => [
        ["vim", "Vim keys on"],
        ["novim", "Vim keys off"],
        ["wide", "diffs take the whole width"],
        ["nowide", "diffs in a centred column"],
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
