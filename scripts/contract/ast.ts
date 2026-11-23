/**
 * Small static-analysis helpers over the TypeScript compiler's syntax tree,
 * for the contract inventory. Only syntax is read: no program, no types, so a
 * full scan of the server takes about a second.
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
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

export function rel(path: string): string {
  return relative(REPO, path);
}

export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** The text of a string literal or of a template without substitutions. */
export function literal(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isParenthesizedExpression(node)) return literal(node.expression);
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return literal(node.expression);
  return undefined;
}

/**
 * A template literal as a pattern: `agent_chat.${x}` gives `agent_chat.*`.
 */
export function pattern(node: ts.Node | undefined): string | undefined {
  const text = literal(node);
  if (text !== undefined) return text;
  if (node && ts.isTemplateExpression(node))
    return (
      node.head.text +
      node.templateSpans.map((span) => `*${span.literal.text}`).join("")
    );
  return undefined;
}

/**
 * The string a constant names: `const NAME = "..."` at the top of the file
 * the identifier is in, or of the module it is imported from (one level).
 */
export function constantText(
  node: ts.Node | undefined,
  path: string,
): string | undefined {
  if (!node || !ts.isIdentifier(node)) return undefined;
  const name = node.text;
  const declared = (file: ts.SourceFile) => {
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name)
          return literal(declaration.initializer);
    }
    return undefined;
  };
  const file = source(path);
  const here = declared(file);
  if (here !== undefined) return here;
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (
      !bindings ||
      !ts.isNamedImports(bindings) ||
      !bindings.elements.some((element) => element.name.text === name)
    )
      continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith(".")) return undefined;
    const target = rel(join(REPO, path, "..", `${specifier}.ts`));
    try {
      return declared(source(target));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The name a function-like node is known by, when it has one. */
export function functionName(node: ts.Node): string | undefined {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node)) &&
    node.name &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  )
    return node.name.text;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
      return parent.name.text;
    if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name))
      return parent.name.text;
  }
  return undefined;
}

export function isFunctionLike(
  node: ts.Node,
): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

/** The innermost named function around a node, or `<module>`. */
export function enclosingFunction(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (isFunctionLike(at)) {
      const name = functionName(at);
      if (name) return name;
    }
  }
  return "<module>";
}

/**
 * The functions of a file with a given name; with `containing`, only those
 * whose text includes it (to tell apart several `handle`s).
 */
export function functionsNamed(
  file: ts.SourceFile,
  name: string,
  containing?: string,
): ts.Node[] {
  const found: ts.Node[] = [];
  walk(file, (node) => {
    if (isFunctionLike(node) && functionName(node) === name) {
      if (!containing || node.getText(file).includes(containing))
        found.push(node);
    }
  });
  if (!found.length)
    throw new Error(`${file.fileName}: no function ${name} found`);
  return found;
}

/** Whether an expression names one of `subjects` (`method`, `url.pathname`). */
function isSubject(node: ts.Node, subjects: ReadonlySet<string>): boolean {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node)
  )
    node = node.expression;
  if (ts.isIdentifier(node)) return subjects.has(node.text);
  if (ts.isPropertyAccessExpression(node)) return subjects.has(node.name.text);
  if (ts.isElementAccessExpression(node)) {
    const key = literal(node.argumentExpression);
    return key !== undefined && subjects.has(key);
  }
  return false;
}

/** The string elements of an array or `new Set([...])` initializer. */
function collectionLiterals(
  node: ts.Node | undefined,
  file: ts.SourceFile,
): string[] | undefined {
  if (!node) return undefined;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    node = node.expression;
  if (ts.isArrayLiteralExpression(node)) {
    const out: string[] = [];
    for (const element of node.elements) {
      const text = literal(element);
      if (text !== undefined) out.push(text);
      else if (ts.isSpreadElement(element)) {
        const spread = resolveConst(element.expression, file);
        if (spread) out.push(...spread);
      }
    }
    return out;
  }
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === "Set" || node.expression.text === "Map")
  ) {
    const first = node.arguments?.[0];
    if (!first) return [];
    if (node.expression.text === "Map" && first) {
      const out: string[] = [];
      const entries = ts.isArrayLiteralExpression(first) ? first.elements : [];
      for (const entry of entries)
        if (ts.isArrayLiteralExpression(entry)) {
          const key = literal(entry.elements[0]);
          if (key !== undefined) out.push(key);
        }
      return out;
    }
    return collectionLiterals(first, file) ?? resolveConst(first, file);
  }
  if (ts.isIdentifier(node)) return resolveConst(node, file);
  return undefined;
}

