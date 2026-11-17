/** Dates and comments for the two independent file-thread DOM fixtures. */
export const threadTime = (second: number) =>
  `2026-11-10T10:00:${String(second).padStart(2, "0")}Z`;

export const threadComment = (
  id: string,
  author: string,
  body: string,
  second = 0,
) => ({
  id,
  author,
  body,
  createdAt: threadTime(second),
  updatedAt: threadTime(second),
});

export const fileThread = (
  id: string,
  line: number,
  resolved: boolean,
  body = `**On** \`${id}\``,
) => ({
  id,
  sessionId: "s1",
  kind: "discussion",
  anchor: { path: "plan.md", line, render: { quote: "para" } },
  comments: [threadComment(`${id}c`, "you", body)],
  resolved,
  createdAt: `2026-11-10T10:00:0${line}Z`,
  updatedAt: `2026-11-10T10:00:0${line}Z`,
});
