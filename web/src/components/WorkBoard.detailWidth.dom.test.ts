import { expect, test } from "bun:test";
import { Window } from "happy-dom";

// An item's detail on a phone: its header rows, description and threads
// fit the screen's width. The detail's grids give their one column no
// content-based minimum (an implicit `auto` column took the thread card's
// longest paragraph, 2470px on a 412px phone, 2026-11-21), and the thread
// card itself keeps none. Applied by a DOM to the detail's markup.
const sheets = await Promise.all(
  [
    "./AssistantTasks.css",
    "./MrReviewsPanel.css",
    "./ChatThreads.css",
    "./WorkBoard.css",
  ].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
);

function render(html: string) {
  const window = new Window({ width: 360, height: 800 });
  const { document } = window;
  document.documentElement.setAttribute("data-layout", "mobile");
  for (const css of sheets) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
  }
  document.body.innerHTML = html;
  return {
    style: (selector: string) =>
      window.getComputedStyle(document.querySelector(selector)!),
    close: () => window.happyDOM.close(),
  };
}

const detail = `
  <aside class="assistant-panel mr-reviews-panel is-mobile is-work">
    <div class="assistant-tasks mr-reviews-body is-work">
      <div class="work-detail-keys" data-work-keys="" tabindex="-1">
        <section class="assistant-task-overview mr-reviews-detail work-detail" data-work-detail="i1">
          <div class="assistant-task-heading"><h3>The comments should fit in the width of the screen</h3></div>
          <div class="work-description" aria-label="Description">
            <div class="chat-review" data-message-id="d1"><div class="rc-text rich"><p>A description with <img src="shot.png" alt=""></p></div></div>
          </div>
          <dl class="assistant-task-metadata">
            <div><dt>State</dt><dd><select><option>Doing</option></select></dd></div>
            <div><dt>Tags</dt><dd><input placeholder="tags, space separated"></dd></div>
            <div><dt>Owner</dt><dd class="mr-reviews-own"><span class="mr-reviews-chip is-wait work-owner">desktop/w35:p1</span><button type="button" class="ghost">Open the session</button></dd></div>
            <div><dt>Links</dt><dd class="mr-reviews-own"><button type="button" class="mr-reviews-chip work-link is-review">review d22a2f86 thread beb2d667</button></dd></div>
          </dl>
        </section>
        <section class="work-detail-threads" aria-label="Comments">
          <div class="work-threads chat-review" data-work-threads="i1">
            <div class="chat-thread" data-thread-id="t1">
              <div class="chat-thread-message from-agent" data-chat-stop="m:c1">
                <div class="chat-thread-body" data-message-id="c1">
                  <div class="rc-text rich"><div class="rc-part" data-part="0"><p>Done, with one catch: there is no session open on the Spotify MCP repo.</p></div><img src="shot.png" alt=""></div>
                </div>
              </div>
            </div>
            <div class="work-threads-bar"><button type="button" class="primary">Comment (c)</button></div>
          </div>
        </section>
      </div>
    </div>
  </aside>`;

test("the detail's columns are the screen's width, not their content's", async () => {
  const page = render(detail);
  try {
    // One column with no minimum: an implicit `auto` column grows to the
    // widest item, and a thread card's longest line is wider than a phone.
    for (const grid of [
      ".work-detail-keys",
      ".work-detail-threads",
      ".work-threads",
    ]) {
      const style = page.style(grid);
      expect(style.display).toBe("grid");
      expect(style.gridTemplateColumns).toBe("minmax(0, 1fr)");
      expect(["0", "0px"]).toContain(style.minWidth);
    }
    // The thread card, drawn as the chat's, keeps no minimum of its own.
    const card = page.style(".work-threads > .chat-thread");
    expect(["0", "0px"]).toContain(card.minWidth);
    expect(["", "auto"]).toContain(card.width);
    expect(card.overflowWrap).toBe("anywhere");
  } finally {
    await page.close();
  }
});

test("the detail's header rows and description fit a 360px phone", async () => {
  const page = render(detail);
  try {
    // State / Tags / Owner / Links: a label column, then the value in the
    // rest, which never grows past it.
    const row = page.style(".work-detail .assistant-task-metadata > div");
    expect(row.display).toBe("grid");
    expect(row.gridTemplateColumns).toBe("110px minmax(0, 1fr)");
    const value = page.style(".work-detail .assistant-task-metadata dd");
    expect(["0", "0px"]).toContain(value.minWidth);
    expect(value.overflowWrap).toBe("anywhere");
    // Chips wrap onto more lines; a link chip is cut short, never wider
    // than its row; a field is the row's width.
    expect(page.style(".mr-reviews-own").flexWrap).toBe("wrap");
    expect(page.style(".work-link").maxWidth).toBe("100%");
    expect(
      page.style(".work-detail .assistant-task-metadata input").maxWidth,
    ).toBe("100%");
    // The description wraps anywhere and scales its images; so do the
    // threads' images.
    expect(page.style(".work-description").overflowWrap).toBe("anywhere");
    expect(page.style(".work-description img").maxWidth).toBe("100%");
    expect(page.style(".work-detail-threads img").maxWidth).toBe("100%");
  } finally {
    await page.close();
  }
});
