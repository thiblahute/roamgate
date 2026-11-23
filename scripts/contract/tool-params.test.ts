import { expect, test } from "bun:test";
import { firstParamError, workToolSchemas } from "../../server/src/work/tools";
import {
  buildToolParamCases,
  readToolParams,
  renderToolParams,
} from "./tool-params";

test("the refusal vectors are what typebox says for each tool's calls", () => {
  expect(readToolParams()).toBe(renderToolParams(buildToolParamCases()));
});

test("the catalog's JSON schemas refuse as the work tools' own schemas do", () => {
  for (const each of buildToolParamCases()) {
    if (each.table !== "work") continue;
    const schema = workToolSchemas[each.tool as keyof typeof workToolSchemas];
    const own = firstParamError(schema, each.params);
    expect({ tool: each.tool, params: each.params, error: own }).toEqual({
      tool: each.tool,
      params: each.params,
      error: each.error,
    });
  }
  expect(firstParamError(workToolSchemas.work_list, { open: true })).toBe(null);
});
