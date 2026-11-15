import { describe, expect, test } from "bun:test";
import {
  listedDirectory,
  listedSite,
  normalizeSiteList,
  parseFrameMessage,
  parseSiteUrl,
  strayTarget,
} from "./renderedPage";

describe("parseFrameMessage", () => {
  const rect = { x: 1, y: 2, w: 3, h: 4 };

  test("accepts the frame's messages", () => {
    expect(
      parseFrameMessage({
        roamgate: "rendered",
        type: "ready",
        url: "a.html",
        title: "A",
      }),
    ).toEqual({
      roamgate: "rendered",
      type: "ready",
      url: "a.html",
      title: "A",
    });
    expect(
      parseFrameMessage({
        roamgate: "rendered",
        type: "select",
        url: "a",
        quote: " words ",
        selector: "p",
        rect,
      }),
    ).toEqual({
      roamgate: "rendered",
      type: "select",
      url: "a",
      quote: "words",
      selector: "p",
      rect,
    });
    expect(
      parseFrameMessage({
        roamgate: "rendered",
        type: "point",
        url: "a",
        selector: "svg",
        region: { x: 0.5, y: 0.5, w: 0, h: 0 },
        rect,
        element: "node1",
      }),
    ).toMatchObject({ type: "point", element: "node1" });
    expect(parseFrameMessage({ roamgate: "rendered", type: "clear" })).toEqual({
      roamgate: "rendered",
      type: "clear",
    });
  });

  test("refuses anything else", () => {
    for (const bad of [
      null,
      "x",
      { type: "ready", url: "a" },
      { roamgate: "rendered", type: "eval", url: "a" },
      {
        roamgate: "rendered",
        type: "select",
        url: "a",
        quote: "  ",
        selector: "p",
        rect,
      },
      {
        roamgate: "rendered",
        type: "select",
        url: "a",
        quote: "x".repeat(4001),
        selector: "p",
        rect,
      },
      {
        roamgate: "rendered",
        type: "select",
        url: 5,
        quote: "x",
        selector: "p",
        rect,
      },
      {
        roamgate: "rendered",
        type: "select",
        url: "a",
        quote: "x",
        selector: "p",
        rect: { x: Number.NaN, y: 0, w: 0, h: 0 },
      },
      {
        roamgate: "rendered",
        type: "point",
        url: "a",
        selector: "s",
        region: { x: 2, y: 0, w: 0, h: 0 },
        rect,
      },
    ])
      expect(parseFrameMessage(bad)).toBeNull();
  });
});

describe("a frame off its token", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef";
  const root = { base: "/", to: `/rendered/${TOKEN}/.roamgate-root/` };

  test("a page's root map comes with its ready, checked", () => {
    const ready = (value: unknown) =>
      parseFrameMessage({
        roamgate: "rendered",
        type: "ready",
        url: "a.html",
        title: "",
        root: value,
      });
    expect(ready(root)).toMatchObject({ root });
    expect(ready({ base: "/docs/", to: `/rendered/${TOKEN}/` })).toMatchObject({
      root: { base: "/docs/", to: `/rendered/${TOKEN}/` },
    });
    for (const bad of [
      { base: "/", to: "/api/" },
      { base: "/", to: `/rendered/${TOKEN}/../` },
      { base: "docs/", to: `/rendered/${TOKEN}/` },
      { base: "/", to: 1 },
      "x",
    ])
      expect(ready(bad)).not.toHaveProperty("root");
    expect(
      parseFrameMessage({ roamgate: "rendered", type: "stray", url: "/a?b" }),
    ).toEqual({ roamgate: "rendered", type: "stray", url: "/a?b" });
    for (const url of ["a", "//evil/x", 3])
      expect(
        parseFrameMessage({ roamgate: "rendered", type: "stray", url }),
      ).toBeNull();
  });

  test("goes back under the token, never anywhere else", () => {
    expect(strayTarget("/documentation/installing/index.html?x=1", root)).toBe(
      `/rendered/${TOKEN}/.roamgate-root/documentation/installing/index.html?x=1`,
    );
    const site = { base: "/docs/", to: `/rendered/${TOKEN}/` };
    expect(strayTarget("/docs/a.html", site)).toBe(`/rendered/${TOKEN}/a.html`);
    expect(strayTarget("/other/a.html", site)).toBeNull();
    for (const url of [
      "/../api/health",
      "/a/%2e%2e/%2E%2E/api",
      "/a%2fb",
      "/a\\b",
      "/./x",
    ])
      expect(strayTarget(url, root)).toBeNull();
    expect(strayTarget("/a", { base: "/", to: "/api/" })).toBeNull();
  });
});

describe("a page's storage write", () => {
  test("is exactly a set, remove or clear within the bounds", () => {
    const msg = { roamgate: "rendered", type: "storage" };
    expect(
      parseFrameMessage({ ...msg, op: "set", key: "k", value: "v" }),
    ).toEqual({ ...msg, op: "set", key: "k", value: "v" });
    expect(parseFrameMessage({ ...msg, op: "remove", key: "k" })).toEqual({
      ...msg,
      op: "remove",
      key: "k",
    });
    expect(parseFrameMessage({ ...msg, op: "clear" })).toEqual({
      ...msg,
      op: "clear",
    });
    for (const bad of [
      { op: "set", key: "k" },
      { op: "set", key: 5, value: "v" },
      { op: "set", key: "", value: "v" },
      { op: "set", key: "k", value: "x".repeat(300 * 1024) },
      { op: "remove" },
      { op: "other", key: "k" },
    ])
      expect(parseFrameMessage({ ...msg, ...bad })).toBeNull();
  });
});

describe("sites we work on", () => {
  test("are kept as http(s) prefixes or absolute directories", () => {
    expect(
      normalizeSiteList([
        "http://localhost:8080",
        "http://localhost:8080/docs/index.html",
        "https://desktop:4000/docs/",
        "http://localhost:8080/",
        "/home/me/site",
        "file:///etc",
        "javascript:alert(1)",
        "http://user:pw@host/",
        "/a/../b",
        "relative/path",
        42,
      ]),
    ).toEqual([
      "http://localhost:8080/",
      "http://localhost:8080/docs/",
      "https://desktop:4000/docs/",
      "/home/me/site/",
    ]);
    expect(normalizeSiteList("nope")).toEqual([]);
  });

  test("match URLs and paths under them only", () => {
    const sites = ["http://localhost:8080/docs/", "/home/me/site/"];
    expect(listedSite(sites, "http://localhost:8080/docs/a.html?x")).toBe(
      "http://localhost:8080/docs/",
    );
    expect(listedSite(sites, "http://localhost:8080/docsother/")).toBeNull();
    expect(listedSite(sites, "http://localhost:8081/docs/")).toBeNull();
    expect(
      listedSite(sites, "http://evil.example/http://localhost:8080/docs/"),
    ).toBeNull();
    expect(listedDirectory(sites, "/home/me/site/index.html")).toBe(
      "/home/me/site/",
    );
    expect(listedDirectory(sites, "/home/me/sitex/index.html")).toBeNull();
    // URL entries never match files, nor directories URLs.
    expect(listedDirectory(["http://localhost/"], "/x")).toBeNull();
    expect(listedSite(["/home/"], "http://localhost/home/")).toBeNull();
  });

  test("site URLs drop their fragment and refuse credentials", () => {
    expect(parseSiteUrl("http://localhost:8080/a#b")).toBe(
      "http://localhost:8080/a",
    );
    expect(parseSiteUrl("http://u:p@localhost/")).toBeNull();
    expect(parseSiteUrl("data:text/html,x")).toBeNull();
  });
});
