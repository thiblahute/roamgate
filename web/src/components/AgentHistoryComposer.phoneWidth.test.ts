import { expect, test } from "bun:test";

const nav = await Bun.file(
  new URL("../styles/layout/mobile-nav.css", import.meta.url),
).text();

const flat = (css: string) => css.replace(/\s+/g, " ");
const css = flat(nav);

const notWriting =
  ".agent-history-composer:not( :focus-within, :has(.agent-history-composer-send:not(:disabled)) )";

/** The width the container query gives the composer at `max-width: N`px. */
function threshold(withStop: boolean) {
  const queries = [
    ...css.matchAll(
      /@container phone-composer \(max-width: (\d+)px\) \{(.*?)\} \}/g,
    ),
  ];
  const found = queries.find(
    ([, , body]) =>
      body!.includes(".agent-history-composer-attach-menu") &&
      body!.includes(":has(.agent-history-composer-stop)") === withStop,
  );
  expect(found).toBeDefined();
  return Number(found![1]);
}

// CSS contract tests (no painted layout here): the room the box keeps for
// its words on 360 and 412px phones, from the sizes the rules give.
test("a phone's chat box keeps room for its words while the agent works", () => {
  expect(css).toContain(
    `.mobile-bottom-input > .agent-history-composer { container: phone-composer / inline-size; }`,
  );
  expect(css).toContain(
    `.mobile-bottom-input > ${notWriting}:has(.agent-history-composer-stop) .agent-history-composer-call { display: none; }`,
  );
  expect(css).toContain(
    "padding-right: calc((var(--composer-inline-buttons, 1) - 1) * 30px + 10px);",
  );
  const idleAttach = threshold(false);
  const workingAttach = threshold(true);

  const slots = 4; // Chat, the pane view, Tabs, More
  const control = 44;
  const gap = 6;
  const stop = 36;
  const inline = 30;
  const textPadding = 14 + 10;
  for (const screen of [360, 412]) {
    // The bar's 8px sides, the navigation's slots and 4px.
    const composer = screen - 16 - (slots * control + 4);
    for (const working of [false, true]) {
      const attach =
        composer > (working ? workingAttach : idleAttach) ? control + gap : 0;
      // The microphone, and the call unless Stop shows.
      const buttons = working ? 1 : 2;
      const field = composer - attach - (working ? stop + gap : 0);
      const words = field - textPadding - buttons * inline;
      expect(words).toBeGreaterThanOrEqual(60);
    }
  }
});
