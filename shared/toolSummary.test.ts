import { expect, test } from "bun:test";
import {
  createToolSummaryNotes,
  toolCallSummary,
  toolDisplayName,
} from "./toolSummary";

const summary = (
  name: string,
  args: Record<string, unknown>,
  context = {},
): string => toolCallSummary(name, JSON.stringify(args), context);

test("the description comes first, then the main argument's first line", () => {
  expect(summary("Bash", { command: "ls", description: "List" })).toBe("List");
  expect(summary("Bash", { command: "\n ls -la\npwd" })).toBe("ls -la");
  expect(summary("bash", { pattern: "foo", path: "/a" })).toBe("/a");
  expect(toolCallSummary("bash", "plain\ntext")).toBe("plain");
});

test("a summary is clipped", () => {
  const clipped = summary("x", { query: "q".repeat(300) });
  expect(clipped).toHaveLength(160);
  expect(clipped.endsWith("…")).toBe(true);
});

test("MCP tools read as their server and tool", () => {
  expect(toolDisplayName("mcp__claude_ai_Spotify__search")).toBe(
    "Spotify: search",
  );
  expect(toolDisplayName("mcp__roamgate__review_reply")).toBe(
    "Roamgate: review reply",
  );
  expect(toolDisplayName("mcp__claude-in-chrome__tabs_context_mcp")).toBe(
    "Claude in chrome: tabs context",
  );
  expect(toolDisplayName("Bash")).toBe("Bash");
  expect(summary("mcp__claude_ai_Spotify__search", { query: "Bach" })).toBe(
    "Spotify: search · Bach",
  );
  expect(summary("mcp__claude_ai_Spotify__pause", {})).toBe("Spotify: pause");
});

test("SendMessage says its summary and who it went to, never an agent id", () => {
  const notes = createToolSummaryNotes();
  notes.noteCall(
    "Agent",
    { name: "cutover", description: "Write the cutover script", prompt: "…" },
    "Async agent launched successfully.\nagentId: a0ed74d49757d9571 (internal ID)",
  );
  notes.noteCall(
    "Agent",
    { description: "Find terminal preferences", prompt: "…" },
    "agentId: add9e792d287e14a0 (internal ID)",
  );
  const send = (args: Record<string, unknown>) =>
    summary("SendMessage", args, notes.context());
  expect(
    send({
      to: "a0ed74d49757d9571",
      summary: "Holder question answered",
      message: "Long text",
    }),
  ).toBe("To the cutover agent: Holder question answered");
  expect(
    send({ to: "add9e792d287e14a0", message: "Please also\ncheck the CSS" }),
  ).toBe('To the "Find terminal preferences" agent: Please also');
  expect(send({ to: "a1111111111111111", summary: "Hi" })).toBe(
    "To an agent: Hi",
  );
  expect(send({ to: "tasks-view", summary: "Keys" })).toBe(
    "To the tasks-view agent: Keys",
  );
  expect(send({ to: "uds:/tmp/cc-socks/1.sock", summary: "Ask" })).toBe(
    "To another session: Ask",
  );
});

test("review_reply says the thread it answered, from its quote", () => {
  const result = JSON.stringify({
    id: "3bad5213aaaa0000",
    kind: "discussion",
    path: null,
    line: null,
    on_chat_message: { quote: "Which holder runs the session?\nmore" },
    comments: [{ id: "c1", author: "user", text: "Why?" }],
  });
  expect(
    summary(
      "mcp__roamgate__review_reply",
      { comment_id: "3bad5213", text: "Done" },
      { result },
    ),
  ).toBe('Replied on "Which holder runs the session?"');
  // Without the result: what Roamgate said of the thread, else the reply.
  const notes = createToolSummaryNotes();
  notes.noteMessage(
    [
      "A comment from me on parts of your messages in this chat:",
      "",
      '- [3bad5213] on your message that starts "I", about this part:',
      "  > the holder keeps it",
      "  Is that so?",
      "- [77aa0011] on web/src/a.ts line 3:",
      "  Rename this",
      "",
      "These are threads on our conversation.",
    ].join("\n"),
  );
  expect(
    summary(
      "mcp__roamgate__review_reply",
      { comment_id: "3bad5213", text: "Yes" },
      notes.context(),
    ),
  ).toBe('Replied on "the holder keeps it"');
  expect(
    summary(
      "mcp__roamgate__review_resolve",
      { comment_id: "77aa0011" },
      notes.context(),
    ),
  ).toBe('Resolved "Rename this"');
  expect(
    summary("mcp__roamgate__review_reply", {
      comment_id: "deadbeef",
      text: "Both done on the desktop\nmore",
    }),
  ).toBe("Replied: Both done on the desktop");
});

