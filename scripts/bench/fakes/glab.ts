/** A fake glab: config reads, GraphQL from the fake forge, REST lists empty. */
import { field, forgeFor, logCall } from "./forge";

const args = process.argv.slice(2);
const host = () => {
  const index = args.indexOf("--hostname");
  return index >= 0 ? args[index + 1]! : "gitlab.bench.test";
};

if (args[0] === "config" && args[1] === "get") {
  const key = args[2];
  const forHost = args.includes("--host")
    ? args[args.indexOf("--host") + 1]
    : undefined;
  logCall({ tool: "glab", kind: "config", key, bytes: 0 });
  if (key === "host") console.log("gitlab.bench.test");
  else if (key === "token" && forHost === "gitlab.bench.test")
    console.log("bench-token");
  process.exit(0);
}
if (args[0] === "auth") {
  logCall({ tool: "glab", kind: "auth", bytes: 0 });
  process.exit(0);
}
if (args[0] !== "api") {
  logCall({
    tool: "glab",
    kind: "unsupported",
    args: args.slice(0, 3),
    bytes: 0,
  });
  process.exit(1);
}
const positional = args.filter(
  (arg, index) =>
    index > 0 &&
    !arg.startsWith("-") &&
    ![
      "--hostname",
      "--method",
      "-X",
      "-f",
      "-F",
      "--header",
      "-H",
      "--input",
      "--raw-field",
      "--field",
    ].includes(args[index - 1]!),
);
const path = positional[0] ?? "";
if (path === "graphql") {
  const query = field(args, "query") ?? "";
  const forge = forgeFor("gitlab", host());
  try {
    const body = JSON.stringify(await forge.fetchers.gitlab(host(), query));
    const call = forge.calls.at(-1);
    logCall({
      tool: "glab",
      kind: call?.kind ?? "graphql",
      bytes: query.length + body.length,
    });
    console.log(body);
  } catch (error) {
    logCall({ tool: "glab", kind: "error", bytes: query.length });
    console.error(String(error));
    process.exit(1);
  }
} else {
  logCall({
    tool: "glab",
    kind: /resource_label_events/.test(path)
      ? "labels"
      : /draft_notes/.test(path)
        ? "drafts"
        : "rest",
    path: path.replace(/\d+/g, "N"),
    bytes: 2,
  });
  console.log("[]");
}
