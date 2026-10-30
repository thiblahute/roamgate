import { expect, test } from "bun:test";
import { sshRefusal } from "./ssh-guard";

test("a server with a HOME of its own refuses SSH hosts unless allowed", () => {
  expect(sshRefusal({ HOME: "/Users/me" }, "/Users/me")).toBeNull();
  expect(sshRefusal({ HOME: "/Users/me/" }, "/Users/me")).toBeNull();
  expect(sshRefusal({ HOME: "/tmp/test-home" }, "/Users/me")).toMatch(
    /own HOME \(\/tmp\/test-home\).*ROAMGATE_ALLOW_SSH=1/,
  );
  expect(
    sshRefusal(
      { HOME: "/tmp/test-home", ROAMGATE_ALLOW_SSH: "1" },
      "/Users/me",
    ),
  ).toBeNull();
  // No HOME (Windows sets USERPROFILE), or no account home known: no guess.
  expect(sshRefusal({}, "C:\\Users\\me")).toBeNull();
  expect(sshRefusal({ HOME: "/tmp/x" }, "")).toBeNull();
});
