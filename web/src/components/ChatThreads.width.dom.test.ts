import { expect, test } from "bun:test";
import { Window } from "happy-dom";

// A thread card is as wide as its column, never as wide as its longest
// line: on a phone (a 412px screen, 2026-11-21) a work item's threads ran
// 2470px past the right edge, the card's lines unwrapped, because a grid
// lays its items out no narrower than their content-based minimum and
// Chrome took the card's longest paragraph for it. Applied by a DOM to
// the thread markup the chat, the Files preview and the Work board share.
const sheets = await Promise.all(
  ["./ChatThreads.css", "./ReviewNoteBody.css"].map((path) =>
    Bun.file(new URL(path, import.meta.url)).text(),
  ),
);

function render(html: string) {
  const window = new Window({ width: 412, height: 915 });
  const { document } = window;
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

const card = `
  <div class="chat-review" style="display: grid">
    <div class="chat-thread" data-thread-id="t1">
      <div class="chat-thread-message from-agent" data-chat-stop="m:c1">
        <div class="chat-thread-message-head">
          <span class="chat-thread-author">Claude</span>
          <button type="button" class="chat-thread-message-reply">Reply</button>
        </div>
        <div class="chat-thread-body" data-message-id="c1">
          <div class="rc-text rich">
            <div class="rc-part" data-part="0">
              <p>Done, with one catch: there is no session open on the Spotify MCP repo
              (<code>/Users/thiblahute/devel/misc/spotify-mcp-rs</code> on the Mac), see
              <a href="https://example.test/a/very/long/path/that/never/breaks">the notes</a>.</p>
            </div>
            <pre class="note-code">const scopes = ["user-read-recently-played", "user-top-read"];</pre>
            <table class="rc-table"><tbody><tr><td class="rc-part">cell</td></tr></tbody></table>
            <img src="shot.png" alt="">
          </div>
        </div>
      </div>
      <div class="chat-thread-bar"><button type="button">Reply</button></div>
    </div>
  </div>`;

test("a thread card keeps no minimum width of its own and wraps anywhere", async () => {
  const page = render(card);
  try {
    const thread = page.style(".chat-thread");
    // A grid or flex item: its column's width, not its longest line's.
    expect(["0", "0px"]).toContain(thread.minWidth);
    expect(["", "auto"]).toContain(thread.width);
    expect(["", "none"]).toContain(thread.maxWidth);
    // A path, a URL or a long token in inline code breaks rather than
    // widening the card.
    expect(thread.overflowWrap).toBe("anywhere");
    expect(thread.whiteSpace).not.toMatch(/nowrap|^pre$/);
  } finally {
    await page.close();
  }
});

test("a thread's message, code, table and image fit the card", async () => {
  const page = render(card);
  try {
    // Rendered Markdown wraps at the card; a code block wraps its lines
    // too (each is a part one comments on, kept whole on screen).
    expect(page.style(".rc-text.rich").whiteSpace).toBe("normal");
    expect(page.style(".note-code").whiteSpace).toBe("pre-wrap");
    // A table scrolls inside its own box; an image scales to the card.
    const table = page.style(".rc-table");
    expect(table.overflowX).toBe("auto");
    expect(table.maxWidth).toBe("100%");
    expect(page.style(".rc-text.rich img").maxWidth).toContain("100%");
    // The author's row gives way before the card does.
    expect(["0", "0px"]).toContain(
      page.style(".chat-thread-message-head > .chat-thread-author").minWidth,
    );
  } finally {
    await page.close();
  }
});
