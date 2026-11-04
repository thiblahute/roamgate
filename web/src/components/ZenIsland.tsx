import { Menu, Minimize2 } from "lucide-react";
import { openAppMenu } from "../configurationOpen";
import { shortcutTitle } from "../shortcutPreferences";

/**
 * Zen's tab, hanging from the top edge (or in the call's strip): its way out,
 * and the application menu, opened without leaving Zen, so what lives there
 * (Activity, Configuration...) is one click away instead of a hover on the
 * tab and a trip to the hidden top bar's far end.
 */
export function ZenIsland({ onExit }: { onExit: () => void }) {
  return (
    <div className="zen-island" role="group" aria-label="Zen mode">
      <button
        type="button"
        className="zen-island-button"
        title={shortcutTitle("Exit Zen mode", "zen.toggle")}
        aria-label={shortcutTitle("Exit Zen mode", "zen.toggle")}
        onClick={onExit}
      >
        <Minimize2 size={13} aria-hidden="true" />
        <span>Exit Zen</span>
      </button>
      <span className="zen-island-divider" aria-hidden="true" />
      <button
        type="button"
        className="zen-island-button zen-island-menu"
        title="Menu"
        aria-label="Menu"
        onClick={openAppMenu}
      >
        <Menu size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
