/**
 * The shapes a recording's messages take: per surface and name, the types
 * seen at each path and how often each key was present. A shape census
 * stands in for the contract until its schemas exist, and is what a new
 * recording is compared with to find fields nobody described.
 */

export type JsonType =
  | "null"
  | "boolean"
  | "number"
  | "string"
  | "array"
  | "object";

export type Shape = {
  /** Values seen at this path, by type. */
  types: Partial<Record<JsonType, number>>;
  /** Objects: each key's shape and how many objects had it. */
  props?: Record<string, Shape & { present: number }>;
  /** Arrays: the shape of their items. */
  items?: Shape;
};

export type Census = Record<string, { count: number; shape: Shape }>;

function typeOf(value: unknown): JsonType {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  if (type === "boolean" || type === "number" || type === "string") return type;
  return "object";
}

/** Folds one value into a shape. */
export function addToShape(shape: Shape, value: unknown, depth = 0): void {
  const type = typeOf(value);
  shape.types[type] = (shape.types[type] ?? 0) + 1;
  if (depth > 32) return;
  if (type === "object") {
    shape.props ??= {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const prop = (shape.props[key] ??= { types: {}, present: 0 });
      prop.present += 1;
      addToShape(prop, item, depth + 1);
    }
  } else if (type === "array") {
    shape.items ??= { types: {} };
    // A few items are enough to learn their shape; keep long lists cheap.
    for (const item of (value as unknown[]).slice(0, 16))
      addToShape(shape.items, item, depth + 1);
  }
}

export function censusKey(surface: string, name: string): string {
  return `${surface} ${name}`;
}

export function addToCensus(
  census: Census,
  surface: string,
  name: string,
  value: unknown,
): void {
  const entry = (census[censusKey(surface, name)] ??= {
    count: 0,
    shape: { types: {} },
  });
  entry.count += 1;
  addToShape(entry.shape, value);
}

export type ShapeDifference = {
  key: string;
  path: string;
  kind: "new-message" | "new-field" | "new-type";
  detail: string;
};

function compareShapes(
  key: string,
  path: string,
  baseline: Shape,
  current: Shape,
  out: ShapeDifference[],
): void {
  for (const type of Object.keys(current.types) as JsonType[])
    if (!baseline.types[type])
      out.push({
        key,
        path: path || "/",
        kind: "new-type",
        detail: `${type} (known: ${Object.keys(baseline.types).join(", ")})`,
      });
  for (const [prop, shape] of Object.entries(current.props ?? {})) {
    const known = baseline.props?.[prop];
    if (!known) {
      out.push({
        key,
        path: `${path}/${prop}`,
        kind: "new-field",
        detail: Object.keys(shape.types).join(" | "),
      });
      continue;
    }
    compareShapes(key, `${path}/${prop}`, known, shape, out);
  }
  if (current.items && baseline.items)
    compareShapes(key, `${path}/*`, baseline.items, current.items, out);
}

/** What a recording shows that a baseline census does not. */
export function compareCensus(
  baseline: Census,
  current: Census,
): ShapeDifference[] {
  const out: ShapeDifference[] = [];
  for (const [key, entry] of Object.entries(current)) {
    const known = baseline[key];
    if (!known) {
      out.push({
        key,
        path: "/",
        kind: "new-message",
        detail: `${entry.count} seen`,
      });
      continue;
    }
    compareShapes(key, "", known.shape, entry.shape, out);
  }
  return out;
}

/** Merges a census into another (for a baseline built over several days). */
export function mergeCensus(into: Census, from: Census): Census {
  const mergeShape = (a: Shape, b: Shape) => {
    for (const [type, count] of Object.entries(b.types) as [JsonType, number][])
      a.types[type] = (a.types[type] ?? 0) + count;
    for (const [key, prop] of Object.entries(b.props ?? {})) {
      a.props ??= {};
      const target = (a.props[key] ??= { types: {}, present: 0 });
      target.present += prop.present;
      mergeShape(target, prop);
    }
    if (b.items) mergeShape((a.items ??= { types: {} }), b.items);
  };
  for (const [key, entry] of Object.entries(from)) {
    const target = (into[key] ??= { count: 0, shape: { types: {} } });
    target.count += entry.count;
    mergeShape(target.shape, entry.shape);
  }
  return into;
}
