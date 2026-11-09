import { expect, test } from "bun:test";
import { handleInstanceSettings } from "./instance-settings";

function put(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://roamgate.example/api/instance-settings", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-roamgate-settings": "1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("instance settings reject cross-site and simple browser writes", async () => {
  const rejectedHeaders: Record<string, string>[] = [
    { "x-roamgate-settings": "" },
    { "sec-fetch-site": "cross-site" },
    { "content-type": "text/plain" },
  ];
  for (const headers of rejectedHeaders) {
    const response = await handleInstanceSettings(
      put({ title_suffix: "Work" }, headers),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  for (const method of ["POST", "DELETE", "OPTIONS", "HEAD"]) {
    const response = await handleInstanceSettings(
      new Request("https://roamgate.example/api/instance-settings", { method }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, PUT");
  }
});

test("invalid or oversized settings never reach persistence", async () => {
  for (const body of [
    null,
    [],
    {},
    { title_suffix: false },
    { title_suffix: "x".repeat(33) },
    { title_suffix: "x\u0000" },
  ]) {
    const response = await handleInstanceSettings(put(body));
    expect(response.status).toBe(400);
    expect(typeof (await response.json()).error).toBe("string");
  }
  const malformed = await handleInstanceSettings(
    new Request("https://roamgate.example/api/instance-settings", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-roamgate-settings": "1",
      },
      body: "{",
    }),
  );
  expect(malformed.status).toBe(400);
  let cancelled = false;
  const oversized = await handleInstanceSettings(
    new Request("https://roamgate.example/api/instance-settings", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-roamgate-settings": "1",
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4097));
        },
        cancel() {
          cancelled = true;
        },
      }),
    }),
  );
  expect(oversized.status).toBe(413);
  expect(cancelled).toBe(true);
});

test("the sites we work on are kept apart from the title, normalized", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "roamgate-instance-settings-"));
  const source = JSON.stringify(import.meta.resolve("./instance-settings"));
  const script = `
    import { handleInstanceSettings } from ${source};
    const put = (body) => handleInstanceSettings(new Request("https://r.example/api/instance-settings", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-roamgate-settings": "1" },
      body: JSON.stringify(body),
    }));
    const out = [];
    out.push(await (await put({ title_suffix: "Work" })).json());
    out.push(await (await put({ rendered_sites: ["http://localhost:8080", "javascript:x", "/srv/site"] })).json());
    out.push((await put({ rendered_sites: "http://x/" })).status);
    out.push(await (await handleInstanceSettings(new Request("https://r.example/api/instance-settings"))).json());
    out.push(await (await put({ rendered_site_roots: { "/srv/site/": "/srv", "http://localhost:8080/": "http://other/", "/nope/": "/" } })).json());
    out.push((await put({ rendered_site_roots: { "/srv/site/": 3 } })).status);
    out.push(await (await put({ rendered_sites: ["/srv/site/"] })).json());
    out.push(await (await put({ rendered_sites: [] })).json());
    console.log(JSON.stringify(out));
  `;
  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        HOME: home,
        ROAMGATE_SETTINGS_PATH: join(home, "settings.json"),
        HERDR_GUI_SETTINGS_PATH: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim().split("\n").pop()!)).toEqual([
      { title_suffix: "Work", rendered_sites: [], rendered_site_roots: {} },
      {
        title_suffix: "Work",
        rendered_sites: ["http://localhost:8080/", "/srv/site/"],
        rendered_site_roots: {},
      },
      400,
      {
        title_suffix: "Work",
        rendered_sites: ["http://localhost:8080/", "/srv/site/"],
        rendered_site_roots: {},
      },
      // Only a listed site's, containing it.
      {
        title_suffix: "Work",
        rendered_sites: ["http://localhost:8080/", "/srv/site/"],
        rendered_site_roots: { "/srv/site/": "/srv/" },
      },
      400,
      {
        title_suffix: "Work",
        rendered_sites: ["/srv/site/"],
        rendered_site_roots: { "/srv/site/": "/srv/" },
      },
      // A site removed takes its root along.
      { title_suffix: "Work", rendered_sites: [], rendered_site_roots: {} },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
