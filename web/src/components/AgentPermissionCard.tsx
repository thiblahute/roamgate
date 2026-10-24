import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  AgentPermissionPrompt,
  AgentPromptAnswer,
  AgentQuestion,
} from "../../../shared/review";
import { isMobileLayout } from "../layoutPreferences";
import { answerAgentPrompt, releaseAgentPrompt } from "../review";
import { store } from "../store";
import "./AgentPermissionCard.css";

/**
 * Takes the keys when a card comes, on a desktop, unless the user is busy
 * elsewhere than the chat's message box.
 */
function useTakeKeys(
  target: () => HTMLElement | null | undefined,
  on: boolean,
) {
  useEffect(() => {
    if (!on || isMobileLayout()) return;
    const active = document.activeElement;
    if (
      active &&
      active !== document.body &&
      !active.closest(".agent-history-composer")
    )
      return;
    requestAnimationFrame(() => target()?.focus({ preventScroll: true }));
    // Once, when it comes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
}

/** Keys with no modifier: a card's own shortcuts. */
function plainKey(event: KeyboardEvent): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if ((event.target as HTMLElement).closest("input[type=text], textarea"))
    return null;
  return event.key;
}

/**
 * An agent asking leave to use a tool, from its permission hook: answered
 * here, or, once its time runs out, in its terminal as usual.
 */
export function AgentPermissionCard({
  prompt,
  compact = false,
}: {
  prompt: AgentPermissionPrompt;
  /** Over a terminal: one line of what it would do. */
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(() => secondsLeft(prompt));
  useEffect(() => {
    const timer = window.setInterval(() => setLeft(secondsLeft(prompt)), 1000);
    return () => window.clearInterval(timer);
  }, [prompt]);

  const answer = async (choice: AgentPromptAnswer) => {
    setBusy(true);
    try {
      if (!(await answerAgentPrompt(prompt.connectionId, prompt.id, choice)))
        store.notify({
          kind: "info",
          message: "Already answered",
          detail: "The terminal asks it now.",
        });
    } catch (error) {
      store.notify({
        kind: "error",
        message: "The answer did not reach the agent",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const toTerminal = () =>
    void releaseAgentPrompt(prompt.connectionId, prompt.id).catch(() => {});
  const rootRef = useRef<HTMLDivElement | null>(null);
  useTakeKeys(() => rootRef.current, !prompt.questions && !compact);

  if (prompt.questions) {
    const form = (
      <QuestionsForm
        prompt={prompt}
        questions={prompt.questions}
        left={left}
        busy={busy}
        onAnswer={(answers) => void answer({ answers })}
        onTerminal={toTerminal}
      />
    );
    // On a phone, a sheet above everything: no bar or layer can cover it.
    return isMobileLayout() ? createPortal(form, document.body) : form;
  }

  return (
    <div
      ref={rootRef}
      className={`agent-permission${compact ? " is-compact" : ""}`}
      role="alertdialog"
      aria-label={`${prompt.agent} asks to use ${prompt.tool}`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (busy) return;
        const key = plainKey(event);
        const choice =
          key === "y"
            ? "allow"
            : key === "a" && prompt.canAlways
              ? "always"
              : key === "n"
                ? "deny"
                : null;
        if (choice) void answer(choice);
        else if (key === "t") toTerminal();
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="agent-permission-head">
        <strong>
          {prompt.agent} asks to use {prompt.tool}
        </strong>
        {compact ? null : (
          <small className="agent-permission-keys">
            y allow{prompt.canAlways ? " · a always" : ""} · n deny · t terminal
          </small>
        )}
        <span className="agent-permission-time" title="Then the terminal asks">
          {left}s
        </span>
      </div>
      <code className="agent-permission-summary">{prompt.summary}</code>
      {prompt.detail && !compact ? (
        <details className="agent-permission-detail">
          <summary>Details</summary>
          <pre>{prompt.detail}</pre>
        </details>
      ) : null}
      <div className="agent-permission-actions">
        <button
          type="button"
          className="primary-btn"
          disabled={busy}
          title="Allow (y)"
          onClick={() => void answer("allow")}
        >
          Allow
        </button>
        {prompt.canAlways ? (
          <button
            type="button"
            className="secondary-btn"
            disabled={busy}
            title="Allow, and don't ask again for this, as the terminal offers (a)"
            onClick={() => void answer("always")}
          >
            Always
          </button>
        ) : null}
        <button
          type="button"
          className="secondary-btn"
          disabled={busy}
          title="Deny (n)"
          onClick={() => void answer("deny")}
        >
          Deny
        </button>
        <button
          type="button"
          className="secondary-btn agent-permission-terminal"
          disabled={busy}
          title="Let the terminal ask it now (t)"
          onClick={toTerminal}
        >
          In the terminal
        </button>
      </div>
    </div>
  );
}

/**
 * Claude's multiple-choice questions: one choice, several, or the user's own
 * words for each, answered together as its question tool expects.
 */
function QuestionsForm({
  prompt,
  questions,
  left,
  busy,
  onAnswer,
  onTerminal,
}: {
  prompt: AgentPermissionPrompt;
  questions: AgentQuestion[];
  left: number;
  busy: boolean;
  onAnswer: (answers: Record<string, string>) => void;
  onTerminal: () => void;
}) {
  // Per question: the chosen labels, and the user's own answer.
  const [chosen, setChosen] = useState<string[][]>(() =>
    questions.map(() => []),
  );
  const [own, setOwn] = useState<string[]>(() => questions.map(() => ""));
  // A phone's keyboard closing under the first tap would move the form:
  // close it before, so the sheet holds still.
  useEffect(() => {
    if (!isMobileLayout()) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }, []);
  const formRef = useRef<HTMLFormElement | null>(null);
  useTakeKeys(
    () =>
      formRef.current?.querySelector<HTMLInputElement>(".agent-question input"),
    true,
  );
  const answerOf = (index: number) =>
    own[index]!.trim() || chosen[index]!.join(", ");
  const complete = questions.every((_, index) => answerOf(index));
  const choose = (index: number, label: string, multi: boolean) =>
    setChosen((current) =>
      current.map((labels, at) =>
        at !== index
          ? labels
          : multi
            ? labels.includes(label)
              ? labels.filter((l) => l !== label)
              : [...labels, label]
            : [label],
      ),
    );
  return (
    <form
      ref={formRef}
      className="agent-permission agent-questions"
      aria-label={`${prompt.agent} asks`}
      onKeyDown={(event) => {
        // 1 to 9 pick a choice of the question the keys are in; one answer
        // moves on to the next question.
        const key = plainKey(event);
        if (!key || !/^[1-9]$/.test(key)) return;
        const fieldsets = [
          ...event.currentTarget.querySelectorAll<HTMLFieldSetElement>(
            ".agent-question",
          ),
        ];
        const index = Math.max(
          0,
          fieldsets.findIndex((fieldset) =>
            fieldset.contains(event.target as Node),
          ),
        );
        const question = questions[index];
        const option = question?.options[Number(key) - 1];
        if (!question || !option) return;
        event.preventDefault();
        event.stopPropagation();
        choose(index, option.label, question.multiSelect);
        const inputs = fieldsets[index]?.querySelectorAll<HTMLInputElement>(
          "input:not([type=text])",
        );
        const next = question.multiSelect
          ? inputs?.[Number(key) - 1]
          : (fieldsets[index + 1]?.querySelector<HTMLInputElement>("input") ??
            formRef.current?.querySelector<HTMLButtonElement>(
              "button[type=submit]",
            ));
        requestAnimationFrame(() => next?.focus({ preventScroll: true }));
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!complete || busy) return;
        onAnswer(
          Object.fromEntries(
            questions.map((question, index) => [
              question.question,
              answerOf(index),
            ]),
          ),
        );
      }}
    >
      <div className="agent-permission-head">
        <strong>{prompt.agent} asks</strong>
        <small className="agent-permission-keys">
          1–9 · ↑↓ · Tab · Enter answers
        </small>
        <span className="agent-permission-time" title="Then the terminal asks">
          {left}s
        </span>
      </div>
      {questions.map((question, index) => (
        <fieldset key={question.question} className="agent-question">
          <legend>
            {question.header ? <span>{question.header}</span> : null}
            {question.question}
          </legend>
          {question.options.map((option) => (
            <label key={option.label} className="agent-question-option">
              <input
                type={question.multiSelect ? "checkbox" : "radio"}
                name={`question-${prompt.id}-${index}`}
                checked={chosen[index]!.includes(option.label)}
                onChange={() =>
                  choose(index, option.label, question.multiSelect)
                }
              />
              <span>
                <strong>{option.label}</strong>
                {option.description ? (
                  <small>{option.description}</small>
                ) : null}
              </span>
            </label>
          ))}
          <input
            type="text"
            className="agent-question-own"
            placeholder="Other: your own answer"
            aria-label={`Your own answer to: ${question.question}`}
            autoComplete="off"
            value={own[index]}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setOwn((current) =>
                current.map((text, at) => (at === index ? value : text)),
              );
            }}
          />
        </fieldset>
      ))}
      <div className="agent-permission-actions">
        <button
          type="submit"
          className="primary-btn"
          disabled={!complete || busy}
          title="Answer (Enter)"
        >
          Answer
        </button>
        <button
          type="button"
          className="secondary-btn agent-permission-terminal"
          disabled={busy}
          title="Let the terminal ask them now"
          onClick={onTerminal}
        >
          In the terminal
        </button>
      </div>
    </form>
  );
}

function secondsLeft(prompt: AgentPermissionPrompt): number {
  return Math.max(
    0,
    Math.round((Date.parse(prompt.expiresAt) - Date.now()) / 1000),
  );
}
