import { afterEach, describe, expect, it, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractSchemas, checkRecordings, unknownFields } from "./check";
import type { Classified } from "./corpus";
import { ContractRecorder } from "./recorder";
import { listSockets, seedScenario, seedYaml } from "./seed";
import { compareCensus } from "./shapes";

const directories: string[] = [];
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "contract-check-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A small recording: one browser socket, an HTTP call, an agent call. */
function recording(): string {
  const directory = join(scratch(), "rec");
  let clock = Date.parse("2026-11-22T10:00:00.000Z");
  const rec = new ContractRecorder({
    directory,
    role: "server",
    now: () => (clock += 1000),
  });
  const ws = (ev: string, message: unknown) =>
    rec.record({ ch: "ws", ev, sock: "ws-1", raw: JSON.stringify(message) });
  rec.record({ ch: "ws", ev: "open", sock: "ws-1" });
  ws("out", { hello: true, bridge_protocol_version: 2 });
  ws("in", {
    id: 1,
    method: "review.get",
    params: { review: "r1" },
    connection_id: "local",
  });
  ws("out", { terminal: { terminal_id: "t", bytes: "AAAA" } });
  ws("out", { connection_id: "local", review: { id: "r1", threads: 2 } });
  ws("out", {
    connection_id: "local",
    connection_generation: 3,
    id: 1,
    result: {
      id: "r1",
      title: "x",
      extra: true,
      at: "2026-11-22T10:00:00.000Z",
    },
  });
  ws("in", { id: 2, method: "work.list", params: { open: "yes" } });
  ws("out", { id: 2, error: { message: "boom" } });
  rec.record({
    ch: "http",
    ev: "exchange",
    url: "http://h/api/health",
    fields: { method: "GET", status: 200 },
    bodies: {
      response: {
        raw: JSON.stringify({ ok: true, version: "1" }),
        kind: "json",
      },
    },
  });
  rec.record({
    ch: "agent",
    ev: "exchange",
    url: "http://localhost/v1/message",
    fields: { method: "POST", status: 200 },
    bodies: {
      body: { raw: "to=a&text=hi", kind: "form" },
      response: { raw: JSON.stringify({ sent: true }), kind: "json" },
    },
  });
  rec.record({
    ch: "spawn",
    ev: "exit",
    fields: { argv: ["git", "status", "--short"], code: 0 },
  });
  rec.close();
  return directory;
}

function contract(): string {
  const directory = join(scratch(), "contract");
  mkdirSync(join(directory, "rpc", "review"), { recursive: true });
  mkdirSync(join(directory, "rpc", "work"), { recursive: true });
  mkdirSync(join(directory, "push"), { recursive: true });
  mkdirSync(join(directory, "http"), { recursive: true });
  mkdirSync(join(directory, "agent-socket"), { recursive: true });
  writeFileSync(
    join(directory, "rpc", "review", "review.get.json"),
    JSON.stringify({
      params: {
        type: "object",
        properties: { review: { type: "string" } },
        required: ["review"],
      },
      reply: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          at: { type: "string" },
        },
        required: ["id", "title"],
      },
    }),
  );
  writeFileSync(
    join(directory, "rpc", "work", "work.list.json"),
    JSON.stringify({
      params: { type: "object", properties: { open: { type: "boolean" } } },
      reply: { type: "array" },
    }),
  );
  writeFileSync(
    join(directory, "push", "review.json"),
    JSON.stringify({
      type: "object",
      properties: { review: { $ref: "#/$defs/review" } },
      required: ["review"],
      $defs: {
        review: {
          type: "object",
          properties: { id: { type: "string" }, threads: { type: "number" } },
        },
      },
    }),
  );
  writeFileSync(
    join(directory, "http", "openapi.yaml"),
    [
      "openapi: 3.1.0",
      "paths:",
      "  /api/health:",
      "    get:",
      "      responses:",
      "        '200':",
      "          content:",
      "            application/json:",
      "              schema:",
      "                $ref: '#/components/schemas/Health'",
      "components:",
      "  schemas:",
      "    Health:",
      "      type: object",
      "      properties:",
      "        ok: { type: boolean }",
      "      required: [ok]",
    ].join("\n"),
  );
  writeFileSync(
    join(directory, "agent-socket", "openapi.yaml"),
    [
      "openapi: 3.1.0",
      "paths:",
      "  /v1/message:",
      "    post:",
      "      requestBody:",
      "        content:",
      "          application/x-www-form-urlencoded:",
      "            schema: { type: object, properties: { to: { type: string }, text: { type: string } }, required: [to] }",
      "      responses:",
      "        '200':",
      "          content:",
      "            application/json:",
      "              schema: { type: object, properties: { sent: { type: boolean } } }",
    ].join("\n"),
  );
  return directory;
}

