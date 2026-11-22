/**
 * A fake headless Claude Code (stream-json in and out) for conversation
 * mode: each user message is answered by one text block streamed as
 * BENCH_CLAUDE_DELTAS deltas (default 400), one every BENCH_CLAUDE_DELTA_MS
 * (default 2), then the assistant message and a result. Every line it
 * writes is logged with its time (BENCH_CLAUDE_LOG). Control requests get
 * a plain success.
 */
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const sessionId = flag("--resume") ?? flag("--session-id") ?? randomUUID();
const deltas = Number(process.env.BENCH_CLAUDE_DELTAS ?? 400);
const every = Number(process.env.BENCH_CLAUDE_DELTA_MS ?? 2);
const logPath = process.env.BENCH_CLAUDE_LOG;
const log = (entry: Record<string, unknown>) => {
  if (logPath)
    appendFileSync(
      logPath,
      `${JSON.stringify({ at: Date.now(), ...entry })}\n`,
    );
};
log({ kind: "start", args });
const out = (event: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};
out({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  model: "claude-bench",
  tools: [],
  cwd: process.cwd(),
});

let turn = 0;
async function answer(text: string) {
  turn += 1;
  const id = `msg_bench_${turn}`;
  const started = Date.now();
  log({ kind: "turn", turn, text: text.slice(0, 80) });
  out({
    type: "stream_event",
    session_id: sessionId,
    event: {
      type: "message_start",
      message: { id, model: "claude-bench", role: "assistant", content: [] },
    },
  });
  out({
    type: "stream_event",
    session_id: sessionId,
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  });
  let full = "";
  for (let index = 0; index < deltas; index++) {
    const piece = `w${index} `;
    full += piece;
    out({
      type: "stream_event",
      session_id: sessionId,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: piece },
      },
    });
    if (every > 0) await Bun.sleep(every);
  }
  out({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "content_block_stop", index: 0 },
  });
  out({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
  });
  out({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "message_stop" },
  });
  out({
    type: "assistant",
    session_id: sessionId,
    message: {
      id,
      model: "claude-bench",
      role: "assistant",
      content: [{ type: "text", text: full }],
    },
  });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: full.slice(0, 40),
    session_id: sessionId,
    duration_ms: Date.now() - started,
  });
  log({ kind: "turn_done", turn, deltas });
}

let buffer = "";
let queue = Promise.resolve();
process.stdin.on("data", (chunk) => {
  buffer += String(chunk);
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line) continue;
    let message: Record<string, any>;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    log({ kind: "in", type: message.type, subtype: message.request?.subtype });
    if (message.type === "control_request") {
      out({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: {},
        },
      });
      continue;
    }
    if (message.type === "user") {
      const content = message.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part: any) => part.text ?? "").join("")
            : "";
      queue = queue.then(() => answer(text));
    }
  }
});
process.stdin.on("end", () => {
  void queue.then(() => process.exit(0));
});
