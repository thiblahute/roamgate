import { highlightRuns } from "../fuzzyMatch";
import "./SearchHighlight.css";

/** Text with the characters a search matched marked, as fzf shows them. */
export function SearchHighlight({
  text,
  positions,
}: {
  text: string;
  positions: readonly number[] | undefined;
}) {
  if (!positions?.length) return <>{text}</>;
  return (
    <>
      {highlightRuns(text, positions).map((run, index) =>
        run.matched ? (
          <mark key={index} className="search-match">
            {run.text}
          </mark>
        ) : (
          run.text
        ),
      )}
    </>
  );
}
