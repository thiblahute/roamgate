import { reviewServiceForTest } from "./testkit";
import { expect, test } from "bun:test";
import {
  describeTarget,
  parseRenderPart,
  parseReviewTarget,
  renderedPlace,
} from "./service";

/** Rendered reviews: a file or a site shown rendered, threads on it. */
function setup() {
  const prompts: string[] = [];
  const { service } = reviewServiceForTest({
    loadDiff: async () => {
      throw new Error("a rendered review has no diff");
    },
    deliveryDelayMs: 10,
    promptAgent: async (_connection, _pane, text) => {
      prompts.push(text);
    },
  });
  return { service, prompts };
}

test("a rendered review shows a relative path or an http(s) URL", () => {
  expect(parseReviewTarget({ kind: "rendered", path: "docs/plan.md" })).toEqual(
    { kind: "rendered", path: "docs/plan.md" },
  );
  expect(
    parseReviewTarget({
      kind: "rendered",
      url: "http://localhost:8080/docs/#top",
    }),
  ).toEqual({ kind: "rendered", url: "http://localhost:8080/docs/" });
  for (const bad of [
    { kind: "rendered" },
    { kind: "rendered", path: "a.md", url: "http://x/" },
    { kind: "rendered", path: "/etc/passwd" },
    { kind: "rendered", path: "../out.md" },
    { kind: "rendered", url: "javascript:alert(1)" },
    { kind: "rendered", url: "file:///etc/passwd" },
    { kind: "rendered", url: "http://user:pw@host/" },
  ])
    expect(() => parseReviewTarget(bad)).toThrow();
  expect(describeTarget({ kind: "rendered", path: "docs/plan.md" })).toBe(
    "docs/plan.md",
  );
});

test("the same file is one review; another file is another", () => {
  const { service } = setup();
  const open = (path: string) =>
    service.open({
      connectionId: "local",
      root: "/repo",
      target: { kind: "rendered", path },
      raise: false,
    }).session.id;
  expect(open("a.md")).toBe(open("a.md"));
  expect(open("a.md")).not.toBe(open("b.md"));
});

test("a rendered part is checked: fractions, a saved snapshot", () => {
  expect(
    parseRenderPart({
      quote: " the words ",
      region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      graphic: "diagram 1",
      element: "queue2",
      moment: "2.4 s",
      snapshot:
        "/home/u/.config/roamgate/reviews/images/0123456789abcdef/fedcba9876543210.png",
    }),
  ).toEqual({
    quote: "the words",
    region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    graphic: "diagram 1",
    element: "queue2",
    moment: "2.4 s",
    snapshot:
      "/home/u/.config/roamgate/reviews/images/0123456789abcdef/fedcba9876543210.png",
  });
  expect(() => parseRenderPart({ region: { x: 1.5, y: 0 } })).toThrow();
  expect(() =>
    parseRenderPart({ region: { x: 0.8, y: 0, w: 0.5, h: 0 } }),
  ).toThrow();
  expect(() => parseRenderPart({ snapshot: "/etc/passwd" })).toThrow();
  expect(() => parseRenderPart({})).toThrow();
});

test("the agent gets the source lines, the region, the moment and the snapshot", async () => {
  const { service, prompts } = setup();
  const session = service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "rendered", path: "docs/design.md" },
    agent: "Claude",
    paneId: "w1:p2",
  }).session;
  await service.addThread({
    sessionId: session.id,
    anchor: {
      path: "docs/design.md",
      line: 12,
      endLine: 30,
      side: "new",
      text: "```mermaid",
      render: {
        graphic: "diagram 1",
        region: { x: 0.25, y: 0.5, w: 0.1, h: 0.2 },
        element: "decoder",
        moment: "1.5 s",
        snapshot: "/r/images/0123456789abcdef/fedcba9876543210.png",
      },
    },
    text: "This arrow is backwards.",
  });
  await service.addThread({
    sessionId: session.id,
    anchor: {
      path: "docs/design.md",
      line: 3,
      side: "new",
      render: { quote: "the words I mean" },
    },
    text: "Say why.",
  });
  await Bun.sleep(60);
  const prompt = prompts.join("\n");
  expect(prompt).toContain(
    'on docs/design.md:12-30 as rendered (diagram 1, region x 25% y 50% w 10% h 20% of it, element "decoder", at 1.5 s):',
  );
  expect(prompt).toContain(
    "(what I saw there: /r/images/0123456789abcdef/fedcba9876543210.png)",
  );
  expect(prompt).toContain(
    "on docs/design.md:3 as rendered, about this part:\n  > the words I mean",
  );
  expect(prompt).toContain("This arrow is backwards.");
});

test("a page of a site is named by its URL", () => {
  expect(
    renderedPlace({
      url: "/tutorials/basic.html",
      selector: "main > h2:nth-of-type(3)",
    }),
  ).toBe("page /tutorials/basic.html, at `main > h2:nth-of-type(3)`");
  expect(renderedPlace({ region: { x: 0.5, y: 0.5, w: 0, h: 0 } })).toBe(
    "point x 50% y 50% of it",
  );
});