describe("contract recording check", () => {
  it("reports mismatches, unknown fields and unlisted messages", async () => {
    const report = await checkRecordings([recording()], contract());
    const summary = report.findings.map(
      (f) => `${f.kind} ${f.surface} ${f.name} ${f.path}`,
    );
    expect(summary).toContain("mismatch rpc.request work.list params/open");
    expect(summary).toContain("unknown-field rpc.reply review.get reply/extra");
    expect(summary).toContain(
      "unknown-field http GET /api/health response/version",
    );
    expect(summary).toContain("unlisted push hello /");
    expect(summary).toContain("unlisted push terminal /");
    // The connection envelope is the transport's, not the reply's.
    expect(summary.some((line) => line.includes("connection_"))).toBe(false);
    // A well-formed push, an error with no error schema and the agent call pass.
    expect(summary.filter((line) => line.includes(" push review "))).toEqual(
      [],
    );
    expect(summary.filter((line) => line.includes(" agent "))).toEqual([]);
    expect(
      summary.filter((line) => line.includes("rpc.reply work.list")),
    ).toEqual([]);
    expect(report.messages).toBeGreaterThan(8);
  });

  it("builds a shape census without a contract and diffs it", async () => {
    const report = await checkRecordings([recording()], null);
    expect(report.findings).toEqual([]);
    expect(report.checked).toBe(0);
    const reply = report.census["rpc.reply review.get"]!;
    expect(reply.count).toBe(1);
    expect(Object.keys(reply.shape.props ?? {})).toEqual([
      "id",
      "title",
      "extra",
      "at",
    ]);
    expect(report.census["spawn git status"]?.count).toBe(1);
    const baseline = structuredClone(report.census);
    delete baseline["rpc.reply review.get"]!.shape.props!.extra;
    delete baseline["agent message"];
    const differences = compareCensus(baseline, report.census).map(
      (d) => `${d.kind} ${d.key} ${d.path}`,
    );
    expect(differences).toEqual([
      "new-field rpc.reply review.get /extra",
      "new-message agent message /",
    ]);
  });

  it("uses the contract's own check first", async () => {
    const dir = contract();
    writeFileSync(
      join(dir, "record-check.ts"),
      `export function createRecordCheck() {
        return { check(message) {
          if (message.surface === "push") return [];
          return undefined;
        } };
      }`,
    );
    const report = await checkRecordings([recording()], dir);
    expect(report.findings.some((f) => f.surface === "push")).toBe(false);
    expect(report.findings.some((f) => f.name === "work.list")).toBe(true);
  });

  it("finds unknown fields through refs and branches", () => {
    const schema = {
      $defs: { a: { type: "object", properties: { x: { type: "number" } } } },
      anyOf: [
        { $ref: "#/$defs/a" },
        {
          type: "object",
          properties: { y: { type: "object", properties: {} } },
        },
      ],
    };
    expect(
      unknownFields(schema, { x: 1, y: { z: 1 }, w: 2 }, schema, ""),
    ).toEqual(["/y/z", "/w"]);
    const list = {
      type: "array",
      items: { type: "object", properties: { a: {} } },
    };
    expect(unknownFields(list, [{ a: 1, b: 2 }, { b: 3 }], list, "")).toEqual([
      "/*/b",
    ]);
    const map = {
      type: "object",
      additionalProperties: { type: "object", properties: { n: {} } },
    };
    expect(unknownFields(map, { k1: { n: 1 }, k2: { m: 1 } }, map, "")).toEqual(
      ["/k2/m"],
    );
  });
});

describe("contract recording seeds", () => {
  it("lists the recorded sockets", () => {
    const [socket] = listSockets([recording()]);
    expect(socket).toMatchObject({
      sock: "ws-1",
      channel: "ws",
      calls: 2,
      methods: { "review.get": 1, "work.list": 1 },
    });
  });

  it("turns a socket's calls, replies and pushes into scenario steps", () => {
    const seed = seedScenario([recording()], { sock: "ws-1" });
    expect(seed.steps).toEqual([
      {
        expect_pushes: [
          {
            push: "hello",
            message: { hello: true, bridge_protocol_version: 2 },
          },
        ],
      },
      {
        call: "review.get",
        params: { review: "r1" },
        connection: "local",
        reply: { id: "r1", title: "x", extra: true, at: "{{time}}" },
      },
      {
        expect_pushes: [
          {
            push: "review",
            connection: "local",
            message: { review: { id: "r1", threads: 2 } },
          },
        ],
      },
      {
        call: "work.list",
        params: { open: "yes" },
        error: { message: "boom" },
      },
    ]);
    expect(seed.fakes).toEqual([]);
    const everything = seedScenario([recording()]);
    expect(everything.steps.map((step) => Object.keys(step)[0])).toContain(
      "agent",
    );
    expect(everything.fakes).toEqual([
      { run: ["git", "status", "--short"], exit: 0 },
    ]);
    const yaml = seedYaml(seed);
    expect(yaml).toStartWith("# Scenario seed");
    expect(Bun.YAML.parse(yaml)).toMatchObject({
      name: seed.name,
      steps: seed.steps,
    });
  });
});

test("a key several anyOf branches describe is unknown only if every one lacks it", () => {
  const branch = (kind: string, field: string) => ({
    type: "object",
    properties: {
      kind: { const: kind },
      status: { type: "object", properties: { [field]: {} } },
    },
  });
  const schema = { anyOf: [branch("status", "a"), branch("card", "b")] };
  expect(
    unknownFields(schema, { kind: "card", status: { b: 1 } }, schema, ""),
  ).toEqual([]);
  expect(
    unknownFields(schema, { kind: "card", status: { c: 1 } }, schema, ""),
  ).toEqual(["/status/c"]);
});

test("a redacted string matches any string schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "redacted-"));
  try {
    mkdirSync(join(dir, "push"));
    writeFileSync(
      join(dir, "push", "secret.json"),
      JSON.stringify({
        type: "object",
        properties: {
          secret: { enum: ["a", "b"] },
          auth: {
            anyOf: [
              { type: "object", properties: { status: { enum: ["x"] } } },
              { type: "null" },
            ],
          },
          other: { enum: ["a"] },
        },
      }),
    );
    const check = new ContractSchemas(dir);
    const findings = check.check({
      surface: "push",
      name: "secret",
      payload: {
        secret: "[redacted:0a1b]",
        auth: { status: "[redacted:0c]" },
        other: "c",
      },
    } as Classified);
    expect(findings?.map((finding) => finding.path)).toEqual(["message/other"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
