import { useState } from "react";
import { createPortal } from "react-dom";
import { CirclePause } from "lucide-react";
import type { LimitPause } from "../../../shared/limitResume";
import type { ConnectionClient } from "../api";
import {
  limitPauseWords,
  resumeLimitPause,
  skipLimitPause,
  useLimitPause,
} from "../limitPauses";
import { ActionsMenu, type ActionsMenuGroup } from "./ActionsMenu";
import "./LimitPauseChip.css";

type Answer = { ok: boolean; reason?: string };

/**
 * A paused session's actions: "Resume now", and "Don't resume" (or,
 * once chosen, "Resume at the reset"). `act` runs them and says how it
 * went.
 */
export function limitPauseGroup(
  pause: LimitPause,
  act: (what: "resume" | "skip" | "unskip") => void,
): ActionsMenuGroup {
  const resuming = pause.state === "resuming";
  return {
    label: "Usage limit",
    items: [
      {
        key: "limit-resume-now",
        label: "Resume now",
        detail: "Sends the resume message now",
        disabled: resuming,
        action: () => act("resume"),
      },
      ...(pause.state === "skipped"
        ? [
            {
              key: "limit-resume-unskip",
              label: "Resume at the reset",
              detail: "Undoes Don't resume",
              action: () => act("unskip"),
            },
          ]
        : pause.state === "off" || pause.state === "resumed"
          ? []
          : [
              {
                key: "limit-resume-skip",
                label: "Don't resume",
                detail: "It stays paused until you resume it",
                disabled: resuming,
                action: () => act("skip"),
              },
            ]),
    ],
  };
}

/** Runs a pause's action against its connection. */
export function runLimitPauseAction(
  client: ConnectionClient,
  paneId: string,
  what: "resume" | "skip" | "unskip",
): Promise<Answer> {
  return what === "resume"
    ? resumeLimitPause(client, paneId)
    : skipLimitPause(client, paneId, what === "skip");
}

/**
 * The pane's session a usage limit paused, in its toolbar (over the
 * terminal and over the chat, phone and desktop): "Paused · 1:41 AM",
 * the whole sentence in its title, its menu "Resume now" and "Don't
 * resume". Nothing when the session is not paused.
 */
export function LimitPauseChip({
  client,
  paneId,
  onError,
}: {
  client: ConnectionClient;
  paneId: string;
  onError?: (message: string) => void;
}) {
  const pause = useLimitPause(client.connectionId, paneId);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (!pause) return null;
  const words = limitPauseWords(pause);
  const act = (what: "resume" | "skip" | "unskip") => {
    setMenu(null);
    void runLimitPauseAction(client, paneId, what).then((result) => {
      if (!result.ok && result.reason) onError?.(result.reason);
    });
  };
  // A toolbar menu is narrow: the actions' words alone, details in titles.
  const group = limitPauseGroup(pause, act);
  const menuGroup = {
    ...group,
    items: group.items.map((item) => ({ ...item, detail: undefined })),
  };
  return (
    <>
      <button
        type="button"
        className={`terminal-pane-action is-labelled limit-pause-chip is-${pause.state}`}
        title={`${words.text}.\n${words.detail}`}
        aria-label={`${words.text}: options`}
        aria-haspopup="menu"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        <CirclePause size={13} aria-hidden="true" />
        <span>{words.short}</span>
      </button>
      {menu
        ? createPortal(
            <ActionsMenu
              x={menu.x}
              y={menu.y}
              header={{
                title: "Paused by the usage limit",
                subtitle: words.status,
              }}
              onClose={() => setMenu(null)}
              groups={[menuGroup]}
            />,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * The same, as a notice in a conversation's chat: the sentence and its
 * two buttons, where the phone's reader looks.
 */
export function LimitPauseNotice({
  client,
  paneId,
}: {
  client: ConnectionClient;
  paneId: string;
}) {
  const pause = useLimitPause(client.connectionId, paneId);
  const [error, setError] = useState<string | null>(null);
  if (!pause) return null;
  const words = limitPauseWords(pause);
  const group = limitPauseGroup(pause, (what) => {
    setError(null);
    void runLimitPauseAction(client, paneId, what).then((result) => {
      if (!result.ok) setError(result.reason ?? "It did not work");
    });
  });
  return (
    <div
      className="agent-history-chat-cut-off limit-pause-notice"
      role="status"
    >
      <span>
        <CirclePause size={13} aria-hidden="true" /> {words.text}.{" "}
        <span className="muted">{words.detail}</span>
        {error ? <span className="limit-pause-error"> {error}</span> : null}
      </span>
      {group.items.map((item) => (
        <button
          key={item.key}
          type="button"
          className="agent-history-chat-cut-off-continue"
          title={item.detail}
          disabled={item.disabled}
          onClick={item.action}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** A pane's pause in a list's detail line (" · Paused · 1:41 AM"). */
export function LimitPauseNote({
  connectionId,
  paneId,
}: {
  connectionId: string | null | undefined;
  paneId: string;
}) {
  const pause = useLimitPause(connectionId, paneId);
  if (!pause) return null;
  const words = limitPauseWords(pause);
  return (
    <span className="limit-pause-note" title={words.text}>
      {" · "}
      {words.short}
    </span>
  );
}

/**
 * The same over a terminal on a phone, whose pane toolbar is hidden: the
 * sentence and its buttons in a slim strip (the phone layout only).
 */
export function LimitPauseStrip({
  client,
  paneId,
}: {
  client: ConnectionClient;
  paneId: string;
}) {
  const pause = useLimitPause(client.connectionId, paneId);
  const [error, setError] = useState<string | null>(null);
  if (!pause) return null;
  const words = limitPauseWords(pause);
  const group = limitPauseGroup(pause, (what) => {
    setError(null);
    void runLimitPauseAction(client, paneId, what).then((result) => {
      if (!result.ok) setError(result.reason ?? "It did not work");
    });
  });
  return (
    <div
      className="terminal-limit-strip"
      role="status"
      title={`${words.text}.\n${words.detail}`}
    >
      <CirclePause size={14} aria-hidden="true" />
      <span>{error ?? words.text}</span>
      {group.items.map((item) => (
        <button
          key={item.key}
          type="button"
          title={item.detail}
          disabled={item.disabled}
          onClick={item.action}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