/** The literals of a module-level or local const array or set. */
export function resolveConst(
  node: ts.Node,
  file: ts.SourceFile,
): string[] | undefined {
  if (!ts.isIdentifier(node)) return undefined;
  let found: string[] | undefined;
  walk(file, (candidate) => {
    if (
      !found &&
      ts.isVariableDeclaration(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === node.text
    )
      found = collectionLiterals(candidate.initializer, file);
  });
  if (found) return found;
  // An imported constant: read it in its module.
  const imported = importedFrom(file, node.text);
  if (!imported) return undefined;
  const target = source(imported.path);
  return resolveConst(ts.factory.createIdentifier(imported.name), target);
}

/** Where a name imported by a relative import comes from. */
export function importedFrom(
  file: ts.SourceFile,
  name: string,
): { path: string; name: string } | undefined {
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith(".")) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.name.text !== name) continue;
      const base = join(file.fileName, "..", specifier);
      const path = base.endsWith(".ts") ? base : `${base}.ts`;
      return { path, name: (element.propertyName ?? element.name).text };
    }
  }
  return undefined;
}

export type Compared = {
  /** Literals compared for equality, or case labels. */
  exact: Set<string>;
  /** Literals tested with `startsWith`. */
  prefixes: Set<string>;
};

/**
 * The string literals a value is tested against inside `scope`: `x === "a"`,
 * `case "a":` of `switch (x)`, `x.startsWith("a")`, `SET.has(x)` and
 * `[...].includes(x)` with a constant collection.
 */
export function comparedLiterals(
  scope: ts.Node,
  subjects: Iterable<string>,
): Compared {
  const names = new Set(subjects);
  const file = scope.getSourceFile();
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  walk(scope, (node) => {
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken
      ) {
        const left = literal(node.left);
        const right = literal(node.right);
        if (right !== undefined && isSubject(node.left, names))
          exact.add(right);
        if (left !== undefined && isSubject(node.right, names)) exact.add(left);
      }
    } else if (
      ts.isSwitchStatement(node) &&
      isSubject(node.expression, names)
    ) {
      for (const clause of node.caseBlock.clauses)
        if (ts.isCaseClause(clause)) {
          const text = literal(clause.expression);
          if (text !== undefined) exact.add(text);
        }
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const call = node.expression.name.text;
      const arg = node.arguments[0];
      if (
        call === "startsWith" &&
        isSubject(node.expression.expression, names)
      ) {
        const text = literal(arg);
        if (text !== undefined) prefixes.add(text);
      } else if (
        (call === "has" || call === "includes") &&
        arg &&
        isSubject(arg, names)
      ) {
        for (const text of collectionLiterals(
          node.expression.expression,
          file,
        ) ?? [])
          exact.add(text);
      }
    }
  });
  return { exact, prefixes };
}

/**
 * Every source file of the server under a directory of the repository:
 * tests and their helpers (fixtures, test data, *testing.ts,
 * test-context.ts, test-environment.ts, test-owners.ts), generated files and the
 * development probes excluded.
 */
export function sourceFiles(
  directory: string,
  exclude: RegExp = /(\.test|\.fixture)\.ts$|\/testdata\/|\.d\.ts$|\.gen\.ts$|\/test-environment\.ts$|\/test-context\.ts$|\/test-owners\.ts$|[/-]testing\.ts$|\/probe-[^/]*\.ts$/,
): string[] {
  const glob = new Bun.Glob("**/*.ts");
  return [...glob.scanSync({ cwd: join(REPO, directory) })]
    .map((path) => join(directory, path))
    .filter((path) => !exclude.test(path))
    .sort();
}
