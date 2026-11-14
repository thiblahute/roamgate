import {
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  CircleDot,
  GitPullRequest,
  RefreshCw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  pullRequestUnavailable,
  type PullRequestStatus,
} from "../../../shared/pullRequest";
import { type ConnectionClient, bridge } from "../api";
import { useConnectionReady } from "../useConnectionClient";
import { ThemedSelect } from "./ThemedSelect";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import "./PullRequestCard.css";

/** The last status each branch's card showed, for the next time it opens. */
const cardMemo = new Map<string, PullRequestStatus>();
const CARD_MEMO_KEPT = 100;

function rememberCard(key: string, status: PullRequestStatus) {
  cardMemo.delete(key);
  cardMemo.set(key, status);
  if (cardMemo.size > CARD_MEMO_KEPT)
    cardMemo.delete(cardMemo.keys().next().value as string);
}

export function PullRequestCard({
  client,
  workspaceId,
  branch,
  compact = false,
  onRequest,
}: {
  client: ConnectionClient;
  workspaceId: string;
  branch?: string;
  /** The request shown (its remote as chosen), null when none. */
  onRequest?: (url: string | null) => void;
  /**
   * The review in Changes: one slim line, and nothing at all when there
   * is no provider, no request or no branch to tell about.
   */
  compact?: boolean;
}) {
  const ready = useConnectionReady(client);
  const [remote, setRemote] = useState("");
  const [match, setMatch] = useState("");
  const [refresh, setRefresh] = useState(0);
  // What this branch's card showed last time is shown at once, whatever
  // the server needs to read again; the answer replaces it.
  const memoKey = `${client.connectionId}\u0000${workspaceId}\u0000${branch ?? ""}`;
  const [remembered] = useState(() => cardMemo.get(memoKey) ?? null);
  const [status, setStatus] = useState<PullRequestStatus | null>(remembered);
  const [stale, setStale] = useState<PullRequestStale | null>(null);
  const [error, setError] = useState("");
  const [finishedAt, setFinishedAt] = useState(remembered?.refreshedAt ?? "");
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  // A click on refresh reads the forge now, whatever the cache says.
  const forced = useRef(false);
  // The host remounts this card when its workspace, branch or connection
  // changes; remote/match selections reset this explicitly.
  const lastGood = useRef<PullRequestStatus | null>(
    remembered?.state === "ready" ? remembered : null,
  );
  // What another device or a background read taught the server is pushed.
  useEffect(
    () =>
      bridge.onForgeCache((push) => {
        if (push.kind !== "card" || remote || match) return;
        const value = push.status;
        if (value.state !== "ready" && value.state !== "no_match") return;
        if (value.branch !== (branch ?? value.branch)) return;
        if (!status?.root || value.root !== status.root) return;
        const known = {
          ...value,
          cached: { fetchedAt: push.fetchedAt, stale: false },
        };
        if (value.state === "ready") lastGood.current = known;
        rememberCard(memoKey, known);
        setStatus(known);
        setStale(null);
        setFinishedAt(push.fetchedAt);
      }),
    [memoKey, branch, remote, match, status?.root],
  );
  useEffect(() => {
    const request = ++sequence.current;
    setLoading(true);
    setError("");
    if (!ready) return;
    const fallBack = (failedAt: string, message?: string) => {
      const good = lastGood.current;
      if (!good) return false;
      setStatus(good);
      setStale({ failedAt, message });
      setFinishedAt(good.refreshedAt);
      return true;
    };
    const force = forced.current;
    forced.current = false;
    let again: ReturnType<typeof setTimeout> | undefined;
    void client
      .call(
        "git.pull_request",
        {
          workspace_id: workspaceId,
          ...(branch ? { branch } : {}),
          ...(remote ? { remote } : {}),
          ...(match ? { match } : {}),
          ...(force ? { refresh: true } : {}),
        },
        65_000,
      )
      .then((value: PullRequestStatus) => {
        if (sequence.current !== request || !client.isCurrent()) return;
        setLoading(false);
        if (
          pullRequestUnavailable(value) &&
          fallBack(value.refreshedAt, value.message)
        )
          return;
        lastGood.current = value.state === "ready" ? value : null;
        if (!remote && !match && !pullRequestUnavailable(value))
          rememberCard(memoKey, value);
        setStatus(value);
        setStale(null);
        setFinishedAt(value.cached?.fetchedAt ?? value.refreshedAt);
        // Known but old for the server, which is reading again: look again
        // soon in case the push got lost.
        if (value.cached?.stale)
          again = setTimeout(() => setRefresh((n) => n + 1), 15_000);
      })
      .catch(() => {
        if (sequence.current !== request || !client.isCurrent()) return;
        setLoading(false);
        const message =
          "PR/MR status unavailable. Check the connection and refresh.";
        if (fallBack(new Date().toISOString(), message)) return;
        setStatus(null);
        setStale(null);
        setError(message);
        setFinishedAt(new Date().toISOString());
      });
    return () => {
      sequence.current = request + 1;
      clearTimeout(again);
    };
  }, [client, ready, workspaceId, branch, remote, match, refresh, memoKey]);

  const current = client.isCurrent() ? status : null;
  const requestUrl =
    current?.state === "ready" ? (current.request?.url ?? null) : null;
  const onRequestRef = useRef(onRequest);
  onRequestRef.current = onRequest;
  useEffect(() => {
    onRequestRef.current?.(requestUrl);
  }, [requestUrl]);
  const reset = () => {
    sequence.current++;
    lastGood.current = null;
    setStatus(null);
    setStale(null);
    setError("");
    setFinishedAt("");
  };
  return (
    <PullRequestCardView
      compact={compact}
      current={current}
      loading={loading}
      stale={current ? stale : null}
      error={
        client.isCurrent() ? error : "Waiting for the connection to recover."
      }
      finishedAt={finishedAt}
      onRefresh={() => {
        forced.current = true;
        setRefresh((value) => value + 1);
      }}
      onRemoteChange={(value) => {
        reset();
        setRemote(value);
        setMatch("");
      }}
      onMatchChange={(value) => {
        reset();
        setMatch(value);
      }}
    />
  );
}

