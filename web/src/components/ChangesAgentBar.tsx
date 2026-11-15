import { useState } from "react";
import type { ChangesAgent } from "../changesReview";
import { ThreadEditor } from "./ThreadEditor";

/**
 * The review's agent group in Changes (plan: review into the inspector,
 * phase 4), for the checkout's review: Comments go to the agent (Live),
 * Hold, Send, Agent review and the overall comment. Shown once the review
 * has an agent to talk to.
 */
export function ChangesAgentBar({
  agent,
  overallOpen,
  onOverall,
}: {
  agent: ChangesAgent;
  overallOpen: boolean;
  onOverall: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
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
        <span
          className="diff-agent-name"
          title={`${name}: how your comments reach it`}
        >
          {name}
          <span className="diff-agent-mode">{mode}</span>
        </span>
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
          {agent.heldCount ? `Send (${agent.heldCount})` : "Send"}
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
      {overallOpen ? (
        <div className="diff-agent-overall chat-review">
          <ThreadEditor
            placeholder={
              agent.talk && !agent.held
                ? `Your overall comment, for ${name}: sent as you save (Cmd+Enter saves, Esc closes)`
                : `Your overall comment, for ${name}: sent when you press Send (Cmd+Enter saves, Esc closes)`
            }
            kept={{ text: agent.summary }}
            sendLabel="Save"
            onSave={async (text) => {
              if (busy) return;
              setBusy(true);
              try {
                await agent.saveOverall(text);
                onOverall(false);
              } finally {
                setBusy(false);
              }
            }}
            onClose={() => onOverall(false)}
            onLeave={() => onOverall(false)}
          />
        </div>
      ) : null}
    </>
  );
}
