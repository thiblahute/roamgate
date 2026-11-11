import { Bot, Folder, LoaderCircle, RefreshCw, X } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ASSISTANT_MAX_MENTIONS,
  type AssistantMention,
  type AssistantMentionTarget,
  type AssistantWorkspace,
  type AssistantWorkspaceRef,
} from "../../../shared/assistant";
import { getAssistantMentions } from "../assistant";
import {
  assistantMentionKey,
  assistantMentionQuery,
  insertAssistantMention,
} from "../assistantMentions";
import "./MessageMentions.css";

/**
 * A message box's @mention picker (Ranger's): @ or the box's @ button
 * opens it, and a pick is a chip bound to the message as a reference.
 */
export type ComposerMentions = {
  /** The workspaces offered while the full list loads, and its scope. */
  workspaces: AssistantWorkspace[];
  /** The workspace on screen: its references come first. */
  currentWorkspace?: AssistantWorkspaceRef;
  /** The references the draft `text` binds. */
  read: (text: string) => AssistantMention[];
  /** The draft is now `text`, binding `mentions`. */
  write: (text: string, mentions: AssistantMention[]) => void;
  /** Opens what a chip names. */
  onOpen: (target: AssistantMentionTarget) => void;
};

/** Where the picker reads and writes: the box's textarea or Vim editor. */
export type MentionField = {
  /** The caret or selection, in the box's text. */
  selection: () => { start: number; end: number } | null;
  /** Puts `insert` in place of `start`..`end`, as typed, caret after it. */
  replace: (start: number, end: number, insert: string) => void;
  focus: () => void;
};

type Picker = ReturnType<typeof assistantMentionQuery>;

/**
 * The picker over a message box. `text` is what the box shows and `draft`
 * what it holds (they differ where an image is shown short); `draftOffset`
 * maps the one to the other. The box hands it each change and selection
 * (`update`) and its keys ahead of its own (`keys`).
 */
