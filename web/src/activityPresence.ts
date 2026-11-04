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

/** Input this recent made a change of view: the user did it. */
export const CAUSE_INPUT_MS = 5_000;

/** Why a report is sent: the recorder turns it into the events' cause. */
export type ReportCause =
  | "user_input"
  | "user_focus"
  | "page_load"
  | "follow_herdr"
  | "app"
  | "repeat";

/**
 * Tells the bridge's activity recorder where this browser's attention is:
 * the workspace and pane on screen, whether the page is visible and
 * focused, how long ago the user last gave input (keys, pointer, wheel,
 * touch: when, never what), and what caused each change. It reports each
 * change, and again every minute while the user looks and is not idle; the
 * bridge ends the span when the reports stop.
 *
 * Only a person counts: a page that loads or reloads has no input yet
 * (`input_age_ms` null, cause `page_load`), even when it opens in front.
 * Bringing the page to the front counts as input once the page has had
 * some. A view that moves without input follows Herdr (shared navigation)
 * or Roamgate itself, and says so. When the bridge answers that a report
 * was no attention, the next input is reported at once. Nothing is sent
 * once the bridge says it is not recording. Returns the function that
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
  /** The last sign of the user: input, or the page brought to the front. */
  let lastInput: number | null = null;
  /** The last key, pointer, wheel or touch. */
  let lastRealInput: number | null = null;
  let idleSeconds = DEFAULT_IDLE_SECONDS;
  let recording = true;
  let stopped = false;
  /** Whether the bridge counted the last report as attention. */
  let attending = false;
  let asking = false;
  let lastKey: string | null = null;
  let lastWhere: string | null = null;
  let repeatTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const looking = () => doc.visibilityState === "visible" && doc.hasFocus();
  const idle = () =>
    lastInput !== null && now() - lastInput >= idleSeconds * 1000;
  const where = () => {
    const snapshot = getSnapshot();
    return {
      workspace_id: snapshot.layout?.workspace_id ?? null,
      tab_id: snapshot.layout?.tab_id ?? null,
      pane_id: paneShown ? (activePaneIdForSnapshot(snapshot) ?? null) : null,
    };
  };
  const key = () => JSON.stringify([where(), looking(), idle()]);
  /** Before any input, whatever happens is the page loading. */
  const loaded = (cause: ReportCause): ReportCause =>
    lastRealInput === null ? "page_load" : cause;

  function clearTimers() {
    if (repeatTimer) clearTimeout(repeatTimer);
    if (idleTimer) clearTimeout(idleTimer);
    repeatTimer = idleTimer = null;
  }

  function armIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (stopped || !recording || !looking() || idle() || lastInput === null)
      return;
    idleTimer = setTimeout(
      () => {
        idleTimer = null;
        // Input since then moved the threshold: wait for the new one.
        if (idle()) send("repeat");
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
      if (looking() && !idle()) send("repeat");
    }, PRESENCE_REPEAT_MS);
    armIdle();
  }

  function send(cause: ReportCause) {
    if (stopped || !recording) return;
    lastKey = key();
    lastWhere = JSON.stringify(where());
    asking = true;
    void client
      .call(
        "activity.presence",
        {
          client_id: clientId,
          client_kind: clientKind,
          ...where(),
          visible: doc.visibilityState === "visible",
          focused: doc.hasFocus(),
          input_age_ms:
            lastInput === null ? null : Math.max(0, now() - lastInput),
          cause: loaded(cause),
        },
        10_000,
      )
      .then(
        (reply: {
          recording?: unknown;
          idle_seconds?: unknown;
          attention?: unknown;
        }) => {
          asking = false;
          if (stopped) return;
          // A bridge older than causes does not say: as good as yes.
          attending = reply?.attention !== false;
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
        },
      )
      .catch(() => {
        asking = false;
      });
    schedule();
  }

  const changed = () => {
    if (key() === lastKey) return;
    if (JSON.stringify(where()) === lastWhere) {
      send("repeat");
      return;
    }
    const at = now();
    const byInput =
      lastRealInput !== null && at - lastRealInput <= CAUSE_INPUT_MS;
    send(
      byInput
        ? "user_input"
        : getSnapshot().navigationMode === "shared"
          ? "follow_herdr"
          : "app",
    );
  };
  const onInput = () => {
    const wasIdle = idle();
    lastInput = lastRealInput = now();
    if (wasIdle || (!attending && !asking && looking())) send("user_input");
  };
  const onAttention = () => {
    // Brought to the front by the user, once the page has seen them.
    if (looking() && lastRealInput !== null) lastInput = now();
    if (key() !== lastKey) send("user_focus");
  };

  const off = subscribe(changed);
  for (const type of INPUT_EVENTS)
    doc.addEventListener(type, onInput, { capture: true, passive: true });
  win.addEventListener("focus", onAttention);
  win.addEventListener("blur", onAttention);
  doc.addEventListener("visibilitychange", onAttention);
  // A hidden page has nothing to say yet; it speaks when it is looked at.
  if (looking()) send("page_load");
  else {
    lastKey = key();
    lastWhere = JSON.stringify(where());
  }
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
