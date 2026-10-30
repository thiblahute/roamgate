import { expect, test } from "bun:test";
import { Window } from "happy-dom";

// The inspector's tabs, applied by a DOM to its markup with its stylesheet:
// whichever tab is selected, only that tab's resource is shown, the file tree
// hidden, the split resizer or the compact layout notwithstanding.
const sheet = await Bun.file(
  new URL("./WorkspaceInspectorHost.css", import.meta.url),
).text();

type View = "files" | "changes" | "commits" | "history";
const VIEWS: readonly View[] = ["files", "changes", "commits", "history"];

interface Layout {
  compact: boolean;
  split: boolean;
  treeHidden: boolean;
}

/** The resources as WorkspaceInspectorHost writes their classes. */
function markup(view: View, { compact, split, treeHidden }: Layout): string {
  const hidden = (own: View) => (view === own ? "" : "is-hidden");
  const resizer = split ? "has-split-resizer" : "";
  return `
    <aside class="workspace-inspector${compact ? " is-compact" : ""}">
      <div class="workspace-inspector-body">
        <div data-view="files" class="workspace-inspector-resource inspector-files-resource ${hidden("files")} ${resizer} ${treeHidden ? "files-tree-hidden" : ""}">
          <div class="workspace-inspector-navigation">tree</div>
          <div class="workspace-inspector-detail workspace-inspector-file-detail">
            <div class="file-preview-tabs">ARCHITECTURE.md</div>
          </div>
        </div>
        <div data-view="changes" class="workspace-inspector-resource ${hidden("changes")} ${resizer}">
          <div class="workspace-inspector-navigation">changes</div>
          <div class="workspace-inspector-detail">diff</div>
        </div>
        <div data-view="commits" class="workspace-inspector-resource inspector-commits-resource ${hidden("commits")}">commits</div>
        <div data-view="history" class="workspace-inspector-resource inspector-history-resource ${hidden("history")}">history</div>
      </div>
    </aside>`;
}

function shownViews(view: View, layout: Layout): View[] {
  const window = new Window({ width: 1280, height: 800 });
  try {
    const { document } = window;
    const style = document.createElement("style");
    style.textContent = sheet;
    document.head.append(style);
    document.body.innerHTML = markup(view, layout);
    return VIEWS.filter(
      (each) =>
        window.getComputedStyle(
          document.querySelector(`[data-view="${each}"]`)!,
        ).display !== "none",
    );
  } finally {
    void window.happyDOM.close();
  }
}

const layouts: Layout[] = [];
for (const compact of [false, true])
  for (const split of [false, true])
    for (const treeHidden of [false, true])
      layouts.push({ compact, split, treeHidden });

test.each(layouts)(
  "switching tabs shows only that tab's resource (%o)",
  (layout) => {
    for (const view of VIEWS) expect(shownViews(view, layout)).toEqual([view]);
  },
);

test("the file alone, its tree hidden, still shows its preview", () => {
  const window = new Window({ width: 1280, height: 800 });
  try {
    const { document } = window;
    const style = document.createElement("style");
    style.textContent = sheet;
    document.head.append(style);
    document.body.innerHTML = markup("files", {
      compact: false,
      split: true,
      treeHidden: true,
    });
    const display = (selector: string) =>
      window.getComputedStyle(document.querySelector(selector)!).display;
    expect(display('[data-view="files"]')).toBe("flex");
    expect(display('[data-view="files"] .workspace-inspector-navigation')).toBe(
      "none",
    );
    expect(display('[data-view="files"] .workspace-inspector-detail')).toBe(
      "flex",
    );
  } finally {
    void window.happyDOM.close();
  }
});
