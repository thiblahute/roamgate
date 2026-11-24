/**
 * GraphQL query complexity: GitLab refuses a query whose complexity is
 * above its limit ("Query has complexity of 272, which exceeds max
 * complexity of 250"; 250 for a signed-in user by default). The inbox
 * estimates each query's complexity the way GitLab counts it, sizes its
 * batches to stay under the host's limit, and on a refusal learns that
 * host's limit (and how far off the estimate was), splits the batch and
 * asks again at once. Pure but for the guard's per-host memory.
 */

/** GitLab's limit for a signed-in user unless the host said otherwise. */
export const GITLAB_MAX_COMPLEXITY = 250;

/** The page size GitLab assumes for a connection asked without first/last. */
const DEFAULT_PAGE = 100;

type Token = { kind: "name" | "punct" | "args"; text: string };

function tokens(query: string): Token[] {
  const list: Token[] = [];
  let i = 0;
  while (i < query.length) {
    const char = query[i]!;
    if (/\s|,/.test(char)) {
      i++;
    } else if (char === "(") {
      // Arguments as one token: strings may hold parentheses.
      let depth = 0;
      const start = i;
      let inString = false;
      for (; i < query.length; i++) {
        const c = query[i]!;
        if (inString) {
          if (c === "\\") i++;
          else if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === "(") depth++;
        else if (c === ")" && --depth === 0) break;
      }
      list.push({ kind: "args", text: query.slice(start + 1, i) });
      i++;
    } else if (query.startsWith("...", i)) {
      list.push({ kind: "punct", text: "..." });
      i += 3;
    } else if (/[_A-Za-z]/.test(char)) {
      const start = i;
      while (i < query.length && /[_0-9A-Za-z]/.test(query[i]!)) i++;
      list.push({ kind: "name", text: query.slice(start, i) });
    } else {
      list.push({ kind: "punct", text: char });
      i++;
    }
  }
  return list;
}

/** What a field with arguments costs over its selection, as GitLab's resolvers count it. */
function resolverCost(args: string, children: number): number {
  let cost = children + 1;
  if (/\bsort\s*:/.test(args)) cost += 1;
  if (/\bsearch\s*:/.test(args)) cost += 5;
  // Loading many items adds 1% per item, not when asked by id.
  if (!/\biids?\s*:/.test(args)) {
    const limit = /\b(?:first|last)\s*:\s*(\d+)/.exec(args);
    const page = Math.min(Number(limit?.[1] ?? DEFAULT_PAGE), DEFAULT_PAGE);
    cost += cost * page * 0.01;
  }
  return cost;
}

/**
 * An estimate of a query's complexity as GitLab counts it: a field 1, an
 * object field 1 and its selection, a field with arguments (a resolver)
 * its selection, 1, 1 more when sorted, and 1% more per item it loads
 * (first/last, else 100) unless asked by id. On gitlab.freedesktop.org it
 * came out a quarter above GitLab's count (342 for 272); too high only
 * splits a little more, and a refusal lowers the host's budget.
 */
export function estimateComplexity(query: string): number {
  const list = tokens(query);
  let at = 0;
  const peek = () => list[at];
  const next = () => list[at++];

  function selection(): number {
    let cost = 0;
    while (at < list.length && peek()?.text !== "}") cost += field();
    next();
    return cost;
  }

  function field(): number {
    const token = next()!;
    if (token.text === "...") {
      // An inline fragment counts its selection.
      if (peek()?.text === "on") {
        next();
        next();
      }
      if (peek()?.text !== "{") return 0;
      next();
      return selection();
    }
    if (token.kind !== "name") return 0;
    let name = token.text;
    if (peek()?.text === ":") {
      next();
      name = next()?.text ?? name;
    }
    const args = peek()?.kind === "args" ? next()!.text : null;
    let children: number | null = null;
    if (peek()?.text === "{") {
      next();
      children = selection();
    }
    if (name === "__typename") return 0;
    if (args !== null) return resolverCost(args, children ?? 0);
    return children === null ? 1 : 1 + children;
  }

  // The operation: `query { ... }` (a name and variables allowed).
  while (at < list.length && peek()?.text !== "{") next();
  if (at >= list.length) return 0;
  next();
  return Math.ceil(selection());
}

/** What GitLab said when it refused a query for its complexity. */
export type ComplexityRefusal = { complexity: number; max: number };

const REFUSAL =
  /complexity of (\d+),? which exceeds (?:the )?max(?:imum)? complexity of (\d+)/i;

/**
 * The refusal in a thrown error (glab exits with GitLab's message) or in a
 * GraphQL answer's errors, if it is one.
 */
