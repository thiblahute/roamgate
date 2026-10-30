import { Check, Copy, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentChatShell } from "../../../shared/agentChat";
import { copyTextWithFeedback } from "../copyText";
import { shortCwd } from "../shortCwd";
import "./AgentChatShell.css";

/** Output lines shown before "Show all". */
export const SHELL_SHOWN_LINES = 12;

function lines(text: string): string[] {
  return text ? text.replace(/\n$/, "").split("\n") : [];
}

/** 0:07, 1:05, 1:02:03. */
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Milliseconds since `startedAt`, ticking each second while `running`. */
function useElapsed(startedAt: string | undefined, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Number.isFinite(start) ? now - start : null;
}

/**
 * A `!` line in the chat (Claude Code's bash mode), drawn as a command the
 * user ran, not as a message: `$ command` with where it ran, how it ended,
 * what it printed (long output folded), and what Claude has of it. Live
 * from the bridge, or read back from the transcript (which keeps no exit
 * code: the browser adds it for the runs it saw end).
 */
export function ShellCommandBlock({
  command,
  stdout = "",
  stderr = "",
  status,
  exitCode = null,
  truncated = false,
  error,
  pending = false,
  sent = false,
  host,
  cwd,
  startedAt,
  finishedAt,
  onStop,
  sequence,
}: {
  command: string;
  stdout?: string;
  stderr?: string;
  status?: AgentChatShell["status"];
  exitCode?: number | null;
  truncated?: boolean;
  error?: string;
  /** Not sent to Claude yet: it goes with the next message. */
  pending?: boolean;
  /** Claude has it (the transcript shows it). */
  sent?: boolean;
  /** The connection it ran on. */
  host?: string;
  /** The directory it ran in. */
  cwd?: string;
  startedAt?: string;
  finishedAt?: string;
  onStop?: () => void;
  sequence?: number;
}) {
  const running = status === "running";
  const elapsed = useElapsed(startedAt, running);
  const took =
    startedAt && finishedAt
      ? Date.parse(finishedAt) - Date.parse(startedAt)
      : Number.NaN;
  const [expanded, setExpanded] = useState(false);
  const shownCommand = command.trim();
  const out = lines(stdout);
  const err = lines(stderr);
  const total = out.length + err.length;
  const folded = !expanded && total > SHELL_SHOWN_LINES;
  // Folded: the latest lines while it runs, the first ones once it ended.
  const from = folded && running ? total - SHELL_SHOWN_LINES : 0;
  const to = folded && !running ? SHELL_SHOWN_LINES : total;
  const shownOut = out.slice(from, to);
  const shownErr = err.slice(
    Math.max(0, from - out.length),
    Math.max(0, to - out.length),
  );
  const chip: { label: string; tone: string; title?: string } | null = running
    ? {
        label:
          elapsed !== null ? `Running ${elapsedLabel(elapsed)}` : "Running",
        tone: "running",
      }
    : status === "stopped"
      ? { label: "Stopped", tone: "stopped" }
      : status === "failed"
        ? { label: "Could not run", tone: "error" }
        : status === "done"
          ? {
              label: `Exit ${exitCode ?? "?"}`,
              tone: exitCode === 0 ? "ok" : "error",
              title: Number.isFinite(took)
                ? `Took ${elapsedLabel(took)}`
                : undefined,
            }
          : null;
  const where = [host, cwd ? shortCwd(cwd) : null].filter(Boolean).join(" · ");
  const outcome = chip && !running ? `, ${chip.label.toLowerCase()}` : "";
  return (
    <div
      className="agent-chat-shell"
      data-status={status ?? "recorded"}
      data-sequence={sequence}
      role="group"
      aria-label={`You ran: ${shownCommand}${where ? `, on ${where}` : ""}${outcome}`}
    >
      <div className="agent-chat-shell-by">
        <span className="agent-chat-shell-you">You ran</span>
        {where ? (
          <span className="agent-chat-shell-where" title={cwd}>
            {where}
          </span>
        ) : null}
      </div>
      <div className="agent-chat-shell-head">
        <span className="agent-chat-shell-prompt" aria-hidden="true">
          $
        </span>
        <code className="agent-chat-shell-command">{shownCommand}</code>
        {chip ? (
          <span
            className={`agent-chat-shell-chip is-${chip.tone}`}
            role={running ? "status" : undefined}
            title={chip.title}
          >
            {running ? (
              <span className="agent-chat-shell-spinner" aria-hidden="true" />
            ) : null}
            {chip.label}
          </span>
        ) : null}
        {running && onStop ? (
          <button
            type="button"
            className="agent-chat-shell-stop"
            aria-label="Stop the command"
            title="Stop the command"
            onClick={onStop}
          >
            <Square size={10} fill="currentColor" aria-hidden="true" />
            <span>Stop</span>
          </button>
        ) : null}
      </div>
      {total ? (
        <pre className={`agent-chat-shell-output${folded ? " is-folded" : ""}`}>
          {shownOut.length ? `${shownOut.join("\n")}\n` : null}
          {shownErr.length ? (
            <span className="agent-chat-shell-stderr">
              {`${shownErr.join("\n")}\n`}
            </span>
          ) : null}
        </pre>
      ) : null}
      {error ? <p className="agent-chat-shell-note is-error">{error}</p> : null}
      {truncated ? (
        <p className="agent-chat-shell-note">
          {pending
            ? "Output truncated: Claude reads the first 30,000 characters."
            : "Output truncated."}
        </p>
      ) : null}
      {total || pending || sent ? (
        <div className="agent-chat-shell-foot">
          {total > SHELL_SHOWN_LINES ? (
            <button
              type="button"
              className="agent-chat-shell-more"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show less" : `Show all ${total} lines`}
            </button>
          ) : null}
          {total ? (
            <button
              type="button"
              className="agent-chat-shell-copy"
              aria-label="Copy the output"
              title="Copy the output"
              onClick={() => void copyTextWithFeedback(`${stdout}${stderr}`)}
            >
              <Copy size={12} aria-hidden="true" />
            </button>
          ) : null}
          {pending ? (
            <span className="agent-chat-shell-claude">
              Claude sees this with your next message
            </span>
          ) : sent ? (
            <span className="agent-chat-shell-claude is-sent">
              <Check size={12} aria-hidden="true" />
              Sent to Claude with your message
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
