import { expect, test } from "bun:test";
import type { HistoryStatus } from "../../../shared/history";
import { createHistoryRoute } from "./history";

const status = { enabled: true, location: "/h" } as HistoryStatus;

function route() {
  const calls: unknown[] = [];
  const handle = createHistoryRoute({
    status: async () => status,
    commit: async () => calls.push("commit"),
    configure: async (change) => {
      if (change.location === "relative") throw new Error("must be absolute");
      calls.push(change);
    },
  });
  return { handle, calls };
}

const write = (
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Request("http://x/api/history", {
    method,
    headers: {
      "content-type": "application/json",
      "x-roamgate-settings": "1",
      ...headers,
    },
    body: JSON.stringify(body),
  });

test("GET is the status; other paths are not the route's", async () => {
  const { handle } = route();
  const response = await handle(
    new Request("http://x/api/history"),
    "/api/history",
  );
  expect(await response?.json()).toEqual(status);
  expect(
    await handle(new Request("http://x/api/historyx"), "/api/historyx"),
  ).toBeNull();
});

test("PUT sets the location and the switch; POST commit runs a pass", async () => {
  const { handle, calls } = route();
  expect(
    (
      await handle(
        write("PUT", { location: "/data/h", enabled: false }),
        "/api/history",
      )
    )?.status,
  ).toBe(200);
  expect(
    (await handle(write("PUT", { location: "" }), "/api/history"))?.status,
  ).toBe(200);
  expect((await handle(write("POST", {}), "/api/history/commit"))?.status).toBe(
    200,
  );
  expect(calls).toEqual([
    { location: "/data/h", enabled: false },
    { location: null },
    "commit",
  ]);
  const bad = await handle(
    write("PUT", { location: "relative" }),
    "/api/history",
  );
  expect(bad?.status).toBe(400);
  expect(await bad?.json()).toEqual({ error: "must be absolute" });
  expect(
    (await handle(write("PUT", { enabled: "yes" }), "/api/history"))?.status,
  ).toBe(400);
});

test("a write without the settings header, or cross-site, is refused", async () => {
  const { handle, calls } = route();
  expect(
    (
      await handle(
        write("PUT", {}, { "x-roamgate-settings": "0" }),
        "/api/history",
      )
    )?.status,
  ).toBe(403);
  expect(
    (
      await handle(
        write("POST", {}, { "sec-fetch-site": "cross-site" }),
        "/api/history/commit",
      )
    )?.status,
  ).toBe(403);
  expect((await handle(write("POST", {}), "/api/history"))?.status).toBe(405);
  expect(calls).toEqual([]);
});
