/**
 * The Roamgate Android app shows this page in its own WebView and adds a
 * bridge, `window.RoamgateApp`. When the bridge has `openSettings`, the page
 * can send the user to the app's own settings (server, password, language,
 * dictation bubble): the Configuration dialog offers it, and nothing else
 * does. In a browser there is no bridge and the entry is not shown.
 */
export type AppSettingsOpener = () => void;

export function appSettingsOpener(
  scope: unknown = globalThis,
): AppSettingsOpener | null {
  if (!scope || typeof scope !== "object") return null;
  const bridge = (scope as { RoamgateApp?: unknown }).RoamgateApp;
  if (!bridge || typeof bridge !== "object") return null;
  const open = (bridge as { openSettings?: unknown }).openSettings;
  if (typeof open !== "function") return null;
  return () => {
    (open as () => void).call(bridge);
  };
}
