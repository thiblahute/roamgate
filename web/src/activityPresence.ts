import type { ConnectionClient } from "./api";
import { roamgateLocalStorage } from "./browserStorage";
import { activePaneIdForSnapshot } from "./paneJump";
import type { store } from "./store";

type Snapshot = ReturnType<typeof store.get>;

/** While the user looks, presence is said again this often. */
export const PRESENCE_REPEAT_MS = 60_000;
const DEFAULT_IDLE_SECONDS = 300;
const INPUT_EVENTS = ["keydown", "pointerdown", "wheel", "touchstart"];
const CLIENT_ID_KEY = "activityClientId";
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type ClientKind = "desktop" | "phone";

/** This browser's id in the activity log, kept across reloads. */
export function activityClientId(
  storage: Pick<Storage, "getItem" | "setItem"> = roamgateLocalStorage,
  random: () => string = () => crypto.randomUUID(),
): string {
  const saved = storage.getItem(CLIENT_ID_KEY);
  if (saved && CLIENT_ID_RE.test(saved)) return saved;
  const id =
    random()
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 64) || "client";
  try {
    storage.setItem(CLIENT_ID_KEY, id);
  } catch {
    // Without storage the id lasts as long as the page.
  }
  return id;
}

export function activityClientKind(
  nav: Pick<Navigator, "userAgent"> & {
    userAgentData?: { mobile?: boolean };
  } = navigator,
): ClientKind {
  const mobile = nav.userAgentData?.mobile;
  if (typeof mobile === "boolean") return mobile ? "phone" : "desktop";
  return /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent)
    ? "phone"
    : "desktop";
}

/**
 * Tells the bridge's activity recorder where this browser's attention is:
 * the workspace and pane on screen, whether the page is visible and
 * focused, and how long ago the user last gave input (keys, pointer, wheel,
 * touch: when, never what). It reports each change, and again every minute
 * while the user looks and is not idle; the bridge ends the span when the
 * reports stop. Bringing the page to the front counts as input. Nothing is
 * sent once the bridge says it is not recording. Returns the function that
 * stops watching.
 */
export function watchActivityPresence({
  client,
  clientId,
  clientKind,
  paneShown,
  getSnapshot,
  subscribe,
  win,
  doc,
  now = Date.now,
}: {
  client: Pick<ConnectionClient, "call">;
  clientId: string;
  clientKind: ClientKind;
  /** False when a phone shows another view than the pane. */
  paneShown: boolean;
  getSnapshot: () => Snapshot;
  subscribe: (listener: () => void) => () => void;
  win: Pick<Window, "addEventListener" | "removeEventListener">;
  doc: Pick<
    Document,
    "visibilityState" | "hasFocus" | "addEventListener" | "removeEventListener"
  >;
  now?: () => number;
}): () => void {
  let lastInput = now();
  let idleSeconds = DEFAULT_IDLE_SECONDS;
  let recording = true;
  let stopped = false;
  let lastKey: string | null = null;
  let repeatTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const looking = () => doc.visibilityState === "visible" && doc.hasFocus();
  const idle = () => now() - lastInput >= idleSeconds * 1000;
  const where = () => {
    const snapshot = getSnapshot();
    return {
      workspace_id: snapshot.layout?.workspace_id ?? null,
      tab_id: snapshot.layout?.tab_id ?? null,
      pane_id: paneShown ? (activePaneIdForSnapshot(snapshot) ?? null) : null,
    };
  };
  const key = () => JSON.stringify([where(), looking(), idle()]);

  function clearTimers() {
    if (repeatTimer) clearTimeout(repeatTimer);
    if (idleTimer) clearTimeout(idleTimer);
    repeatTimer = idleTimer = null;
  }

  function armIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (stopped || !recording || !looking() || idle()) return;
    idleTimer = setTimeout(
      () => {
        idleTimer = null;
        // Input since then moved the threshold: wait for the new one.
        if (idle()) send();
        else armIdle();
      },
      lastInput + idleSeconds * 1000 - now(),
    );
  }

  function schedule() {
    clearTimers();
    if (stopped || !recording || !looking() || idle()) return;
    repeatTimer = setTimeout(() => {
      repeatTimer = null;
      if (looking() && !idle()) send();
    }, PRESENCE_REPEAT_MS);
    armIdle();
  }

  function send() {
    if (stopped || !recording) return;
    lastKey = key();
    void client
      .call(
        "activity.presence",
        {
          client_id: clientId,
          client_kind: clientKind,
          ...where(),
          visible: doc.visibilityState === "visible",
          focused: doc.hasFocus(),
          input_age_ms: Math.max(0, now() - lastInput),
        },
        10_000,
      )
      .then((reply: { recording?: unknown; idle_seconds?: unknown }) => {
        if (stopped) return;
        if (reply?.recording === false) {
          recording = false;
          clearTimers();
          return;
        }
        if (
          typeof reply?.idle_seconds === "number" &&
          reply.idle_seconds > 0 &&
          reply.idle_seconds !== idleSeconds
        ) {
          idleSeconds = reply.idle_seconds;
          armIdle();
        }
      })
      .catch(() => undefined);
    schedule();
  }

  const changed = () => {
    if (key() !== lastKey) send();
  };
  const onInput = () => {
    const wasIdle = idle();
    lastInput = now();
    if (wasIdle) send();
  };
  const onAttention = () => {
    if (looking()) lastInput = now();
    changed();
  };

  const off = subscribe(changed);
  for (const type of INPUT_EVENTS)
    doc.addEventListener(type, onInput, { capture: true, passive: true });
  win.addEventListener("focus", onAttention);
  win.addEventListener("blur", onAttention);
  doc.addEventListener("visibilitychange", onAttention);
  // A hidden page has nothing to say yet; it speaks when it is looked at.
  if (looking()) send();
  else lastKey = key();
  return () => {
    stopped = true;
    clearTimers();
    off();
    for (const type of INPUT_EVENTS)
      doc.removeEventListener(type, onInput, { capture: true });
    win.removeEventListener("focus", onAttention);
    win.removeEventListener("blur", onAttention);
    doc.removeEventListener("visibilitychange", onAttention);
  };
}
