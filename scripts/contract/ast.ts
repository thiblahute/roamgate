/**
 * The TypeScript compiler's syntax tree of a repository file, for the
 * schema generator: only syntax is read, no program, no types.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript-api";

export const REPO = join(import.meta.dir, "..", "..");

const cache = new Map<string, ts.SourceFile>();

/** A source file of the repository, by path relative to its root. */
export function source(path: string): ts.SourceFile {
  let file = cache.get(path);
  if (!file) {
    file = ts.createSourceFile(
      path,
      readFileSync(join(REPO, path), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    cache.set(path, file);
  }
  return file;
}
