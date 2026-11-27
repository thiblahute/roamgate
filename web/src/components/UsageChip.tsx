import { Gauge } from "lucide-react";
import { useEffect, useState } from "react";
import { bridge } from "../api";
import { useAccountUsage } from "../accountUsage";
import { chipText, type UsageProfile } from "../usageView";
import { openUsageView } from "../usageViewOpen";
import "./UsageView.css";

type Profiles = { profiles: UsageProfile[]; default: string };

/** How long the chip keeps the profiles it read before reading them again
 * on the next usage push (never on a timer). */
const PROFILES_TTL_MS = 60_000;

/** The default account and its tightest window ("Work 61% 7d"), coloured
 * by the warning lines; opens the Usage view. Hidden without an account. */
export function UsageChipView({
  text,
  compact = false,
  onOpen,
}: {
  text: ReturnType<typeof chipText>;
  compact?: boolean;
  onOpen: () => void;
}) {
  if (!text) return null;
  const percent = text.window ? `${Math.round(text.window.utilization)}%` : "";
  const label = text.window
    ? `${text.name}: ${percent} of ${text.window.label} used`
    : `${text.name}: no usage reading yet`;
  return (
    <button
      type="button"
      className="topbar-button usage-chip"
      data-level={text.level}
      aria-label={`Usage. ${label}`}
      title={`${label}. Open Usage`}
      onClick={onOpen}
    >
      <Gauge size={14} aria-hidden="true" />
      {compact ? null : <span className="usage-chip-name">{text.name}</span>}
      {text.window ? (
        <span className="usage-chip-value">
          {percent}
          {compact ? "" : ` ${text.window.label}`}
        </span>
      ) : null}
    </button>
  );
}

/** The header chip, fed by the shared usage store. */
export function UsageChip({ compact = false }: { compact?: boolean }) {
  const board = useAccountUsage();
  const [profiles, setProfiles] = useState<Profiles | null>(null);
  const [readAt, setReadAt] = useState(0);
  useEffect(() => {
    if (readAt && Date.now() - readAt < PROFILES_TTL_MS) return;
    let live = true;
    bridge
      .call("settings.profiles.get")
      .then((result) => {
        if (!live) return;
        setProfiles(result as Profiles);
        setReadAt(Date.now());
      })
      .catch(() => {
        // Not connected yet: the next push asks again.
      });
    return () => {
      live = false;
    };
    // The board's pushes are the only clock.
  }, [board, readAt]);
  if (
    !Array.isArray(profiles?.profiles) ||
    !profiles.profiles.some((profile) => profile?.account)
  )
    return null;
  return (
    <UsageChipView
      text={chipText(profiles.profiles, profiles.default, board)}
      compact={compact}
      onOpen={openUsageView}
    />
  );
}
