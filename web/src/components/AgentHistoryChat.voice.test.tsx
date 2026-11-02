import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { voiceMessage } from "../../../shared/voiceMessage";
import type { HistoryEntry } from "./agentHistory";
import { AgentHistoryChat } from "./AgentHistoryChat";
import { groupHistoryChatItems } from "./agentHistoryView";

const user = (id: string, text: string): HistoryEntry => ({
  id,
  role: "user",
  kind: "message",
  text,
  sent_at: "2026-01-01T00:00:00Z",
});

function chat(entries: HistoryEntry[]) {
  return renderToStaticMarkup(
    <AgentHistoryChat
      items={groupHistoryChatItems(entries)}
      listRef={{ current: null }}
      contentRef={{ current: null }}
      onOpen={() => {}}
    />,
  );
}

test("words the companion forwards show as said by voice", () => {
  const html = chat([user("u1", voiceMessage("check out his last messages"))]);
  expect(html).toContain('title="Said by voice"');
  expect(html).toContain("check out his last messages");
  expect(html).not.toContain("[Voice]");
});

test("words said over a reading show where they cut it", () => {
  const html = chat([
    user("u1", voiceMessage("No, the other one.", "The tests pass.")),
  ]);
  expect(html).toContain(
    'title="Said by voice, interrupting the reading at: The tests pass."',
  );
  expect(html).toContain("No, the other one.");
});

test("words typed carry no voice label", () => {
  const html = chat([user("u1", "Lance les tests du serveur.")]);
  expect(html).not.toContain("Said by voice");
  expect(html).toContain("Lance les tests du serveur.");
});
