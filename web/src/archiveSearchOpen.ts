import { importWithReload } from "./lazyWithReload";

/** The archive search's entry in the command menu and the application menu. */
export const ARCHIVE_SEARCH_ENTRY = {
  title: "Search past sessions",
  detail: "Every machine's Claude Code, Codex and Pi conversations",
  keywords: [
    "archive",
    "search",
    "history",
    "sessions",
    "transcripts",
    "conversations",
    "grep",
    "past",
  ],
};

function loadRoot() {
  return importWithReload(
    "archive-search",
    () => import("./components/ArchiveSearchRoot"),
  );
}

/** Opens the archive search (components/ArchiveSearchRoot.tsx), loaded on first use. */
export function openArchiveSearch(query = "") {
  void loadRoot().then((module) => module.showArchiveSearch(query));
}
