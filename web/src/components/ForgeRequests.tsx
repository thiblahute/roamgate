import { ChevronDown, GitPullRequest, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type ForgePipelineStatus,
  type ForgeProvider,
  type ForgeRef,
  forgeRefLabel,
} from "../../../shared/forge";
import type {
  ConversationRequest,
  ConversationRequestGroup,
} from "../forgeRefs";
import {
  forgeAgeLabel,
  forgeStore,
  useForgeHolds,
  useForgePipelines,
  useForgeStatus,
} from "../forgeStore";
import {
  ForgeChip,
  forgeChipState,
  openForgeReview,
  PipelineIcon,
  useForgeChat,
  useOnScreen,
} from "./ForgeChip";

const MENU_WIDTH = 380;
const EDGE = 16;

/** "MRs", "PRs" or "MRs / PRs", as the forges in the list call theirs. */
export function requestsNoun(
  providers: Iterable<ForgeProvider>,
  count: number,
): string {
  const set = new Set(providers);
  const one = count === 1;
  if (set.size === 1 && set.has("github")) return one ? "PR" : "PRs";
  if (set.size === 1) return one ? "MR" : "MRs";
  return one ? "MR / PR" : "MRs / PRs";
}

/** A popover under its button, closed by a click elsewhere or Escape. */
function usePopover() {
  const [place, setPlace] = useState<{ top: number; right: number } | null>(
    null,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const close = () => setPlace(null);
  const toggle = () => {
    const button = rootRef.current?.querySelector("button");
    if (place || !button) return close();
    const rect = button.getBoundingClientRect();
    const width = Math.min(MENU_WIDTH, window.innerWidth - 2 * EDGE);
    const right = Math.max(rect.right, EDGE + width);
    setPlace({ top: rect.bottom + 6, right: window.innerWidth - right });
  };
  useEffect(() => {
    if (!place) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      // The chips' hover cards live outside the menu.
      if (
        !rootRef.current?.contains(target) &&
        !target?.closest?.(".forge-card")
      )
        close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [place]);
  return { place, rootRef, toggle, close };
}

const SOURCE_LABEL: Record<ConversationRequest["sources"][number], string> = {
  branch: "branch",
  created: "created",
  mentioned: "mentioned",
};

/** One request in a list: repo · !N · state · pipeline, and its actions. */
function ForgeRow({
  forgeRef,
  root,
  tags,
  repoLabel,
}: {
  forgeRef: ForgeRef;
  root?: string;
  tags?: string[];
  repoLabel?: string;
}) {
  const chat = useForgeChat();
  const element = useRef<HTMLLIElement>(null);
  const onScreen = useOnScreen(element, "0px");
  const entry = useForgeStatus(
    chat?.client ?? null,
    forgeRef,
    onScreen,
    root ?? chat?.path ?? "",
  );
  const status = entry.status;
  const request = status?.state === "ready" ? status.request : undefined;
  const state = forgeChipState(entry);
  const checked = status?.fetchedAt ? forgeAgeLabel(status.fetchedAt) : "";
  const note = [
    state.detail ?? request?.title,
    checked ? `checked ${checked}${status?.stale ? ", refreshing" : ""}` : "",
  ]
    .filter(Boolean)
    .join(" - ");
  return (
    <li
      ref={element}
      className={`forge-row${status?.stale ? " is-stale" : ""}`}
    >
      <a
        className="forge-row-main"
        href={request?.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-disabled={!request}
        title={note}
      >
        <span className="forge-row-line">
          {repoLabel ? (
            <span className="forge-row-repo">{repoLabel}</span>
          ) : null}
          <span className="forge-row-ref">{forgeRefLabel(forgeRef, true)}</span>
          <span className={`forge-chip-state is-${state.tone}`}>
            {state.label || "…"}
          </span>
          {request?.pipeline ? (
            <PipelineIcon status={request.pipeline.status} />
          ) : null}
          {tags?.map((tag) => (
            <span key={tag} className="forge-row-tag">
              {tag}
            </span>
          ))}
        </span>
        {request?.title ? (
          <span className="forge-row-title">{request.title}</span>
        ) : null}
      </a>
      {request && forgeRef.provider === "gitlab" ? (
        <button
          type="button"
          className="forge-row-review"
          title="Review in Roamgate"
          onClick={() => void openForgeReview(chat, request.url, root)}
        >
          Review
        </button>
      ) : null}
    </li>
  );
}

function repoName(project: string): string {
  return project.split("/").pop() ?? project;
}

const PIPELINE_RANK: ForgePipelineStatus[] = [
  "failed",
  "running",
  "pending",
  "manual",
  "canceled",
  "success",
  "skipped",
];

/** The pipeline to show for several requests: the worst of them. */
function WorstPipeline({ refs }: { refs: ForgeRef[] }) {
  const chat = useForgeChat();
  const statuses = useForgePipelines(chat?.client ?? null, refs);
  const worst = PIPELINE_RANK.find((status) => statuses.includes(status));
  return worst ? <PipelineIcon status={worst} /> : null;
}

/**
 * The session's own requests, in the chat's header: one chip for the
 * branch of its repository, or "3 MRs" listing each when it works in
 * several.
 */
export function ForgeHeaderChips({
  branches,
}: {
  branches: { ref: ForgeRef; root: string; branch: string }[];
}) {
  const { place, rootRef, toggle } = usePopover();
  const chat = useForgeChat();
  // Several: their pipelines show in the one chip, so all are kept fresh.
  useForgeHolds(
    chat?.client ?? null,
    branches.length > 1
      ? branches.map(({ ref, root }) => ({ ref, path: root }))
      : [],
    true,
  );
  if (!branches.length) return null;
  if (branches.length === 1) {
    const [only] = branches;
    return (
      <span className="forge-header" title={`Branch ${only!.branch}`}>
        <ForgeChip forgeRef={only!.ref} root={only!.root} variant="header" />
      </span>
    );
  }
  const noun = requestsNoun(
    branches.map(({ ref }) => ref.provider),
    branches.length,
  );
  return (
    <div ref={rootRef} className="forge-header forge-menu-root">
      <button
        type="button"
        className="forge-header-many"
        aria-expanded={!!place}
        aria-label={`${branches.length} ${noun} for this session's branches`}
        title={`This session's branches have ${branches.length} ${noun}`}
        onClick={toggle}
      >
        <GitPullRequest size={13} aria-hidden />
        {branches.length}
        <span className="forge-header-noun">{noun}</span>
        <WorstPipeline refs={branches.map(({ ref }) => ref)} />
        <ChevronDown size={12} aria-hidden />
      </button>
      {place ? (
        <div
          className="forge-menu"
          role="menu"
          style={{ top: place.top, right: place.right, width: MENU_WIDTH }}
        >
          <h3>This session's branches</h3>
          <ul>
            {branches.map(({ ref, root, branch }) => (
              <ForgeRow
                key={`${ref.host}/${ref.project}#${ref.number}`}
                forgeRef={ref}
                root={root}
                repoLabel={repoName(ref.project)}
                tags={[branch]}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Every request of the conversation, by repository: its branches', those
 * it created and those it named. Each opens its page, or its review.
 */
export function ForgeRequestsMenu({
  groups,
}: {
  groups: ConversationRequestGroup[];
}) {
  const { place, rootRef, toggle } = usePopover();
  const chat = useForgeChat();
  const count = groups.reduce((sum, group) => sum + group.requests.length, 0);
  if (!count) return null;
  const noun = requestsNoun(
    groups.map((group) => group.project.provider),
    2,
  );
  let list: ReactNode = null;
  if (place)
    list = (
      <div
        className="forge-menu"
        role="menu"
        style={{ top: place.top, right: place.right, width: MENU_WIDTH }}
      >
        <div className="forge-menu-head">
          <h3>{noun} of this conversation</h3>
          <button
            type="button"
            className="forge-menu-refresh"
            title="Read these from the forge now"
            aria-label={`Refresh the ${noun} of this conversation`}
            onClick={() => {
              if (!chat?.client) return;
              for (const group of groups)
                for (const request of group.requests)
                  forgeStore.refresh(chat.client, request.ref);
            }}
          >
            <RefreshCw size={12} aria-hidden />
          </button>
        </div>
        {groups.map((group) => (
          <section key={group.key} className="forge-menu-group">
            <h4 title={`${group.project.host}/${group.project.project}`}>
              {group.project.project}
              <small>{group.project.host}</small>
            </h4>
            <ul>
              {group.requests.map((request) => (
                <ForgeRow
                  key={request.key}
                  forgeRef={request.ref}
                  root={request.root ?? group.root}
                  tags={request.sources.map((source) =>
                    source === "branch" && request.branch
                      ? request.branch
                      : SOURCE_LABEL[source],
                  )}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  return (
    <div ref={rootRef} className="forge-menu-root">
      <button
        type="button"
        className="agent-history-icon forge-menu-button"
        aria-label={`${noun} of this conversation: ${count}`}
        aria-expanded={!!place}
        title={`${noun} this conversation worked on, created or named`}
        onClick={toggle}
      >
        <GitPullRequest size={14} />
        <span>{count}</span>
      </button>
      {list}
    </div>
  );
}
