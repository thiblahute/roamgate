import { describe, expect, test } from "bun:test";
import { hljs } from "diff2html/lib-esm/ui/js/highlight.js-slim";
import directHighlighter from "highlight.js/lib/core";
import webPackage from "../../package.json";
import {
  highlightCodeTokens,
  highlightSnippetTokens,
  syntaxLanguageHintForPath,
} from "./syntaxHighlighting";

describe("syntaxLanguageHintForPath", () => {
  test("uses the requested highlight.js version throughout the diff renderer", () => {
    expect(hljs).toBe(directHighlighter);
    expect(hljs.versionString).toBe(webPackage.dependencies["highlight.js"]);
  });

  test("normalizes common code extensions", () => {
    expect(syntaxLanguageHintForPath("src/App.tsx")).toBe("typescript");
    expect(syntaxLanguageHintForPath("config/settings.jsonc")).toBe("json");
    expect(syntaxLanguageHintForPath("styles/theme.sass")).toBe("scss");
    expect(syntaxLanguageHintForPath("docs/guide.mdx")).toBe("markdown");
  });

  test("recognizes extensionless language files", () => {
    expect(syntaxLanguageHintForPath("services/api/Dockerfile")).toBe(
      "dockerfile",
    );
    expect(syntaxLanguageHintForPath("scripts/Makefile")).toBe("makefile");
    expect(syntaxLanguageHintForPath("app/Gemfile")).toBe("ruby");
    expect(syntaxLanguageHintForPath("config/.env.local")).toBe("bash");
  });

  test("supports Windows paths and falls back safely", () => {
    expect(syntaxLanguageHintForPath("src\\worker.ps1")).toBe("powershell");
    expect(syntaxLanguageHintForPath("README")).toBe("plaintext");
    expect(syntaxLanguageHintForPath("archive.unknownlang")).toBe(
      "unknownlang",
    );
  });

  test("returns reusable highlight.js token ranges", async () => {
    const text = 'const markup = "<tag>&"; const answer: number = 42;';
    const tokens = await highlightCodeTokens(text, "src/answer.ts");
    const keyword = tokens.find((token) => token.className === "hljs-keyword");
    const number = tokens.find((token) => token.className === "hljs-number");

    expect(keyword && text.slice(keyword.from, keyword.to)).toBe("const");
    expect(number && text.slice(number.from, number.to)).toBe("42");
    expect(tokens.every((token) => token.to > token.from)).toBe(true);
  });
});

describe("highlightSnippetTokens", () => {
  const keyword = (tokens: { className: string }[]) =>
    tokens.some((token) => token.className.includes("hljs-keyword"));

  test("uses the fence's language, by name or extension", async () => {
    expect(keyword(await highlightSnippetTokens("fn main() {}", "rust"))).toBe(
      true,
    );
    expect(keyword(await highlightSnippetTokens("fn main() {}", "rs"))).toBe(
      true,
    );
  });

  test("falls back to the commented file's language", async () => {
    expect(
      keyword(await highlightSnippetTokens("def f(): pass", "", "a/b.py")),
    ).toBe(true);
    expect(await highlightSnippetTokens("def f(): pass", "")).toEqual([]);
  });
});