test("the other Roamgate tools say what they did", () => {
  const notes = createToolSummaryNotes();
  notes.noteCall(
    "mcp__roamgate__agent_sessions",
    {},
    JSON.stringify({
      sessions: [{ address: "desktop/w20:p1", name: "gst2-doc-slides" }],
    }),
  );
  const roamgate = (tool: string, args: Record<string, unknown>) =>
    summary(`mcp__roamgate__${tool}`, args, notes.context());
  expect(
    roamgate("review_add", {
      file: "web/src/components/Chat.tsx",
      line: 12,
      text: "Rename this",
    }),
  ).toBe("Commented on components/Chat.tsx:12: Rename this");
  expect(roamgate("review_add", { kind: "draft", text: "Fix it" })).toBe(
    "Drafted a review comment: Fix it",
  );
  expect(roamgate("review_resolve", { comment_id: "0000ffff" })).toBe(
    "Resolved a thread",
  );
  expect(
    roamgate("review_working", { comment_id: "1", message: "Fixing the CSS" }),
  ).toBe("Working: Fixing the CSS");
  expect(
    roamgate("review_working", { done: true, message: "Fixed the CSS" }),
  ).toBe("Done: Fixed the CSS");
  expect(
    roamgate("review_notify", { title: "Approve the login", text: "Open it" }),
  ).toBe("Notified you: Approve the login");
  expect(
    roamgate("agent_message", { to: "desktop/w20:p1", text: "Handover\nx" }),
  ).toBe("Messaged gst2-doc-slides: Handover");
  expect(roamgate("agent_message", { to: "mac/w1:p2", text: "Hi" })).toBe(
    "Messaged another session: Hi",
  );
  expect(roamgate("agent_sessions", {})).toBe("Listed sessions");
});

test("a session's name comes from a message it sent", () => {
  const notes = createToolSummaryNotes();
  notes.noteMessage(
    'Another agent session sent you a message through Roamgate:\n<roamgate-agent-message from="mac/w2:p3" from-name="Voice &amp; calls" workspace="v" agent="claude">\nHi\n</roamgate-agent-message>',
  );
  expect(
    summary(
      "mcp__roamgate__agent_message",
      { to: "mac/w2:p3", text: "Hello" },
      notes.context(),
    ),
  ).toBe("Messaged Voice & calls: Hello");
});

test("built-in tools say what they did in plain words", () => {
  expect(
    summary("Agent", { description: "Find the CSS", prompt: "Long brief" }),
  ).toBe("Find the CSS");
  expect(
    summary("Bash", { command: "bun test", description: "Run the tests" }),
  ).toBe("Run the tests");
  expect(
    summary("Read", { file_path: "/Users/me/roamgate/web/src/App.tsx" }),
  ).toBe("Read src/App.tsx");
  expect(
    summary("Edit", {
      file_path: "/a/b/shared/toolSummary.ts",
      old_string: "x",
      new_string: "y",
    }),
  ).toBe("Edit shared/toolSummary.ts");
  expect(summary("Write", { file_path: "notes.md", content: "x" })).toBe(
    "Write notes.md",
  );
  expect(summary("Grep", { pattern: "toolSummary", path: "/a/b/web" })).toBe(
    "Search for toolSummary in b/web",
  );
  expect(summary("WebSearch", { query: "bun test fake timers" })).toBe(
    "Search the web: bun test fake timers",
  );
  expect(
    summary("WebFetch", { url: "https://www.example.com/a?b", prompt: "x" }),
  ).toBe("Fetch example.com");
  expect(
    summary("ToolSearch", {
      query: "select:SendMessage,mcp__claude_ai_Spotify__search",
    }),
  ).toBe("Loaded tools: SendMessage, Spotify: search");
  expect(summary("ToolSearch", { query: "notebook jupyter" })).toBe(
    'Looked for tools: "notebook jupyter"',
  );
  expect(
    summary("TodoWrite", {
      todos: [
        { content: "A", status: "completed", activeForm: "Doing A" },
        { content: "B", status: "in_progress", activeForm: "Doing B" },
      ],
    }),
  ).toBe("Doing B");
});
