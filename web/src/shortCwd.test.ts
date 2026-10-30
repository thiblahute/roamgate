import { expect, test } from "bun:test";
import { shortCwd } from "./shortCwd";

test("a directory reads short: home as ~, a long path by its last parts", () => {
  expect(shortCwd("/Users/me/devel/gstreamer/gstreamer-ocio")).toBe(
    "~/devel/gstreamer/gstreamer-ocio",
  );
  expect(shortCwd("/home/me")).toBe("~");
  expect(shortCwd("/home/me/")).toBe("~");
  expect(shortCwd("/root/src")).toBe("~/src");
  expect(shortCwd("/home/meadow-other")).toBe("~");
  expect(shortCwd("/srv/app")).toBe("/srv/app");
  expect(shortCwd("C:\\Users\\me\\src\\app")).toBe("~\\src\\app");
  expect(
    shortCwd("/Users/me/devel/misc/roamgate.worktrees/up-rebase/web/src"),
  ).toBe("~/.../up-rebase/web/src");
  expect(shortCwd("/opt/a/very/long/path/that/goes/on/and/on/forever/x")).toBe(
    ".../path/that/goes/on/and/on/forever/x",
  );
  const long = shortCwd(`/Users/me/${"x".repeat(60)}`);
  expect(long).toBe(`~/.../${"x".repeat(60)}`);
});
