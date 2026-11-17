import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { replaceDataFile } from "../config/data-paths";
import { roamgateEnv } from "../config/environment";
import {
  applyLedgers,
  exportReviews,
  importChanges,
  importedMrReviews,
  parseReviewsExport,
  stableJson,
} from "../mr-reviews/export";
import { normalizeStoredMrReviews } from "../mr-reviews/settings";
import {
  type CliCommand,
  type CliContext,
  displayPath,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  wantsHelp,
} from "./command";
import { readServiceSetup, runtimeDataRoot } from "./service-context";

function reviewsHelp(): string {
  return `Export or import what the Reviews panel authored, without the server.

Usage:
  roamgate reviews export [--out FILE]
  roamgate reviews import FILE [--apply]

export prints (or writes to FILE) the Reviews' own authored state as stable,
key-sorted JSON: the order, pins, removals, what was set by hand, saved
views, requests not proposed yet, groups and workspaces headed upstream,
upstreaming efforts, and each effort's ledger with its commits' history.
Never secrets, never what is read again from the forges or derived.

import shows what FILE would change (added, removed, changed; a local value
newer than the imported one is flagged) and changes nothing unless --apply
is given. Ledgers are replaced and histories merged. A running server reads
the settings again on its next use; reload the Reviews panel.
`;
}

/** settings.json as the server finds it: the service's, else the default. */
function settingsPath(context: CliContext): string {
  let path: string | undefined;
  try {
    path = roamgateEnv("SETTINGS_PATH", readServiceSetup(context.runtime).env);
  } catch {
    // No usable service file: the default location.
  }
  return (
    path ??
    roamgateEnv("SETTINGS_PATH", context.runtime.env) ??
    join(runtimeDataRoot(context.runtime), "settings.json")
  );
}

function readSettingsFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8"));
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

export function createReviewsCommand(
  options: { now?: () => number } = {},
): CliCommand {
  return {
    name: "reviews",
    summary: "export or import the Reviews' order, overrides, views, efforts",
    actions: ["export", "import"],
    flags: ["--out", "--apply"],
    help: reviewsHelp,
    async run(args, context) {
      const action = args[0];
      if (wantsHelp(args) || action === undefined) {
        context.log(reviewsHelp());
        return EXIT_OK;
      }
      const settingsFile = settingsPath(context);
      const effortsRoot = join(
        runtimeDataRoot(context.runtime),
        "mr-reviews",
        "efforts",
      );
      const local = () =>
        exportReviews({
          stored: readSettingsFile(settingsFile).mr_reviews as
            | Record<string, unknown>
            | undefined,
          effortsRoot,
          ...(options.now ? { now: options.now } : {}),
        });
      if (action === "export") {
        const at = args.indexOf("--out");
        const out = at >= 0 ? args[at + 1] : undefined;
        if (at >= 0 && !out) {
          context.error("--out needs a file");
          return EXIT_USAGE;
        }
        const text = stableJson(local());
        if (!out) {
          context.log(text.trimEnd());
          return EXIT_OK;
        }
        replaceDataFile(resolve(out), text);
        context.log(
          `Wrote the Reviews export to ${displayPath(resolve(out), context.runtime)}`,
        );
        return EXIT_OK;
      }
      if (action === "import") {
        const file = args.slice(1).find((arg) => !arg.startsWith("--"));
        if (!file) {
          context.error("Usage: roamgate reviews import FILE [--apply]");
          return EXIT_USAGE;
        }
        let incoming: ReturnType<typeof parseReviewsExport>;
        try {
          incoming = parseReviewsExport(readFileSync(resolve(file), "utf8"));
        } catch (error) {
          context.error(
            `${file}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return EXIT_FAILURE;
        }
        const changes = importChanges(local(), incoming);
        for (const change of changes)
          context.log(
            `${change.kind === "added" ? "+" : change.kind === "removed" ? "-" : "~"} ${change.path}${change.newerLocal ? "  (yours is newer)" : ""}`,
          );
        if (!changes.length) context.log("Nothing would change.");
        if (!args.includes("--apply")) {
          if (changes.length)
            context.log(`${changes.length} changes; --apply to make them.`);
          return EXIT_OK;
        }
        const settings = readSettingsFile(settingsFile);
        const next = normalizeStoredMrReviews(
          importedMrReviews(
            settings.mr_reviews as Record<string, unknown> | undefined,
            incoming,
          ),
        );
        replaceDataFile(
          settingsFile,
          `${JSON.stringify({ ...settings, mr_reviews: next }, null, 2)}\n`,
        );
        const ledgers = applyLedgers(incoming, effortsRoot);
        context.log(
          `Applied ${changes.length} changes (${ledgers} effort ledger${ledgers === 1 ? "" : "s"}).`,
        );
        return EXIT_OK;
      }
      context.error(`Unknown reviews action: ${action}`);
      return EXIT_USAGE;
    },
  };
}
