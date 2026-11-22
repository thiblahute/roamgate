import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { HistorySettings } from "../../../shared/history";
import { roamgateEnv } from "../config/environment";
import type { HistoryArea, HistoryPaths, ReviewSource } from "./area";
import {
  companionArea,
  connectionsArea,
  moveHostsArea,
  sessionProfilesArea,
  settingsArea,
  voiceArea,
} from "./files";
import { mrReviewsArea } from "./mr-reviews";
import { reviewsArea } from "./reviews";
import type { HistoryPlace } from "./runtime";
import { workArea } from "./work";

/**
 * Where the history repo is and whether it is written: on by default at
 * `<data>/history`; Settings' `history.location` moves it and
 * `history.enabled: false` turns it off. `ROAMGATE_HISTORY=off` makes off
 * the default (test servers), which the settings can still turn on.
 */
export function historyPlace(
  settings: { history?: HistorySettings } | null | undefined,
  data: string,
  environment: Record<string, string | undefined> = process.env,
  home = homedir(),
): HistoryPlace {
  const defaultLocation =
    roamgateEnv("HISTORY_DIR", environment) ?? join(data, "history");
  const off = /^(off|0|false|no)$/i.test(
    roamgateEnv("HISTORY", environment) ?? "",
  );
  const set = settings?.history?.location;
  return {
    enabled: settings?.history?.enabled ?? !off,
    location: set ? expandLocation(set, home) : defaultLocation,
    defaultLocation,
  };
}

/**
 * The machine's name for the commits' `Roamgate-Host:` trailer: in a
 * toolbox (whose own name is always `toolbx`), the host's.
 */
export function historyHost(
  inToolbox = existsSync("/run/.toolboxenv"),
  hostFile = "/run/host/etc/hostname",
): string {
  if (inToolbox)
    try {
      const name = readFileSync(hostFile, "utf8").trim();
      if (name) return name;
    } catch {}
  return hostname();
}

/** A location as typed: `~` is the home directory; a relative one is refused. */
export function expandLocation(value: string, home = homedir()): string {
  const trimmed = value.trim();
  const expanded =
    trimmed === "~"
      ? home
      : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
        ? join(home, trimmed.slice(2))
        : trimmed;
  if (!isAbsolute(expanded))
    throw new Error("the history location must be an absolute path");
  return resolve(expanded);
}

/** Every area of the history, in the order a commit message lists them. */
export function historyAreas(
  paths: HistoryPaths,
  reviews: () => ReviewSource | null,
): HistoryArea[] {
  return [
    workArea(paths, reviews),
    reviewsArea(paths, reviews),
    settingsArea(paths),
    connectionsArea(paths),
    moveHostsArea(paths),
    sessionProfilesArea(paths),
    mrReviewsArea(paths),
    companionArea(paths),
    voiceArea(paths),
  ];
}
