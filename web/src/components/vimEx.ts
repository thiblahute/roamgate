import { Vim } from "@replit/codemirror-vim";

/**
 * What an editor does on `:w` (and `:wq`, `:x`), on `:q`, on `:sugg`
 * (a review comment's GitLab suggestion), and on `:suspend` / `:stop`
 * (an agent conversation stopped as a shell job, as Vim's own).
 */
export type VimExHandlers = {
  commit: (explicit: boolean) => void;
  cancel: () => void;
  suggest?: () => void;
  suspend?: () => void;
};

/** An editor with its own command line runs each ex line itself. */
export type VimExRunner = (input: string) => void;

/**
 * Vim's ex commands are global: each editor registers its handlers (or its
 * runner) here, keyed by its CodeMirror Vim instance, and every definition
 * dispatches through this one registry, so a command defined for one editor
 * never takes it from another.
 */
export const vimExEditors = new WeakMap<object, VimExHandlers | VimExRunner>();

const ACTIONS: Record<string, (editor: VimExHandlers) => void> = {
  write: (editor) => editor.commit(true),
  wq: (editor) => editor.commit(true),
  xit: (editor) => editor.commit(true),
  quit: (editor) => editor.cancel(),
  q: (editor) => editor.cancel(),
  suggest: (editor) => editor.suggest?.(),
  suspend: (editor) => editor.suspend?.(),
  stop: (editor) => editor.suspend?.(),
};
const defined = new Set<string>();

function define(name: string, prefix: string) {
  const key = `${name} ${prefix}`;
  if (defined.has(key)) return;
  defined.add(key);
  Vim.defineEx(name, prefix, (cm, params) => {
    const editor = vimExEditors.get(cm);
    if (typeof editor === "function") editor(params.input);
    else if (editor) ACTIONS[name]?.(editor);
  });
}

/**
 * Defines `:w`, `:q`, `:sugg` and `:suspend` (`:sus`, `:stop`), and
 * `words` for the editors' runners.
 */
export function defineExCommands(words: Iterable<string> = []) {
  define("write", "w");
  define("wq", "wq");
  define("xit", "x");
  define("quit", "q");
  define("suggest", "sugg");
  define("suspend", "sus");
  define("stop", "stop");
  for (const word of words) define(word, word);
}
