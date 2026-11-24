import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { CLAUDE_START_ENV } from "../../../shared/agentChat";
import {
  DISMISSED_PERMISSION_MESSAGE,
  DISMISSED_QUESTION_MESSAGE,
} from "../../../shared/review";
import {
  INDEX_PATH,
  renderAssetsIndex,
} from "../../../scripts/contract/assets-index";
import {
  ASSET_TEXTS,
  CLAUDE_START_HOOK_INSTALL_PY,
  RENDERED_HELPER_JS,
  ROAMGATE_HOLD_PY,
  ROAMGATE_REVIEW_PY,
  VOICE_MODELS,
} from ".";
import { fillTemplate, templateNames } from "./template";

const ROOT = join(import.meta.dir, "..", "..", "..");
const ASSETS = join(ROOT, "contract", "assets");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("fillTemplate", () => {
  test("fills values and keeps everything else byte for byte", () => {
    expect(fillTemplate("a={{a}} ${b} {x} {{b}}\n", { a: "'q'", b: 2 })).toBe(
      "a='q' ${b} {x} 2\n",
    );
  });

  test("keeps a section when its flag is true, its inverse when false", () => {
    const template = "[{{#on}}yes {{v}}{{/on}}{{^on}}no{{/on}}]";
    expect(fillTemplate(template, { on: true, v: "x" })).toBe("[yes x]");
    expect(fillTemplate(template, { on: false, v: "x" })).toBe("[no]");
  });

  test("nests sections", () => {
    const template = "{{#a}}A{{#b}}B{{/b}}{{/a}}";
    expect(fillTemplate(template, { a: true, b: true })).toBe("AB");
    expect(fillTemplate(template, { a: true, b: false })).toBe("A");
    expect(fillTemplate(template, { a: false, b: true })).toBe("");
  });

  test("refuses a missing or an unused value, and a wrong kind", () => {
    expect(() => fillTemplate("{{a}}", {})).toThrow("no value for {{a}}");
    expect(() => fillTemplate("x", { a: "1" })).toThrow("no {{a}} to fill");
    expect(() => fillTemplate("{{a}}", { a: true })).toThrow("flag");
    expect(() => fillTemplate("{{#a}}{{/a}}", { a: "1" })).toThrow(
      "true or false",
    );
    expect(() => fillTemplate("{{#a}}", { a: true })).toThrow("not closed");
    expect(() => fillTemplate("{{#a}}{{/b}}", { a: true, b: true })).toThrow(
      "closes",
    );
    expect(() => fillTemplate("{{toString}}", {})).toThrow("no value");
  });

  test("lists a template's tags", () => {
    expect(templateNames("{{#a}}{{b}}{{/a}}{{^c}}{{/c}}{{b}}")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("contract/assets", () => {
  test("every file is embedded, and every embedded text is a file", () => {
    const onDisk = files(ASSETS)
      .map((path) => relative(ASSETS, path))
      .filter(
        (path) =>
          path !== "index.json" &&
          path !== "README.md" &&
          !path.endsWith(".json"),
      )
      .sort();
    expect(Object.keys(ASSET_TEXTS).sort()).toEqual(onDisk);
    for (const [path, text] of Object.entries(ASSET_TEXTS))
      expect(text).toBe(readFileSync(join(ASSETS, path), "utf8"));
    expect(VOICE_MODELS).toEqual(
      JSON.parse(
        readFileSync(join(ASSETS, "data", "voice-models.json"), "utf8"),
      ),
    );
  });

  test("every template parses", () => {
    for (const text of Object.values(ASSET_TEXTS))
      expect(() => templateNames(text)).not.toThrow();
  });

  test("index.json says what each file is, its tags and its users", () => {
    expect(readFileSync(INDEX_PATH, "utf8")).toBe(renderAssetsIndex());
  });

  test("the installed clients carry the server's constants", () => {
    expect(ROAMGATE_REVIEW_PY).toContain(
      `\nDISMISSED_QUESTION = ${JSON.stringify(DISMISSED_QUESTION_MESSAGE)}\n`,
    );
    expect(ROAMGATE_REVIEW_PY).toContain(
      `\nDISMISSED_PERMISSION = ${JSON.stringify(DISMISSED_PERMISSION_MESSAGE)}\n`,
    );
    for (const client of [ROAMGATE_REVIEW_PY, ROAMGATE_HOLD_PY])
      expect(client).toContain(`\nSTART_ENV = "${CLAUDE_START_ENV}"\n`);
    expect(CLAUDE_START_HOOK_INSTALL_PY).toContain(
      '\nMARK = "roamgate-review claude-start"\n',
    );
    // Installed and checksummed as they are: never templates.
    for (const client of [
      ROAMGATE_REVIEW_PY,
      ROAMGATE_HOLD_PY,
      CLAUDE_START_HOOK_INSTALL_PY,
    ])
      expect(templateNames(client)).toEqual([]);
  });

  test("the rendered helper is web/src/renderedHelper.ts as the web toolchain builds it", () => {
    expect(RENDERED_HELPER_JS).not.toContain("</script");
    const out = mkdtempSync(join(tmpdir(), "roamgate-helper-"));
    try {
      const build = Bun.spawnSync(
        [
          process.execPath,
          "x",
          "vite",
          "build",
          "--config",
          "vite.helper.config.ts",
        ],
        {
          cwd: join(ROOT, "web"),
          env: { ...process.env, ROAMGATE_HELPER_OUT_DIR: out },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(build.stderr.toString()).toBe("");
      expect(build.exitCode).toBe(0);
      expect(readFileSync(join(out, "rendered-helper.js"), "utf8")).toBe(
        RENDERED_HELPER_JS,
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
