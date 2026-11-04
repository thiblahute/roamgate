import { expect, test } from "bun:test";
import {
  historyEntriesFromTrajectory,
  redactHistoryUpdate,
} from "./session-history";

test("a message sent to another agent session is kept on its call and result, payload redacted or not", () => {
  const command =
    'roamgate-review message desktop/w5:p1 -- "Is the build green?"';
  const entries = historyEntriesFromTrajectory(
    { path: "/tmp/h.jsonl", mtimeMs: 1000 },
    {
      schema_version: "ATIF-v1.7",
      agent: { name: "claude", version: "2" },
      steps: [
        {
          step_id: 1,
          source: "agent",
          message: "Asking",
          tool_calls: [
            {
              tool_call_id: "t1",
              function_name: "Bash",
              arguments: { command },
            },
            {
              tool_call_id: "t2",
              function_name: "Bash",
              arguments: {
                command: "roamgate-review message local/w1:p1 -- hi",
              },
            },
          ],
          observation: {
            results: [
              {
                source_call_id: "t1",
                content: JSON.stringify({
                  sent: true,
                  to: { name: "Merge checks" },
                }),
              },
              {
                source_call_id: "t2",
                content: '{"error": "too many messages"}',
                extra: { is_error: true },
              },
            ],
          },
        },
      ],
    },
  );
  const redacted = redactHistoryUpdate({
    mode: "snapshot",
    cursor: { epoch: "e", revision: 1 },
    entries,
  } as never) as { entries: typeof entries };
  const calls = redacted.entries.filter((entry) => entry.kind === "tool_call");
  expect(calls.map((entry) => [entry.text, entry.agent_message])).toEqual([
    ["", { to: "desktop/w5:p1", text: "Is the build green?" }],
    ["", { to: "local/w1:p1", text: "hi" }],
  ]);
  const results = redacted.entries.filter(
    (entry) => entry.kind === "tool_result",
  );
  expect(results.map((entry) => entry.agent_message_result)).toEqual([
    { sent: true, name: "Merge checks" },
    { sent: false, name: null },
  ]);
});
