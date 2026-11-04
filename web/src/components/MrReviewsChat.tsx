import { GitPullRequest, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import type { AssistantMessage } from "../../../shared/assistant";
import { forgeRefLabel } from "../../../shared/forge";
import type { MrAgentMessage, MrItem } from "../../../shared/mrReviews";
import type { ChatSource } from "../chatSource";
import {
  resetMrAgent,
  sendMrAgent,
  stopMrAgent,
  subscribeMrAgent,
  unqueueMrAgent,
  useMrAgent,
} from "../mrReviewsAgent";
import { rangerChatStatus } from "../rangerChat";
import { REVIEWS_VOICE_KEY, REVIEWS_VOICE_SESSION } from "../voiceRoute";
import { RangerChat, type RangerMessageExtras } from "./RangerChat";

/**
 * The reviews agent's chat, in the Reviews panel: Ranger's chat pieces
 * (messages, message box, voice chat) on the agent's snapshot. It answers
 * from the inbox, the user's interest signals and forge searches; what it
 * did shows as Ranger's "Work performed", and a review it showed as a
 * button to show it again.
 */

const TOOL_LABELS: Record<string, string> = {
  known_requests: "Known requests",
  interest_signals: "Your interest signals",
  search_requests: "Forge search",
  request_files: "Changed files",
  suggest: "Suggested",
  feedback: "Feedback",
  set_hints: "Hints",
  open_review: "Review shown",
};

function Activity({
  message,
  running,
}: {
  message: MrAgentMessage;
  running: boolean;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (details.current) details.current.open = running;
  }, [running]);
  if (!message.tools.length) return null;
  return (
    <details className="assistant-tools" ref={details}>
      <summary>
        {running && message.tools.some((tool) => tool.status === "running")
          ? "Looking"
          : "Work performed"}{" "}
        ({message.tools.length})
      </summary>
      <ul>
        {message.tools.map((tool) => (
          <li key={tool.id}>
            <details className="assistant-activity-card assistant-tool-details">
              <summary>
                <span>{TOOL_LABELS[tool.name] ?? tool.name}</span>
                <span className={`assistant-tool-state is-${tool.status}`}>
                  {tool.status}
                </span>
              </summary>
              <div className="assistant-tool-content">
                {tool.arguments !== undefined ? (
                  <>
                    <strong>Arguments</strong>
                    <pre tabIndex={0}>{tool.arguments}</pre>
                  </>
                ) : null}
                {tool.output !== undefined ? (
                  <>
                    <strong>
                      {tool.status === "failed" ? "Error" : "Result"}
                    </strong>
                    <pre tabIndex={0}>{tool.output}</pre>
                  </>
                ) : null}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function MrReviewsChat({
  mobile,
  focusRequest = 0,
  onFocusComposer,
  onOpen,
  onError,
}: {
  mobile: boolean;
  /** Changed: the message box takes the focus once it is there. */
  focusRequest?: number;
  onFocusComposer?: () => void;
  /** Shows a request's review, as Enter in the inbox does. */
  onOpen: (item: MrItem) => void;
  onError: (message: string) => void;
}) {
  const { snapshot, error } = useMrAgent();
  const focused = useRef(0);
  const loaded = snapshot !== null;
  useEffect(() => {
    if (!loaded || !focusRequest || focused.current === focusRequest) return;
    focused.current = focusRequest;
    onFocusComposer?.();
  }, [loaded, focusRequest, onFocusComposer]);
  // A new chat has a new message box: it takes the focus.
  const resetAsked = useRef(false);
  const instance = snapshot?.instance_id;
  useEffect(() => {
    if (!instance || !resetAsked.current) return;
    resetAsked.current = false;
    onFocusComposer?.();
  }, [instance, onFocusComposer]);

  const extras = useCallback(
    (message: AssistantMessage): RangerMessageExtras => {
      if (message.role !== "assistant" || !snapshot) return {};
      const own = message as MrAgentMessage;
      const last = message === snapshot.messages[snapshot.messages.length - 1];
      const running = snapshot.running && last;
      const opens = own.opens ?? [];
      if (!own.tools.length && !opens.length && !own.failed) return {};
      return {
        after: (
          <div className="mr-reviews-chat-after">
            <Activity message={own} running={running} />
            {own.failed ? (
              <span className="assistant-hint">
                This answer stopped on an error.
              </span>
            ) : null}
            {opens.length ? (
              <div className="assistant-task-buttons">
                {opens.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className="ghost"
                    onClick={() => onOpen(item)}
                  >
                    <GitPullRequest size={13} /> Review {forgeRefLabel(item)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ),
      };
    },
    [snapshot, onOpen],
  );

  const source = useCallback(
    (
      current: { instance_id: string; running: boolean },
      entries: ChatSource["entries"],
    ): ChatSource => ({
      kind: "ranger",
      agent: "Reviews agent",
      draftKey: `mr-reviews-agent:${current.instance_id}`,
      entries,
      status: rangerChatStatus(current),
      threads: null,
      voiceSession: REVIEWS_VOICE_SESSION,
      voiceKey: REVIEWS_VOICE_KEY,
    }),
    [],
  );

  if (!snapshot)
    return (
      <div className="assistant-panel-empty">
        {error ? (
          <span className="assistant-error">{error}</span>
        ) : (
          "Loading..."
        )}
      </div>
    );

  return (
    <RangerChat
      snapshot={snapshot}
      connectionId=""
      mobile={mobile}
      workspaces={[]}
      disabled={null}
      extras={extras}
      agent="Reviews agent"
      placeholder="Ask about requests to review: what is new, what touches a path, why one was suggested"
      source={source}
      subscribe={subscribeMrAgent}
      stopTitle="Stop the answer; waiting questions are dropped"
      // A question sent while it answers waits: it cannot be steered.
      canSteer={false}
      empty={
        <div className="assistant-panel-empty mr-reviews-chat-empty">
          <Sparkles size={24} aria-hidden="true" />
          <strong>Ask the reviews agent</strong>
          <span>
            It searches the forges (read only) and answers from your inbox, your
            history in your clones, your hints and your feedback. For example:
            "anything new on GES or the RTP stack?", "find MRs touching
            validate", "why did you suggest !12967?"
          </span>
        </div>
      }
      onSend={async (text, _mentions, whenBusy) => {
        await sendMrAgent(text, whenBusy ? { whenBusy: "queue" } : {});
      }}
      onStop={() => void stopMrAgent().catch((cause) => onError(String(cause)))}
      onRemoveQueued={(id) => unqueueMrAgent(id)}
      onError={onError}
    >
      <div className="mr-reviews-chat-controls">
        <span className="assistant-hint">Model: {snapshot.model}</span>
        {snapshot.messages.length ? (
          <button
            type="button"
            className="ghost"
            disabled={snapshot.running}
            title="Start over: a new conversation; suggestions, feedback and hints stay"
            onClick={() => {
              resetAsked.current = true;
              void resetMrAgent().catch((cause) => onError(String(cause)));
            }}
          >
            New chat
          </button>
        ) : null}
      </div>
    </RangerChat>
  );
}