export function useMentionPicker({
  config,
  draftKey,
  text,
  draft,
  draftOffset,
  field,
  composing,
  onPicked,
  onError,
}: {
  config: ComposerMentions | undefined;
  draftKey: string;
  text: string;
  draft: string;
  draftOffset: (offset: number) => number;
  field: () => MentionField | null;
  composing: () => boolean;
  /** A pick put `text` in the draft, the caret at `caret`. */
  onPicked: (text: string, caret: number) => void;
  onError: (message: string) => void;
}) {
  const [picker, setPicker] = useState<Picker>(null);
  const [category, setCategory] = useState<"all" | "workspace" | "agent">(
    "all",
  );
  const [targets, setTargets] = useState<AssistantMentionTarget[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [active, setActive] = useState(0);
  const [retry, setRetry] = useState(0);
  // A chip removed leaves the text as it is: draw the box again.
  const [, setChanged] = useState(0);
  const browsing = useRef(false);
  const dismissed = useRef("");
  const list = useRef<HTMLDivElement>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const id = useId();
  const enabled = !!config;
  const open = enabled && picker !== null;
  const mentions = config ? config.read(draft) : [];
  const workspaces = config?.workspaces ?? [];
  const currentWorkspace = config?.currentWorkspace;
  const mentionedWorkspaces = mentions.filter(
    (mention) => mention.kind === "workspace",
  );
  const scope = workspaces
    .filter(
      (workspace) =>
        !mentionedWorkspaces.length ||
        mentionedWorkspaces.some(
          (mention) =>
            mention.connection_id === workspace.connection_id &&
            mention.workspace_id === workspace.workspace_id,
        ),
    )
    .map(({ connection_id, workspace_id }) => ({ connection_id, workspace_id }))
    .sort((a, b) => {
      const current = (ref: AssistantWorkspaceRef) =>
        ref.connection_id === currentWorkspace?.connection_id &&
        ref.workspace_id === currentWorkspace?.workspace_id;
      return Number(current(b)) - Number(current(a));
    });
  const scopeSignature = JSON.stringify(scope);
  const workspaceSignature = JSON.stringify(workspaces);
  const immediate = useMemo(
    () =>
      (JSON.parse(workspaceSignature) as AssistantWorkspace[]).map(
        (workspace): AssistantMentionTarget => ({
          kind: "workspace",
          connection_id: workspace.connection_id,
          workspace_id: workspace.workspace_id,
          runtime_generation: workspace.runtime_generation,
          connection_label: workspace.connection_label,
          workspace_label: workspace.label,
          label: workspace.label,
        }),
      ),
    [workspaceSignature],
  );
  useEffect(() => {
    setPicker(null);
    setTargets(null);
    dismissed.current = "";
  }, [draftKey]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setTargets(null);
    setErrors([]);
    setTruncated(false);
    void getAssistantMentions(JSON.parse(scopeSignature)).then(
      (catalog) => {
        if (cancelled) return;
        const listed = new Set(catalog.targets.map(assistantMentionKey));
        setTargets([
          ...catalog.targets,
          ...immediate.filter(
            (target) => !listed.has(assistantMentionKey(target)),
          ),
        ]);
        setErrors(catalog.errors);
        if (catalog.errors.length) errorRef.current(catalog.errors.join("\n"));
        setTruncated(catalog.truncated ?? false);
        setLoading(false);
      },
      (cause: unknown) => {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setErrors([message]);
        errorRef.current(message);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, scopeSignature, immediate, draftKey, retry]);

  const query = picker?.query.toLocaleLowerCase() ?? "";
  const candidates = (targets ?? immediate)
    .filter(
      (target) =>
        (category === "all" || target.kind === category) &&
        [
          target.label,
          target.connection_label,
          target.workspace_label,
          ...(target.kind === "agent" ? [target.agent, target.pane_id] : []),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query),
    )
    .sort((a, b) => {
      const current = (target: AssistantMentionTarget) =>
        target.connection_id === currentWorkspace?.connection_id &&
        target.workspace_id === currentWorkspace?.workspace_id;
      return Number(current(b)) - Number(current(a));
    });
  const selected =
    candidates[Math.min(active, Math.max(0, candidates.length - 1))];
  useEffect(() => {
    setActive(0);
  }, [query, category, targets]);
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const close = () => {
    browsing.current = false;
    dismissed.current = `${text}:${field()?.selection()?.start}`;
    setPicker(null);
  };
  /** The box's text or caret changed (`changed`: by typing). */
  const update = (
    value: string,
    start: number,
    end: number,
    changed = false,
  ) => {
    if (!enabled) return;
    if (changed) dismissed.current = "";
    if (browsing.current && !changed) return;
    browsing.current = false;
    if (composing() || dismissed.current === `${value}:${start}`) return;
    const next = assistantMentionQuery(value, start, end);
    const at = next ? draftOffset(next.start) : -1;
    setPicker(
      next &&
        !config!
          .read(draft)
          .some((mention) => at >= mention.start && at < mention.end)
        ? next
        : null,
    );
  };
  /** Put away, as an input method starts composing. */
  const hide = () => setPicker(null);
  const select = (target: AssistantMentionTarget) => {
    if (!config || !picker || loading || !targets || composing()) return;
    if (mentions.length >= ASSISTANT_MAX_MENTIONS) {
      setErrors([
        `Use up to ${ASSISTANT_MAX_MENTIONS} references per message.`,
      ]);
      return;
    }
    const start = draftOffset(picker.start);
    const end = draftOffset(picker.end);
    const next = insertAssistantMention(draft, mentions, target, start, end);
    if (next.text.length > 20_000) {
      setErrors(["This reference would exceed the message length limit."]);
      return;
    }
    // Typed into the box, so its undo takes it back; then the draft and the
    // references as they must be, whatever the box made of it.
    const box = field();
    box?.focus();
    box?.replace(picker.start, picker.end, `@${target.label} `);
    config.write(next.text, next.mentions);
    onPicked(next.text, next.caret);
    setPicker(null);
    browsing.current = false;
    dismissed.current = "";
  };
  /** The box's keys, ahead of it: true when the picker took the key. */
  const keys = (event: ReactKeyboardEvent) => {
    if (
      !open ||
      event.nativeEvent.isComposing ||
      composing() ||
      event.keyCode === 229
    )
      return false;
    const stop = () => {
      event.preventDefault();
      event.nativeEvent.stopPropagation();
    };
    if (event.key === "Escape") {
      stop();
      close();
      return true;
    }
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey)
      return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      stop();
      if (candidates.length)
        setActive(
          (index) =>
            (index + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) %
            candidates.length,
        );
      return true;
    }
    if (event.key === "Enter" || (event.key === "Tab" && selected)) {
      stop();
      if (selected && !event.repeat) select(selected);
      return true;
    }
    return false;
  };
  /** The @ button: opens the picker at the caret, or closes it. */
  const toggle = () => {
    if (open) {
      close();
      return;
    }
    const box = field();
    browsing.current = true;
    box?.focus();
    const at = box?.selection() ?? { start: text.length, end: text.length };
    setCategory("all");
    setPicker({ start: at.start, end: at.end, query: "" });
  };
  const keepFocus = (event: ReactMouseEvent) => event.preventDefault();

  const popup: ReactNode = open ? (
    <div className="assistant-mention-picker">
      <div className="assistant-mention-picker-head">
        <div
          className="assistant-mention-categories"
          role="group"
          aria-label="Reference types"
        >
          {(["all", "workspace", "agent"] as const).map((kind) => (
            <button
              type="button"
              key={kind}
              aria-pressed={category === kind}
              onMouseDown={keepFocus}
              onClick={() => setCategory(kind)}
            >
              {kind === "all"
                ? "All"
                : kind === "workspace"
                  ? "Workspaces"
                  : "Agents"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="assistant-mention-close"
          aria-label="Close reference menu"
          onMouseDown={keepFocus}
          onClick={close}
        >
          <X size={13} />
        </button>
      </div>
      <div
        ref={list}
        id={id}
        role="listbox"
        aria-label="Workspace and agent references"
        aria-busy={loading}
        className="assistant-mention-options"
      >
        {candidates.map((target, index) => (
          <button
            type="button"
            role="option"
            id={`${id}-${index}`}
            key={assistantMentionKey(target)}
            tabIndex={-1}
            aria-selected={target === selected}
            disabled={loading || !targets}
            onMouseDown={keepFocus}
            onClick={() => select(target)}
          >
            {target.kind === "agent" ? <Bot size={15} /> : <Folder size={15} />}
            <span>
              <strong>{target.label}</strong>
              <small>
                {target.connection_label} &middot; {target.workspace_label}
                {target.kind === "agent"
                  ? ` / ${target.pane_id.slice(0, 8)}`
                  : ""}
              </small>
            </span>
            <span className="assistant-mention-kind">
              {target.kind === "agent" ? target.agent : "Workspace"}
            </span>
          </button>
        ))}
      </div>
      {loading ? (
        <p className="assistant-mention-notice" role="status">
          <LoaderCircle size={12} className="assistant-spinner" /> Loading
          references
        </p>
      ) : null}
      {!loading && !candidates.length && !errors.length ? (
        <p className="assistant-mention-notice" role="status">
          No matching references in authorized workspaces.
        </p>
      ) : null}
      {errors.map((error) => (
        <p className="assistant-mention-notice" role="status" key={error}>
          {error}
        </p>
      ))}
      {!loading && errors.length ? (
        <button
          type="button"
          className="assistant-mention-retry"
          onMouseDown={keepFocus}
          onClick={() => setRetry((count) => count + 1)}
        >
          <RefreshCw size={12} /> Retry
        </button>
      ) : null}
      {truncated ? (
        <p className="assistant-mention-notice" role="status">
          Some agents are omitted. Mention a workspace, then reopen Agents to
          narrow the list.
        </p>
      ) : null}
      <div className="assistant-mention-picker-foot">
        References add context. Actions follow Ranger permissions.
      </div>
    </div>
  ) : null;

  const chips: ReactNode =
    config && mentions.length ? (
      <div className="assistant-mention-tray" aria-label="Message references">
        {mentions.map((mention) => (
          <span
            className="assistant-mention-chip"
            key={`${mention.start}:${assistantMentionKey(mention)}`}
          >
            <button
              type="button"
              title={`${mention.kind === "agent" ? mention.agent : "Workspace"} / ${mention.connection_label} / ${mention.workspace_label}`}
              onClick={() => config.onOpen(mention)}
            >
              {mention.kind === "agent" ? (
                <Bot size={12} />
              ) : (
                <Folder size={12} />
              )}
              <span>
                {mention.label}
                <small>
                  {mention.connection_label} / {mention.workspace_label}
                </small>
              </span>
            </button>
            <button
              type="button"
              aria-label={`Remove reference to ${mention.label}`}
              onMouseDown={keepFocus}
              onClick={() => {
                config.write(
                  draft,
                  mentions.filter((ref) => ref !== mention),
                );
                setChanged((count) => count + 1);
              }}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
    ) : null;

  // What the box says of the picker: a combobox with its list.
  const aria: Record<string, string> | undefined = enabled
    ? {
        role: "combobox",
        "aria-autocomplete": "list",
        "aria-expanded": String(open),
        ...(open ? { "aria-controls": id } : {}),
        ...(open && selected && targets && !loading
          ? { "aria-activedescendant": `${id}-${candidates.indexOf(selected)}` }
          : {}),
      }
    : undefined;

  return { enabled, open, update, hide, keys, toggle, popup, chips, aria };
}
