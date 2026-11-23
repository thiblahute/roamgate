/**
 * The templates of contract/assets (contract/assets/README.md): `{{name}}`
 * is a value written as given (quoting is the caller's), `{{#name}}...
 * {{/name}}` is kept when `name` is true and `{{^name}}...{{/name}}` when
 * it is false. Nothing else is special, so a template is the script it
 * sends, byte for byte, but for its tags. Every tag needs its value and
 * every value its tag: a mismatch throws, so a template and its caller
 * cannot drift apart silently.
 */

export type TemplateValues = Record<string, string | number | boolean>;

type Node =
  | { kind: "text"; text: string }
  | { kind: "value"; name: string }
  | { kind: "section"; name: string; inverted: boolean; body: Node[] };

const TAG = /\{\{([#^/]?)([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

const parsed = new Map<string, Node[]>();

function parse(template: string): Node[] {
  const cached = parsed.get(template);
  if (cached) return cached;
  const root: Node[] = [];
  const stack: { name: string; nodes: Node[] }[] = [{ name: "", nodes: root }];
  let at = 0;
  for (const match of template.matchAll(TAG)) {
    const top = stack[stack.length - 1]!;
    if (match.index > at)
      top.nodes.push({ kind: "text", text: template.slice(at, match.index) });
    at = match.index + match[0].length;
    const [, sigil, name] = match as unknown as [string, string, string];
    if (sigil === "/") {
      if (top.name !== name)
        throw new Error(`template: {{/${name}}} closes {{${top.name}}}`);
      stack.pop();
    } else if (sigil === "#" || sigil === "^") {
      const body: Node[] = [];
      top.nodes.push({ kind: "section", name, inverted: sigil === "^", body });
      stack.push({ name, nodes: body });
    } else top.nodes.push({ kind: "value", name });
  }
  if (stack.length > 1)
    throw new Error(
      `template: {{${stack[stack.length - 1]!.name}}} not closed`,
    );
  if (at < template.length)
    root.push({ kind: "text", text: template.slice(at) });
  parsed.set(template, root);
  return root;
}

function names(nodes: Node[], into: Set<string>): Set<string> {
  for (const node of nodes) {
    if (node.kind === "value") into.add(node.name);
    else if (node.kind === "section") {
      into.add(node.name);
      names(node.body, into);
    }
  }
  return into;
}

function render(nodes: Node[], values: TemplateValues): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") out += node.text;
    else if (node.kind === "value") {
      const value = values[node.name];
      if (typeof value === "boolean")
        throw new Error(`template: {{${node.name}}} is a section's flag`);
      out += String(value);
    } else {
      const flag = values[node.name];
      if (typeof flag !== "boolean")
        throw new Error(`template: {{#${node.name}}} needs true or false`);
      if (flag !== node.inverted) out += render(node.body, values);
    }
  }
  return out;
}

/** The template with its tags filled from `values`. */
export function fillTemplate(template: string, values: TemplateValues): string {
  const nodes = parse(template);
  const used = names(nodes, new Set());
  for (const name of used)
    if (!Object.prototype.hasOwnProperty.call(values, name))
      throw new Error(`template: no value for {{${name}}}`);
  for (const name of Object.keys(values))
    if (!used.has(name)) throw new Error(`template: no {{${name}}} to fill`);
  return render(nodes, values);
}

/** The names a template asks for (tests). */
export function templateNames(template: string): string[] {
  return [...names(parse(template), new Set())].sort();
}
