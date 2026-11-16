import { ChevronDown } from "lucide-react";
import type { ChangesAgent } from "../changesReview";
import { ReviewMenu } from "./ReviewMenu";

/**
 * The review's agent group in Changes (plan: review into the inspector,
 * phase 4), for the checkout's review: one chip, the agent's name, its
 * mode and the held comments' count, whose menu holds Live, Hold, Send,
 * its Review, the overall comment, asking it about the line and going to
 * its pane. What it said is the chip's tooltip, never a line of its own.
 * Shown once the review has an agent to talk to.
 */
export function ChangesAgentBar({
  agent,
  overallOpen,
  onOverall,
  onAsk,
  onFocusAgentPane,
  status,
}: {
  agent: ChangesAgent;
  overallOpen: boolean;
  onOverall: (open: boolean) => void;
  /** A discussion with the agent on the cursor's line (C, :ask). */
  onAsk: () => void;
  /** Go to the agent's pane, the review kept; absent: no such entry. */
  onFocusAgentPane?: (paneId: string) => void;
  /** The review's own status line, shown in the chip's tooltip. */
  status?: string;
}) {
  if (!agent.agentName) return null;
  const name = agent.agentName;
  const mode = agent.talk ? (agent.held ? "holding" : "live") : "manual";
  const sendCount = agent.heldCount || agent.waiting;
  const sendLabel = agent.gitlab
    ? // A merge request's review: the Send is the agent's, never the
      // forge's (user decision 2026-11-13).
      sendCount
      ? `Send ${sendCount} to ${name}`
      : `Send to ${name}`
    : agent.heldCount
      ? `Send (${agent.heldCount})`
      : "Send";
  const said = [agent.status, status].filter(Boolean).join(" · ");
  return (
    <>
      <div
        className="diff-agent-bar"
        role="group"
        aria-label="Agent"
        data-mode={mode}
      >
        <ReviewMenu
          className="rv-agent diff-agent-name"
          title={`${name}, ${mode}: how your comments reach it, sending them, its review${said ? `\n${said}` : ""}`}
          label={
            <>
              {name}
              <span className="diff-agent-mode">{mode}</span>
              {agent.heldCount ? (
                <span className="rv-badge" title="Comments held until Send">
                  {agent.heldCount}
                </span>
              ) : null}
              <ChevronDown size={12} />
            </>
          }
          items={[
            {
              label: "Live",
              title: agent.talk
                ? `Your comments go to ${name} as you write them; uncheck to hold them until you Send them`
                : `Send your comments to ${name} as you write them`,
              checked: agent.talk,
              onSelect: () => agent.setTalk(!agent.talk),
            },
            agent.talk && {
              label: "Hold",
              hint: ":hold",
              title: agent.held
                ? `Your comments wait until you Send them to ${name}; uncheck to send each as you write it`
                : `Hold your comments and Send them to ${name} when you are done`,
              checked: agent.held,
              onSelect: agent.toggleHold,
            },
            {
              label: sendLabel,
              hint: ":send",
              title: `Send the held comments, or the open discussions, to ${name}`,
              disabled: !agent.heldCount && !agent.waiting,
              onSelect: agent.send,
            },
            {
              label: agent.reviewing ? "Reviewing..." : "Review",
              hint: ":review",
              title: `${name} reviews the changes, line by line, reading the checkout`,
              disabled: agent.reviewing,
              onSelect: () => agent.review(),
            },
            {
              label: "Overall",
              hint: ":overall",
              title: "An overall comment on the review",
              checked: overallOpen,
              onSelect: () => onOverall(!overallOpen),
            },
            {
              label: `Ask ${name} about this line`,
              hint: "C",
              title: `A discussion with ${name} on the line your cursor is on (:ask)`,
              onSelect: onAsk,
            },
            !!agent.agentPaneId &&
              !!onFocusAgentPane && {
                label: `Go to ${name}'s pane`,
                title: "The review is kept",
                onSelect: () => onFocusAgentPane(agent.agentPaneId!),
              },
          ]}
        />
      </div>
      {/* What the agent and the review said: the chip's tooltip, read out. */}
      {said ? (
        <span
          className="diff-agent-status sr-only"
          role="status"
          aria-live="polite"
        >
          {said}
        </span>
      ) : null}
    </>
  );
}
