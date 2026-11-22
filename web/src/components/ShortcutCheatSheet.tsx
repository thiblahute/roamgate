import { useEffect } from "react";
import { activeTerminalInput } from "../activeTerminalInput";
import { SHORTCUT_PLATFORMS, type ShortcutId } from "../shortcutBindings";
import { shortcutCheatSheet } from "../shortcutCheatSheet";
import { SHORTCUT_CATALOG } from "../shortcutCatalog";
import {
  shortcutMatches,
  useShortcutPreferences,
} from "../shortcutPreferences";
import { shortcutPresses } from "../shortcutPress";
import { type ShortcutGroup, ShortcutHelp } from "./ShortcutHelp";

const CATALOG_IDS = new Set<string>(SHORTCUT_CATALOG.map((item) => item.id));

/**
 * The app's shortcuts of the active preset, in the views' shortcut help:
 * searched, and run (as their keys pressed where the focus was). Editing
 * stays in Configuration.
 */
export function ShortcutCheatSheet({ onClose }: { onClose: () => void }) {
  const { preferences, preset, platform } = useShortcutPreferences();
  const groups: ShortcutGroup[] = shortcutCheatSheet(
    preset.bindings,
    platform,
  ).map(({ group, rows }) => ({
    heading: group,
    rows: rows.map((row) => {
      const keys =
        row.combos.map((caps) => caps.join("+")).join(" ") || "Unassigned";
      // An app shortcut runs as its first binding; the panels' keys, the
      // numbered ranges and the modifier held with a click are listed only.
      const binding = CATALOG_IDS.has(row.key)
        ? preset.bindings[row.key as ShortcutId][0]
        : undefined;
      return [
        keys,
        row.label,
        binding && shortcutPresses(binding) ? binding : false,
      ] as const;
    }),
  }));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (!shortcutMatches(event, "shortcuts.show")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <ShortcutHelp
      className="shortcut-cheatsheet"
      title={`Keyboard shortcuts: ${
        preferences.active === "auto"
          ? `Automatic (${SHORTCUT_PLATFORMS[platform]})`
          : preset.name
      }`}
      groups={groups}
      placeholder="Filter shortcuts"
      // Opened from the menu, which is gone: the terminal has the keys.
      target={() => activeTerminalInput(document)}
      onClose={onClose}
    />
  );
}
