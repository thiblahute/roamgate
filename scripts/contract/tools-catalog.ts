/**
 * contract/tools/catalog.json: every tool Roamgate gives a model, with its
 * name, its input's JSON Schema and its description verbatim, so both
 * servers offer the same tools.
 *
 * The server's tables (typebox, in the server's code) are serialised here;
 * the Claude mod's table is the catalog's own (the mod reads it from
 * server/claude-mod/hooks/catalog.gen.ts, generated from the catalog).
 *
 *   bun scripts/contract/tools-catalog.ts --write   rewrites both files
 *
 * tools-catalog.test.ts fails when either differs from what this makes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  rangerTools,
  type RangerTool,
} from "../../server/src/assistant/ranger-tools";
import {
  BOARD_DESCRIPTIONS,
  BOARD_WRITING,
  type BoardToolName,
  boardToolSchemas,
} from "../../server/src/mr-reviews/board-tools";
import { createReviewsAgentTools } from "../../server/src/mr-reviews/agent-tools";
import {
  WORK_DESCRIPTIONS,
  WORK_WRITING,
  type WorkToolName,
  workToolSchemas,
} from "../../server/src/work/tools";
import {
  WORK_MCP_SERVER,
  workVoiceTools,
  YOUTUBE_MCP_SERVER,
  youtubeTools,
} from "../../server/src/voice/voice-tools";

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

/** A typebox schema as JSON (its symbols left out, as tools send it). */
function json(schema: unknown): unknown {
  return JSON.parse(JSON.stringify(schema));
}

function ranger(tool: RangerTool): CatalogTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: json(tool.parameters),
    replay: tool.replay,
    sequential: tool.sequential,
  };
}

/** A stand-in for what runs the tools: listing them runs nothing. */
function never(): never {
  throw new Error("the catalog runs no tool");
}

const STUBS = new Proxy({}, { get: () => never });

/** The Ranger tools of a turn given every handler. */
function rangerTable(automatic: boolean): CatalogTool[] {
  return rangerTools(
    {
      read: never,
      propose: never,
      task: never,
      notify: never,
      show: never,
      arrange: never,
      threads: never,
      archive: never,
    },
    automatic,
  ).map(ranger);
}

/** The server's tables, from its code. */
export function serverTables(): Record<string, CatalogTable> {
  const manual = rangerTable(false);
  const automatic = rangerTable(true);
  return {
    board: {
      about:
        "The Reviews board's tools, run by the agent socket's `reviews` command (`tool`, `params`); `help` lists them. writes: they change the user's lists.",
      tools: Object.entries(boardToolSchemas).map(([name, schema]) => ({
        name,
        description: BOARD_DESCRIPTIONS[name as BoardToolName],
        input_schema: json(schema),
        writes: BOARD_WRITING.includes(name as BoardToolName),
      })),
    },
    "reviews-agent": {
      about:
        "The Reviews panel's agent: its own tools, then the board's, as one Ranger-style table.",
      tools: createReviewsAgentTools(STUBS as never).map(ranger),
    },
    work: {
      about:
        "The Work board's tools for agents, run by the agent socket's `work` command (`tool`, `params`); `help` lists them. writes: they change the board.",
      tools: Object.entries(workToolSchemas).map(([name, schema]) => ({
        name,
        description: WORK_DESCRIPTIONS[name as WorkToolName],
        input_schema: json(schema),
        writes: WORK_WRITING.includes(name as WorkToolName),
      })),
    },
    ranger: {
      about:
        "Ranger's tools when every handler is given (a turn gets those its handlers allow), in a turn that proposes.",
      tools: manual,
    },
    "ranger-automatic": {
      about:
        "What differs in a turn that acts by itself (high permission): the tools whose description or sequential changes.",
      tools: automatic.filter((tool, index) => {
        const base = manual[index]!;
        if (base.name !== tool.name) throw new Error("ranger tables differ");
        return (
          base.description !== tool.description ||
          base.sequential !== tool.sequential
        );
      }),
    },
    "voice-work": {
      about: `The voice companion's Work board tools, every write in the user's name, served as the MCP server ${WORK_MCP_SERVER}.`,
      tools: workVoiceTools(never).map(ranger),
    },
    "voice-youtube": {
      about: `The voice companion's YouTube player, served as the MCP server ${YOUTUBE_MCP_SERVER}.`,
      tools: youtubeTools(STUBS as never).map(ranger),
    },
  };
}

export function readCatalog(): Catalog {
  return JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as Catalog;
}

/** The catalog: the server's tables from its code, the mod's as it is. */
export function buildCatalog(current: Catalog): Catalog {
  const mod = current.tables["claude-mod"];
  if (!mod) throw new Error("the catalog has no claude-mod table");
  return {
    version: current.version,
    constants: current.constants,
    tables: { ...serverTables(), "claude-mod": mod },
  };
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
  const catalog = buildCatalog(readCatalog());
  writeFileSync(CATALOG_PATH, renderCatalog(catalog));
  writeFileSync(MOD_CATALOG_PATH, renderModCatalog(catalog));
}
