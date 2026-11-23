import { ArrowLeft, Search } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  OpenedSession,
  SearchHit,
  SearchResult,
} from "../../../shared/archiveSearch";
import { bridge } from "../api";
import { CloseButton } from "./CloseButton";
import { focusDialogElement } from "./dialogFocus";
import "./ArchiveSearch.css";

/** A search of tool output reads every transcript: minutes, not seconds. */
const SLOW_TIMEOUT_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 60 * 1000;
const AGENTS = ["claude", "codex", "pi"];
const DOT = " \u00b7 ";

type Load =
  | { state: "idle" }
  | { state: "searching"; started: number; slow: boolean }
  | { state: "ready"; result: SearchResult }
  | { state: "error"; message: string };

type Opened = {
  hit: SearchHit;
  raw: boolean;
  load:
    | { state: "loading" }
    | { state: "ready"; session: OpenedSession | null }
    | { state: "error"; message: string };
};

/** A snippet with its [matches] marked. */
export function markedSnippet(snippet: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const match of snippet.matchAll(/\[([^\]\n]+)\]/g)) {
    const index = match.index ?? 0;
    if (index > at) out.push(snippet.slice(at, index));
    out.push(<mark key={index}>{match[1]}</mark>);
    at = index + match[0].length;
  }
  if (at < snippet.length) out.push(snippet.slice(at));
  return out;
}

function shortProject(project: string): string {
  const parts = project.split(/-+/).filter(Boolean);
  return parts.slice(-2).join("/") || project;
}

function when(ts: string | null): string {
  return ts ? ts.slice(0, 16).replace("T", " ") : "";
}

