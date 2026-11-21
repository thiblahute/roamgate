/**
 * The phone's workspace search field. Every input event updates the query,
 * including those an Android keyboard sends while it composes a word, so the
 * list follows the letters as they appear instead of waiting for the word.
 */
export function WorkspaceSearchField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      type="search"
      data-dictation="off"
      aria-label="Search workspaces"
      placeholder="Search workspaces"
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      enterKeyHint="search"
      data-1p-ignore
      data-bwignore
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}
