import { describe, expect, test } from "bun:test";
import { applyAccountUsage } from "./accountUsage";

describe("account usage", () => {
  test("a push replaces the accounts it names and drops the removed", () => {
    const first = applyAccountUsage(new Map(), {
      accounts: [
        { agent: "claude", id: "work", status: "fresh" },
        { agent: "codex", id: "c", status: "auth_expired" },
        { nonsense: true },
      ],
      removed: [],
    });
    expect([...first.keys()]).toEqual(["claude/work", "codex/c"]);
    const next = applyAccountUsage(first, {
      accounts: [{ agent: "claude", id: "work", status: "rate_limited" }],
      removed: ["codex/c"],
    });
    expect(next.get("claude/work")?.status).toBe("rate_limited");
    expect(next.has("codex/c")).toBe(false);
    expect(applyAccountUsage(next, null)).toBe(next);
  });
});