type PullRequestStale = { failedAt: string; message?: string };

export function PullRequestCardView({
  compact = false,
  current,
  loading,
  stale = null,
  error,
  finishedAt,
  onRefresh,
  onRemoteChange,
  onMatchChange,
}: {
  /** One slim line; nothing when there is nothing to tell (Changes' review). */
  compact?: boolean;
  current: PullRequestStatus | null;
  /** A request is pending; a shown status stays visible while it refreshes. */
  loading: boolean;
  /** The shown status is the last success; the latest refresh failed. */
  stale?: PullRequestStale | null;
  error: string;
  finishedAt: string;
  onRefresh: () => void;
  onRemoteChange: (value: string) => void;
  onMatchChange: (value: string) => void;
}) {
  /*
   * Compact, the card is a chip in a row that clips what overflows it: its
   * details open over the page (the app's), under the chip, as the review's
   * menus do, and the chip itself stays one line.
   */
  const [chipOpen, setChipOpen] = useState(false);
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  const pr = current?.state === "ready" ? current.request : undefined;
  if (
    compact &&
    !error &&
    (!current ||
      ["unsupported", "no_match", "detached"].includes(current.state))
  )
    return null;
  const provider =
    current?.provider === "github"
      ? "GitHub"
      : current?.provider === "gitlab"
        ? "GitLab"
        : "PR/MR";
  const label = error
    ? "Status unavailable"
    : current
      ? {
          ready: "Request found",
          select_remote: "Choose a source remote",
          select_match: "Choose a request",
          unsupported: "Provider not configured",
          missing_cli: "CLI setup needed",
          unauthenticated: "Authentication needed",
          no_match: "No linked request",
          detached: "No branch selected",
          error: "Status unavailable",
        }[current.state]
      : loading
        ? "Checking this branch..."
        : "Status unavailable";
  const needsAttention =
    !!error ||
    !!stale ||
    ["error", "missing_cli", "unauthenticated"].includes(current?.state ?? "");
  const message = error || stale?.message || current?.message;
  const staleLabel = stale
    ? `Refresh failed; showing last known status from ${new Date(current?.refreshedAt ?? stale.failedAt).toLocaleString()}`
    : "";
  const summary = (
    <summary
      className="pull-request-card-summary"
      onClick={
        compact
          ? (event) => {
              // The details open in the popover, never in the chip.
              event.preventDefault();
              setLayer(event.currentTarget.closest<HTMLElement>(".app"));
              setChipOpen((value) => !value);
            }
          : undefined
      }
    >
      <span className="pull-request-card-icon">
        <GitPullRequest size={17} aria-hidden="true" />
      </span>
      <span className="pull-request-card-heading">
        <span className="pull-request-card-eyebrow">
          {pr ? (
            <a
              className="pull-request-card-link"
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${provider} #${pr.number} in a new tab`}
              title={`Open on ${provider}`}
              onClick={(event) => event.stopPropagation()}
            >
              {provider} #{pr.number}
              <ArrowUpRight size={13} aria-hidden="true" />
            </a>
          ) : (
            `${provider} status`
          )}
        </span>
        <span
          className="pull-request-card-title"
          role="status"
          aria-live="polite"
        >
          {pr?.title ?? label}
        </span>
      </span>
      {pr ? (
        <span
          className="pull-request-card-badge"
          data-state={pr.draft ? "draft" : pr.state}
        >
          {pr.draft ? `Draft / ${pr.state}` : pr.state}
        </span>
      ) : null}
      {stale ? (
        <span
          className="pull-request-card-stale"
          title={staleLabel}
          aria-label={staleLabel}
          role="img"
        >
          Last known
        </span>
      ) : null}
      <ChevronRight
        className="pull-request-card-chevron"
        size={14}
        aria-hidden="true"
      />
      <button
        className="pull-request-card-refresh"
        type="button"
        title="Refresh PR/MR status"
        aria-label="Refresh PR/MR status"
        disabled={loading}
        onClick={(event) => {
          event.stopPropagation();
          onRefresh();
        }}
      >
        <RefreshCw size={14} aria-hidden="true" />
      </button>
    </summary>
  );
  const details = (
    <>
      {current ? (
        <PullRequestSelectors
          current={current}
          onRemoteChange={onRemoteChange}
          onMatchChange={onMatchChange}
        />
      ) : null}
      {pr ? (
        <div className="pull-request-card-signals">
          <div
            className="pull-request-card-route"
            aria-label="Source and target branches"
          >
            <code>{pr.source}</code>
            <ArrowRight size={13} aria-hidden="true" />
            <code>{pr.target}</code>
          </div>
          <dl>
            <div>
              <dt>
                <CircleDot size={12} aria-hidden="true" />
                {current?.provider === "github" ? "Checks" : "Pipeline"}
              </dt>
              <dd>{current?.ci ?? "Unavailable"}</dd>
            </div>
            <div>
              <dt>
                <CircleDot size={12} aria-hidden="true" />
                {current?.provider === "github"
                  ? "Review decision"
                  : "Approvals"}
              </dt>
              <dd>{current?.review ?? "Unavailable"}</dd>
            </div>
          </dl>
        </div>
      ) : null}
      {current || error || !loading ? (
        <details className="pull-request-card-context">
          <summary>
            <ChevronRight size={12} aria-hidden="true" />
            {message ? "Details & troubleshooting" : "Checkout details"}
          </summary>
          {message ? (
            <p className="pull-request-card-message">{message}</p>
          ) : null}
          <dl>
            {pr ? (
              <div>
                <dt>Author</dt>
                <dd>{pr.author}</dd>
              </div>
            ) : null}
            {current?.remotes.map((remote) => (
              <div key={remote.name}>
                <dt>Remote / {remote.name}</dt>
                <dd>
                  {remote.host}/{remote.repository}
                </dd>
              </div>
            ))}
            {current ? (
              <>
                <div>
                  <dt>Checkout</dt>
                  <dd>
                    <code>{current.root}</code>
                  </dd>
                </div>
                <div>
                  <dt>Branch</dt>
                  <dd>
                    <code>{current.branch || "Detached HEAD"}</code>
                    {current.rebasing ? " (rebase in progress)" : null}
                  </dd>
                </div>
              </>
            ) : null}
            {stale ? (
              <div>
                <dt>Last refresh failed</dt>
                <dd>
                  <time dateTime={stale.failedAt}>
                    {new Date(stale.failedAt).toLocaleString()}
                  </time>
                </dd>
              </div>
            ) : null}
            {finishedAt ? (
              <div>
                <dt>{stale ? "Last successful refresh" : "Last refreshed"}</dt>
                <dd>
                  <time dateTime={finishedAt}>
                    {new Date(finishedAt).toLocaleString()}
                  </time>
                </dd>
              </div>
            ) : null}
          </dl>
        </details>
      ) : null}
    </>
  );
  return (
    <section
      className={`pull-request-card${compact ? " is-compact" : ""}`}
      aria-label="Pull or merge request status"
      aria-busy={loading || undefined}
      data-attention={needsAttention || undefined}
      data-stale={stale ? true : undefined}
    >
      {compact ? (
        <Popover open={chipOpen} onOpenChange={setChipOpen}>
          <details className="pull-request-card-disclosure" open={false}>
            <PopoverTrigger asChild>{summary}</PopoverTrigger>
          </details>
          <PopoverContent
            container={layer}
            align="start"
            sideOffset={4}
            collisionPadding={8}
            className="pull-request-card pull-request-card-content is-chip-details"
            aria-label="Pull or merge request details"
            // The review's own keys stay out of the details.
            onKeyDown={(event) => event.stopPropagation()}
            onKeyUp={(event) => event.stopPropagation()}
          >
            {details}
          </PopoverContent>
        </Popover>
      ) : (
        <details className="pull-request-card-disclosure">
          {summary}
          <div className="pull-request-card-content">{details}</div>
        </details>
      )}
    </section>
  );
}

export function PullRequestSelectors({
  current,
  onRemoteChange,
  onMatchChange,
}: {
  current: PullRequestStatus;
  onRemoteChange: (value: string) => void;
  onMatchChange: (value: string) => void;
}) {
  const pr = current.state === "ready" ? current.request : undefined;
  return (
    <>
      {current.remotes.length > 1 || current.state === "select_remote" ? (
        <label>
          Source remote
          <ThemedSelect
            className="pull-request-card-remote-select"
            aria-label="Source remote"
            value={current.remote ?? ""}
            placeholder="Select remote"
            options={current.remotes.map((item) => ({
              value: item.name,
              label: `${item.name}: ${item.host}/${item.repository}`,
            }))}
            onChange={onRemoteChange}
          />
        </label>
      ) : null}
      {current.matches &&
      (current.matches.length > 1 || current.state === "select_match") ? (
        <label>
          Matching request
          <select
            value={pr?.id ?? ""}
            onChange={(event) => {
              onMatchChange(event.target.value);
            }}
          >
            <option value="" disabled>
              Select PR/MR
            </option>
            {current.matches.map((item) => (
              <option key={item.id} value={item.id}>
                #{item.number}: {item.title} ({item.state})
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </>
  );
}
