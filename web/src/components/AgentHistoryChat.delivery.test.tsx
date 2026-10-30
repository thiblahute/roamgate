import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentHistoryChat } from "./AgentHistoryChat";

const base = {
  items: [],
  listRef: { current: null },
  contentRef: { current: null },
  onOpen: () => {},
};

test("a lost conversation shows an error with Recover after the chat", () => {
  const html = renderToStaticMarkup(
    <AgentHistoryChat
      {...base}
      delivery={{
        text: "Lost the conversation process",
        detail: "The pane holder's log could not be read",
        recovering: false,
        onRecover: () => {},
      }}
    />,
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain("agent-history-chat-lost");
  expect(html).toContain("<strong>Lost the conversation process</strong>");
  expect(html).toContain("The pane holder&#x27;s log could not be read");
  expect(html).toMatch(/<button[^>]*>Recover<\/button>/);
});

test("Recover is disabled while it runs, and nothing shows without a fault", () => {
  const html = renderToStaticMarkup(
    <AgentHistoryChat
      {...base}
      delivery={{
        text: "The queued message is not going out",
        detail: null,
        recovering: true,
        onRecover: () => {},
      }}
    />,
  );
  expect(html).toMatch(
    /<button[^>]*disabled=""[^>]*>Recovering\.\.\.<\/button>/,
  );
  expect(html).not.toContain("agent-history-chat-lost-detail");
  expect(renderToStaticMarkup(<AgentHistoryChat {...base} />)).not.toContain(
    "agent-history-chat-lost",
  );
});

test("a turn that seems stuck offers Interrupt and Restart Claude; Stop unanswered, Restart Claude only", () => {
  const silent = renderToStaticMarkup(
    <AgentHistoryChat
      {...base}
      delivery={{
        text: "Claude seems stuck since 23:18",
        detail: "Nothing came from it since then",
        recovering: false,
        onRecover: () => {},
        stuck: "silent",
        onInterrupt: () => {},
      }}
    />,
  );
  expect(silent).toContain("<strong>Claude seems stuck since 23:18</strong>");
  expect(silent).toMatch(/<button[^>]*>Interrupt<\/button>/);
  expect(silent).toMatch(/<button[^>]*>Restart Claude<\/button>/);
  expect(silent).not.toMatch(/>Recover</);
  const unanswered = renderToStaticMarkup(
    <AgentHistoryChat
      {...base}
      delivery={{
        text: "Claude did not answer Stop",
        detail: null,
        recovering: true,
        onRecover: () => {},
        stuck: "stop_unanswered",
        onInterrupt: () => {},
      }}
    />,
  );
  expect(unanswered).not.toMatch(/>Interrupt</);
  expect(unanswered).toMatch(
    /<button[^>]*disabled=""[^>]*>Restarting\.\.\.<\/button>/,
  );
});

test("an API key with no answer asks the terminal's question, with both answers", () => {
  const html = renderToStaticMarkup(
    <AgentHistoryChat
      {...base}
      apiKeyQuestion={{ queued: 2, answering: false, onAnswer: () => {} }}
    />,
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain(
    "<strong>This session&#x27;s environment has an Anthropic API key.</strong>",
  );
  expect(html).toContain(
    "Use it (billed to the API), or use your subscription login?",
  );
  expect(html).toContain("2 queued messages wait for it.");
  expect(html).toMatch(/<button[^>]*>Use the API key<\/button>/);
  expect(html).toMatch(/<button[^>]*>Use my subscription login<\/button>/);
  const answering = renderToStaticMarkup(
    <AgentHistoryChat
      {...base}
      apiKeyQuestion={{ queued: 0, answering: true, onAnswer: () => {} }}
    />,
  );
  expect(answering).not.toContain("queued message");
  expect(answering.match(/disabled=""/g)).toHaveLength(2);
});
