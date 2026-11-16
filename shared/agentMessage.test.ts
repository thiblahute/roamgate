import { expect, test } from "bun:test";
import {
  AGENT_MESSAGE_TOOL,
  frameAgentMessage,
  outgoingAgentMessage,
  parseAgentAddress,
} from "./agentMessage";
import { parseInjectedMessage } from "./injectedMessage";

const bash = (command: string) => JSON.stringify({ command });

test("addresses are CONNECTION/PANE", () => {
  expect(parseAgentAddress("desktop/w17:p1")).toEqual({
    connectionId: "desktop",
    paneId: "w17:p1",
  });
  expect(parseAgentAddress("w17:p1")).toBeNull();
  expect(parseAgentAddress("a/b c")).toBeNull();
  expect(parseAgentAddress("/w1:p1")).toBeNull();
});

test("the sender's message is read back from its Bash call, however quoted", () => {
  expect(
    outgoingAgentMessage(
      "Bash",
      bash(
        `~/.cache/roamgate/bin/roamgate-review --agent Claude message local/w2:p2 -- "It's \\"done\\""`,
      ),
    ),
  ).toEqual({ to: "local/w2:p2", text: 'It\'s "done"' });
  expect(
    outgoingAgentMessage(
      "Bash",
      bash("roamgate-review message local/w2:p2 -- 'one' two"),
    ),
  ).toEqual({ to: "local/w2:p2", text: "one two" });
  expect(
    outgoingAgentMessage(
      "Bash",
      bash(
        "cd /src && roamgate-review message local/w2:p2 - <<'EOF'\nfirst\nsecond\nEOF",
      ),
    ),
  ).toEqual({ to: "local/w2:p2", text: "first\nsecond" });
  expect(
    outgoingAgentMessage("Bash", bash("roamgate-review sessions")),
  ).toBeNull();
  expect(
    outgoingAgentMessage("Read", bash("roamgate-review message a/b -- x")),
  ).toBeNull();
  expect(
    outgoingAgentMessage("Bash", bash("roamgate-review message nope -- x")),
  ).toBeNull();
});

test("a framed message reads as another session's in the chat, never the user's", () => {
  const framed = frameAgentMessage(
    {
      address: "local/w1:p1",
      name: 'A "quoted" <title>',
      workspace: "roamgate",
      agent: "claude",
    },
    "Hello\n\nworld",
  );
  expect(framed).toContain('from-name="A &quot;quoted&quot; &lt;title&gt;"');
  expect(parseInjectedMessage(framed)).toEqual({
    notices: [
      {
        kind: "session",
        label: 'From A "quoted" <title>',
        body: "Hello\n\nworld",
      },
    ],
    rest: "",
  });
  // Words of the user's after it stay theirs.
  expect(parseInjectedMessage(`${framed}\n\nand mine`)?.rest).toBe("and mine");
});

test("the sender's message is read back from its Roamgate tool call", () => {
  const text = 'Run `make` with "$X" set';
  expect(
    outgoingAgentMessage(
      AGENT_MESSAGE_TOOL,
      JSON.stringify({ to: "desktop/w17:p1", text }),
    ),
  ).toEqual({ to: "desktop/w17:p1", text });
  expect(
    outgoingAgentMessage(AGENT_MESSAGE_TOOL, JSON.stringify({ to: "nope" })),
  ).toBeNull();
  expect(outgoingAgentMessage(AGENT_MESSAGE_TOOL, "{")).toBeNull();
  // Another server's tool of the same short name is not Roamgate's.
  expect(
    outgoingAgentMessage(
      "mcp__other__agent_message",
      JSON.stringify({ to: "desktop/w17:p1", text }),
    ),
  ).toBeNull();
});
