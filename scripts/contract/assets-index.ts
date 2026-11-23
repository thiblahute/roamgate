/**
 * contract/assets/index.json: each file of contract/assets, what it is,
 * the tags a template fills (server/src/assets/template.ts) and the
 * server's modules that use it.
 *
 *   bun scripts/contract/assets-index.ts --write
 *
 * assets.test.ts (server/src/assets) fails when the file differs.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { templateNames } from "../../server/src/assets/template";

const ROOT = join(import.meta.dir, "..", "..");
export const ASSETS_DIR = join(ROOT, "contract", "assets");
export const INDEX_PATH = join(ASSETS_DIR, "index.json");
const SERVER_SRC = join(ROOT, "server", "src");

/** What each kind of file is, by its directory. */
const KINDS: Record<string, string> = {
  data: "data, read as JSON",
  html: "page, a template",
  js: "page script, built from web/src (bun run build:assets)",
  ps1: "PowerShell run on a Windows host, a template when it has tags",
  python: "Python 3 run on a host (the clients are installed there as files)",
  sh: "POSIX shell run on a host, a template when it has tags",
  skill: "installed on hosts beside roamgate-review",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** The asset's name in server/src/assets/index.ts. */
function identOf(index: string, path: string): string {
  const match = new RegExp(
    `import (\\w+) from "\\.\\./\\.\\./\\.\\./contract/assets/${path.replace(/[.]/g, "\\.")}"`,
  ).exec(index);
  if (!match) throw new Error(`${path} is not imported by server/src/assets`);
  return match[1]!;
}

export function buildAssetsIndex(): Record<string, unknown> {
  const index = readFileSync(join(SERVER_SRC, "assets", "index.ts"), "utf8");
  const sources = files(SERVER_SRC)
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
    .filter((path) => !path.includes(`${join("src", "assets")}/`))
    .map((path) => ({
      path: relative(ROOT, path),
      text: readFileSync(path, "utf8"),
    }));
  const entries: Record<string, unknown> = {};
  for (const file of files(ASSETS_DIR).sort()) {
    const path = relative(ASSETS_DIR, file);
    if (path === "index.json" || path === "README.md") continue;
    const kind = KINDS[path.split("/")[0]!];
    if (!kind) throw new Error(`${path}: no kind for its directory`);
    let ident = identOf(index, path);
    if (ident === "LOGIN_HTML_FILE") ident = "LOGIN_HTML_TEMPLATE";
    const used = new RegExp(
      `import \\{[^}]*\\b${ident}\\b[^}]*\\} from "(?:\\.\\./)*(?:\\./)?assets"`,
    );
    const text = readFileSync(file, "utf8");
    entries[path] = {
      kind,
      ...(path.endsWith(".json") ? {} : { tags: templateNames(text) }),
      used_by: sources
        .filter((source) => used.test(source.text))
        .map((source) => source.path)
        .sort(),
    };
  }
  return entries;
}

export function renderAssetsIndex(): string {
  return `${JSON.stringify(buildAssetsIndex(), null, 2)}\n`;
}

if (import.meta.main) {
  if (!process.argv.includes("--write")) {
    console.error("usage: bun scripts/contract/assets-index.ts --write");
    process.exit(2);
  }
  writeFileSync(INDEX_PATH, renderAssetsIndex());
}
