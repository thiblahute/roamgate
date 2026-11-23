import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A rehearsal of families on the Rust core in a test that starts a server
 * process (ROAMGATE_TEST_RUST_FAMILIES, comma separated, with
 * ROAMGATE_CORE_BIN naming the core): the owners table of the test
 * server's HOME gives them to Rust, shadow reads off. Without both
 * variables it writes nothing.
 */
export function seedTestRustOwners(
  home: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const families = (env.ROAMGATE_TEST_RUST_FAMILIES ?? "")
    .split(",")
    .map((family) => family.trim())
    .filter(Boolean);
  if (families.length === 0 || !env.ROAMGATE_CORE_BIN) return [];
  const runtime = join(home, ".config", "roamgate", "runtime");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(runtime, "owners.json"),
    `${JSON.stringify({
      version: 1,
      owners: Object.fromEntries(families.map((family) => [family, "rust"])),
      shadow: { enabled: false, rate: 0 },
    })}\n`,
    { mode: 0o600 },
  );
  return families;
}
