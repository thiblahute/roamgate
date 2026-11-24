/**
 * contract/tools/catalog.json: every tool Roamgate gives a model, with its
 * name, its input's JSON Schema and its description verbatim. The server
 * builds its tool tables from it (roamgate-claude's registry); the Claude
 * mod reads its own table from server/claude-mod/hooks/catalog.gen.ts,
 * generated from the catalog.
 *
 *   bun scripts/contract/tools-catalog.ts --write   rewrites catalog.gen.ts
 *
 * tools-catalog.test.ts fails when it differs from what this makes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..", "..");
export const CATALOG_PATH = join(ROOT, "contract", "tools", "catalog.json");
export const MOD_CATALOG_PATH = join(
  ROOT,
  "server",
  "claude-mod",
  "hooks",
  "catalog.gen.ts",
);

export type CatalogTool = {
  name: string;
  description: string;
  input_schema: unknown;
  [extra: string]: unknown;
};

export type CatalogTable = { about: string; tools: CatalogTool[] };

export type Catalog = {
  version: number;
  constants: Record<string, string>;
  tables: Record<string, CatalogTable>;
};

export function readCatalog(): Catalog {
  return JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as Catalog;
}

export function renderCatalog(catalog: Catalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

/** The mod's module: its table and constants, as TypeScript. */
export function renderModCatalog(catalog: Catalog): string {
  const mod = catalog.tables["claude-mod"]!;
  const tools = mod.tools.map(({ input_schema, ...rest }) => ({
    ...rest,
    inputSchema: input_schema,
  }));
  return `// Generated from contract/tools/catalog.json by
// scripts/contract/tools-catalog.ts --write: do not edit.

/** The client's name in requests: the server names its agent from it. */
export const MOD_VIA = ${JSON.stringify(catalog.constants.MOD_VIA)};

/** The mod's tools: what the model sees of each, and the command it runs. */
export const MOD_TOOLS: readonly {
  name: string;
  command: string;
  description: string;
  inputSchema: Record<string, unknown>;
  deferred?: boolean;
}[] = ${JSON.stringify(tools, null, 2)};
`;
}

if (import.meta.main) {
  if (!process.argv.includes("--write")) {
    console.error("usage: bun scripts/contract/tools-catalog.ts --write");
    process.exit(2);
  }
  writeFileSync(MOD_CATALOG_PATH, renderModCatalog(readCatalog()));
}
