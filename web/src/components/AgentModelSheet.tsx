import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type {
  AgentChatModel,
  AgentChatModelResult,
  AgentChatModels,
} from "../../../shared/agentChat";
import { currentModelValue, isModelName } from "../../../shared/agentModels";
import "./AgentModelSheet.css";

type Row = AgentChatModel & { typed?: boolean };

/** The rows a filter keeps, and a typed model id to switch to at the end. */
export function modelSheetRows(
  models: readonly AgentChatModel[],
  query: string,
): Row[] {
  const typed = query.trim();
  const needle = typed.toLowerCase();
  const kept = needle
    ? models.filter((row) =>
        [row.value, row.label, row.description ?? ""].some((field) =>
          field.toLowerCase().includes(needle),
        ),
      )
    : [...models];
  const exact = models.some(
    (row) => row.value.toLowerCase() === needle || row.label === typed,
  );
  return typed && !exact && isModelName(typed)
    ? [...kept, { value: typed, label: typed, typed: true }]
    : kept;
}

/**
 * /model typed in a conversation-mode chat: the models the session's agent
 * and profile offer, the one it runs marked. Typing filters them, or names
 * a model the list lacks; Up/Down and Enter, or a tap, switch to one; Esc
 * closes. The sheet stays open on a refusal, which it says.
 */
export function AgentModelSheet({
  load,
  onPick,
  onClose,
}: {
  load: () => Promise<AgentChatModels>;
  onPick: (model: string) => Promise<AgentChatModelResult>;
  onClose: () => void;
}) {
  const [listed, setListed] = useState<AgentChatModels | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [switching, setSwitching] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let live = true;
    loadRef
      .current()
      .then((models) => {
        if (!live) return;
        setListed(models);
        const current = currentModelValue(
          models.models,
          models.current,
          models.chosen,
        );
        const at = models.models.findIndex((row) => row.value === current);
        if (at >= 0) setCursor(at);
      })
      .catch((error: unknown) => {
        if (live)
          setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
  }, []);
  // A touch screen's keyboard would cover the list: the sheet takes the
  // focus there, the filter a tap away.
  useEffect(() => {
    let touch = false;
    try {
      touch = window.matchMedia("(pointer: coarse)").matches;
    } catch {
      // No media queries: a keyboard is assumed.
    }
    (touch ? sheetRef.current : inputRef.current)?.focus();
  }, []);

  const current = listed
    ? currentModelValue(listed.models, listed.current, listed.chosen)
    : null;
  const rows = useMemo(
    () => modelSheetRows(listed?.models ?? [], query),
    [listed, query],
  );
  const at = Math.min(cursor, Math.max(0, rows.length - 1));
  useEffect(() => {
    sheetRef.current
      ?.querySelector(`[data-model-index="${at}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const pick = (row: Row | undefined) => {
    if (!row || row.disabled || switching) return;
    setSwitching(row.value);
    setRefusal(null);
    onPick(row.value).then(
      (result) => {
        setSwitching(null);
        if (result.ok) onClose();
        else setRefusal(result.reason);
      },
      (error: unknown) => {
        setSwitching(null);
        setRefusal(error instanceof Error ? error.message : String(error));
      },
    );
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const key = event.key;
    if (key === "Escape") onClose();
    else if (key === "ArrowDown") setCursor(Math.min(rows.length - 1, at + 1));
    else if (key === "ArrowUp") setCursor(Math.max(0, at - 1));
    else if (key === "Enter") pick(rows[at]);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      className="agent-model-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={sheetRef}
        className="agent-model-sheet"
        role="dialog"
        aria-label="Model"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="agent-model-head">
          <strong>Switch the model</strong>
          <button
            type="button"
            className="agent-history-icon"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
        <input
          ref={inputRef}
          className="agent-model-filter"
          type="text"
          data-dictation="off"
          value={query}
          placeholder="Filter, or type a model name"
          aria-label="Filter the models, or type a model name"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
        />
        {refusal ? (
          <p className="agent-model-refusal" role="alert">
            {refusal}
          </p>
        ) : null}
        {switching ? (
          <p className="agent-model-note" role="status">
            Switching to {switching}...
          </p>
        ) : null}
        {!listed && !loadError ? (
          <p className="agent-model-note" role="status">
            Asking for the models...
          </p>
        ) : null}
        {loadError ? (
          <p className="agent-model-refusal" role="alert">
            {loadError}
          </p>
        ) : null}
        {listed?.error ? (
          <p className="agent-model-note" role="note">
            {listed.error}
          </p>
        ) : null}
        {rows.length ? (
          <ul className="agent-model-list">
            {rows.map((row, index) => (
              <li key={`${row.typed ? "typed:" : ""}${row.value}`}>
                <button
                  type="button"
                  data-model-index={index}
                  className={index === at ? "is-cursor" : undefined}
                  disabled={row.disabled || !!switching}
                  aria-current={row.value === current ? "true" : undefined}
                  onPointerEnter={() => setCursor(index)}
                  onClick={() => pick(row)}
                >
                  <span className="agent-model-name">
                    {row.typed ? `Use ${row.value}` : row.label}
                    {!row.typed && row.label !== row.value ? (
                      <code>{row.value}</code>
                    ) : null}
                    {row.value === current ? (
                      <span className="agent-model-current">current</span>
                    ) : null}
                  </span>
                  {row.description ? (
                    <span className="agent-model-description">
                      {row.description}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : listed ? (
          <p className="agent-model-note">
            No model matches; type its full name to switch to it.
          </p>
        ) : null}
      </div>
    </div>
  );
}
