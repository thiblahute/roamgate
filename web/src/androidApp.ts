/**
 * The Roamgate Android app on this phone. Its Trusted Web Activity opens
 * the server at `/?roamgate_app=<versionCode>` (and Chrome gives such a
 * page the referrer `android-app://net.ts.roamgate`): the page keeps that
 * in localStorage, which the app's Trusted Web Activity and Chrome's tabs
 * share, so a call started in either can be handed to the app's native
 * call service (webrtcCall.ts's handOff). A handoff the app does not take
 * counts against it: after FORGET_AFTER in a row the page forgets the app
 * (uninstalled), until its next launch notes it again.
 *
 * The app may also show Roamgate in its own WebView, with a JavaScript
 * bridge `window.RoamgateApp` (appBridge): there the app is taken as
 * installed, and a call goes to it through the bridge, with no intent URL.
 */

export const ANDROID_APP_PACKAGE = "net.ts.roamgate";
/** The launch URL's parameter carrying the app's version code. */
export const APP_PARAM = "roamgate_app";
const KEY = "roamgate.androidApp";
/** Handoffs not taken in a row before the app is taken for gone. */
export const FORGET_AFTER = 3;

type Noted = { version: string; at: number; misses: number };

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const browserStore = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

function read(store: Store | null): Noted | null {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Noted>;
    if (typeof value.version !== "string") return null;
    return {
      version: value.version,
      at: typeof value.at === "number" ? value.at : 0,
      misses: typeof value.misses === "number" ? value.misses : 0,
    };
  } catch {
    return null;
  }
}

function write(store: Store | null, value: Noted | null) {
  try {
    if (value) store?.setItem(KEY, JSON.stringify(value));
    else store?.removeItem(KEY);
  } catch {
    // Private mode or storage full: the app is simply not known.
  }
}

/**
 * Notes the app when this page was opened by it (the launch parameter, or
 * its referrer), and takes the parameter out of the address bar. Run once
 * as the page loads.
 */
export function noteAndroidApp(
  page: {
    href: string;
    referrer: string;
    replace?: (url: string) => void;
  } = {
    href: globalThis.location?.href ?? "",
    referrer: globalThis.document?.referrer ?? "",
    replace: (url) => globalThis.history?.replaceState(null, "", url),
  },
  store: Store | null = browserStore(),
  now = Date.now(),
) {
  let url: URL;
  try {
    url = new URL(page.href);
  } catch {
    return;
  }
  const version = url.searchParams.get(APP_PARAM);
  const referred = page.referrer.startsWith(
    `android-app://${ANDROID_APP_PACKAGE}`,
  );
  if (version === null && !referred) return;
  write(store, {
    version: version || read(store)?.version || "?",
    at: now,
    misses: 0,
  });
  if (version !== null) {
    url.searchParams.delete(APP_PARAM);
    page.replace?.(`${url.pathname}${url.search}${url.hash}`);
  }
}

/** The JavaScript bridge of the app's WebView: it takes a call by itself. */
export type AppBridge = {
  /** Joins call `callId` with the single-use handoff `token`. */
  handOff(callId: string, token: string): void;
};

/**
 * The app's bridge when this page runs in the app's WebView
 * (`window.RoamgateApp` with a `handOff` function), else null.
 */
export function appBridge(scope: object = globalThis): AppBridge | null {
  const bridge = (scope as { RoamgateApp?: unknown }).RoamgateApp;
  if (typeof bridge === "undefined" || bridge === null) return null;
  return typeof (bridge as { handOff?: unknown }).handOff === "function"
    ? (bridge as AppBridge)
    : null;
}

/** Whether the app is on this phone, as far as the page knows. */
export function androidAppKnown(
  userAgent = globalThis.navigator?.userAgent ?? "",
  store: Store | null = browserStore(),
): boolean {
  return /Android/i.test(userAgent) && read(store) !== null;
}

/** The app took a handoff: its misses start again. */
export function androidAppTookCall(store: Store | null = browserStore()) {
  const noted = read(store);
  if (noted?.misses) write(store, { ...noted, misses: 0 });
}

/**
 * The app did not take a handoff: forgotten after FORGET_AFTER in a row.
 * True when it was forgotten now.
 */
export function androidAppMissedCall(
  store: Store | null = browserStore(),
): boolean {
  const noted = read(store);
  if (!noted) return false;
  const misses = noted.misses + 1;
  if (misses >= FORGET_AFTER) {
    write(store, null);
    return true;
  }
  write(store, { ...noted, misses });
  return false;
}

/**
 * The intent URL that opens the app's call service on call `call` with
 * `handoff` (`/call/<id>?handoff=...` on the server of `base`, this
 * page's URL). Its package is
 * named, so only the app takes it, verified links or not; without the
 * app nothing opens and the call goes on in the page. The parameter is
 * not `token`, which logs a page in.
 */
export function handoffIntentUrl(
  base: string,
  call: number,
  handoff: string,
): string {
  const url = new URL(`/call/${call}`, base);
  url.searchParams.set("handoff", handoff);
  const scheme = url.protocol.replace(/:$/, "");
  return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=${scheme};package=${ANDROID_APP_PACKAGE};action=android.intent.action.VIEW;end`;
}
