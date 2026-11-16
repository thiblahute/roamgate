import { ChevronDown } from "lucide-react";
import type { ChangesAgent } from "../changesReview";
import { ReviewMenu } from "./ReviewMenu";

/**
 * The review's agent group in Changes (plan: review into the inspector,
 * phase 4), for the checkout's review: Comments go to the agent (Live),
 * Hold, Send, Agent review and the overall comment (its editor is the
 * review's, drawn above the diff). Shown once the review has an agent to
 * talk to. The agent's name opens its menu, as the review pane's does:
 * how comments reach it, asking it about the line, its review, going to
 * its pane.
 */
export function ChangesAgentBar({
  agent,
  overallOpen,
  onOverall,
  onAsk,
  onFocusAgentPane,
}: {
  agent: ChangesAgent;
  overallOpen: boolean;
  onOverall: (open: boolean) => void;
  /** A discussion with the agent on the cursor's line (C, :ask). */
  onAsk: () => void;
  /** Go to the agent's pane, the review kept; absent: no such entry. */
  onFocusAgentPane?: (paneId: string) => void;
}) {
  if (!agent.agentName) return null;
  const name = agent.agentName;
  const mode = agent.talk ? (agent.held ? "holding" : "live") : "manual";
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
          title={`${name}: how your comments reach it, and asking it`}
          label={
            <>
              {name}
              <span className="diff-agent-mode">{mode}</span>
              <ChevronDown size={12} />
            </>
          }
          items={[
            {
              label: `Comments go to ${name}`,
              title: agent.talk
                ? `Your comments go to ${name} as you write them; uncheck to hold them until you Send them`
                : `Send your comments to ${name} as you write them`,
              checked: agent.talk,
              onSelect: () => agent.setTalk(!agent.talk),
            },
            agent.talk && {
              label: "Hold until Send",
              hint: ":hold",
              title: agent.held
                ? `Your comments wait until you Send them to ${name}; uncheck to send each as you write it`
                : `Hold your comments and Send them to ${name} when you are done`,
              checked: agent.held,
              onSelect: agent.toggleHold,
            },
            {
              label: `Ask ${name} about this line`,
              hint: "C",
              title: `A discussion with ${name} on the line your cursor is on (:ask)`,
              onSelect: onAsk,
            },
            {
              label: `${name} reviews the changes`,
              hint: ":review",
              title: `${name} reviews line by line, reading the checkout`,
              disabled: agent.reviewing,
              onSelect: () => agent.review(),
            },
            !!agent.agentPaneId &&
              !!onFocusAgentPane && {
                label: `Go to ${name}'s pane`,
                title: "The review is kept",
                onSelect: () => onFocusAgentPane(agent.agentPaneId!),
              },
          ]}
        />
        <button
          type="button"
          aria-pressed={agent.talk}
          title={
            agent.talk
              ? `Your comments go to ${name} as you write them; click to hold them until you Send`
              : `Send your comments to ${name} as you write them`
          }
          onClick={() => agent.setTalk(!agent.talk)}
        >
          Live
        </button>
        {agent.talk ? (
          <button
            type="button"
            aria-pressed={agent.held}
            title={
              agent.held
                ? `Your comments wait until you Send them to ${name} (:hold)`
                : `Hold your comments and Send them to ${name} when you are done (:hold)`
            }
            onClick={agent.toggleHold}
          >
            Hold
          </button>
        ) : null}
        <button
          type="button"
          disabled={!agent.heldCount && !agent.waiting}
          title={`Send the held comments, or the open discussions, to ${name} (:send)`}
          onClick={agent.send}
        >
          {agent.gitlab
            ? // A merge request's review: the Send is the agent's, never
              // the forge's (user decision 2026-11-13).
              agent.heldCount || agent.waiting
              ? `Send ${agent.heldCount || agent.waiting} to ${name}`
              : `Send to ${name}`
            : agent.heldCount
              ? `Send (${agent.heldCount})`
              : "Send"}
        </button>
        <button
          type="button"
          disabled={agent.reviewing}
          title={`${name} reviews the changes, line by line (:review [focus])`}
          onClick={() => agent.review()}
        >
          {agent.reviewing ? "Reviewing..." : "Review"}
        </button>
        <button
          type="button"
          aria-pressed={overallOpen}
          title="An overall comment on the review (:overall)"
          onClick={() => onOverall(!overallOpen)}
        >
          Overall
        </button>
      </div>
      {agent.status ? (
        <span className="diff-agent-status" role="status" aria-live="polite">
          {agent.status}
        </span>
      ) : null}
    </>
  );
}
