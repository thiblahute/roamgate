/** A fake gh: logged in, GraphQL from the fake forge. */
import { field, forgeFor, logCall } from "./forge";

const args = process.argv.slice(2);
if (args[0] === "auth") {
  logCall({ tool: "gh", kind: "auth", bytes: 0 });
  process.exit(0);
}
if (args[0] !== "api") {
  logCall({
    tool: "gh",
    kind: "unsupported",
    args: args.slice(0, 3),
    bytes: 0,
  });
  process.exit(1);
}
const hostIndex = args.indexOf("--hostname");
const host = hostIndex >= 0 ? args[hostIndex + 1]! : "github.com";
if (args.includes("graphql")) {
  const query = field(args, "query") ?? "";
  const forge = forgeFor("github", host);
  try {
    const body = JSON.stringify(await forge.fetchers.github(host, query));
    const call = forge.calls.at(-1);
    logCall({
      tool: "gh",
      kind: call?.kind ?? "graphql",
      bytes: query.length + body.length,
    });
    console.log(body);
  } catch (error) {
    logCall({ tool: "gh", kind: "error", bytes: query.length });
    console.error(String(error));
    process.exit(1);
  }
} else {
  logCall({ tool: "gh", kind: "rest", bytes: 2 });
  console.log("[]");
}
