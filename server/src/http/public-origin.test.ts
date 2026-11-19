import { expect, test } from "bun:test";
import { publicOrigin } from "./public-origin";

const proxied = new URL("http://roamgate.example.ts.net/api/notifications/ws");
const local = new URL("http://127.0.0.1:8787/api/notifications/ws");

test("tailscale serve's forwarded scheme and host count from loopback", () => {
  // What tailscale serve sends: the Host kept, X-Forwarded-Proto and -Host.
  const headers = new Headers({
    "x-forwarded-proto": "https",
    "x-forwarded-host": "roamgate.example.ts.net",
    "x-forwarded-for": "100.64.0.7",
  });
  for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
    expect(publicOrigin(proxied, headers, peer)).toBe(
      "https://roamgate.example.ts.net",
    );
  expect(publicOrigin(local, headers, "127.0.0.1")).toBe(
    "https://roamgate.example.ts.net",
  );
  expect(
    publicOrigin(
      local,
      new Headers({
        "x-forwarded-proto": "HTTPS, http",
        "x-forwarded-host": "box.example.com:8443, other",
      }),
      "127.0.0.1",
    ),
  ).toBe("https://box.example.com:8443");
});

test("forwarded headers from another peer are ignored", () => {
  const headers = new Headers({
    "x-forwarded-proto": "https",
    "x-forwarded-host": "evil.example",
  });
  expect(publicOrigin(local, headers, "192.0.2.7")).toBe(
    "http://127.0.0.1:8787",
  );
  expect(publicOrigin(local, headers, undefined)).toBe("http://127.0.0.1:8787");
  expect(publicOrigin(local, headers, "unknown")).toBe("http://127.0.0.1:8787");
});

test("a *.ts.net name on the default port is https", () => {
  expect(publicOrigin(proxied, new Headers(), "100.64.0.7")).toBe(
    "https://roamgate.example.ts.net",
  );
  expect(publicOrigin(proxied, new Headers(), "127.0.0.1")).toBe(
    "https://roamgate.example.ts.net",
  );
  // Roamgate's own port on the tailnet is its plain listener.
  const direct = new URL("http://box.example.ts.net:8787/");
  expect(publicOrigin(direct, new Headers(), "100.64.0.7")).toBe(
    "http://box.example.ts.net:8787",
  );
  // A local proxy that says http is believed.
  expect(
    publicOrigin(
      proxied,
      new Headers({ "x-forwarded-proto": "http" }),
      "127.0.0.1",
    ),
  ).toBe("http://roamgate.example.ts.net");
});

test("malformed forwarded values fall back to the request", () => {
  for (const host of ["a.example/evil", "user@a.example", "a b", ""])
    expect(
      publicOrigin(
        local,
        new Headers({ "x-forwarded-host": host, "x-forwarded-proto": "ftp" }),
        "127.0.0.1",
      ),
    ).toBe("http://127.0.0.1:8787");
});
