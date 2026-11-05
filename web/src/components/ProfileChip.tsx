import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Gauge, TriangleAlert } from "lucide-react";
import type { ConnectionClient } from "../api";
import {
  activeLimit,
  resetTime,
  retrySession,
  useSessionProfile,
} from "../sessionProfiles";
import { ActionsMenu, type ActionsMenuGroup } from "./ActionsMenu";
import "./ProfileChip.css";

/**
 * The pane session's agent profile, compact enough for a chat's header
 * row: a chip with its model when it is not the default (so the user sees
 * what they spend on), a "Run with:" menu for the other profiles, and,
 * when the session stopped on a usage limit, "Limit · 5:20 PM" (the whole
 * message in its title; its menu offers Retry and Continue with each
 * profile) and a short "Use <profile>" for the likeliest one.
 */
export function ProfileChip({
  client,
  paneId,
  enabled,
  agentStatus,
  onError,
}: {
  client: ConnectionClient;
  paneId: string;
  /** The pane runs a Claude (terminal or conversation mode). */
  enabled: boolean;
  agentStatus: string | undefined;
  onError?: (message: string) => void;
}) {
  const profile = useSessionProfile(client, paneId, enabled, agentStatus);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const room = usePaneRoom(chipRef);
  const data = profile.data;
  if (!enabled || !data?.session_id || data.profiles.length < 2) return null;
  const current = data.profile ?? data.default;
  const notDefault = current !== data.default;
  const others = data.profiles.filter((each) => each.name !== current);
  const limit = activeLimit(profile);
  // The likeliest way on: back to the default, else the first other.
  const next =
    others.find((each) => each.default && notDefault) ?? others[0] ?? null;
  const report = (result: { ok: boolean; reason?: string }) => {
    if (!result.ok && result.reason) onError?.(result.reason);
  };
  const run = (name: string, afterLimit: boolean) => {
    void profile
      .switchTo(name, afterLimit ? limit?.resets_at : null)
      .then(report);
  };
  const retry = () => void retrySession(client, paneId).then(report);
  const open = (event: React.MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  const resets = limit ? resetTime(limit) : "";
  const limitTitle = limit
    ? `${limit.message}${resets ? `\nResets ${resets} here.` : ""}`
    : "";
  const shown = profileParts(
    room,
    !!limit,
    !!next,
    notDefault || !!profile.switching,
  );
  const label = !shown.chipLabel
    ? null
    : profile.switching
      ? `${profile.switching}...`
      : notDefault
        ? (data.label ?? current)
        : null;
  const groups: ActionsMenuGroup[] = [
    ...(limit
      ? [
          {
            label: resets ? `Usage limit, resets ${resets}` : "Usage limit",
            items: [
              {
                key: "retry",
                label: `Retry with ${current}`,
                detail: "Sends continue (the limit may be over)",
                disabled: !!profile.switching,
                action: () => {
                  setMenu(null);
                  retry();
                },
              },
              ...others.map((each) => ({
                key: `continue-${each.name}`,
                label: `Continue with ${each.name}`,
                ...(each.label !== each.name ? { detail: each.label } : {}),
                disabled: !!profile.switching,
                action: () => {
                  setMenu(null);
                  run(each.name, !each.default);
                },
              })),
            ],
          },
        ]
      : []),
    {
      label: "Run with",
      items: data.profiles.map((each) => ({
        key: each.name,
        label: `Run with: ${each.name}`,
        detail:
          each.label !== each.name
            ? `${each.label}${each.default ? ", default" : ""}`
            : each.default
              ? "Default"
              : undefined,
        disabled: each.name === current || !!profile.switching,
        action: () => {
          setMenu(null);
          run(each.name, false);
        },
      })),
    },
  ];
  return (
    <>
      {limit ? (
        <>
          <button
            type="button"
            className="terminal-pane-action is-labelled profile-limit"
            title={limitTitle}
            aria-label={`Usage limit hit${resets ? `, resets ${resets}` : ""}: options`}
            aria-haspopup="menu"
            onClick={open}
          >
            <TriangleAlert size={13} aria-hidden="true" />
            {shown.limitLabel ? (
              <span>{resets ? `Limit · ${resets}` : "Limit"}</span>
            ) : null}
          </button>
          {next && shown.next ? (
            <button
              type="button"
              className="terminal-pane-action is-labelled profile-next"
              title={`Continue with ${next.name}${next.label !== next.name ? ` (${next.label})` : ""}`}
              aria-label={`Continue with ${next.name}`}
              disabled={!!profile.switching}
              onClick={() => run(next.name, !next.default)}
            >
              <span>Use {next.name}</span>
            </button>
          ) : null}
        </>
      ) : null}
      <button
        ref={chipRef}
        type="button"
        className={`terminal-pane-action profile-chip${label ? " is-labelled is-other" : ""}`}
        title={
          notDefault
            ? `Runs with the ${current} profile (${data.label ?? current}); default: ${data.default}${data.returns_at ? `. Back to ${data.returns_to} at ${new Date(data.returns_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}`
            : `Runs with the ${current} profile`
        }
        aria-label={
          notDefault ? `Profile: ${current}` : "Run with another profile"
        }
        aria-haspopup="menu"
        onClick={open}
      >
        <Gauge size={14} aria-hidden="true" />
        {label ? <span>{label}</span> : null}
      </button>
      {menu
        ? createPortal(
            <ActionsMenu
              x={menu.x}
              y={menu.y}
              header={{ title: "Profile", subtitle: `Now: ${current}` }}
              onClose={() => setMenu(null)}
              groups={groups}
            />,
            document.body,
          )
        : null}
    </>
  );
}

/** Rough widths (px) of what the profile adds to the pane's toolbar. */
const WIDTH = { limitLabel: 115, next: 95, chipLabel: 85 };

/**
 * What fits beside the chat header's own content, most useful first: the
 * limit's reset time, the "Use <profile>" shortcut, the profile's model.
 * Everything stays in the menu and the titles. In Zen the header's middle
 * is under Zen's tab, so only the pane's right half (less what the header
 * keeps there) is room.
 */
export function profileParts(
  room: number,
  limit: boolean,
  next: boolean,
  chipLabel: boolean,
) {
  let left = room;
  const take = (wanted: boolean, width: number) => {
    if (!wanted || left < width) return false;
    left -= width;
    return true;
  };
  const limitLabel = take(limit, WIDTH.limitLabel);
  return {
    limitLabel,
    next: take(limit && next, WIDTH.next),
    chipLabel: take(chipLabel, WIDTH.chipLabel),
  };
}

/** The room (px) the pane gives the profile's words, kept up to date. */
function usePaneRoom(ref: React.RefObject<HTMLElement | null>): number {
  const [room, setRoom] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const toolbar = ref.current?.closest(".terminal-pane-toolbar");
    const pane = toolbar?.parentElement;
    if (!pane) return;
    const measure = () => {
      const width = pane.getBoundingClientRect().width;
      const zen = !!pane.closest(".app.zen");
      // Zen: its tab hangs over the middle; the header's actions (about
      // 160px) and the toolbar's icons (about 120px) need the right half.
      setRoom(Math.max(0, zen ? width / 2 - 300 : width - 620));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  });
  return room;
}