function Elapsed({ started }: { started: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <>{Math.floor((now - started) / 1000)} s</>;
}

export function ArchiveSearch({
  onClose,
  initialQuery = "",
}: {
  onClose: () => void;
  initialQuery?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hitRef = useRef<HTMLLIElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [regex, setRegex] = useState(false);
  const [recent, setRecent] = useState(false);
  const [toolOutput, setToolOutput] = useState(false);
  const [host, setHost] = useState("");
  const [agent, setAgent] = useState("");
  const [project, setProject] = useState("");
  const [since, setSince] = useState("");
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const [opened, setOpened] = useState<Opened | null>(null);
  const request = useRef(0);

  useEffect(() => focusDialogElement(inputRef.current), []);

  const search = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      const text = query.trim();
      if (!text) return;
      const id = ++request.current;
      setOpened(null);
      setLoad({ state: "searching", started: Date.now(), slow: toolOutput });
      try {
        const result: SearchResult = await bridge.call(
          "bridge.archive.search",
          {
            query: text,
            regex,
            recent,
            tool_output: toolOutput,
            ...(host.trim() ? { host: host.trim() } : {}),
            ...(agent ? { agent } : {}),
            ...(project.trim() ? { project: project.trim() } : {}),
            ...(since ? { since } : {}),
            limit: 50,
          },
          toolOutput ? SLOW_TIMEOUT_MS : TIMEOUT_MS,
        );
        if (id === request.current) setLoad({ state: "ready", result });
      } catch (error) {
        if (id === request.current)
          setLoad({ state: "error", message: (error as Error).message });
      }
    },
    [query, regex, recent, toolOutput, host, agent, project, since],
  );

  const open = useCallback(async (hit: SearchHit, raw: boolean) => {
    if (!hit.key) return;
    setOpened({ hit, raw, load: { state: "loading" } });
    try {
      const session: OpenedSession | null = await bridge.call(
        "bridge.archive.open",
        { key: hit.key, line: hit.doc, raw },
        TIMEOUT_MS,
      );
      setOpened({ hit, raw, load: { state: "ready", session } });
    } catch (error) {
      setOpened({
        hit,
        raw,
        load: { state: "error", message: (error as Error).message },
      });
    }
  }, []);

  useEffect(() => {
    if (opened?.load.state === "ready")
      hitRef.current?.scrollIntoView({ block: "center" });
  }, [opened]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (opened) setOpened(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, opened]);

  const result = load.state === "ready" ? load.result : null;

  return (
    <div
      className="modal-backdrop archive-search-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal archive-search"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Search past sessions"
      >
        <div className="modal-head">
          <div>
            <h2>Search past sessions</h2>
            <p>Every machine's agent conversations, deleted ones included</p>
          </div>
          <CloseButton onClick={onClose} />
        </div>
        <form className="archive-search-form" onSubmit={search}>
          <div className="archive-search-query">
            <input
              ref={inputRef}
              type="search"
              value={query}
              placeholder={
                regex ? "A Perl regex" : 'Words, "a phrase", OR, NOT'
              }
              aria-label="Search for"
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="submit" className="primary" disabled={!query.trim()}>
              <Search size={15} aria-hidden="true" />
              Search
            </button>
          </div>
          <div className="archive-search-options">
            <label>
              <input
                type="checkbox"
                checked={recent}
                onChange={(event) => setRecent(event.target.checked)}
              />
              Newest first
            </label>
            <label>
              <input
                type="checkbox"
                checked={regex}
                onChange={(event) => setRegex(event.target.checked)}
              />
              Regex
            </label>
            <label title="Reads every archived transcript: a minute or more">
              <input
                type="checkbox"
                checked={toolOutput}
                onChange={(event) => setToolOutput(event.target.checked)}
              />
              Include tool output (slow)
            </label>
          </div>
          <div className="archive-search-filters">
            <input
              value={host}
              placeholder="Machine"
              aria-label="Machine"
              onChange={(event) => setHost(event.target.value)}
            />
            <select
              value={agent}
              aria-label="Agent"
              onChange={(event) => setAgent(event.target.value)}
            >
              <option value="">Any agent</option>
              {AGENTS.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <input
              value={project}
              placeholder="Project"
              aria-label="Project"
              onChange={(event) => setProject(event.target.value)}
            />
            <input
              type="date"
              value={since}
              aria-label="Since"
              title="Since"
              onChange={(event) => setSince(event.target.value)}
            />
          </div>
        </form>
        <div className="archive-search-body">
          {opened ? (
            <OpenedView
              opened={opened}
              hitRef={hitRef}
              onBack={() => setOpened(null)}
            />
          ) : load.state === "searching" ? (
            <p className="archive-search-note" role="status">
              {load.slow
                ? "Reading every archived transcript for tool output: this is slow. "
                : "Searching... "}
              <Elapsed started={load.started} />
            </p>
          ) : load.state === "error" ? (
            <p className="archive-search-note is-error" role="alert">
              {load.message}
            </p>
          ) : result ? (
            <>
              <p className="archive-search-note">
                {result.sessions ?? result.hits.length} session(s),{" "}
                {result.total} matching message(s)
                {result.truncated ? `, the first ${result.hits.length}` : ""}
                {result.warning ? `. ${result.warning}` : ""}
              </p>
              <ul className="archive-search-hits">
                {result.hits.map((hit) => (
                  <li key={`${hit.key ?? hit.session}:${hit.doc}`}>
                    <button
                      type="button"
                      className="archive-search-hit"
                      disabled={!hit.key}
                      onClick={() => void open(hit, result.source === "raw")}
                    >
                      <span className="archive-search-hit-title">
                        {hit.title ?? hit.session}
                        {hit.subagent ? " (subagent)" : ""}
                      </span>
                      <span className="archive-search-hit-meta">
                        {hit.host}
                        {DOT}
                        {hit.agent}
                        {DOT}
                        <span title={hit.project}>
                          {shortProject(hit.project)}
                        </span>
                        {DOT}
                        {when(hit.ts)}
                        {hit.matches ? `${DOT}${hit.matches} match(es)` : ""}
                      </span>
                      {(hit.snippets?.length
                        ? hit.snippets
                        : [hit.snippet]
                      ).map((snippet, index) => (
                        <span key={index} className="archive-search-snippet">
                          {markedSnippet(snippet)}
                        </span>
                      ))}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="archive-search-note">
              Conversation text and tool calls are searched; tool output only
              when asked.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function OpenedView({
  opened,
  hitRef,
  onBack,
}: {
  opened: Opened;
  hitRef: React.RefObject<HTMLLIElement | null>;
  onBack: () => void;
}) {
  const { load, hit } = opened;
  const session = load.state === "ready" ? load.session : null;
  return (
    <div className="archive-search-opened">
      <div className="archive-search-opened-head">
        <button type="button" onClick={onBack}>
          <ArrowLeft size={15} aria-hidden="true" />
          Results
        </button>
        <span>
          {hit.title ?? hit.session}
          {DOT}
          {hit.host}
          {DOT}
          {hit.agent}
          {session?.cwd ? `${DOT}${session.cwd}` : ""}
        </span>
      </div>
      {load.state === "loading" ? (
        <p className="archive-search-note">Opening...</p>
      ) : load.state === "error" ? (
        <p className="archive-search-note is-error" role="alert">
          {load.message}
        </p>
      ) : !session ? (
        <p className="archive-search-note">This session cannot be opened.</p>
      ) : (
        <ol className="archive-search-records">
          {session.before ? <li className="archive-search-more">...</li> : null}
          {session.records.map((record) => (
            <li
              key={record.line}
              ref={record.hit ? hitRef : undefined}
              className={record.hit ? "is-hit" : undefined}
            >
              {record.messages.map((message, index) => (
                <div
                  key={index}
                  className={`archive-search-message role-${message.role}`}
                >
                  <span className="archive-search-message-head">
                    {when(record.ts)} {message.role}
                    {message.kind !== "text" ? ` ${message.kind}` : ""}
                    {message.tool ? ` ${message.tool}` : ""}
                  </span>
                  <span className="archive-search-message-text">
                    {message.text}
                  </span>
                </div>
              ))}
            </li>
          ))}
          {session.after ? <li className="archive-search-more">...</li> : null}
        </ol>
      )}
    </div>
  );
}
