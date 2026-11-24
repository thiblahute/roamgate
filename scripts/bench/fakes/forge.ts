/**
 * The benchmark's forges, answered by its fake forge (own-forge.ts) from a
 * fixed set of requests:
 * the same answers on every run and every server. Each call is logged to
 * BENCH_FORGE_LOG with its kind and bytes.
 */
import { appendFileSync } from "node:fs";
import { createOwnForge, type FakeRequest, fakeRequests } from "./own-forge";

const at = (base: string, step: number) => (index: number) =>
  new Date(Date.parse(base) - index * step).toISOString();

function requests(): FakeRequest[] {
  return [
    // 30 open, spread over a year, a few with running or failed pipelines.
    ...fakeRequests(
      30,
      "open",
      at("2026-11-01T00:00:00Z", 11 * 86_400_000),
    ).map((r, index) => ({
      ...r,
      pipeline: (
        ["success", "failed", "running", "success", "pending"] as const
      )[index % 5],
      approvedBy: index % 4 === 0 ? ["alice"] : [],
      unresolved: index % 3,
      labels: index % 2 ? ["bug"] : ["feature", "needs-review"],
    })),
    // 40 merged and 10 closed in the last days.
    ...fakeRequests(40, "merged", at("2026-11-04T00:00:00Z", 3_600_000), 100),
    ...fakeRequests(10, "closed", at("2026-11-03T00:00:00Z", 7_200_000), 200),
  ];
}

function followed(): FakeRequest[] {
  return fakeRequests(25, "open", at("2026-11-02T00:00:00Z", 5_400_000), 500, [
    "upstream/app",
  ]).map((r) => ({ ...r, reviewers: ["me"] }));
}

export function forgeFor(provider: "gitlab" | "github", host: string) {
  return createOwnForge(provider, host, requests(), { followed: followed() });
}

export function logCall(entry: Record<string, unknown>) {
  const path = process.env.BENCH_FORGE_LOG;
  if (path)
    appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
}

/** The value of `-f key=value` / `-F key=value` / `--raw-field` arguments. */
export function field(args: string[], key: string): string | undefined {
  for (let index = 0; index < args.length - 1; index++) {
    const flag = args[index];
    if (
      flag !== "-f" &&
      flag !== "-F" &&
      flag !== "--raw-field" &&
      flag !== "--field"
    )
      continue;
    const value = args[index + 1]!;
    if (value.startsWith(`${key}=`)) return value.slice(key.length + 1);
  }
  return undefined;
}
