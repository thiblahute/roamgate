import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContractRecorder,
  contractRecordDirectory,
  type RecordLine,
} from "./recorder";

const directories: string[] = [];
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "contract-record-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function lines(directory: string): RecordLine[] {
  return readdirSync(directory)
    .filter((name) => name.startsWith("rec-"))
    .sort()
    .flatMap((name) =>
      readFileSync(join(directory, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordLine),
    );
}

describe("contract record mode", () => {
  it("is off unless ROAMGATE_CONTRACT_RECORD asks", () => {
    const root = () => "/data/roamgate";
    expect(contractRecordDirectory({}, root)).toBeNull();
    for (const off of ["", "0", "off", "false", "no"])
      expect(
        contractRecordDirectory({ ROAMGATE_CONTRACT_RECORD: off }, root),
      ).toBeNull();
    for (const on of ["1", "on", "true", "YES"])
      expect(
        contractRecordDirectory({ ROAMGATE_CONTRACT_RECORD: on }, root),
      ).toBe("/data/roamgate/contract-record");
    expect(
      contractRecordDirectory({ ROAMGATE_CONTRACT_RECORD: "/tmp/rec" }, root),
    ).toBe("/tmp/rec");
    // Roamgate's own name wins, even empty.
    expect(
      contractRecordDirectory(
        { ROAMGATE_CONTRACT_RECORD: "", HERDR_GUI_CONTRACT_RECORD: "1" },
        root,
      ),
    ).toBeNull();
    expect(
      contractRecordDirectory({ HERDR_GUI_CONTRACT_RECORD: "1" }, root),
    ).toBe("/data/roamgate/contract-record");
  });

  it("writes redacted JSONL in private files, in batches", () => {
    const directory = join(scratch(), "rec");
    const recorder = new ContractRecorder({ directory, role: "server" });
    recorder.record({
      ch: "ws",
      ev: "in",
      sock: "ws-1",
      raw: JSON.stringify({
        id: 1,
        method: "auth.check",
        params: { token: "abc123" },
      }),
    });
    recorder.record({
      ch: "http",
      ev: "exchange",
      url: "http://h/x?token=t0k3n&a=1",
      fields: { status: 200 },
    });
    recorder.record({ ch: "ws", ev: "out", sock: "ws-1", raw: "not json" });
    // Nothing written before the batch.
    expect(readdirSync(directory)).toEqual([]);
    recorder.flush();
    const [start, request, exchange, text] = lines(directory);
    expect(start).toMatchObject({
      ch: "recorder",
      ev: "start",
      role: "server",
      v: 1,
    });
    expect(request).toMatchObject({
      ch: "ws",
      ev: "in",
      sock: "ws-1",
      msg: { id: 1, method: "auth.check" },
    });
    expect(JSON.stringify(request)).not.toContain("abc123");
    expect(exchange).toMatchObject({
      path: "/x",
      query: { a: "1" },
      status: 200,
    });
    expect(JSON.stringify(exchange)).not.toContain("t0k3n");
    expect(text?.msg).toEqual({ text: "not json" });
    expect(request!.seq).toBeGreaterThan(start!.seq);
    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      const [file] = readdirSync(directory);
      expect(statSync(join(directory, file!)).mode & 0o777).toBe(0o600);
    }
    recorder.close();
  });

  it("rotates segments and prunes the oldest files past its budget", () => {
    const directory = scratch();
    // An older recording of another process, to be pruned first.
    writeFileSync(
      join(directory, "rec-20000101T000000-1-0001.jsonl"),
      "x".repeat(3000),
    );
    writeFileSync(join(directory, "unrelated.txt"), "kept");
    const recorder = new ContractRecorder({
      directory,
      role: "server",
      segmentBytes: 1000,
      keepBytes: 2500,
    });
    for (let index = 0; index < 20; index += 1) {
      recorder.record({
        ch: "ws",
        ev: "in",
        raw: JSON.stringify({ index, pad: "y".repeat(200) }),
      });
      recorder.flush();
    }
    recorder.close();
    const names = readdirSync(directory).sort();
    expect(names).toContain("unrelated.txt");
    expect(names).not.toContain("rec-20000101T000000-1-0001.jsonl");
    const recordings = names.filter((name) => name.startsWith("rec-"));
    expect(recordings.length).toBeGreaterThan(1);
    const total = recordings.reduce(
      (sum, name) => sum + statSync(join(directory, name)).size,
      0,
    );
    expect(total).toBeLessThanOrEqual(2500 + 1000);
    // The newest event survived.
    expect(
      lines(directory).some(
        (line) => (line.msg as { index?: number })?.index === 19,
      ),
    ).toBe(true);
  });

  it("drops and counts events past its queue", () => {
    const directory = scratch();
    const recorder = new ContractRecorder({ directory, role: "server" });
    for (let index = 0; index < 20_005; index += 1)
      recorder.record({ ch: "ws", ev: "in", raw: "{}" });
    recorder.flush();
    recorder.close();
    expect(recorder.stats().dropped).toBe(5);
    expect(
      lines(directory).find((line) => line.ev === "dropped"),
    ).toMatchObject({
      ch: "recorder",
      count: 5,
    });
  });

  it("ignores events after close", () => {
    const directory = scratch();
    const recorder = new ContractRecorder({ directory, role: "server" });
    recorder.close();
    recorder.record({ ch: "ws", ev: "in", raw: "{}" });
    recorder.flush();
    expect(readdirSync(directory)).toEqual([]);
  });
});
