import { expect, test } from "bun:test";
import { Window } from "happy-dom";

// The phone layout rules, applied by a DOM to the drawer's and the bottom
// bar's markup: a phone shows no tick ruler over a chat, and the message box
// keeps its text clear of the microphone however narrow Stop leaves it.
const sheets = await Promise.all(
  [
    "./ConversationMinimap.css",
    "./AgentHistoryDrawer.css",
    "./AgentHistoryComposer.css",
    "../styles/layout/mobile-nav.css",
  ].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
);

function render(layout: "mobile" | "desktop", html: string) {
  const window = new Window({ width: 390, height: 844 });
  const { document } = window;
  // Before the first style is computed: computed styles are cached.
  document.documentElement.setAttribute("data-layout", layout);
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

const drawer = (paneChat: boolean, orientation: string) => `
  <aside class="agent-history-drawer is-open is-embedded${paneChat ? " is-pane-chat" : ""}">
    <div class="agent-history-drawer-head">
      <span class="agent-chat-title">A long session title</span>
      <span class="agent-chat-owner is-conversation has-refusal">Still in conversation mode<span class="agent-chat-owner-reason">The pane holder is not connected</span></span>
    </div>
    <div class="agent-history-messages">
      <div class="agent-history-chat-frame">
        <div class="agent-history-chat"></div>
        <div class="conversation-minimap${orientation}"></div>
      </div>
    </div>
  </aside>`;

for (const paneChat of [false, true])
  for (const orientation of ["", " is-horizontal"])
    test(`no minimap in a ${paneChat ? "pane's chat" : "History drawer"} on a phone (${orientation ? "strip" : "rail"})`, async () => {
      const phone = render("mobile", drawer(paneChat, orientation));
      const desktop = render("desktop", drawer(paneChat, orientation));
      try {
        expect(phone.style(".conversation-minimap").display).toBe("none");
        expect(desktop.style(".conversation-minimap").display).not.toBe("none");
        // Without its rail, the chat takes the whole width.
        if (!orientation)
          expect(phone.style(".agent-history-chat").paddingRight).toBe("0px");
      } finally {
        await phone.close();
        await desktop.close();
      }
    });

// The bottom bar's rules nest under the phone layout, which the DOM used
// here does not apply: this one is read from the stylesheet.
test("the phone's message box is never wider than its field", () => {
  const nav = sheets[3]!;
  // The box's own rule: its padding is the one beside the microphone.
  const rule = [
    ...nav.matchAll(
      /\.agent-history-composer-editor\s+\.cm-content \{[^}]*\}/g,
    ),
  ]
    .map((match) => match[0])
    .find((each) => each.includes("padding: 11px 14px;"));
  expect(rule).toBeDefined();
  // At its min-content width, the placeholder's one line, it ran under the
  // microphone once Stop narrowed the box.
  expect(rule).toContain("min-width: 0;");
  const placeholder = nav.slice(
    nav.indexOf(".agent-history-composer .cm-placeholder {"),
  );
  expect(placeholder.slice(0, placeholder.indexOf("}"))).toContain(
    "text-overflow: ellipsis;",
  );
});

test("a phone's chat header keeps the mode in view", async () => {
  const phone = render("mobile", drawer(true, ""));
  const desktop = render("desktop", drawer(true, ""));
  try {
    // The title gives way first.
    expect(phone.style(".agent-chat-title").flexShrink).toBe("4");
    expect(phone.style(".agent-chat-title").minWidth).not.toBe("0px");
    expect(phone.style(".agent-chat-owner").maxWidth).toBe("60%");
    expect(desktop.style(".agent-chat-owner").maxWidth).not.toBe("60%");
    // A refusal's reason is read, not hovered: shown, and wrapped rather
    // than cut.
    for (const layout of [phone, desktop]) {
      expect(layout.style(".agent-chat-owner-reason").display).not.toBe("none");
      expect(layout.style(".agent-chat-owner").whiteSpace).toBe("normal");
    }
  } finally {
    await phone.close();
    await desktop.close();
  }
});
