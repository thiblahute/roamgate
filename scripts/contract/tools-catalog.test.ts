import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CATALOG_PATH,
  MOD_CATALOG_PATH,
  readCatalog,
  renderCatalog,
  renderModCatalog,
} from "./tools-catalog";
import { MOD_VIA } from "../../server/src/assets";
import {
  MOD_VIA as MOD_VIA_OF_MOD,
  ROAMGATE_TOOLS,
} from "../../server/claude-mod/hooks/tools";

test("the catalog is written as the generator writes it", () => {
  expect(readFileSync(CATALOG_PATH, "utf8")).toBe(renderCatalog(readCatalog()));
});

test("the mod's module is the catalog's claude-mod table", () => {
  expect(readFileSync(MOD_CATALOG_PATH, "utf8")).toBe(
    renderModCatalog(readCatalog()),
  );
});

test("the mod runs every tool of its table, and the server knows its name", () => {
  const table = readCatalog().tables["claude-mod"]!.tools;
  expect(ROAMGATE_TOOLS.map((tool) => tool.name)).toEqual(
    table.map((tool) => tool.name),
  );
  for (const tool of ROAMGATE_TOOLS) expect(typeof tool.body).toBe("function");
  expect(MOD_VIA).toBe(readCatalog().constants.MOD_VIA!);
  expect(MOD_VIA_OF_MOD).toBe(MOD_VIA);
});

test("tool names are unique within a table", () => {
  for (const [name, table] of Object.entries(readCatalog().tables)) {
    const names = table.tools.map((tool) => tool.name);
    expect({ name, names: [...new Set(names)] }).toEqual({ name, names });
  }
});
