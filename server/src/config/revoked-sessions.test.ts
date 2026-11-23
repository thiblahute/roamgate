import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_REVOKED_SESSIONS, openRevokedSessions } from "./revoked-sessions";
import { revokedSessionsPath, sessionSecretPath } from "./session-secret";

test("sits next to the signing secret", () => {
  expect(revokedSessionsPath(undefined, "/d")).toBe(
    "/d/session-secret.revoked.json",
  );
  expect(revokedSessionsPath("/s.json", "/d")).toBe(
    sessionSecretPath("/s.json", "/d").replace(/\.json$/, ".revoked.json"),
  );
});

test("an ended cookie is forgotten once it would have expired anyway", () => {
  const directory = mkdtempSync(join(tmpdir(), "roamgate-revoked-"));
  try {
    const path = join(directory, "session-secret.revoked.json");
    let now = 1_000;
    const revoked = openRevokedSessions(path, () => now);
    revoked.add("a", 2_000);
    expect(revoked.has("a")).toBe(true);
    expect(revoked.has("b")).toBe(false);
    now = 2_000;
    expect(revoked.has("a")).toBe(false);
    revoked.add("b", 3_000);
    const state = JSON.parse(readFileSync(path, "utf8"));
    expect(state.version).toBe(1);
    expect(Object.values(state.revoked)).toEqual([3_000]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps the latest to expire past its bound", () => {
  const now = 0;
  const revoked = openRevokedSessions(null, () => now);
  for (let index = 0; index <= MAX_REVOKED_SESSIONS; index++)
    revoked.add(`t${index}`, 10 + index);
  expect(revoked.has("t0")).toBe(false);
  expect(revoked.has("t1")).toBe(true);
  expect(revoked.has(`t${MAX_REVOKED_SESSIONS}`)).toBe(true);
});

test("an unreadable file is ignored", () => {
  const directory = mkdtempSync(join(tmpdir(), "roamgate-revoked-"));
  try {
    const path = join(directory, "session-secret.revoked.json");
    writeFileSync(path, "{nope");
    expect(openRevokedSessions(path).has("a")).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