export function complexityRefusal(value: unknown): ComplexityRefusal | null {
  const messages: string[] = [];
  if (value instanceof Error) messages.push(value.message);
  else if (typeof value === "string") messages.push(value);
  else {
    const errors = (value as { errors?: unknown } | null)?.errors;
    if (Array.isArray(errors))
      for (const error of errors) {
        const message = (error as { message?: unknown })?.message;
        if (typeof message === "string") messages.push(message);
      }
  }
  for (const message of messages) {
    const match = REFUSAL.exec(message);
    if (match) return { complexity: Number(match[1]), max: Number(match[2]) };
  }
  return null;
}

/** A refused query, thrown by the guard when even one unit is too much. */
export class ComplexityError extends Error {}

export type ComplexityGuard = ReturnType<typeof createComplexityGuard>;

/**
 * The per-host memory of complexity limits and the batching that keeps
 * queries under them. A host's budget is in estimate units: its limit
 * (GITLAB_MAX_COMPLEXITY for GitLab, none for GitHub, until a refusal
 * says) scaled by how far the estimate fell short when it was refused.
 */
export function createComplexityGuard(
  options: { onLearn?: (host: string, learned: HostLimit) => void } = {},
) {
  const learned = new Map<string, HostLimit>();

  function budget(host: string, provider: "gitlab" | "github"): number {
    const known = learned.get(host);
    if (known) return Math.floor(known.max * known.scale);
    return provider === "gitlab" ? GITLAB_MAX_COMPLEXITY : Infinity;
  }

  function learn(host: string, estimate: number, refusal: ComplexityRefusal) {
    const before = learned.get(host);
    // The estimate's share of the real count, never above 1 (an estimate
    // too high only splits more), and only lowered by a later refusal.
    const scale = Math.min(
      1,
      before?.scale ?? 1,
      estimate > 0 && refusal.complexity > 0
        ? (estimate / refusal.complexity) * 0.95
        : 1,
    );
    const next = { max: refusal.max, scale };
    learned.set(host, next);
    options.onLearn?.(host, next);
  }

  /**
   * The units cut in batches whose query stays under the host's budget,
   * in order, at most `most` units each.
   */
  function pack<U>(
    host: string,
    provider: "gitlab" | "github",
    units: U[],
    build: (part: U[]) => string,
    most = Infinity,
  ): U[][] {
    const limit = budget(host, provider);
    const batches: U[][] = [];
    let current: U[] = [];
    for (const unit of units) {
      const candidate = [...current, unit];
      if (
        current.length &&
        (candidate.length > most ||
          estimateComplexity(build(candidate)) > limit)
      ) {
        batches.push(current);
        current = [unit];
      } else current = candidate;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  /**
   * Asks the units in as few queries as the host's budget allows, in
   * order; a query refused for its complexity teaches the host's limit and
   * is split and asked again at once. Throws ComplexityError when a single
   * unit is refused, and whatever `ask` throws otherwise.
   */
  async function run<U, R>(
    host: string,
    provider: "gitlab" | "github",
    units: U[],
    build: (part: U[]) => string,
    ask: (query: string, part: U[]) => Promise<R>,
    most = Infinity,
  ): Promise<R[]> {
    const results: R[] = [];
    const queue = pack(host, provider, units, build, most);
    while (queue.length) {
      const part = queue.shift()!;
      const query = build(part);
      let refusal: ComplexityRefusal | null = null;
      let answer: R | undefined;
      try {
        answer = await ask(query, part);
        // An answer with only the refusal in its errors.
        if (!(answer as { data?: unknown } | null)?.data)
          refusal = complexityRefusal(answer);
      } catch (error) {
        refusal = complexityRefusal(error);
        if (!refusal) throw error;
      }
      if (!refusal) {
        results.push(answer as R);
        continue;
      }
      learn(host, estimateComplexity(query), refusal);
      if (part.length < 2)
        throw new ComplexityError(
          `Query has complexity of ${refusal.complexity}, which exceeds max complexity of ${refusal.max}`,
        );
      let split = pack(host, provider, part, build, most);
      if (split.length < 2) {
        const half = Math.ceil(part.length / 2);
        split = [part.slice(0, half), part.slice(half)];
      }
      queue.unshift(...split);
    }
    return results;
  }

  return {
    budget,
    learn,
    pack,
    run,
    /** What was learned of a host, if anything. */
    limit(host: string): HostLimit | undefined {
      return learned.get(host);
    },
  };
}

/** A host's limit as it said it, and the estimate's share of its count. */
export type HostLimit = { max: number; scale: number };
